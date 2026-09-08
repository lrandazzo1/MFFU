#!/usr/bin/env node
/* ============================================================================
   FSN — UNIVERSAL LINK / DEEP LINK CHECK

   `node scripts/deeplink-check.mjs`

   index.html has no build step and no test suite, so per CLAUDE.md every
   change to it is verified by loading the real file in Chromium and driving
   it. This is the deep-link half of that: it proves that the link a share card
   hands out is a link this app can open again.

   It asserts:
     - FSNDeepLink parses and builds the same grammar (round-trip), and refuses
       a foreign host, a malformed article id and an out-of-range week
     - a share card's copied brief carries a link naming the story it is about
     - the native arrival — @capacitor/app's appUrlOpen, the ONLY route into
       the packaged binary, which has no address bar — opens that article
     - a franchise dossier link opens the dossier
     - a link about a DIFFERENT league opens nothing and says so
     - the dossier's copy-link button mints a link this app can parse
     - zero uncaught page errors, zero [FSN*] console errors

   The Capacitor bridge is stubbed the way the real one behaves: a Plugins.App
   object with addListener/getLaunchUrl, and isNativePlatform() false so the
   page keeps addressing links at this harness's own origin rather than at
   production.
============================================================================ */

import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/* The repo root plus a stub for the one API route boot calls. Same shape as
   render-check.mjs: an unprovisioned push deployment, which is the branch the
   Setup card is written to render without throwing. */
function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/notifications-register') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configured: false, apns: false, web: false, groups: [] }));
        return;
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = join(root, rel.replace(/^\/+/, ''));
      if (!file.startsWith(root) || !existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* Two scored matchups across four teams — enough for the wire to have stories
   on it and for the Record Book to have a franchise to open. */
function syntheticLeague() {
  const team = (id, abbrev, name, wins, losses, pf, pa) => ({
    id,
    abbrev,
    name,
    location: name,
    nickname: '',
    owners: ['{OWNER-' + id + '}'],
    primaryOwner: '{OWNER-' + id + '}',
    playoffSeed: id,
    rankCalculatedFinal: id,
    points: pf,
    record: { overall: { wins, losses, ties: 0, pointsFor: pf, pointsAgainst: pa } },
  });

  const matchup = (id, homeId, awayId, homeScore, awayScore, period) => ({
    id,
    matchupPeriodId: period,
    playoffTierType: 'NONE',
    winner: homeScore > awayScore ? 'HOME' : 'AWAY',
    home: { teamId: homeId, totalPoints: homeScore, pointsByScoringPeriod: { [period]: homeScore } },
    away: { teamId: awayId, totalPoints: awayScore, pointsByScoringPeriod: { [period]: awayScore } },
  });

  return {
    id: 999999,
    seasonId: 2026,
    scoringPeriodId: 2,
    status: { currentMatchupPeriod: 2, latestScoringPeriod: 2, finalScoringPeriod: 17, isActive: true },
    settings: {
      name: 'Deep Link Test League',
      size: 4,
      scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 2 },
    },
    teams: [
      team(1, 'AAA', 'Alpha', 2, 0, 240.5, 190.2),
      team(2, 'BBB', 'Bravo', 1, 1, 210.1, 205.7),
      team(3, 'CCC', 'Charlie', 1, 1, 198.4, 212.9),
      team(4, 'DDD', 'Delta', 0, 2, 175.6, 215.8),
    ],
    schedule: [
      matchup(1, 1, 2, 128.4, 101.2, 1),
      matchup(2, 3, 4, 96.7, 88.1, 1),
      matchup(3, 1, 3, 112.1, 101.7, 2),
      matchup(4, 2, 4, 109.0, 87.5, 2),
    ],
  };
}

/* The environment pre-installs Chromium under PLAYWRIGHT_BROWSERS_PATH, but its
   build number will not always match whatever playwright version npm resolved,
   and downloading a second copy is blocked. Resolve the binary on disk instead
   of trusting playwright's version-derived path. Same helper as
   render-check.mjs, which is where this pattern is explained at length. */
