#!/usr/bin/env node
/* ============================================================================
   FSN — LEAGUE-SWITCH CURTAIN TIMING CHECK

   `node scripts/switch-curtain-check.mjs`

   The broadcast curtain shown while the active league is swapped must stay up
   until the INCOMING league is on screen. The regression this guards against is
   a curtain dismissed on a stopwatch (or on the fetch promise alone, which
   resolves a frame or two before the repaint it triggered has run): the reader
   sees a flash of the outgoing league's cards, or of the screen
   clearLeagueStateForSwitch emptied, before the new league paints.

   The check drives the real #leagueSwitcher against a stub ESPN relay whose
   payload is tagged with the League ID, then reads the DOM AT THE EXACT MOMENT
   the curtain flips to closed — captured by a MutationObserver installed before
   boot, not by polling afterwards, so it observes the frame the reader would.

   It asserts, at that instant:
     - the incoming league's teams are on screen
     - the outgoing league's teams are gone
     - nothing rendered a "hit a snag" fallback
     - a switch superseded by a newer one does not lift the curtain early

   And it asserts the second half of the same contract AFTER the instant: that
   the home screen is not still rebuilding once the reveal has happened. The
   stub relay deliberately serves the league's completed seasons LATE, because
   the multi-year archive walk is detached from the live fetch and applying it
   rewrites the ticker, the Record Book and the Desk's lead story. A curtain
   tied to the live season alone drops before that lands and the reader watches
   the Desk rewrite itself — which is a flash the content checks above cannot
   see, since the DOM they read is already the new league's.
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
const ARCHIVE_YEAR = CURRENT_YEAR - 1;
const RELAY_DELAY_MS = 700;
/* The completed seasons answer well after the live one, which is the whole
   point: it reproduces the real ordering (live season connects, archive walk
   lands seconds later) that a prematurely dropped curtain exposes. */
const ARCHIVE_DELAY_MS = 900;

/* An ESPN-shaped payload whose every visible string carries the League ID, so
   "which league is painted right now" is answerable from the DOM alone. */
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

/* Serve the repo plus a stub /api/espn relay. The relay answers the CURRENT
   season promptly and the consolidated leagueHistory route LATE, so the mount
   has the two-stage shape it has in production: a live season the reader could
   be shown early, and an archive that rewrites the Desk when it arrives. The
   curtain has to cover both. */
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
        const historyLeague = (target.match(/leagueHistory\/(\d+)/) || [])[1];
        if (historyLeague) {
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify([leaguePayload(historyLeague, ARCHIVE_YEAR)]));
          }, ARCHIVE_DELAY_MS);
          return;
        }
        if (!league || Number(season) !== CURRENT_YEAR) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'No such season for this league.' }));
          return;
        }
        /* A real network beat, and deliberately longer than the curtain's
           minimum-visible floor. A swap that finishes inside that floor is
           revealed by a timer that has outlasted the render anyway, which is
           what used to make this bug look intermittent: it shows up on the
           slow, large league, not on the instant one. */
        setTimeout(() => {
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

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[switch-curtain-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  server.close();
  process.exit(1);
}
console.log('[switch-curtain-check] chromium: ' + executablePath);

/* Long enough to span the late archive the stub relay serves, so a curtain
   that lifts on the live season alone is caught rebuilding afterwards. */
const POST_DROP_SAMPLE_MS = 2500;

const LEAGUE_A = '111111';
const LEAGUE_B = '222222';
const LEAGUE_C = '333333';

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });

/* Seed the switcher with three saved leagues and open on one of them, then
   install the curtain observer — all before a line of app script runs, so the
   very first close of the curtain is captured. */
