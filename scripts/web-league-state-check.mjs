#!/usr/bin/env node
/* ============================================================================
   FSN — WEB LEAGUE STATE CHECK

   `node scripts/web-league-state-check.mjs`

   On the web the address bar is the only state that survives a hard refresh in
   a browser that keeps no site data — Safari private browsing, an embedded
   webview, a locked-down profile. FSNStore reports that refusal honestly and
   keeps values in memory, but memory does not survive F5: the reader came back
   to an app that had forgotten which league it was showing.

   This asserts the two halves of the fix:

     1. /api/league refuses a request that names no league with
        400 NO_ACTIVE_LEAGUE and no payload of any kind. There is no sample,
        seed or demo league in that route and this is what keeps it that way.
     2. index.html carries the active league (and its platform, never its share
        token) in ?league_id=…, restores it on the next boot, keeps it through a
        season switch, and shows "SELECT OR CONNECT A LEAGUE" — with the
        onboarding link — when there is genuinely no league to show.
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

/* ---------- 1. the API contract ---------- */

// A stub that records every request. Nothing may reach it for a call that
// names no league: the refusal has to happen before any storage read.
const reached = [];
const db = createServer((req, res) => {
  reached.push(req.url);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('[]');
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

async function call(req) {
  const res = fakeRes();
  await handler(Object.assign({ headers: {} }, req), res);
  return res.out;
}

for (const [label, query] of [
  ['no league_id at all', {}],
  ['an empty league_id', { league_id: '' }],
  ['the literal string "undefined"', { league_id: 'undefined' }],
  ['a non-numeric league_id', { league_id: 'smashmouth' }],
]) {
  reached.length = 0;
  const out = await call({ method: 'GET', query });
  assert.equal(out.statusCode, 400, label + ' must be a 400, got ' + out.statusCode);
  assert.equal(out.body.error, 'No active league specified');
  assert.equal(out.body.code, 'NO_ACTIVE_LEAGUE');
  assert.equal(out.body.record, undefined, 'no record may ride along');
  assert.equal(out.body.history_json, undefined, 'no league payload of any kind may ride along');
  assert.equal(reached.length, 0, 'the refusal must happen before any storage read');
  console.log('ok    GET with ' + label + ' → 400 NO_ACTIVE_LEAGUE, no data');
}
{
  reached.length = 0;
  // Vercel hands the function an already-parsed body, which is the shape
  // readBody() takes first.
  const out = await call({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { season_year: 2026, history_json: { yearsData: [] } },
  });
  assert.equal(out.statusCode, 400);
  assert.equal(out.body.error, 'No active league specified');
  assert.equal(out.body.code, 'NO_ACTIVE_LEAGUE');
  assert.equal(reached.length, 0, 'a write naming no league must not reach storage');
  console.log('ok    POST with no league_id → 400 NO_ACTIVE_LEAGUE, nothing written');
}
db.close();

/* ---------- 2. the browser ---------- */

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
  console.error('[web-league-state-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  process.exit(1);
}

const html = readFileSync(join(root, 'index.html'), 'utf8');
const renderCheck = readFileSync(join(root, 'scripts/render-check.mjs'), 'utf8');
const fixtureSource = renderCheck.slice(renderCheck.indexOf('function syntheticLeague()'), renderCheck.indexOf('/* A real VAPID'));
const fixture = Function(fixtureSource + '; return syntheticLeague();')();
const LEAGUE = String(fixture.id);
const TOKEN = 'a'.repeat(43);
const origin = 'http://web-league.test';

/* Storage is blocked, so the app cannot read the "onboarding done" flag and
   plays the first-run intro on every load; the first live payload then opens
   the team-profile chooser. Both are modal. Answer them the way a reader would
   before touching anything underneath. */
async function dismissOverlays(page) {
  const isOpen = (id) => page.evaluate((el) => {
    const node = document.getElementById(el);
    return !!(node && node.dataset.open === 'true');
  }, id);
  for (let pass = 0; pass < 4; pass += 1) {
    // The profile chooser sits on top of the intro, so it answers first —
    // clicking through it is what a reader cannot do either.
    const pickerOpen = await isOpen('profilePicker');
    if (pickerOpen) {
      await page.click('#profileGuest');
      await page.waitForTimeout(250);
    }
    const ftuOpen = await isOpen('ftuModal');
    if (ftuOpen) {
      await page.click('#ftuSkip');
      await page.waitForTimeout(250);
    }
    if (!ftuOpen && !pickerOpen) break;
  }
}

/* Drive the REAL control the reader touches. The app upgrades every <select>
   into a custom bottom sheet (.fsn-dd-trigger + .fsn-dd-opt rows) and hides the
   native element, so a plain selectOption() only works in the window before
   that upgrade runs. Click the sheet when it exists, fall back to the native
   select when it does not. */
async function selectSeason(page, year) {
  const trigger = page.locator('#homeWeekScrubber .fsn-dd-trigger');
  if (await trigger.count()) {
    await trigger.first().click();
    await page.locator('.fsn-dd-sheet .fsn-dd-opt[data-value="' + year + '"]').first().click();
    return;
  }
  const select = page.locator('#homeWeekScrubber select[data-season-select]');
  await select.waitFor({ state: 'attached', timeout: 20000 });
  await select.selectOption(year);
}

const browser = await chromium.launch({ executablePath });

/* Storage is REFUSED for the whole run, which is the condition the URL
   carrier exists for: everything the app remembers has to survive in the
   address bar or not at all. */
async function openPage(options) {
  const opts = options || {};
  const page = await browser.newPage({ serviceWorkers: 'block' });
  const state = { espnReads: [], leagueReads: [], errors: [] };
  await page.addInitScript(() => {
    try { localStorage.setItem('hasCompletedOnboarding', 'true'); } catch (err) { /* about to be blocked */ }
    Storage.prototype.setItem = function () { throw new DOMException('blocked', 'QuotaExceededError'); };
    Storage.prototype.getItem = function () { throw new DOMException('blocked', 'SecurityError'); };
  });
  page.on('pageerror', (err) => state.errors.push(String(err)));
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() !== 'error') return;
    // Storage is blocked on purpose in this run; FSNStore saying so loudly is
    // the behaviour other checks already assert, not a failure here.
    if (/^\[FSNStore\]/.test(text)) return;
    if (/LEAGUE_RECORD_NOT_PERSISTED/.test(text)) return;
    if (opts.expectNoLeague && /NO_ACTIVE_LEAGUE/.test(text)) { state.errors.noLeague = true; return; }
    if (/\[(FSN|NewsDesk|Standings|Matchups|League Storage|Season|FSNScope)/.test(text)) state.errors.push(text);
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/espn') {
      state.espnReads.push({ target: url.searchParams.get('url') || '', headers: route.request().headers() });
      return json(fixture);
    }
    if (url.pathname === '/api/league') {
      state.leagueReads.push(url.href);
      if (opts.refuseLeague) return json({ error: 'No active league specified', code: 'NO_ACTIVE_LEAGUE' }, 400);
      if (route.request().method() === 'POST') {
        return json({ record: { league_id: LEAGUE, season_year: 2026, has_cookies: true, share_token: TOKEN, updated_at: '2026-09-21T00:00:00.000Z', history_json: {} } });
      }
      return json({ record: {
        league_id: LEAGUE, season_year: 2026, has_cookies: true, share_token: TOKEN,
        updated_at: '2026-09-12T00:00:00.000Z',
        history_json: { settings: {}, yearsData: [{ year: 2025, leagueData: Object.assign({}, fixture, { seasonId: 2025 }) }] },
      } });
    }
    if (url.pathname.startsWith('/api/')) return json({ configured: false, articles: [], transactions: [] });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    try {
      return route.fulfill({ body: readFileSync(join(root, url.pathname.slice(1))), contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'image/svg+xml' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  return { page, state };
}

try {
  /* ---- a league opened from an invite link survives a hard refresh ---- */
  const { page, state } = await openPage();
  await page.goto(origin + '/?id=' + LEAGUE + '&token=' + TOKEN, { waitUntil: 'load' });
  await page.waitForFunction(() => /Live ESPN Data|LIVE ESPN DATA/i.test(document.getElementById('connStatus').textContent || ''), null, { timeout: 30000 });
  await page.waitForTimeout(700);
  await dismissOverlays(page);

  const afterConnect = await page.evaluate(() => location.href);
  assert.match(afterConnect, /[?&]league_id=/, 'the active league must ride in the URL: ' + afterConnect);
  assert.match(afterConnect, /[?&]platform=espn/, 'and its platform, so a numeric id is not restored as the wrong provider');
  assert.ok(!afterConnect.includes(TOKEN), 'the share token must NEVER linger in the address bar');
  assert.ok(!/token=/.test(afterConnect), 'no token parameter of any kind may survive');
  console.log('ok    the URL carries league_id + platform after connecting, and never the share token');

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => /LIVE ESPN DATA/i.test(document.getElementById('connStatus').textContent || ''), null, { timeout: 30000 });
  await page.waitForTimeout(700);
  await dismissOverlays(page);
  const afterReload = await page.evaluate(() => ({
    href: location.href,
    league: document.getElementById('leagueIdInput').value,
    teams: (window.LeagueData.espnData && window.LeagueData.espnData.teams || []).length,
    noData: !document.getElementById('homeNoData').classList.contains('hidden'),
  }));
  assert.equal(afterReload.league, LEAGUE, 'a hard refresh with storage blocked must restore the league from the URL');
  assert.ok(afterReload.teams > 0, 'and reconnect its data');
  assert.equal(afterReload.noData, false, 'so the connect panel is not shown for a league that IS selected');
  console.log('ok    a hard refresh with site data blocked restores the league from the URL');

  /* ---- switching seasons keeps the league everywhere ---- */
  state.espnReads.length = 0;
  await selectSeason(page, '2025');
  await page.waitForFunction(() => document.getElementById('seasonYear').value === '2025', null, { timeout: 20000 });
  const afterSwitch = await page.evaluate(() => ({
    href: location.href,
    league: document.getElementById('leagueIdInput').value,
  }));
  assert.equal(afterSwitch.league, LEAGUE, 'the season switch must not drop the league');
  assert.match(afterSwitch.href, new RegExp('league_id=' + LEAGUE), 'and must not drop it from the URL: ' + afterSwitch.href);
  for (const read of state.espnReads) {
    assert.ok(read.target.includes('/leagues/' + LEAGUE) || read.target.includes('/' + LEAGUE + '?'),
      'every season read names the active league: ' + read.target);
  }
  console.log('ok    switching seasons keeps league_id in the URL and in every read');

  // …and the restored URL still survives a refresh taken on the past season.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('leagueIdInput').value.length > 0, null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => document.getElementById('leagueIdInput').value), LEAGUE);
  console.log('ok    a refresh taken while viewing a past season still restores the league');
  assert.deepEqual(state.errors, [], 'no unexpected page or [FSN*] console errors');
  await page.close();

  /* ---- no league at all: select or connect, never sample data ---- */
  const cold = await openPage();
  await cold.page.goto(origin + '/', { waitUntil: 'load' });
  await cold.page.waitForFunction(() => typeof window.__fsnRender === 'function');
  await cold.page.waitForTimeout(800);
  await dismissOverlays(cold.page);
  /* A boot with nothing to restore lands on Setup — the connect flow — which
     is where a reader with no league belongs. Home is what they see if they
     navigate there anyway, and that is the panel under test. */
  assert.equal(await cold.page.evaluate(() => {
    const el = document.querySelector('.screen[data-active="true"]');
    return el && el.getAttribute('data-screen');
  }), 'setup', 'a launch with no league to restore opens the connect flow');
  await cold.page.click('#tabBar .tab-btn[data-tab="home"]');
  await cold.page.waitForTimeout(200);
  const empty = await cold.page.evaluate(() => {
    const byId = (id) => document.getElementById(id);
    return {
      title: byId('homeNoDataTitle').textContent,
      text: byId('homeNoDataText').textContent,
      connect: byId('homeNoDataConnect').textContent,
      introHidden: byId('homeNoDataIntro').hidden,
      noDataShown: !byId('homeNoData').classList.contains('hidden'),
      contentHidden: byId('homeContent').classList.contains('hidden'),
      league: byId('leagueIdInput').value,
      teams: (window.LeagueData.espnData && window.LeagueData.espnData.teams || []).length,
    };
  });
  assert.equal(empty.league, '', 'no league is selected in this browser');
  assert.equal(empty.teams, 0, 'and no league data of any kind is rendered');
  assert.match(empty.title, /SELECT OR CONNECT A LEAGUE/);
  assert.equal(empty.noDataShown, true);
  assert.equal(empty.contentHidden, true);
  assert.equal(empty.introHidden, false, 'a reader with no saved leagues is offered the walkthrough');
  assert.equal(cold.state.leagueReads.length, 0, 'no /api/league request goes out without a league');
  console.log('ok    a browser with no league shows SELECT OR CONNECT A LEAGUE and renders no data');

  await cold.page.click('#homeNoDataIntro');
  await cold.page.waitForFunction(() => document.getElementById('ftuModal').dataset.open === 'true', null, { timeout: 10000 });
  console.log('ok    the empty state links into the onboarding walkthrough');

  const boards = await cold.page.evaluate(() => {
    document.querySelector('#tabBar .tab-btn[data-tab="matchups"]').click();
    document.querySelector('#tabBar .tab-btn[data-tab="analytics"]').click();
    return {
      matchups: document.getElementById('matchupList').textContent,
      analytics: document.getElementById('analyticsBody').textContent,
    };
  });
  assert.match(boards.matchups, /SELECT OR CONNECT A LEAGUE/);
  assert.match(boards.analytics, /SELECT OR CONNECT A LEAGUE/);
  console.log('ok    the matchup and analytics boards say the same thing');
  assert.deepEqual(cold.state.errors, [], 'no unexpected page or [FSN*] console errors');
  await cold.page.close();

  /* ---- the server refusing a read is shown, never papered over ---- */
  const refused = await openPage({ refuseLeague: true, expectNoLeague: true });
  await refused.page.goto(origin + '/?league_id=' + LEAGUE + '&platform=espn', { waitUntil: 'load' });
  await refused.page.waitForFunction(() => /No league is selected/i.test(
    document.getElementById('cloudSyncStatusText').textContent || ''), null, { timeout: 30000 });
  const refusedState = await refused.page.evaluate(() => ({
    status: document.getElementById('cloudSyncStatusText').textContent,
    seasons: (window.scopedArchiveRows() || []).length,
  }));
  assert.match(refusedState.status, /Choose a saved league or connect a new one/);
  console.log('ok    a NO_ACTIVE_LEAGUE answer is surfaced, not degraded into cached or sample data');
  await refused.page.close();
} finally {
  await browser.close();
}

console.log('\n[web-league-state-check] clean');
