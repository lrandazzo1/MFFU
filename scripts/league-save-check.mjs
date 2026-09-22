#!/usr/bin/env node
/* ============================================================================
   FSN — LEAGUE SAVE CHECK

   `node scripts/league-save-check.mjs`

   The bug this exists to keep fixed: pressing SAVE LEAGUE DATA NOW returned
   HTTP 409 VERSION_CONFLICT forever, because the version marker this browser
   was holding (in memory, and mirrored into localStorage) had drifted from the
   row's real updated_at. An explicit save must never be refused for that.

   Two halves, both against the real code:

     1. api/league.js saveLeagueRow() driven by an in-memory Supabase double —
        the version guard still protects automatic saves, and force / refreshed
        host credentials bypass it by re-reading the authoritative updated_at
        from the database immediately before the write.
     2. index.html in Chromium — the Save button sends force:true and adopts
        the updated_at the server returns, into both the in-memory marker and
        the localStorage mirror, so the NEXT save is not a conflict either.
============================================================================ */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const leagueApi = require(join(root, 'api/league.js'));
const { saveLeagueRow, encryptCookies, inspectStoredCookies } = leagueApi;

const LEAGUE = '1234567';
const SEASON = 2026;
const STALE = '2026-09-01T00:00:00.000Z';
const CURRENT = '2026-09-20T00:00:00.000Z';

/* A deliberately small stand-in for PostgREST: enough chaining for the exact
   calls saveLeagueRow makes, and a hook (onRead) for simulating a leaguemate
   committing between the read and the write.

   `uniqueOn` is the table's real unique key. The LIVE database keys
   public.leagues on league_id ALONE (leagues_pkey PRIMARY KEY (league_id))
   while supabase/schema.sql declares the composite, so the default here is the
   live one — that divergence is the whole reason a save for a second season
   used to die on Postgres 23505. An upsert whose ON CONFLICT target does not
   match `uniqueOn` gets Postgres 42P10, exactly as the real server answers. */
function fakeClient(options) {
  const opts = options || {};
  const uniqueOn = opts.uniqueOn || ['league_id'];
  const state = {
    rows: opts.rows ? opts.rows.map((row) => Object.assign({}, row)) : [],
    reads: 0, updates: 0, inserts: 0, upserts: 0, conflictTargets: [],
  };

  function matches(filters) {
    return state.rows.filter((row) => filters.every(([col, value]) => String(row[col]) === String(value)));
  }
  function findByKey(row, columns) {
    return state.rows.find((existing) =>
      columns.every((col) => String(existing[col]) === String(row[col])));
  }

  state.from = function () {
    const filters = [];
    const api = {
      select() { return api; },
      eq(col, value) { filters.push([col, value]); return api; },
      limit() {
        state.reads += 1;
        const found = matches(filters).map((row) => Object.assign({}, row));
        if (typeof opts.onRead === 'function') opts.onRead(state, state.reads);
        return Promise.resolve({ data: found, error: null });
      },
      update(patch) { api._patch = patch; api._mode = 'update'; return api; },
      insert(row) { api._row = row; api._mode = 'insert'; return api; },
      upsert(row, options) {
        api._row = row;
        api._mode = 'upsert';
        api._conflict = String((options && options.onConflict) || '').split(',').map((c) => c.trim()).filter(Boolean);
        return api;
      },
      maybeSingle() {
        state.updates += 1;
        const found = matches(filters);
        if (!found.length) return Promise.resolve({ data: null, error: null });
        Object.assign(found[0], api._patch);
        return Promise.resolve({ data: Object.assign({}, found[0]), error: null });
      },
      single() {
        if (api._mode === 'upsert') {
          state.upserts += 1;
          state.conflictTargets.push(api._conflict.join(','));
          const targetMatchesConstraint = api._conflict.length === uniqueOn.length &&
            uniqueOn.every((col) => api._conflict.indexOf(col) !== -1);
          if (!targetMatchesConstraint) {
            return Promise.resolve({
              data: null,
              error: Object.assign(new Error('there is no unique or exclusion constraint matching the ON CONFLICT specification'), { code: '42P10' }),
            });
          }
          const existing = findByKey(api._row, uniqueOn);
          if (existing) {
            Object.assign(existing, api._row);
            return Promise.resolve({ data: Object.assign({}, existing), error: null });
          }
          state.rows.push(Object.assign({}, api._row));
          return Promise.resolve({ data: Object.assign({}, api._row), error: null });
        }
        state.inserts += 1;
        const clash = !!findByKey(api._row, uniqueOn);
        if (clash) {
          return Promise.resolve({
            data: null,
            error: Object.assign(new Error('duplicate key value violates unique constraint "leagues_pkey"'), { code: '23505' }),
          });
        }
        state.rows.push(Object.assign({}, api._row));
        return Promise.resolve({ data: Object.assign({}, api._row), error: null });
      },
    };
    return api;
  };
  return state;
}