function resolveChromium() {
  const override = String(process.env.FSN_CHROMIUM_PATH || '').trim();
  if (override) return override;
  const dir = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers');
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith('chromium'))
    .sort()
    .reverse()
    .flatMap((name) => [
      join(dir, name, 'chrome-linux', 'chrome'),
      join(dir, name, 'chrome-linux', 'headless_shell'),
    ]);
  return candidates.find((file) => existsSync(file)) || null;
}

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[deeplink-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') +
    '. Set FSN_CHROMIUM_PATH to one.');
  server.close();
  process.exit(1);
}
console.log('[deeplink-check] chromium: ' + executablePath);

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });

await page.addInitScript(() => {
  try { window.localStorage.setItem('hasCompletedOnboarding', 'true'); } catch (err) { /* private mode */ }

  /* The Capacitor bridge as the packaged binary exposes it. isNativePlatform()
     answers false so FSNDeepLink.base() keeps addressing this harness's own
     origin — the native branch points at production, which no test may reach. */
  window.__fsnAppListeners = {};
  window.__fsnLaunchUrl = null;
  window.Capacitor = {
    isNativePlatform() { return false; },
    Plugins: {
      App: {
        addListener(name, cb) {
          window.__fsnAppListeners[name] = cb;
          return Promise.resolve({ remove() {} });
        },
        getLaunchUrl() { return Promise.resolve(window.__fsnLaunchUrl); },
      },
    },
  };

  /* Capture what the app copies instead of writing to a real clipboard. */
  window.__fsnCopied = [];
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get() {
        return {
          writeText(text) { window.__fsnCopied.push(String(text)); return Promise.resolve(); },
          readText() { return Promise.resolve(''); },
        };
      },
    });
  } catch (err) { /* some builds seal navigator.clipboard; the execCommand fallback still runs */ }
});

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (/\[(FSN|NewsDesk|Standings|Matchups|League Share|Privacy|Yahoo|EditorialScheduleEngine)/.test(text)) {
    consoleErrors.push(text);
  }
});

let failed = false;
const fail = (message) => { failed = true; console.error('  FAIL  ' + message); };
const pass = (message) => console.log('  ok    ' + message);
const section = (title) => console.log('\n' + title);

