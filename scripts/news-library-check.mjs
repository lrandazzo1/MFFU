#!/usr/bin/env node
/* ============================================================================
   FSN — NEWS LIBRARY CHECK

   `node scripts/news-library-check.mjs`

   Pins the season-opening News Desk against the regression that emptied it.

   The timeline stream ends with a SCHEDULED RELEASE GATE: on the week the live
   calendar is actually sitting on, a story is on the wire only once its slot has
   gone to air, so Sunday's finals are not readable on Wednesday. That rule is
   correct for anything reporting a result and catastrophic for everything else
   in the season-opening window, because Week 1 opens on a Tuesday and the
   earliest of the six slots — the Wednesday waiver run — is still a day away.
   Every slot-stamped story was therefore held; the gate's "promote the next one
   due when the wire would be blank" floor never fired, because the live-stamped
   State of the League lead already counted as released; and the desk rendered
   exactly one card where the pre-season board, the draft report cards and the
   Week 1 matchup previews belonged.

   Two scenarios, both run against a pinned page clock (Tuesday of Week 1 of the
   2026 season, the exact broken window) so the assertions hold every day of the
   year rather than only inside the window that happened to reproduce it:

     A. pre-season — a drafted league with a loaded schedule and no scores. The
        wire must carry the State of the League lead PLUS draft coverage, the
        pre-season preview board and per-matchup previews, every one of them
        stamped in the past, and the News screen must render them with populated
        Draft / Matchups filter pills and no "hit a snag".

     B. the gate itself — the same league with Week 1 scores posted. Result copy
        (the Sunday finals, the Tuesday post-mortem, the Wednesday waiver wire)
        must still be held until its slot airs. The fix releases advance
        coverage; it must not release results early.

   Fully offline: a local static server serves the repo and the one API route the
   client boots against is stubbed.
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

/* Tuesday 8 September 2026, 15:00 UTC — day 0 of fantasy Week 1 for the 2026
   season (Labor Day is 7 September, the slate rolls the Tuesday after). Not one
   of the six weekly slots has aired at this moment, which is precisely the state
   that emptied the desk. The container runs in UTC, so the page's local-time
   calendar math resolves against the same instant. */
const PINNED_CLOCK = Date.UTC(2026, 8, 8, 15, 0, 0);

/* Wednesday 7 October 2026, 15:00 UTC — mid-week of fantasy Week 5, four weeks
   into the same season. The waiver run (Wednesday 09:00) has aired; the primer
   (Thursday) and the availability wire (Saturday) have not. Scenario C pins the
   claim the fix makes about itself: the advance carve-out is scoped to the
   season-opening window, so outside it a Thursday primer still arrives on
   Thursday and the reader is not handed next weekend's coverage on Wednesday. */
const MIDSEASON_CLOCK = Date.UTC(2026, 9, 7, 15, 0, 0);
const MIDSEASON_WEEK = 5;

const RESULT_SLOTS = ['gameday', 'primetime', 'recap', 'waivers'];
const ADVANCE_SLOTS = ['primer', 'injury'];

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/notifications-register') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configured: false, apns: false, web: false, vapidPublicKey: '', groups: [] }));
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

/* An eight-team league with a completed twelve-round draft, a full fourteen-week
   schedule and rosters carrying ADP — everything the pre-season desks read from.
   `scoredThrough` posts results for weeks 1..N so the same league can exercise
   the gate's result half and, four weeks in, its mid-season cadence. */