function rowToWrite(updatedAt) {
  return {
    league_id: LEAGUE,
    season_year: SEASON,
    history_json: { schemaVersion: 2, yearsData: [] },
    share_token: 'b'.repeat(43),
    cookies: { espn_s2: 'fresh-s2', swid: '{11111111-2222-3333-4444-555555555555}' },
    updated_at: updatedAt || '2026-09-21T00:00:00.000Z',
  };
}

/* The default stored row holds an envelope written with THIS deployment's
   ACTIVE key, so it is not stale and the version guard is the only thing
   deciding whether a save lands. Pass LEGACY_PLAINTEXT to get the other case:
   a pre-encryption row, which every save is now expected to repair. */
function storedRow(cookies) {
  return {
    league_id: LEAGUE,
    season_year: SEASON,
    history_json: { yearsData: [] },
    share_token: 'b'.repeat(43),
    cookies: cookies === undefined ? encryptCookies(STORED_PAIR) : cookies,
    updated_at: CURRENT,
  };
}

// A legacy plaintext envelope, which decryptCookies reads without a key.
const LEGACY_PLAINTEXT = { espn_s2: 'stored-s2', swid: '{11111111-2222-3333-4444-555555555555}' };

const STORED_PAIR = { espn_s2: 'stored-s2', swid: '{11111111-2222-3333-4444-555555555555}' };

async function rejects(promise) {
  try { await promise; }
  catch (err) { return err; }
  throw new Error('expected the save to be rejected, but it resolved');
}

/* ---------- 1. the API route ---------- */
{
  const client = fakeClient({ rows: [storedRow()] });
  const err = await rejects(saveLeagueRow(client, rowToWrite(), STALE, { cookies: STORED_PAIR }));
  assert.equal(err.code, 'VERSION_CONFLICT');
  assert.equal(err.status, 409);
  assert.equal(err.currentUpdatedAt, CURRENT);
  assert.equal(client.rows[0].updated_at, CURRENT, 'a refused save must not write');
  console.log('ok    an automatic save holding a stale marker is still refused (guard intact)');
}
{
  const client = fakeClient({ rows: [storedRow()] });
  const saved = await saveLeagueRow(client, rowToWrite(CURRENT), CURRENT, { cookies: STORED_PAIR });
  assert.equal(saved.updated_at, CURRENT);
  console.log('ok    an automatic save holding the current marker still writes');
}
{
  const client = fakeClient({ rows: [storedRow()] });
  const saved = await saveLeagueRow(client, rowToWrite('2026-09-22T00:00:00.000Z'), STALE, { force: true });
  assert.equal(saved.updated_at, '2026-09-22T00:00:00.000Z');
  assert.equal(client.rows[0].updated_at, '2026-09-22T00:00:00.000Z');
  console.log('ok    force:true saves past a stale marker by re-reading the database version');
}
{
  const client = fakeClient({ rows: [storedRow()] });
  const saved = await saveLeagueRow(client, rowToWrite('2026-09-22T01:00:00.000Z'), STALE, {
    cookies: { espn_s2: 'rotated-s2', swid: '{11111111-2222-3333-4444-555555555555}' },
  });
  assert.equal(saved.updated_at, '2026-09-22T01:00:00.000Z');
  console.log('ok    refreshed host credentials bypass the guard even without force');
}
{
  /* The stored envelope is written with THIS deployment's active key, so the
     row is not stale and the only question is whether the credentials changed.
     They have not, so the version guard is still the one in charge. */
  const client = fakeClient({ rows: [storedRow()] });
  const err = await rejects(saveLeagueRow(client, rowToWrite(), STALE, { cookies: STORED_PAIR }));
  assert.equal(err.code, 'VERSION_CONFLICT', 'unchanged cookies must not be read as a credential refresh');
  console.log('ok    unchanged host credentials under the active key do not bypass the guard');
}
{
  /* A legacy plaintext row is stale by definition: the credentials are sitting
     in the column unencrypted. Re-saving it is a REPAIR and must not be
     refused for holding a marker that drifted — otherwise the host presses
     save, sees 409, and the row never gets encrypted. */
  const client = fakeClient({ rows: [storedRow(LEGACY_PLAINTEXT)] });
  const saved = await saveLeagueRow(client, rowToWrite('2026-09-22T03:00:00.000Z'), STALE, {
    cookies: STORED_PAIR,
  });
  assert.equal(saved.updated_at, '2026-09-22T03:00:00.000Z');
  assert.ok(inspectStoredCookies(client.rows[0].cookies).readable, 'the repaired row must still be readable');
  console.log('ok    a stale stored envelope is re-encrypted past the version guard');
}
{
  // A leaguemate commits between the forced save's read and its write. The
  // retry re-reads and wins rather than reporting a conflict.
  const client = fakeClient({
    rows: [storedRow()],
    onRead(state, reads) { if (reads === 1) state.rows[0].updated_at = '2026-09-21T12:00:00.000Z'; },
  });
  const saved = await saveLeagueRow(client, rowToWrite('2026-09-22T02:00:00.000Z'), STALE, { force: true });
  assert.equal(saved.updated_at, '2026-09-22T02:00:00.000Z');
  assert.ok(client.reads >= 2, 'the forced save must re-read the authoritative version');
  console.log('ok    a commit landing mid-save is re-read and retried, not reported as a conflict');
}
{
  const client = fakeClient({ rows: [] });
  const err = await rejects(saveLeagueRow(client, rowToWrite(), STALE, {}));
  assert.equal(err.code, 'VERSION_CONFLICT');
  const forced = fakeClient({ rows: [] });
  const saved = await saveLeagueRow(forced, rowToWrite(), STALE, { force: true });
  assert.equal(saved.league_id, LEAGUE);
  assert.equal(forced.rows.length, 1);
  console.log('ok    a marker for a row that does not exist becomes a first write under force');
}