try {
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  /* ---- 1. The grammar ---------------------------------------------------- */
  section('[1] FSNDeepLink — the link grammar');

  const grammar = await page.evaluate(() => {
    const out = {};
    out.present = !!(window.FSNDeepLink && typeof window.FSNDeepLink.parse === 'function');
    if (!out.present) return out;

    out.built = window.FSNDeepLink.build({
      league: '999999', season: 2026, week: 2, story: 'tl-power-2', ref: 'share-card',
    });
    out.roundTrip = window.FSNDeepLink.parse(out.built);

    out.foreignHost = window.FSNDeepLink.parse('https://not-fsn.example/?story=tl-power-2');
    out.associatedHost = window.FSNDeepLink.parse(
      'https://app.fantasysportsnetwork.app/?story=tl-power-2&owner=%7BOWNER-1%7D'
    );
    out.malformedStory = window.FSNDeepLink.parse('https://app.fantasysportsnetwork.app/?story=' +
      encodeURIComponent('<script>alert(1)</script>'));
    out.sillyWeek = window.FSNDeepLink.parse('https://app.fantasysportsnetwork.app/?week=99&story=tl-power-2');
    out.nothing = window.FSNDeepLink.parse('https://app.fantasysportsnetwork.app/');
    out.hosts = window.FSNDeepLink.HOSTS;
    out.emptyBuild = window.FSNDeepLink.build({});
    return out;
  });

  if (!grammar.present) {
    fail('window.FSNDeepLink is not exposed — the whole feature is missing');
  } else {
    pass('FSNDeepLink is on the global scope (block 1, reachable from every block)');

    if (grammar.built && grammar.built.startsWith(base + '/?')) pass('build() addresses this page’s own origin: ' + grammar.built);
    else fail('build() produced "' + grammar.built + '", which is not a link on this origin');

    const rt = grammar.roundTrip || {};
    if (rt.story === 'tl-power-2') pass('round-trip preserved the article id');
    else fail('round-trip lost the article id (got "' + rt.story + '")');
    if (rt.league === '999999') pass('round-trip preserved the League ID');
    else fail('round-trip lost the League ID (got "' + rt.league + '")');
    if (rt.season === 2026 && rt.week === 2) pass('round-trip preserved season 2026 / week 2');
    else fail('round-trip lost the season or week (got ' + rt.season + ' / ' + rt.week + ')');
    if (rt.ref === 'share-card') pass('round-trip preserved the acquisition ref');
    else fail('round-trip lost the ref (got "' + rt.ref + '")');

    if (grammar.foreignHost === null) pass('a link on a foreign host is refused');
    else fail('a link on not-fsn.example was accepted — the parser trusts any host');

    if (grammar.associatedHost && grammar.associatedHost.owner === '{OWNER-1}') {
      pass('an associated production host is accepted and its owner id survives encoding');
    } else {
      fail('a link on app.fantasysportsnetwork.app did not parse into an owner route');
    }

    if (grammar.malformedStory && grammar.malformedStory.story === '') pass('a markup-shaped article id is dropped');
    else fail('a markup-shaped article id survived parsing: "' + (grammar.malformedStory || {}).story + '"');

    if (grammar.sillyWeek && grammar.sillyWeek.week === 0 && grammar.sillyWeek.story === 'tl-power-2') {
      pass('week 99 is dropped while the rest of the link still parses');
    } else {
      fail('an out-of-range week was not dropped cleanly');
    }

    if (grammar.nothing && !grammar.nothing.story && !grammar.nothing.owner) {
      pass('a bare link with no parameters names no content');
    } else {
      fail('a bare link parsed into content: ' + JSON.stringify(grammar.nothing));
    }
    if (grammar.emptyBuild === '') pass('build() with nothing to say returns no link at all');
    else fail('build() invented a link out of an empty route: "' + grammar.emptyBuild + '"');

    const expectedHosts = ['fantasysportsnetwork.app', 'www.fantasysportsnetwork.app', 'app.fantasysportsnetwork.app'];
    if (JSON.stringify(grammar.hosts) === JSON.stringify(expectedHosts)) {
      pass('the associated hosts are the three the entitlement claims');
    } else {
      fail('FSNDeepLink.HOSTS is ' + JSON.stringify(grammar.hosts) + ', expected ' + JSON.stringify(expectedHosts));
    }
  }

  /* ---- 2. Seed a league so there is something to link to ----------------- */
  section('[2] A league on the wire');

  await page.evaluate((data) => {
    /* The League ID as a connected app holds it: in the Setup field and on the
       store's meta. LeagueData.leagueId() reads both, and a share link names
       the league only when one of them answers. */
    document.getElementById('leagueIdInput').value = '999999';
    window.LeagueData.setMeta('leagueId', '999999');
    window.LeagueData.setEspnData(data);
    /* The minimum a franchise dossier needs: one manager with a season, and the
       raw per-year league payload the resume is recomputed from. */
    window.LeagueData.setLeagueHistory({
      managers: {
        '{OWNER-1}': {
          name: 'Alpha Manager',
          teamNamesByYear: { 2026: 'Alpha' },
          logoByYear: { 2026: '' },
        },
      },
      h2h: {},
      perManagerGameLog: {},
      records: {},
      seasonTotals: {},
      careerTotals: {},
    });
    window._franchiseYearsData = [{ year: 2026, leagueData: data }];
    window.__fsnRender();
  }, syntheticLeague());
  await page.waitForTimeout(900);

  const pickerOpen = await page.getAttribute('#profilePicker', 'data-open');
  if (pickerOpen === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(400);
  }

  await page.click('#tabBar .tab-btn[data-tab="news"]');
  await page.waitForTimeout(700);

  const storyId = await page.evaluate(() => {
    const el = document.querySelector('.screen[data-screen="news"] [data-article]');
    return el ? el.getAttribute('data-article') : '';
  });
  if (storyId) pass('the wire carries a linkable story: ' + storyId);
  else fail('no [data-article] on the News screen — nothing to deep link to');

  /* ---- 3. The share card's brief carries a link to its own story --------- */
  section('[3] The share card link');

  if (storyId) {
    await page.evaluate((id) => { window.__fsnCopied.length = 0; document.querySelector('[data-article="' + id + '"]').click(); }, storyId);
    await page.waitForTimeout(600);

    const readerOpen = await page.getAttribute('#reader', 'data-open');
    if (readerOpen === 'true') pass('tapping the story opened the reader');
    else fail('tapping the story did not open the reader');

    await page.click('#readerCopy');
    await page.waitForTimeout(400);

    const copied = await page.evaluate(() => (window.__fsnCopied || [])[0] || '');
    const linkInBrief = await page.evaluate((text) => {
      const match = String(text).match(/https?:\/\/\S+/);
      if (!match) return null;
      return { url: match[0], route: window.FSNDeepLink.parse(match[0]) };
    }, copied);

    if (!linkInBrief) {
      fail('the copied brief carries no link at all:\n' + JSON.stringify(copied));
    } else if (!linkInBrief.route || !linkInBrief.route.story) {
      fail('the copied brief’s link names no story: ' + linkInBrief.url);
    } else if (linkInBrief.route.story !== storyId) {
      fail('the copied brief links to "' + linkInBrief.route.story + '" but the open story is "' + storyId + '"');
    } else {
      pass('the copied brief links back to this exact story: ' + linkInBrief.url);
      if (linkInBrief.route.league === '999999') pass('the link names the league it is about');
      else fail('the link does not name the league (got "' + linkInBrief.route.league + '")');
      if (!/token=/.test(linkInBrief.url)) pass('the link carries no share token');
      else fail('the link leaked a share token into a message meant for a group chat');
    }

    await page.evaluate(() => {
      const btn = document.getElementById('readerClose');
      if (btn) btn.click();
    });
    await page.waitForTimeout(300);
  }

  /* ---- 4. The native arrival: appUrlOpen --------------------------------- */
  section('[4] iOS hands the app a link (appUrlOpen)');

  const listenerBound = await page.evaluate(() => typeof window.__fsnAppListeners.appUrlOpen === 'function');
  if (listenerBound) pass('the app subscribed to appUrlOpen at boot');
  else fail('nothing subscribed to appUrlOpen — a universal link would open the app on Home');

  if (listenerBound && storyId) {
    await page.evaluate(() => {
      const btn = document.getElementById('readerClose');
      if (btn) btn.click();
      window.__fsnRender();
    });
    await page.click('#tabBar .tab-btn[data-tab="setup"]');
    await page.waitForTimeout(300);

    await page.evaluate((id) => {
      window.__fsnAppListeners.appUrlOpen({
        url: 'https://app.fantasysportsnetwork.app/?id=999999&season=2026&week=2&story=' +
          encodeURIComponent(id) + '&ref=share-card',
      });
    }, storyId);
    await page.waitForTimeout(1200);

    const opened = await page.evaluate(() => ({
      reader: document.getElementById('reader').dataset.open,
      screen: (document.querySelector('.screen[data-active="true"]') || document.createElement('div')).dataset.screen || '',
    }));
    if (opened.reader === 'true') pass('the link opened the reader from a cold Setup screen');
    else fail('the link did not open the reader (reader data-open=' + opened.reader + ')');

    const shownStory = await page.evaluate(() => {
      const body = document.getElementById('readerBody');
      const h = body && body.querySelector('.headline');
      return h ? h.textContent.trim() : '';
    });
    if (shownStory) pass('the reader is showing an article: "' + shownStory.slice(0, 60) + '"');
    else fail('the reader opened with no article in it');

    await page.evaluate(() => { document.getElementById('readerClose').click(); });
    await page.waitForTimeout(300);
  }

  /* ---- 5. A franchise dossier link --------------------------------------- */
  section('[5] A franchise dossier link');

  if (listenerBound) {
    await page.evaluate(() => {
      window.__fsnAppListeners.appUrlOpen({
        url: 'https://app.fantasysportsnetwork.app/?id=999999&owner=' + encodeURIComponent('{OWNER-1}') + '&ref=dossier',
      });
    });
    await page.waitForTimeout(1200);

    const dossierOpen = await page.getAttribute('#franchiseModal', 'data-open');
    if (dossierOpen === 'true') pass('the link opened the franchise dossier');
    else fail('the link did not open the franchise dossier (data-open=' + dossierOpen + ')');

    if (dossierOpen === 'true') {
      await page.evaluate(() => { window.__fsnCopied.length = 0; });
      await page.click('#franchiseLinkBtn');
      await page.waitForTimeout(400);
      const dossierLink = await page.evaluate(() => {
        const copied = (window.__fsnCopied || [])[0] || '';
        return { copied, route: copied ? window.FSNDeepLink.parse(copied) : null };
      });
      if (dossierLink.route && dossierLink.route.owner === '{OWNER-1}') {
        pass('the dossier’s copy-link button minted a link back to the same dossier: ' + dossierLink.copied);
      } else {
        fail('the dossier copy-link button produced "' + dossierLink.copied + '", which does not parse back to this owner');
      }
      await page.evaluate(() => { document.getElementById('franchiseModalClose').click(); });
      await page.waitForTimeout(300);
    }
  }

  /* ---- 6. A link about somebody else's league ---------------------------- */
  section('[6] A link about a different league');

  if (listenerBound && storyId) {
    await page.click('#tabBar .tab-btn[data-tab="setup"]');
    await page.waitForTimeout(300);
    await page.evaluate((id) => {
      window.__fsnAppListeners.appUrlOpen({
        url: 'https://app.fantasysportsnetwork.app/?id=123456&story=' + encodeURIComponent(id),
      });
    }, storyId);
    await page.waitForTimeout(1000);

    const state = await page.evaluate(() => ({
      reader: document.getElementById('reader').dataset.open,
      league: document.getElementById('leagueIdInput').value.trim(),
    }));
    if (state.reader !== 'true') pass('a story from another league did not open in this one');
    else fail('a story id from league 123456 was opened against league ' + state.league);
    if (state.league === '999999') pass('the open league was left alone');
    else fail('the link changed the open league to ' + state.league);
  }

  /* ---- 7. The cold-start native path: getLaunchUrl ----------------------- */
  section('[7] iOS launches the app from a link (getLaunchUrl)');

  /* A link tapped while the app was NOT running does not arrive as an event —
     it is the launch URL, read once at boot. This is the path a share card
     takes for a reader who does not already have the app open, so it is worth
     more than the warm path. Asserted with a route that needs no league data
     (a provider + a tab), because a fresh launch has none. */
  await page.addInitScript(() => {
    window.__fsnLaunchUrl = { url: 'https://www.fantasysportsnetwork.app/?goto=setup&platform=sleeper' };
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1800);

  const launched = await page.evaluate(() => ({
    screen: (document.querySelector('.screen[data-active="true"]') || document.createElement('div')).dataset.screen || '',
    provider: (document.querySelector('.provider-tab.is-active') || document.createElement('div')).dataset.provider || '',
  }));
  if (launched.screen === 'setup') pass('the launch URL landed the app on Setup');
  else fail('the launch URL did not route the launch (active screen is "' + launched.screen + '")');
  if (launched.provider === 'sleeper') pass('the launch URL preselected the Sleeper provider');
  else fail('the launch URL did not preselect the provider (got "' + launched.provider + '")');

  /* ---- 8. Nothing broke -------------------------------------------------- */
  section('[8] Runtime health');

  if (pageErrors.length === 0) pass('zero uncaught page errors');
  else { fail(pageErrors.length + ' uncaught page error(s)'); pageErrors.forEach((e) => console.error('        ' + e.split('\n')[0])); }

  if (consoleErrors.length === 0) pass('zero [FSN*] console errors');
  else { fail(consoleErrors.length + ' tagged console error(s)'); consoleErrors.forEach((e) => console.error('        ' + e)); }
} catch (err) {
  failed = true;
  console.error('\n[deeplink-check] the harness itself threw:');
  console.error(err);
} finally {
  await browser.close();
  server.close();
}

console.log('');
if (failed) {
  console.error('[deeplink-check] FAILED');
  process.exit(1);
}
console.log('[deeplink-check] clean');
