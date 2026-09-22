#!/usr/bin/env node
/* ============================================================================
   FSN — SEASON SCOPE CHECK

   `node scripts/season-scope-check.mjs`

   The bug this exists to keep fixed: changing the year in the header dropdown
   could leave the reader's league entirely. The season lookup matched rows by
   YEAR ALONE against an in-memory archive that carries no league identity, and
   /api/league answered a request for a season it could not parse with whatever
   season that league had most recently stored.

   Two halves, both against the real code:

     1. api/league.js behind a stub PostgREST, asserting the outgoing query for
        every read carries league_id (and season_year when one was asked for),
        that a season with no row is a 404 the browser can recognise, and that
        no other league's row can be served.
     2. index.html in Chromium: a foreign archive is refused by the season
        picker, the on-demand ESPN read for a past season is scoped and
        credentialed, a payload for another league is refused, and a season the
        league has not synced paints "No 2025 data synced" — with the league
        still named — rather than another league's board.
============================================================================ */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const LEAGUE_A = '1111111';
const LEAGUE_B = '2222222';
const TOKEN_A = 'a'.repeat(43);

/* ---------- 1. /api/league over a stub PostgREST ---------- */

// Rows for TWO leagues, so an unscoped query would visibly return the wrong
// one rather than quietly passing.
const TABLE = [
  { league_id: LEAGUE_A, season_year: 2026, history_json: { yearsData: [] }, cookies: null, share_token: TOKEN_A, updated_at: '2026-09-20T00:00:00.000Z' },
  { league_id: LEAGUE_A, season_year: 2024, history_json: { yearsData: [] }, cookies: null, share_token: TOKEN_A, updated_at: '2024-09-20T00:00:00.000Z' },
  { league_id: LEAGUE_B, season_year: 2025, history_json: { yearsData: [] }, cookies: null, share_token: 'b'.repeat(43), updated_at: '2025-09-20T00:00:00.000Z' },
];

const queries = [];

function applyFilter(rows, key, expr) {
  const [op, value] = String(expr).split(/\.(.+)/);
  if (op === 'eq') return rows.filter((row) => String(row[key]) === String(value));
  if (op === 'not') return rows.filter((row) => row[key] != null);
  if (op === 'is') return rows.filter((row) => (value === 'null' ? row[key] == null : row[key] != null));
  return rows;
}

const db = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const params = url.searchParams;
  queries.push({ path: url.pathname, query: url.search, filters: Object.fromEntries(params.entries()) });

  let rows = TABLE.slice();
  for (const [key, expr] of params.entries()) {
    if (key === 'select' || key === 'order' || key === 'limit' || key === 'offset') continue;
    rows = applyFilter(rows, key, expr);
  }
  const order = params.get('order') || '';
  if (order.startsWith('season_year')) {
    rows.sort((a, b) => (order.includes('desc') ? b.season_year - a.season_year : a.season_year - b.season_year));
  }
  const limit = parseInt(params.get('limit') || '0', 10);
  if (limit > 0) rows = rows.slice(0, limit);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(rows));
});
await new Promise((resolve) => db.listen(0, '127.0.0.1', resolve));

process.env.SUPABASE_URL = 'http://127.0.0.1:' + db.address().port;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
const handler = require(join(root, 'api/league.js'));

function fakeRes() {
  const out = { statusCode: 0, body: null, headers: {} };
  return {
    out,
    setHeader(name, value) { out.headers[name] = value; },
    status(code) { out.statusCode = code; return this; },
    json(body) { out.body = body; return this; },
    end() { return this; },
  };
}

async function get(query, headers) {
  const res = fakeRes();
  await handler({ method: 'GET', query, headers: headers || {} }, res);
  return res.out;
}