/* ---------- 1b. the primary-key collision (Postgres 23505) ---------- */
{
  /* THE BUG. The live table keys on league_id alone, so a league that already
     has a 2025 row owns the key. A save for 2026 finds nothing on
     (league_id, season_year), takes the "first write" path, and — as a plain
     INSERT — walks into leagues_pkey. As an upsert it is the update it always
     should have been. */
  const client = fakeClient({
    uniqueOn: ['league_id'],
    rows: [Object.assign(storedRow(), { season_year: 2025 })],
  });
  const saved = await saveLeagueRow(client, rowToWrite('2026-09-22T04:00:00.000Z'), '', { cookies: STORED_PAIR });
  assert.equal(saved.league_id, LEAGUE);
  assert.equal(Number(saved.season_year), SEASON);
  assert.equal(client.rows.length, 1, 'the league must still own exactly one row');
  assert.equal(client.inserts, 0, 'no bare INSERT may be issued against a keyed league');
  assert.equal(client.conflictTargets[0], 'league_id', 'the live primary key is tried first');
  console.log('ok    a second season for an already-keyed league upserts instead of raising 23505');
}
{
  // The composite schema in supabase/schema.sql must keep working: the first
  // target answers 42P10 and the save falls through to (league_id, season_year).
  const client = fakeClient({ uniqueOn: ['league_id', 'season_year'], rows: [] });
  const saved = await saveLeagueRow(client, rowToWrite('2026-09-22T05:00:00.000Z'), '', { cookies: STORED_PAIR });
  assert.equal(saved.league_id, LEAGUE);
  assert.ok(client.conflictTargets.indexOf('league_id,season_year') !== -1,
    'a 42P10 must fall through to the composite conflict target');
  console.log('ok    a 42P10 on the live key falls through to the composite key in schema.sql');
}

/* ---------- 1c. decryption failures say nothing about the keys ---------- */
{
  const { decryptCookies } = leagueApi;
  const envelope = encryptCookies(STORED_PAIR);
  // Corrupt the ciphertext so the GCM tag check fails under every candidate key.
  const broken = Object.assign({}, envelope, { data: Buffer.from('not the ciphertext').toString('base64') });
  const opened = decryptCookies(broken);
  assert.equal(opened.ok, false);
  assert.equal(opened.reason, 'This invite link has expired or requires the league host to re-authenticate.');
  assert.ok(!/candidate key|LEAGUE_COOKIE_ENCRYPTION_KEY|fallback|A256GCM/i.test(opened.reason),
    'the reader-facing reason must not describe this deployment\'s key configuration');
  assert.ok(/candidate key/.test(opened.internalReason || ''),
    'the full diagnostic must still exist for the server log');
  console.log('ok    an undecryptable envelope reports one clean sentence and logs the rest');
}