function preseasonLeague(scoredThrough) {
  const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
  const POS_IDS = [1, 2, 2, 3, 3, 4, 5, 16];
  const ROSTER_SIZE = 12;
  const playerId = (teamId, slot) => 1000 + (teamId - 1) * ROSTER_SIZE + slot;
  const through = Number(scoredThrough) || 0;

  const rosterEntry = (teamId, slot) => ({
    playerPoolEntry: {
      player: {
        id: playerId(teamId, slot),
        fullName: NAMES[teamId - 1] + ' Player ' + (slot + 1),
        defaultPositionId: POS_IDS[slot % POS_IDS.length],
        proTeamId: (slot % 30) + 1,
        injuryStatus: slot === 2 ? 'OUT' : 'ACTIVE',
        /* A spread of ADPs so the draft board has real reaches and steals to
           grade rather than a flat, ungradable column. */
        ownership: { averageDraftPosition: (teamId - 1) * ROSTER_SIZE + slot + 1 + ((slot * 7) % 9) - 4, percentOwned: 90 - slot },
      },
    },
    lineupSlotId: slot < 8 ? slot : 20,
    appliedStatTotal: through ? 12 + slot : 0,
  });

  const teams = NAMES.map((name, idx) => {
    const id = idx + 1;
    const entries = [];
    for (let slot = 0; slot < ROSTER_SIZE; slot++) entries.push(rosterEntry(id, slot));
    return {
      id, abbrev: name.slice(0, 3).toUpperCase(), name, location: name, nickname: '',
      owners: ['{OWNER-' + id + '}'], playoffSeed: id, points: 0,
      record: { overall: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 } },
      roster: { entries },
    };
  });

  const schedule = [];
  let matchupId = 1;
  for (let week = 1; week <= 14; week++) {
    for (let i = 0; i < 4; i++) {
      const home = ((i + week) % 8) + 1;
      const away = ((i + week + 4) % 8) + 1;
      if (home === away) continue;
      const live = week <= through;
      const homeScore = live ? 110 + i * 7 + week : 0;
      const awayScore = live ? 96 + i * 5 + week : 0;
      schedule.push({
        id: matchupId++, matchupPeriodId: week, playoffTierType: 'NONE',
        winner: live ? (homeScore > awayScore ? 'HOME' : 'AWAY') : 'UNDECIDED',
        home: { teamId: home, totalPoints: homeScore, pointsByScoringPeriod: live ? { [week]: homeScore } : {} },
        away: { teamId: away, totalPoints: awayScore, pointsByScoringPeriod: live ? { [week]: awayScore } : {} },
      });
    }
  }

  const picks = [];
  let overall = 1;
  for (let round = 1; round <= ROSTER_SIZE; round++) {
    for (let i = 0; i < 8; i++) {
      const teamId = round % 2 === 1 ? i + 1 : 8 - i;
      picks.push({
        playerId: playerId(teamId, round - 1), teamId,
        roundId: round, roundPickNumber: i + 1, overallPickNumber: overall++, keeper: false,
      });
    }
  }

  return {
    id: 999999, seasonId: 2026, scoringPeriodId: Math.max(1, through),
    status: { currentMatchupPeriod: Math.max(1, through), latestScoringPeriod: through, finalScoringPeriod: 17, isActive: true },
    settings: { name: 'News Library Check', size: 8, scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 6 } },
    members: NAMES.map((n, i) => ({
      id: '{OWNER-' + (i + 1) + '}', displayName: 'Manager ' + (i + 1),
      firstName: 'Manager', lastName: String(i + 1),
    })),
    teams, schedule,
    draftDetail: { drafted: true, inProgress: false, picks },
  };
}

function resolveChromium() {
  const override = String(process.env.FSN_CHROMIUM_PATH || '').trim();
  if (override) return override;
  const dir = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers');
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((name) => name.startsWith('chromium'))
    .sort().reverse()
    .flatMap((name) => [
      join(dir, name, 'chrome-linux', 'chrome'),
      join(dir, name, 'chrome-linux', 'headless_shell'),
    ])
    .find((file) => existsSync(file)) || null;
}

let failed = false;
const fail = (message) => { failed = true; console.error('  FAIL  ' + message); };
const pass = (message) => console.log('  ok    ' + message);

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[news-library-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  server.close();
  process.exit(1);
}
console.log('[news-library-check] chromium: ' + executablePath);
console.log('[news-library-check] page clock pinned to ' + new Date(PINNED_CLOCK).toUTCString());

const browser = await chromium.launch({ executablePath });

/* Boot a page whose clock reads PINNED_CLOCK, seed it with `league`, and hand
   back the timeline stream plus what the News screen actually painted. */
