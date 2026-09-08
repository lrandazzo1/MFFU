#!/usr/bin/env node
/* ============================================================================
   FSN — COLD-BOOT LOADING SCREEN CHECK

   `node scripts/boot-curtain-check.mjs`

   index.html's static markup paints Home's "NO SIGNAL / OPEN SETUP" card,
   because that is the honest state of an app with no league in it. On a cold
   launch it is also briefly WRONG: bootApp() reads the saved League ID out of
   device storage and refetches it, so a returning reader watches the setup
   prompt flash past before their dashboard arrives — the app looks like it
   forgot them.

   The fix is the FSN broadcast bumper (#leagueCurtain), raised from <head>
   before the body is parsed and held until the league has mounted. This check
   is the mechanical proof of it, and it measures what the READER sees rather
   than what the DOM holds: every animation frame from the very first one, it
   asks whether the "NO SIGNAL" card is actually exposed — laid out, visible,
   and not covered by the loading screen — using elementFromPoint at the card's
   own position. A card that is in the DOM behind an opaque curtain is not a
   flash; a card the reader can see for two frames is.

   Three launches, because the bug and its two neighbours are different states:

     A. a browser with a saved league   → the loading screen holds, and lifts
                                          onto the populated dashboard
     B. a browser with no league at all → the loading screen lifts onto SETUP,
                                          not onto the "NO SIGNAL" card
     C. a saved league the relay refuses → the loading screen still lifts (a
                                          failed restore must never strand the
                                          reader behind it), and lands on Home
                                          where the reader's league lives

   In all three: the "NO SIGNAL" card is never exposed before the reveal, the
   curtain always comes down, and nothing throws.
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

const CURRENT_YEAR = 2026;
const LEAGUE = '444444';
/* A real network beat before the live season answers. Without one the restore
   could finish inside the first frame and the check would prove nothing: the
   flash under test only exists because the fetch takes time. */
const RELAY_DELAY_MS = 900;

/* An ESPN-shaped payload whose every visible string carries the League ID, so
   "is the dashboard actually painted" is answerable from the DOM alone. */
function leaguePayload(leagueId, season = CURRENT_YEAR) {
  const tag = 'L' + leagueId;
  const team = (i, wins, losses, pf, pa) => ({
    id: i,
    abbrev: (tag + i).slice(-4).toUpperCase(),
    name: tag + '-Team' + i,
    location: tag + '-Team' + i,
    nickname: '',
    owners: ['{OWNER-' + leagueId + '-' + i + '}'],
    playoffSeed: i,
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
    id: Number(leagueId),
    seasonId: season,
    scoringPeriodId: 2,
    status: { currentMatchupPeriod: 2, latestScoringPeriod: 2, finalScoringPeriod: 17, isActive: true },
    settings: {
      name: tag + ' League',
      size: 4,
      scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 4 },
    },
    members: [1, 2, 3, 4].map((i) => ({
      id: '{OWNER-' + leagueId + '-' + i + '}',
      displayName: tag + '-Manager' + i,
      firstName: tag,
      lastName: 'Manager' + i,
    })),
    teams: [
      team(1, 2, 0, 240.5, 190.2),
      team(2, 1, 1, 210.1, 205.7),
      team(3, 1, 1, 205.4, 210.9),
      team(4, 0, 2, 188.0, 237.2),
    ],
    schedule: [
      matchup(1, 1, 4, 128.4, 92.1, 1),
      matchup(2, 2, 3, 105.6, 101.2, 1),
      matchup(3, 1, 3, 112.1, 104.2, 2),
      matchup(4, 2, 4, 104.5, 95.9, 2),
    ],
  };
}

/* Serve the repo plus a stub /api/espn relay. `mode` is flipped per launch so
   the same server can play a working ESPN and a broken one. */
let relayMode = 'ok';
function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/notifications-register') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ configured: false }));
        return;
      }
      if (url.pathname === '/api/espn') {
        const target = url.searchParams.get('url') || '';
        const season = (target.match(/seasons\/(\d{4})/) || [])[1];
        const league = (target.match(/leagues\/(\d+)/) || [])[1];
        setTimeout(() => {
          if (relayMode === 'down') {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'The ESPN relay is unreachable.' }));
            return;
          }
          if (!league || Number(season) !== CURRENT_YEAR) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'No such season for this league.' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(leaguePayload(league)));
        }, RELAY_DELAY_MS);
        return;
      }
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      const path = join(root, file.replace(/^\/+/, ''));
      if (!path.startsWith(root) || !existsSync(path)) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
      res.end(readFileSync(path));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function resolveChromium() {
  const override = String(process.env.FSN_CHROMIUM_PATH || '').trim();
  if (override) return override;
  const dir = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers');
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((name) => name.startsWith('chromium'))
    .sort()
    .reverse()
    .flatMap((name) => [
      join(dir, name, 'chrome-linux', 'chrome'),
      join(dir, name, 'chrome-linux', 'headless_shell'),
    ])
    .find((file) => existsSync(file)) || null;
}