await page.addInitScript(({ a, b, c, POST_DROP_SAMPLE_MS }) => {
  try {
    const store = window.localStorage;
    store.setItem('hasCompletedOnboarding', 'true');
    store.setItem('mffu.saved.leagues.v1', JSON.stringify([
      { id: b, provider: 'espn', name: 'L' + b + ' League', lastUsed: 3 },
      { id: a, provider: 'espn', name: 'L' + a + ' League', lastUsed: 2 },
      { id: c, provider: 'espn', name: 'L' + c + ' League', lastUsed: 1 },
    ]));
    store.setItem('fsn_saved_league_id', b);
    store.setItem('fsn.setup.v1', JSON.stringify({
      leagueId: b, season: '2026', week: '2', provider: 'espn', statsMode: 'career',
    }));
  } catch (err) { /* private mode — the check cannot run, and the asserts will say so */ }

  /* Read the DOM in the same task as the attribute flip. Anything polled
     afterwards would be measuring a later frame than the reader's.

     The second measurement is the one that catches a curtain dropped early:
     count how much the home screen is still rebuilt AFTER the reveal. A repaint
     the store publishes queued but the browser has not run yet is invisible to
     a content check — the DOM already holds the new league — but the reader
     sees it as the flash the curtain exists to hide. A curtain held until the
     mount is settled leaves nothing behind it to rebuild.

     The window is measured in MILLISECONDS, not frames, because the rebuild
     that matters most arrives on the archive walk's own schedule — a second or
     so after the live season, not on the next animation frame. */
  window.__curtainDrops = [];
  window.__homeMutations = 0;
  const watch = () => {
    const el = document.getElementById('leagueCurtain');
    const home = document.getElementById('homeContent');
    if (!el || !home) { requestAnimationFrame(watch); return; }
    new MutationObserver((records) => { window.__homeMutations += records.length; })
      .observe(home, { childList: true, subtree: true, characterData: true });
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName !== 'data-open') continue;
        if (el.dataset.open === 'false') {
          const text = String(document.body.innerText || '');
          const drop = {
            at: Math.round(performance.now()),
            text,
            snag: /hit a snag/i.test(text),
            mutationsAtDrop: window.__homeMutations,
            mutationsAfterDrop: 0,
          };
          window.__curtainDrops.push(drop);
          const until = performance.now() + POST_DROP_SAMPLE_MS;
          const sample = () => {
            drop.mutationsAfterDrop = window.__homeMutations - drop.mutationsAtDrop;
            if (performance.now() < until) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }
      }
    }).observe(el, { attributes: true, attributeFilter: ['data-open'] });
  };
  watch();
}, { a: LEAGUE_A, b: LEAGUE_B, c: LEAGUE_C, POST_DROP_SAMPLE_MS });

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  /* The stub relay serves only the current season, so the background archive
     walk gets an honest 404 for every completed one and says so. That is the
     app reporting the harness's own shape, not a rendering regression. */
  if (/ESPN relay rejected .*HTTP 404/.test(text)) return;
  if (/\[(FSN|NewsDesk|Standings|Matchups|LeagueSwitch|League Share|Privacy|Yahoo|EditorialScheduleEngine)/.test(text)) {
    consoleErrors.push(text);
  }
});

let failed = false;
const fail = (message) => { failed = true; console.error('  FAIL  ' + message); };
const pass = (message) => console.log('  ok    ' + message);

/* Fire the switcher the way the reader does — a change event on the real
   <select> — without waiting for the Setup screen to be visible. */