async function readDesk(league, options) {
  const opts = options || {};
  const clock = opts.clock == null ? PINNED_CLOCK : opts.clock;
  const week = opts.week == null ? 1 : opts.week;
  const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/\[(FSN|NewsDesk|Timeline|Standings|Matchups)/.test(text)) consoleErrors.push(text);
  });

  /* Shift the page clock rather than freezing it: timers, the feed's minute
     tick and playwright's own waits all keep advancing, but every calendar read
     the release engine makes lands inside the season-opening window. */
  await page.addInitScript((pinned) => {
    try { window.localStorage.setItem('hasCompletedOnboarding', 'true'); } catch (err) { /* private mode */ }
    const RealDate = Date;
    const skew = pinned - RealDate.now();
    function ShiftedDate(...args) {
      if (!(this instanceof ShiftedDate)) return new RealDate(RealDate.now() + skew).toString();
      return args.length ? new RealDate(...args) : new RealDate(RealDate.now() + skew);
    }
    ShiftedDate.prototype = RealDate.prototype;
    ShiftedDate.now = () => RealDate.now() + skew;
    ShiftedDate.parse = RealDate.parse;
    ShiftedDate.UTC = RealDate.UTC;
    window.Date = ShiftedDate;
  }, clock);

  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.evaluate((data) => { window.LeagueData.setEspnData(data); window.__fsnRender(); }, league);
  await page.waitForTimeout(1000);

  if ((await page.getAttribute('#profilePicker', 'data-open')) === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(400);
  }
  await page.click('#tabBar .tab-btn[data-tab="news"]');
  await page.waitForTimeout(900);

  const result = await page.evaluate((wk) => {
    const stream = (window.NewsDesk.getTimelineStream(wk) || []).filter(Boolean);
    const feed = document.getElementById('timelineFeed');
    const screen = document.querySelector('.screen[data-screen="news"]');
    return {
      now: Date.now(),
      phase: window.FSNIntel.seasonPhase(wk),
      stream: stream.map((a) => ({
        id: a.id, kind: a.kind, topic: a.topic, slot: a.slot, at: a.at, meta: a.meta, custom: !!a.custom,
      })),
      leadRendered: !!document.querySelector('#newsLeadWrap h2'),
      feedCards: feed ? feed.querySelectorAll('.tl-card').length : 0,
      topicPills: [...document.querySelectorAll('#topicBar [data-topic]')]
        .map((b) => ({ topic: b.dataset.topic, count: Number(b.querySelector('.cnt').textContent.trim()) })),
      snag: screen ? /hit a snag/i.test(screen.innerText) : true,
    };
  }, week);
  result.pageErrors = pageErrors;
  result.consoleErrors = consoleErrors;
  await page.close();
  return result;
}