/* Installed before a line of app script runs. Samples every animation frame
   from the first, so the window this is written to catch — the handful of
   frames between the body painting and the league landing — cannot be missed
   by arriving late. */
function instrument(seed) {
  try {
    const store = window.localStorage;
    store.setItem('hasCompletedOnboarding', 'true');
    if (seed.leagueId) {
      store.setItem('fsn_saved_league_id', seed.leagueId);
      store.setItem('mffu.saved.leagues.v1', JSON.stringify([
        { id: seed.leagueId, provider: 'espn', name: 'L' + seed.leagueId + ' League', lastUsed: 1 },
      ]));
      store.setItem('fsn.setup.v1', JSON.stringify({
        leagueId: seed.leagueId, season: '2026', week: '2', provider: 'espn', statsMode: 'career',
      }));
    }
  } catch (err) { /* private mode — the asserts below will say the seed failed */ }

  const state = {
    frames: 0,
    exposedBeforeDrop: 0,
    exposedAfterDrop: 0,
    firstExposureAt: 0,
    coveredAtFirstFrame: null,
    /* Timings are reported RELATIVE to DOMContentLoaded. index.html is a single
       ~1MB file with a CDN script in front of it, so on a slow machine most of
       the wall clock before the reveal is parse and transfer, not the hold —
       and the hold is what this check is measuring. */
    dclAt: 0,
    dropAt: 0,
    atDrop: null,
  };
  window.__bootProbe = state;
  document.addEventListener('DOMContentLoaded', () => {
    state.dclAt = Math.round(performance.now());
  }, { once: true });

  /* Is the "NO SIGNAL / OPEN SETUP" card actually in front of the reader? Not
     "is it in the DOM" — it always is — but laid out, visible, on screen, and
     the topmost thing at its own coordinates. elementFromPoint is what makes
     the last part true: while the loading screen is up it owns those pixels. */
  function noSignalExposed() {
    const el = document.getElementById('homeNoData');
    if (!el) return false;
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return false;
    if (box.bottom <= 0 || box.top >= (window.innerHeight || 0)) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const x = Math.round(box.left + box.width / 2);
    const y = Math.round(Math.max(0, box.top) + Math.min(box.height, 40) / 2);
    const hit = document.elementFromPoint(x, y);
    return !!(hit && (hit === el || el.contains(hit)));
  }

  function snapshot() {
    const curtain = document.getElementById('leagueCurtain');
    const content = document.getElementById('homeContent');
    const noData = document.getElementById('homeNoData');
    const active = document.querySelector('.screen[data-active="true"]');
    return {
      at: Math.round(performance.now()),
      screen: active ? active.getAttribute('data-screen') : '',
      curtainOpen: !!(curtain && curtain.dataset.open === 'true'),
      preAdopt: document.documentElement.getAttribute('data-fsn-boot') === 'loading',
      contentShown: !!(content && !content.classList.contains('hidden')),
      noDataShown: !!(noData && !noData.classList.contains('hidden')),
      text: String(document.body.innerText || ''),
    };
  }

  const tick = () => {
    state.frames += 1;
    const curtain = document.getElementById('leagueCurtain');
    const up = document.documentElement.getAttribute('data-fsn-boot') === 'loading' ||
      !!(curtain && curtain.dataset.open === 'true');
    if (state.coveredAtFirstFrame === null) state.coveredAtFirstFrame = up;
    if (up) {
      state.dropAt = 0;
    } else if (!state.dropAt) {
      state.dropAt = Math.round(performance.now());
      state.atDrop = snapshot();
    }
    if (noSignalExposed()) {
      if (!state.firstExposureAt) state.firstExposureAt = Math.round(performance.now());
      if (state.dropAt) state.exposedAfterDrop += 1;
      else state.exposedBeforeDrop += 1;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[boot-curtain-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  server.close();
  process.exit(1);
}
console.log('[boot-curtain-check] chromium: ' + executablePath);

let failed = false;
const fail = (message) => { failed = true; console.error('  FAIL  ' + message); };
const pass = (message) => console.log('  ok    ' + message);

const browser = await chromium.launch({ executablePath });

/* One launch = one fresh browser context, because a cold boot is exactly what
   is under test: a shared context would carry the previous launch's storage. */
async function launch(seed) {
  const context = await browser.newContext({ viewport: { width: 414, height: 896 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // The stub relay serves only the current season, so the detached archive
    // walk gets an honest 404 for every completed one and says so.
    if (/ESPN relay rejected .*HTTP 404/.test(text)) return;
    if (seed.relay === 'down' && /\[ESPN live fetch\]/.test(text)) return;
    if (/\[(FSN|FSNBoot|NewsDesk|Standings|Matchups|LeagueSwitch|League Share|Privacy|Yahoo|EditorialScheduleEngine)/.test(text)) {
      consoleErrors.push(text);
    }
  });
  await page.addInitScript(instrument, seed);
  relayMode = seed.relay || 'ok';
  await page.goto(base + '/', { waitUntil: 'load' });
  // Long enough for the relay beat, the reveal and its minimum-visible floor.
  await page.waitForFunction(() => window.__bootProbe && window.__bootProbe.dropAt > 0,
    null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(700);
  const probe = await page.evaluate(() => window.__bootProbe);
  await context.close();
  return { probe, pageErrors, consoleErrors };
}

function assertCommon(name, result) {
  const probe = result.probe || {};
  if (probe.frames > 4) pass(name + ': sampled ' + probe.frames + ' frames from the first one');
  else fail(name + ': the frame sampler barely ran (' + probe.frames + ' frames) — nothing was measured');

  if (probe.coveredAtFirstFrame) pass(name + ': the loading screen was already up on the first painted frame');
  else fail(name + ': the first painted frame had no loading screen — the reader saw the bare app');

  if (probe.dropAt) {
    pass(name + ': the loading screen came down ' + (probe.dropAt - probe.dclAt) +
      'ms after DOMContentLoaded');
  } else {
    fail(name + ': the loading screen never came down — the reader is stranded behind it');
  }

  if (!probe.exposedBeforeDrop) {
    pass(name + ': the "NO SIGNAL / OPEN SETUP" card was never exposed before the reveal');
  } else {
    fail(name + ': the "NO SIGNAL / OPEN SETUP" card was exposed on ' + probe.exposedBeforeDrop +
      ' frame(s) before the reveal (first at ' + probe.firstExposureAt + 'ms) — that is the setup flash');
  }

  if (!result.pageErrors.length) pass(name + ': zero uncaught page errors');
  else result.pageErrors.forEach((e) => fail(name + ': page error: ' + e));
  if (!result.consoleErrors.length) pass(name + ': zero tagged console errors');
  else result.consoleErrors.forEach((e) => fail(name + ': console error: ' + e));
}

try {
  /* ---- A. a browser that already has a league ---------------------------- */
  const saved = await launch({ leagueId: LEAGUE, relay: 'ok' });
  assertCommon('saved league', saved);
  const atSavedDrop = (saved.probe && saved.probe.atDrop) || {};
  if (atSavedDrop.screen === 'home') pass('saved league: the reveal landed on the dashboard');
  else fail('saved league: the reveal landed on "' + atSavedDrop.screen + '" instead of the dashboard');
  if (atSavedDrop.contentShown && !atSavedDrop.noDataShown) {
    pass('saved league: the dashboard was populated at the reveal, not still showing "NO SIGNAL"');
  } else {
    fail('saved league: at the reveal the dashboard was not populated (content shown: ' +
      atSavedDrop.contentShown + ', "NO SIGNAL" shown: ' + atSavedDrop.noDataShown + ')');
  }
  if (/L444444/.test(String(atSavedDrop.text || ''))) pass('saved league: league ' + LEAGUE + ' was on screen at the reveal');
  else fail('saved league: league ' + LEAGUE + ' had not painted at the reveal — the curtain lifted early');
  if (!saved.probe.exposedAfterDrop) pass('saved league: the "NO SIGNAL" card never appeared after the reveal either');
  else fail('saved league: the "NO SIGNAL" card was exposed after the reveal — the restore did not hold');

  /* ---- B. a browser with no league at all -------------------------------- */
  const fresh = await launch({ leagueId: '', relay: 'ok' });
  assertCommon('no league', fresh);
  const atFreshDrop = (fresh.probe && fresh.probe.atDrop) || {};
  if (atFreshDrop.screen === 'setup') pass('no league: the reveal landed on Setup, where a reader with no league belongs');
  else fail('no league: the reveal landed on "' + atFreshDrop.screen + '" instead of Setup');
  if (!fresh.probe.exposedAfterDrop) pass('no league: the "NO SIGNAL" card was never exposed at all');
  else fail('no league: the "NO SIGNAL" card was exposed on ' + fresh.probe.exposedAfterDrop +
    ' frame(s) after the reveal — Setup should be in front of it');

  /* ---- C. a saved league the relay refuses -------------------------------- */
  const broken = await launch({ leagueId: LEAGUE, relay: 'down' });
  assertCommon('failed restore', broken);
  const atBrokenDrop = (broken.probe && broken.probe.atDrop) || {};
  if (atBrokenDrop.screen === 'home') {
    pass('failed restore: the reveal stayed on the dashboard — the reader has a league, the connection is what broke');
  } else {
    fail('failed restore: the reveal moved the reader to "' + atBrokenDrop.screen +
      '"; a failed restore is not the same as having no league');
  }
} catch (err) {
  fail('the check itself threw: ' + ((err && err.stack) || err));
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? '\n[boot-curtain-check] FAILED' : '\n[boot-curtain-check] clean');
process.exit(failed ? 1 : 0);