{
  queries.length = 0;
  const out = await get({ league_id: LEAGUE_A, season_year: '2024' }, { 'x-league-token': TOKEN_A });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.body.record.league_id, LEAGUE_A);
  assert.equal(out.body.record.season_year, 2024);
  const rowRead = queries.find((q) => (q.filters.select || '').includes('history_json'));
  assert.equal(rowRead.filters.league_id, 'eq.' + LEAGUE_A, 'the row read must filter on league_id');
  assert.equal(rowRead.filters.season_year, 'eq.2024', 'the row read must filter on season_year');
  console.log('ok    a season read filters on BOTH league_id and season_year');
}
{
  queries.length = 0;
  // League A has no 2025 row; league B does. An unscoped or year-only query
  // would hand back league B — the exact bug.
  const out = await get({ league_id: LEAGUE_A, season_year: '2025' }, { 'x-league-token': TOKEN_A });
  assert.equal(out.statusCode, 404);
  assert.equal(out.body.code, 'SEASON_NOT_STORED');
  assert.equal(out.body.league_id, LEAGUE_A);
  assert.equal(out.body.season_year, 2025);
  assert.ok(!JSON.stringify(out.body).includes(LEAGUE_B), 'no other league may appear in the answer');
  assert.deepEqual(out.body.available_seasons, [2026, 2024], 'an authorized caller learns this league’s own seasons');
  console.log('ok    a missing season is a scoped 404, never another league’s row');
}
{
  const out = await get({ league_id: LEAGUE_A, season_year: '2025' }, {});
  assert.equal(out.statusCode, 404);
  assert.equal(out.body.code, 'SEASON_NOT_STORED');
  assert.equal(out.body.available_seasons, undefined, 'an unauthorized caller gets no season listing');
  console.log('ok    the 404 lists seasons only for a caller holding the invite token');
}
{
  queries.length = 0;
  const out = await get({ league_id: LEAGUE_A, season_year: '1899' }, { 'x-league-token': TOKEN_A });
  assert.equal(out.statusCode, 400);
  assert.equal(out.body.code, 'INVALID_SEASON');
  assert.equal(queries.length, 0, 'an unparseable season must not reach the database at all');
  console.log('ok    an invalid explicit season is refused, not silently widened to the latest');
}
{
  queries.length = 0;
  const out = await get({ league_id: LEAGUE_A }, { 'x-league-token': TOKEN_A });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.record.season_year, 2026, 'no season asked for means this league’s newest');
  const rowRead = queries.find((q) => (q.filters.select || '').includes('history_json'));
  assert.equal(rowRead.filters.league_id, 'eq.' + LEAGUE_A);
  console.log('ok    the latest-season read is still bounded to the one league');
}
assert.ok(queries.every((q) => q.filters.league_id === 'eq.' + LEAGUE_A),
  'every query this handler issued was scoped to the requested league');
console.log('ok    no query in any path was issued without a league_id filter');
db.close();

/* ---------- 2. the header dropdown ---------- */

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
  console.error('[season-scope-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  process.exit(1);
}

const html = readFileSync(join(root, 'index.html'), 'utf8');
// Reuse the repository's structurally real league fixture.
const renderCheck = readFileSync(join(root, 'scripts/render-check.mjs'), 'utf8');
const fixtureSource = renderCheck.slice(renderCheck.indexOf('function syntheticLeague()'), renderCheck.indexOf('/* A real VAPID'));
const makeFixture = Function(fixtureSource + '; return syntheticLeague;')();

function leagueFixture(id, season, nameSuffix) {
  const data = makeFixture();
  data.id = Number(id);
  data.seasonId = season;
  data.settings = Object.assign({}, data.settings, { name: 'LEAGUE ' + nameSuffix });
  data.teams = data.teams.map((team, idx) => Object.assign({}, team, {
    name: nameSuffix + ' TEAM ' + (idx + 1),
    location: nameSuffix, nickname: 'TEAM ' + (idx + 1),
  }));
  return data;
}

/* Drive the REAL control the reader uses: the season <select> the week
   scrubber renders. Nothing here reaches into the UI layer's closure — a test
   that called switchSeasonYear() directly would not prove the dropdown is
   wired to it. */
async function selectSeason(page, year) {
  const select = page.locator('#homeWeekScrubber select[data-season-select]');
  await select.waitFor({ state: 'attached', timeout: 20000 });
  await select.selectOption(year);
}

/* The first live payload opens the modal team-profile chooser, which
   intercepts every tap until it is answered. Answer it the way a reader with
   no team would, so the season walk exercises the real app. */