async function switchTo(leagueId) {
  await page.evaluate((value) => {
    const select = document.getElementById('leagueSwitcher');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, 'espn:' + leagueId);
}

const drops = () => page.evaluate(() => window.__curtainDrops.map((d) => ({
  at: d.at, snag: d.snag,
  mutationsAfterDrop: d.mutationsAfterDrop,
  sawA: /L111111-Team/.test(d.text),
  sawB: /L222222-Team/.test(d.text),
  sawC: /L333333-Team/.test(d.text),
})));

try {
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  /* The first live payload opens the modal team-profile chooser. Answer it as a
     reader with no team so it does not sit over the switch under test. */
  if (await page.getAttribute('#profilePicker', 'data-open') === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(400);
  }

  const booted = await page.evaluate(() => /L222222-Team/.test(String(document.body.innerText || '')));
  if (booted) pass('booted into league ' + LEAGUE_B);
  else fail('league ' + LEAGUE_B + ' never painted at boot; the check cannot measure a switch away from it');

  /* ---- 1. A single switch ------------------------------------------------ */
  await switchTo(LEAGUE_A);
  await page.waitForFunction(() => window.__curtainDrops.length >= 1, null, { timeout: 25000 })
    .catch(() => fail('the curtain never came down after switching to league ' + LEAGUE_A));
  await page.waitForTimeout(POST_DROP_SAMPLE_MS + 800);

  const afterFirst = await drops();
  if (afterFirst.length === 1) pass('the curtain came down exactly once for one switch');
  else fail('expected 1 curtain drop, saw ' + afterFirst.length);

  const first = afterFirst[0] || {};
  if (first.sawA) pass('at the drop, the incoming league (' + LEAGUE_A + ') was already painted');
  else fail('at the drop, the incoming league (' + LEAGUE_A + ') was NOT on screen — the curtain lifted early');
  if (!first.sawB) pass('at the drop, the outgoing league (' + LEAGUE_B + ') was gone');
  else fail('at the drop, the outgoing league (' + LEAGUE_B + ') was still on screen — stale state was revealed');
  if (!first.snag) pass('at the drop, no "hit a snag" fallback was showing');
  else fail('at the drop, a "hit a snag" fallback was on screen');
  if (first.mutationsAfterDrop === 0) {
    pass('the home screen was finished rebuilding before the curtain lifted (' +
      POST_DROP_SAMPLE_MS + 'ms window, spanning the late archive)');
  } else {
    fail('the home screen was still being rebuilt ' + first.mutationsAfterDrop +
      ' time(s) in the ' + POST_DROP_SAMPLE_MS + 'ms AFTER the curtain lifted — the reveal beat the ' +
      'archive walk, so the reader watches the Desk rewrite itself');
  }

  /* ---- 2. Two switches in flight at once --------------------------------- */
  /* An older switch settling must not pull the curtain off a newer one that is
     still loading: the reader would see the app revealed mid-swap. */
  await switchTo(LEAGUE_B);
  await page.waitForTimeout(40);
  await switchTo(LEAGUE_C);
  await page.waitForTimeout(6000 + POST_DROP_SAMPLE_MS);

  const afterRace = (await drops()).slice(afterFirst.length);
  if (!afterRace.length) {
    fail('the curtain never came down after two overlapping switches');
  } else {
    const early = afterRace.filter((d) => !d.sawC);
    if (!early.length) pass('every drop during overlapping switches showed the newest league (' + LEAGUE_C + ')');
    else fail(early.length + ' drop(s) during overlapping switches revealed a league other than ' + LEAGUE_C);
    const last = afterRace[afterRace.length - 1];
    if (last.sawC && !last.sawB) pass('the final drop showed league ' + LEAGUE_C + ' with no leftovers from ' + LEAGUE_B);
    else fail('the final drop did not settle cleanly on league ' + LEAGUE_C);
    if (!afterRace.some((d) => d.snag)) pass('no "hit a snag" fallback during the overlapping switches');
    else fail('a "hit a snag" fallback was revealed during the overlapping switches');
    const restless = afterRace.filter((d) => d.mutationsAfterDrop > 0);
    if (!restless.length) pass('no drop during overlapping switches revealed a still-rebuilding screen');
    else fail(restless.length + ' drop(s) during overlapping switches revealed a screen still being rebuilt');
  }

  const closed = await page.getAttribute('#leagueCurtain', 'data-open');
  if (closed === 'false') pass('the curtain is down once the switches have settled');
  else fail('the curtain is still up after the switches settled (data-open=' + closed + ')');

  /* ---- 3. Runtime health ------------------------------------------------- */
  if (!pageErrors.length) pass('zero uncaught page errors');
  else pageErrors.forEach((e) => fail('page error: ' + e));
  if (!consoleErrors.length) pass('zero tagged console errors');
  else consoleErrors.forEach((e) => fail('console error: ' + e));
} catch (err) {
  fail('the check itself threw: ' + ((err && err.stack) || err));
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? '\n[switch-curtain-check] FAILED' : '\n[switch-curtain-check] clean');
process.exit(failed ? 1 : 0);