try {
  /* ---- A. the pre-season desk is populated ------------------------------ */
  console.log('\n[A] pre-season week — drafted league, no scores posted');
  const pre = await readDesk(preseasonLeague(0));

  if (pre.phase === 'draft' || pre.phase === 'preseason') pass('season phase resolved to "' + pre.phase + '"');
  else fail('expected a draft/pre-season phase at the pinned clock, got "' + pre.phase + '"');

  const kinds = new Set(pre.stream.map((a) => a.kind));
  const topics = new Set(pre.stream.map((a) => a.topic));

  if (pre.stream.length > 1) pass('the wire carries ' + pre.stream.length + ' stories');
  else {
    fail('the wire carries ' + pre.stream.length + ' story. This is the regression: the release gate held ' +
      'every slot-stamped story in the season-opening window and left only the live-stamped State of the ' +
      'League lead. Advance coverage must not be gated inside the transition window.');
  }

  if (kinds.has('sotl')) pass('the State of the League lead is on the wire');
  else fail('the State of the League lead is missing — it is the structural lead of the transition window');

  if (topics.has('draft')) pass('draft coverage is on the wire (' + pre.stream.filter((a) => a.topic === 'draft').length + ' stories)');
  else fail('no draft coverage on the wire. tlDraft() stamps off slotTime("injury"), which under a live ' +
    'release anchor resolves to a slot LATER THIS WEEK; a future stamp must be pulled back to the recent past ' +
    'so the report cards are readable in the one window they exist for.');

  const previews = pre.stream.filter((a) => a.kind === 'preview' || a.slot === 'primer');
  if (previews.length >= 2) pass('pre-season / matchup preview coverage is on the wire (' + previews.length + ' stories)');
  else fail('the pre-season board and the per-matchup previews are missing (found ' + previews.length + ')');

  const future = pre.stream.filter((a) => !a.custom && a.at > pre.now);
  if (future.length === 0) pass('every story on the wire carries a timestamp in the past');
  else fail(future.length + ' story/stories were released with a timestamp in the future (' +
    future.map((a) => a.id + ' → ' + a.meta).slice(0, 3).join(', ') +
    '). Advance copy released ahead of its slot must be re-stamped into the window that has already ' +
    'elapsed since its week opened, or the card reads "THURSDAY" on a story the reader is holding on Tuesday.');

  if (pre.leadRendered) pass('the News screen painted a lead story');
  else fail('the News screen painted no lead story');

  if (pre.feedCards >= pre.stream.length - 1) pass('the feed painted ' + pre.feedCards + ' cards below the lead');
  else fail('the feed painted ' + pre.feedCards + ' cards for a ' + pre.stream.length + '-story wire');

  const pillFor = (id) => (pre.topicPills.find((p) => p.topic === id) || { count: 0 }).count;
  if (pillFor('draft') > 0) pass('the Draft filter pill reports ' + pillFor('draft') + ' stories');
  else fail('the Draft filter pill is empty or hidden — renderTopicBar() drops zero-count topics');
  if (pillFor('matchups') > 0) pass('the Matchups filter pill reports ' + pillFor('matchups') + ' stories');
  else fail('the Matchups filter pill is empty or hidden');

  if (!pre.snag) pass('no "hit a snag" text on the News screen');
  else fail('"hit a snag" rendered on the News screen');

  /* ---- B. the gate still holds results ---------------------------------- */
  console.log('\n[B] the release gate — same league with Week 1 scores posted');
  const live = await readDesk(preseasonLeague(1));

  /* Draft coverage carries the default gameday slot because it passes its own
     timestamp; it is advance copy by topic and is exempt on purpose. */
  const leaked = live.stream.filter((a) => !a.custom && a.topic !== 'draft' && RESULT_SLOTS.includes(a.slot) && a.at > live.now);
  if (leaked.length === 0) pass('no result copy was released ahead of its slot');
  else fail(leaked.length + ' result-slot story/stories reached the wire before their slot aired (' +
    leaked.map((a) => a.id + ' · ' + a.slot).slice(0, 4).join(', ') +
    '). Sunday\'s finals are not readable on Tuesday — the gate must keep holding results.');

  const liveAdvance = live.stream.filter((a) => a.topic === 'draft' || a.slot === 'primer' || a.slot === 'injury');
  if (liveAdvance.length > 0) pass('advance coverage is still released in the opening week (' + liveAdvance.length + ' stories)');
  else fail('advance coverage vanished once scores posted');

  /* ---- C. mid-season cadence is untouched ------------------------------- */
  console.log('\n[C] mid-season — Week ' + MIDSEASON_WEEK + ' on the Wednesday, four weeks of results behind it');
  const mid = await readDesk(preseasonLeague(MIDSEASON_WEEK - 1),
    { clock: MIDSEASON_CLOCK, week: MIDSEASON_WEEK });

  /* The gate's own floor rule — "promote only the next story due when the wire
     would otherwise be blank" — predates this fix and can legitimately surface a
     single still-ahead story mid-week. Anything past that one card means the
     advance carve-out leaked out of the season-opening window it is scoped to. */
  const midDesk = mid.stream.filter((a) => !a.custom);
  const midEarly = midDesk.filter((a) => ADVANCE_SLOTS.includes(a.slot));
  const floorOnly = midEarly.length <= 1 && midDesk.length <= 1;
  if (midEarly.length === 0 || floorOnly) {
    pass('the Thursday primer and the Saturday availability wire are still held on the Wednesday' +
      (midEarly.length ? ' (one card promoted by the gate\'s pre-existing blank-wire floor)' : ''));
  } else {
    fail(midEarly.length + ' advance story/stories were released early in a mid-season week (' +
      midEarly.map((a) => a.id + ' · ' + a.slot).slice(0, 4).join(', ') +
      '). The advance carve-out is scoped to the season-opening window on purpose — outside it the desk ' +
      'still publishes on the calendar it advertises.');
  }

  if (mid.stream.length > 0) pass('the mid-season wire is not empty (' + mid.stream.length + ' stories)');
  else fail('the mid-season wire came back empty');

  if (!mid.snag) pass('no "hit a snag" text on the mid-season News screen');
  else fail('"hit a snag" rendered on the mid-season News screen');

  /* ---- runtime health --------------------------------------------------- */
  console.log('');
  const allPageErrors = pre.pageErrors.concat(live.pageErrors, mid.pageErrors);
  const allConsoleErrors = pre.consoleErrors.concat(live.consoleErrors, mid.consoleErrors);
  if (allPageErrors.length === 0) pass('zero uncaught page errors');
  else fail(allPageErrors.length + ' uncaught page error(s): ' + allPageErrors[0].slice(0, 300));
  if (allConsoleErrors.length === 0) pass('zero [FSN*] / [NewsDesk] / [Timeline] console errors');
  else fail(allConsoleErrors.length + ' tagged console error(s): ' + allConsoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.close();
}

if (failed) {
  console.error('\n[news-library-check] FAILED');
  process.exit(1);
}
console.log('\n[news-library-check] clean');