async function dismissProfilePicker(page) {
  if (await page.getAttribute('#profilePicker', 'data-open') === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(300);
  }
}

const origin = 'http://season-scope.test';
const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  const espnReads = [];
  const errors = [];
  let espnAnswer = { status: 404, body: { error: 'no such season' } };

  await page.addInitScript(() => {
    localStorage.setItem('hasCompletedOnboarding', 'true');
    localStorage.setItem('fsn.espn.s2.v1', 'fixture-s2');
    localStorage.setItem('fsn.espn.swid.v1', '{11111111-2222-3333-4444-555555555555}');
  });
  /* Two console errors are DELIBERATE in this run and are themselves part of
     what is being asserted: the relay returning 404 for a season this league
     does not have, and the payload-identity refusal when ESPN answers with
     another league. Everything else tagged with a subsystem is a failure. */
  const expected = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() !== 'error') return;
    if (/^\[FSN\] ESPN relay rejected .*HTTP 404/.test(text)) { expected.push('relay-404'); return; }
    if (/^\[Season\] The \d{4} read for league \d+ failed/.test(text) && /HTTP 404/.test(text)) { expected.push('season-404'); return; }
    if (/SEASON_PAYLOAD_LEAGUE_MISMATCH/.test(text)) { expected.push('league-mismatch'); return; }
    if (/\[(FSN|NewsDesk|Standings|Matchups|League Storage|Season|FSNScope)/.test(text)) errors.push(text);
  });

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/espn') {
      const target = url.searchParams.get('url') || '';
      espnReads.push({ target, headers: route.request().headers() });
      return json(espnAnswer.body, espnAnswer.status);
    }
    if (url.pathname === '/api/league') {
      /* Answer the cloud save the guest-profile choice kicks off with a real
         record shape, so its version marker lands and the run is not polluted
         by an unrelated (and correct) complaint about a missing updated_at. */
      if (route.request().method() === 'POST') {
        let body = {};
        try { body = JSON.parse(route.request().postData() || '{}'); } catch { body = {}; }
        return json({ record: {
          league_id: String(body.league_id || ''), season_year: Number(body.season_year) || 2026,
          has_cookies: true, share_token: 'c'.repeat(43),
          updated_at: '2026-09-21T00:00:00.000Z', history_json: body.history_json || {},
        } });
      }
      return json({ error: 'No stored league record exists yet.', code: 'LEAGUE_NOT_STORED' }, 404);
    }
    if (url.pathname.startsWith('/api/')) return json({ configured: false, articles: [], transactions: [] });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    try {
      return route.fulfill({ body: readFileSync(join(root, url.pathname.slice(1))), contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'image/svg+xml' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });

  await page.goto(origin + '/?goto=home', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__fsnRender === 'function');

  // League B's 2025 archive lands while league B is the league on screen…
  await page.evaluate(({ leagueB, dataB }) => {
    document.getElementById('leagueIdInput').value = leagueB;
    window._franchiseYearsData = [{ year: 2025, leagueData: dataB }];
  }, { leagueB: LEAGUE_B, dataB: leagueFixture(LEAGUE_B, 2025, 'BRAVO') });

  // …and then the reader is on league A, live 2026.
  await page.evaluate(({ leagueA, dataA }) => {
    document.getElementById('leagueIdInput').value = leagueA;
    document.getElementById('seasonYear').value = '2026';
    window.LeagueData.setEspnData(dataA);
    window.LeagueData.setMeta('leagueId', leagueA);
    window.__fsnRender();
  }, { leagueA: LEAGUE_A, dataA: leagueFixture(LEAGUE_A, 2026, 'ALPHA') });

  await dismissProfilePicker(page);

  const scoped = await page.evaluate(() => ({
    stamped: window._franchiseArchiveScope,
    rows: window.scopedArchiveRows().length,
    raw: (window._franchiseYearsData || []).length,
  }));
  assert.equal(scoped.stamped, 'espn:' + LEAGUE_B, 'the archive is stamped with the league it was built for');
  assert.equal(scoped.raw, 1, 'the rows are still in memory…');
  assert.equal(scoped.rows, 0, '…but unreadable while league A is on screen');
  console.log('ok    an archive built for another league is refused by the season lookup');

  // Selecting 2025 from the real dropdown must go to ESPN for THIS league.
  espnReads.length = 0;
  await selectSeason(page, '2025');
  await page.waitForFunction(() => document.getElementById('homeSeasonGap') &&
    !document.getElementById('homeSeasonGap').classList.contains('hidden'), null, { timeout: 20000 });

  assert.equal(espnReads.length, 1, 'exactly one on-demand read');
  assert.ok(espnReads[0].target.includes('/seasons/2025/'), 'the read asks for 2025: ' + espnReads[0].target);
  assert.ok(espnReads[0].target.includes('/leagues/' + LEAGUE_A), 'the read asks for league A: ' + espnReads[0].target);
  assert.ok(!espnReads[0].target.includes(LEAGUE_B), 'the read must never name another league');
  assert.equal(espnReads[0].headers['x-espn-s2'], 'fixture-s2', 'the historical read carries the stored host credentials');
  assert.equal(espnReads[0].headers['x-espn-swid'], '{11111111-2222-3333-4444-555555555555}');
  console.log('ok    a missing season is fetched on demand for THIS league id, with stored credentials');

  const gap = await page.evaluate(() => ({
    text: document.getElementById('homeSeasonGapText').textContent,
    title: document.getElementById('homeSeasonGapTitle').textContent,
    league: document.getElementById('homeLeagueName').textContent,
    noData: document.getElementById('homeNoData').classList.contains('hidden'),
    conn: document.getElementById('connStatus').textContent,
    seasonInput: document.getElementById('seasonYear').value,
    leagueInput: document.getElementById('leagueIdInput').value,
  }));
  assert.match(gap.text, /No 2025 data synced/, gap.text);
  assert.match(gap.title, /2025 NOT SYNCED/);
  assert.equal(gap.noData, true, 'the disconnected panel must stay hidden — the league IS connected');
  assert.match(gap.conn, /NOT SYNCED/);
  assert.equal(gap.leagueInput, LEAGUE_A, 'the reader is still inside league A');
  assert.equal(gap.seasonInput, '2025');
  assert.ok(!gap.league.includes('BRAVO'), 'league B must not be named anywhere: ' + gap.league);
  console.log('ok    the clean state reads "No 2025 data synced for this league" and keeps the league');

  await page.click('#tabBar .tab-btn[data-tab="matchups"]');
  await page.click('#tabBar .tab-btn[data-tab="analytics"]');
  await page.click('#tabBar .tab-btn[data-tab="home"]');
  const boards = await page.evaluate(() => ({
    matchups: document.getElementById('matchupList').textContent,
    analytics: document.getElementById('analyticsBody').textContent,
  }));
  assert.match(boards.matchups, /2025 NOT SYNCED/);
  assert.ok(!/BRAVO/.test(boards.matchups), 'no other league’s teams on the matchup board');
  assert.match(boards.analytics, /2025 NOT SYNCED/);
  console.log('ok    the matchup and analytics boards show the same scoped empty state');

  // ESPN answering with a DIFFERENT league's payload is refused outright.
  espnAnswer = { status: 200, body: leagueFixture(LEAGUE_B, 2023, 'BRAVO') };
  espnReads.length = 0;
  await selectSeason(page, '2023');
  await page.waitForFunction(() => {
    const gap = document.getElementById('homeSeasonGap');
    return gap && !gap.classList.contains('hidden') && /2023/.test(document.getElementById('homeSeasonGapTitle').textContent || '');
  }, null, { timeout: 20000 });
  const afterMismatch = await page.evaluate(() => ({
    teams: (window.LeagueData.espnData && window.LeagueData.espnData.teams || []).length,
    name: document.getElementById('homeLeagueName').textContent,
    archive: window.scopedArchiveRows().map((row) => row.year),
  }));
  assert.equal(afterMismatch.teams, 0, 'a payload for another league must never be applied');
  assert.ok(!afterMismatch.name.includes('BRAVO'));
  assert.ok(!afterMismatch.archive.includes(2023), 'and must never enter this league’s archive');
  console.log('ok    an ESPN payload naming a different league is refused, not rendered');

  // The happy path still works: league A's own 2024 season loads and is kept.
  espnAnswer = { status: 200, body: leagueFixture(LEAGUE_A, 2024, 'ALPHA') };
  await selectSeason(page, '2024');
  await page.waitForFunction(() => {
    const gap = document.getElementById('homeSeasonGap');
    return gap && gap.classList.contains('hidden') && document.getElementById('seasonYear').value === '2024';
  }, null, { timeout: 20000 });
  const loaded = await page.evaluate(() => ({
    season: window.LeagueData.espnData && (window.LeagueData.espnData.seasonId || window.LeagueData.espnData.season),
    league: String(window.LeagueData.espnData && window.LeagueData.espnData.id || ''),
    archive: window.scopedArchiveRows().map((row) => row.year),
    stamped: window._franchiseArchiveScope,
  }));
  assert.equal(loaded.season, 2024);
  assert.equal(loaded.league, LEAGUE_A);
  assert.ok(loaded.archive.includes(2024), 'the fetched season joins THIS league’s archive');
  assert.equal(loaded.stamped, 'espn:' + LEAGUE_A, 'and the archive is now stamped for league A');
  console.log('ok    the league’s own past season still loads and is cached under it');

  /* ---- a non-ESPN league is never asked about by ESPN league id ----
     A Sleeper season lives under its own previous_league_id, so sending this
     league's id to the ESPN season route would be asking a different platform
     about a number that means something else there. */
  await page.click('#tabBar .tab-btn[data-tab="setup"]');
  await page.click('#providerSleeper');
  await page.evaluate(({ sleeperId, live }) => {
    document.getElementById('leagueIdInput').value = sleeperId;
    document.getElementById('seasonYear').value = '2026';
    window._franchiseYearsData = [{ year: 2026, leagueData: live }];
    window.LeagueData.setEspnData(live);
    window.__fsnRender();
  }, { sleeperId: '9099099', live: leagueFixture('9099099', 2026, 'SLEEP') });
  await dismissProfilePicker(page);
  await page.click('#tabBar .tab-btn[data-tab="home"]');

  espnReads.length = 0;
  await selectSeason(page, '2026');
  const sleeperCurrent = await page.evaluate(() => ({
    gapHidden: document.getElementById('homeSeasonGap').classList.contains('hidden'),
    teams: (window.LeagueData.espnData && window.LeagueData.espnData.teams || []).length,
  }));
  assert.equal(sleeperCurrent.gapHidden, true, 'a provider season already in its own archive is not "unsynced"');
  assert.ok(sleeperCurrent.teams > 0, 'and it stays on screen');
  assert.equal(espnReads.length, 0, 'no ESPN read may go out for a Sleeper league');
  console.log('ok    a Sleeper league keeps its own archived season without touching ESPN');

  /* With no archive rows the picker offers the calendar range, which is how a
     reader reaches a season their Sleeper league has never synced. */
  await page.evaluate(() => { window._franchiseYearsData = []; window.__fsnRender(); });
  await selectSeason(page, '2021');
  await page.waitForFunction(() => {
    const gap = document.getElementById('homeSeasonGap');
    return gap && !gap.classList.contains('hidden') && /2021/.test(document.getElementById('homeSeasonGapTitle').textContent || '');
  }, null, { timeout: 20000 });
  assert.equal(espnReads.length, 0, 'a Sleeper league id must never be sent to the ESPN season route');
  const sleeperGap = await page.evaluate(() => document.getElementById('homeSeasonGapText').textContent);
  assert.match(sleeperGap, /No 2021 data synced/);
  console.log('ok    a Sleeper season with no archive shows the clean state, with no cross-platform read');

  assert.deepEqual(errors, [], 'no unexpected page or [FSN*] console errors');
  assert.ok(expected.includes('relay-404') && expected.includes('season-404'),
    'the refused season read is logged by both the relay and the season switch, not swallowed');
  assert.ok(expected.includes('league-mismatch'), 'the cross-league payload refusal is logged, not swallowed');
  console.log('ok    both refusals are logged loudly and nothing else errored');
  await page.close();
} finally {
  await browser.close();
}

console.log('\n[season-scope-check] clean');