/* ---------- 2. the Save button ---------- */
const html = readFileSync(join(root, 'index.html'), 'utf8');
const origin = 'http://league-save.test';
/* Same resolver as scripts/render-check.mjs: the pre-installed Chromium build
   number will not match whatever playwright version npm resolved, and a second
   download is blocked in this environment. */
function resolveChromium() {
  const override = String(process.env.FSN_CHROMIUM_PATH || '').trim();
  if (override) return override;
  const dir = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers');
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((name) => name.startsWith('chromium'))
    .sort()
    .reverse()
    .flatMap((name) => [join(dir, name, 'chrome-linux', 'chrome'), join(dir, name, 'chrome-linux', 'headless_shell')])
    .find((file) => existsSync(file)) || null;
}

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[league-save-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  process.exit(1);
}
const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  const posts = [];
  const errors = [];
  let serverVersion = CURRENT;

  await page.addInitScript(({ league }) => {
    localStorage.setItem('hasCompletedOnboarding', 'true');
    localStorage.setItem('fsn.espn.s2.v1', 'fixture-s2');
    localStorage.setItem('fsn.espn.swid.v1', '{11111111-2222-3333-4444-555555555555}');
    // The stale mirror this bug was reported against: a locally minted marker
    // for a row the server has since moved on from.
    localStorage.setItem('fsn.league.storage.v2:' + league + ':2026', JSON.stringify({
      league_id: league, season_year: 2026, has_cookies: true,
      updated_at: '2026-09-01T00:00:00.000Z', local_fallback: true, history_json: { yearsData: [] },
    }));
  }, { league: LEAGUE });

  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /\[(FSN|NewsDesk|Standings|Matchups|League Storage|League Share)/.test(msg.text())) errors.push(msg.text());
  });

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/league') {
      if (route.request().method() === 'POST') {
        let body = {};
        try { body = JSON.parse(route.request().postData() || '{}'); } catch { body = {}; }
        posts.push(body);
        /* The server this bug was filed against: any save whose marker is not
           the live version is refused. Only force:true gets through, which is
           exactly the behaviour api/league.js now implements. */
        if (body.force !== true && String(body.expected_updated_at || '') !== serverVersion) {
          return json({ error: 'The shared league archive changed after this browser loaded it.', code: 'VERSION_CONFLICT', current_updated_at: serverVersion }, 409);
        }
        serverVersion = '2026-09-22T09:00:00.000Z';
        return json({ record: { league_id: LEAGUE, season_year: 2026, has_cookies: true, share_token: 'b'.repeat(43), updated_at: serverVersion, history_json: body.history_json } });
      }
      return json({ error: 'No stored league record exists yet.' }, 404);
    }
    if (url.pathname.startsWith('/api/')) return json({ configured: false, articles: [], transactions: [] });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    try {
      return route.fulfill({ body: readFileSync(join(root, url.pathname.slice(1))), contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'image/svg+xml' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });

  await page.goto(origin + '/?goto=setup', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__fsnRender === 'function');
  await page.evaluate((league) => {
    document.getElementById('leagueIdInput').value = league;
    document.getElementById('seasonYear').value = '2026';
    window._franchiseYearsData = [];
  }, LEAGUE);

  await page.locator('#cloudSyncBtn').click();
  await page.waitForFunction(() => /League data saved/.test(document.getElementById('cloudSyncStatusText').textContent || ''), null, { timeout: 20000 });

  assert.equal(posts.length, 1, 'the forced save must succeed on the first request, with no conflict round-trip');
  assert.equal(posts[0].force, true, 'the Save button must send force:true');
  assert.equal(posts[0].league_id, LEAGUE);
  console.log('ok    SAVE LEAGUE DATA NOW sends force:true and succeeds against a stale marker');

  const cached = await page.evaluate((league) => JSON.parse(localStorage.getItem('fsn.league.storage.v2:' + league + ':2026') || 'null'), LEAGUE);
  assert.equal(cached && cached.updated_at, '2026-09-22T09:00:00.000Z', 'the localStorage mirror must adopt the returned updated_at');
  console.log('ok    the localStorage mirror adopts the updated_at the server returned');

  // The second press is the real regression test: it must not conflict either.
  await page.locator('#cloudSyncBtn').click();
  await page.waitForFunction(() => document.getElementById('cloudSyncBtn').disabled === false, null, { timeout: 20000 });
  assert.equal(posts.length, 2);
  assert.equal(posts[1].expected_updated_at, '2026-09-22T09:00:00.000Z', 'the next save must assert the version the server just wrote');
  const status = await page.evaluate(() => document.getElementById('cloudSyncStatusText').textContent || '');
  assert.ok(/League data saved/.test(status), 'the second explicit save must also succeed: ' + status);
  console.log('ok    a second press carries the new version forward and succeeds');

  assert.deepEqual(errors, [], 'no page or [FSN*] console errors');
  console.log('ok    zero page errors and zero [FSN*] console errors');
  await page.close();

  /* ---------- 3. what an invite link says when the host's session is unreadable ----------
     The banner used to read "Token lookup failed in database … Server code:
     COOKIES_UNDECRYPTABLE. Detail: … (tried 3 candidate keys)" — this
     deployment's key configuration, printed at a league-mate whose only
     available action is to ask their commissioner for a new link. */
  const invitePage = await browser.newPage({ serviceWorkers: 'block' });
  const inviteLogs = [];
  const inviteErrors = [];
  await invitePage.addInitScript(() => localStorage.setItem('hasCompletedOnboarding', 'true'));
  invitePage.on('pageerror', (err) => inviteErrors.push(String(err)));
  invitePage.on('console', (msg) => {
    inviteLogs.push(msg.text());
    if (msg.type() === 'error' && /\[(FSN|NewsDesk|Standings|Matchups|League Storage)/.test(msg.text())) {
      inviteErrors.push(msg.text());
    }
  });
  // Exactly the body api/espn.js answers with for this verdict.
  const relayBody = {
    error: 'This invite link has expired or requires the league host to re-authenticate.',
    code: 'COOKIES_UNDECRYPTABLE',
    league_id: LEAGUE,
    detail: 'This invite link has expired or requires the league host to re-authenticate.',
    stage: 'supabase-lookup',
    lookup_status: 'none',
    auth: 'share-token',
  };
  await invitePage.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/espn') return json(relayBody, 400);
    if (url.pathname === '/api/league') return json({ error: 'Invite access refused by fixture', code: 'SHARE_TOKEN_REQUIRED' }, 401);
    if (url.pathname.startsWith('/api/')) return json({ configured: false, articles: [], transactions: [] });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    try {
      return route.fulfill({ body: readFileSync(join(root, url.pathname.slice(1))), contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'image/svg+xml' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await invitePage.goto(origin + '/?goto=setup', { waitUntil: 'load' });
  await invitePage.waitForFunction(() => typeof window.__fsnRender === 'function');
  await invitePage.evaluate(() => { document.getElementById('privateLeagueAuthModal').dataset.open = 'true'; });
  await invitePage.locator('#privateLeagueAuthInviteInput').evaluate((input, value) => {
    // Model paste -> value insertion -> input, as the browser emits it.
    input.dispatchEvent(new Event('paste', { bubbles: true }));
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, 'id=' + LEAGUE + '&token=' + 'a'.repeat(43));
  await invitePage.waitForFunction(
    () => /Supabase Lookup Stage/.test(document.getElementById('privateLeagueAuthInviteStatus').textContent || ''),
    null, { timeout: 20000 });

  const banner = await invitePage.evaluate(() => document.getElementById('privateLeagueAuthInviteStatus').textContent || '');
  assert.ok(banner.includes('This invite link has expired or requires the league host to re-authenticate.'),
    'the banner must carry the clean sentence: ' + banner);
  for (const leak of ['Server code', 'candidate key', 'COOKIES_UNDECRYPTABLE', 'LEAGUE_COOKIE_ENCRYPTION_KEY',
    'A256GCM', 'espn_s2', 'SWID']) {
    assert.ok(!banner.includes(leak), 'the banner must not expose "' + leak + '": ' + banner);
  }
  console.log('ok    an unreadable host session shows one clean sentence, with no server internals');

  assert.ok(inviteLogs.some((line) => line.includes('[Private League Auth][Supabase Lookup Stage]') &&
    line.includes('server code COOKIES_UNDECRYPTABLE')),
    'the server code must still reach the console for a tester');
  console.log('ok    the server code and relay detail still reach the console');

  assert.deepEqual(inviteErrors.filter((line) => !/\[Private League Auth\]/.test(line)), [],
    'no page errors beyond the expected invite refusal');
  await invitePage.close();
} finally {
  await browser.close();
}

console.log('\n[league-save-check] clean');
