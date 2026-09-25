#!/usr/bin/env node
/* ============================================================================
   FSN — DRAFT WEEK CLAMP CHECK

   `node scripts/draft-week-clamp-check.mjs`

   The regression this locks down: the draft desk's four cards (Round 1 Shocker,
   Reach of the Draft, Steal of the Draft, Draft Grades) carried no week of
   their own, so ensureArticleIdentity() stamped them with whichever week the
   reader was sitting on and slotTime() stamped them "6H AGO". On a Week 3 wire
   that put the whole draft desk at the top of TODAY, above the actual Week 3
   slate.

   Loads the real index.html in Chromium against a synthetic league that has
   both a completed draft and three scored weeks, then asserts:

     - Week 3's timeline contains ZERO draft cards
     - Week 1's timeline still contains the draft desk, every card keyed to
       week 1 and typed DRAFT
     - every card on the Week 3 wire reports week 3
     - the Draft topic pill is absent from the Week 3 topic bar and present on
       Week 1
     - no page errors and no [FSN*] console errors along the way
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

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ configured: false }));
      return;
    }
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = join(root, rel.replace(/^\/+/, ''));
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* A league that has drafted AND has played three weeks — the exact state that
   produced the bug. Player ownership carries an ADP so the draft board can
   compute the reach/steal deltas the cards are built from. */
function draftedLeague() {
  const season = 2026;

  const playerRec = (id, name, pos, adp) => ({
    id,
    fullName: name,
    defaultPositionId: pos,
    proTeamId: 1 + (id % 30),
    injuryStatus: 'ACTIVE',
    ownership: { averageDraftPosition: adp, percentOwned: 90 },
  });

  /* 4 teams x 4 rounds. ADPs are deliberately skewed off the pick order so the
     board yields a clear reach, a clear steal and a spread of grades. */
  const adpFor = (overall) => {
    if (overall === 2) return 31.5;   // a 29.5-pick reach
    if (overall === 9) return 1.5;    // a 7.5-pick steal
    return overall + ((overall % 3) - 1) * 2.5;
  };

  const picks = [];
  const roster = { 1: [], 2: [], 3: [], 4: [] };
  for (let overall = 1; overall <= 16; overall += 1) {
    const round = Math.ceil(overall / 4);
    const pickInRound = overall - (round - 1) * 4;
    const teamId = round % 2 === 1 ? pickInRound : 5 - pickInRound;
    const playerId = 1000 + overall;
    picks.push({
      playerId,
      overallPickNumber: overall,
      roundId: round,
      roundPickNumber: pickInRound,
      teamId,
      keeper: false,
    });
    roster[teamId].push({
      playerId,
      lineupSlotId: roster[teamId].length < 2 ? 0 : 20,
      appliedStatTotal: 12 + (overall % 7),
      playerPoolEntry: { id: playerId, player: playerRec(playerId, 'Draftee ' + overall, 1 + (overall % 4), adpFor(overall)) },
    });
  }

  const team = (id, abbrev, name, wins, losses, pf, pa) => ({
    id,
    abbrev,
    name,
    location: name,
    nickname: '',
    owners: ['{OWNER-' + id + '}'],
    playoffSeed: id,
    points: pf,
    record: { overall: { wins, losses, ties: 0, pointsFor: pf, pointsAgainst: pa } },
    roster: { entries: roster[id] },
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
    id: 888888,
    seasonId: season,
    scoringPeriodId: 3,
    status: { currentMatchupPeriod: 3, latestScoringPeriod: 3, finalScoringPeriod: 17, isActive: true },
    settings: {
      name: 'Draft Clamp League',
      size: 4,
      scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 4 },
    },
    members: [1, 2, 3, 4].map((i) => ({
      id: '{OWNER-' + i + '}',
      displayName: 'Manager ' + i,
      firstName: 'Manager',
      lastName: String(i),
    })),
    teams: [
      team(1, 'AAA', 'Alpha', 3, 0, 360.5, 290.2),
      team(2, 'BBB', 'Bravo', 2, 1, 320.1, 305.7),
      team(3, 'CCC', 'Charlie', 1, 2, 305.4, 320.9),
      team(4, 'DDD', 'Delta', 0, 3, 288.0, 357.2),
    ],
    schedule: [
      matchup(1, 1, 4, 128.4, 92.1, 1),
      matchup(2, 2, 3, 105.6, 101.2, 1),
      matchup(3, 1, 3, 112.1, 104.2, 2),
      matchup(4, 2, 4, 104.5, 95.9, 2),
      matchup(5, 1, 2, 120.0, 110.0, 3),
      matchup(6, 3, 4, 100.1, 100.0, 3),
    ],
    draftDetail: { drafted: true, picks },
  };
}

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

const failures = [];
const ok = (label) => console.log('  ok    ' + label);
const bad = (label, detail) => {
  failures.push(label + (detail ? ' — ' + detail : ''));
  console.log('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
};
const expect = (cond, label, detail) => (cond ? ok(label) : bad(label, detail));

const server = await startServer();
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[draft-week-clamp-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') +
    '. Set FSN_CHROMIUM_PATH to one.');
  server.close();
  process.exit(1);
}

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (/\[(FSN|NewsDesk|Standings|Matchups|Timeline|Intel)/i.test(text)) consoleErrors.push(text);
});

await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__fsnRender === 'function' &&
  window.LeagueData && typeof window.LeagueData.setEspnData === 'function');

await page.evaluate((payload) => {
  window.LeagueData.setEspnData(payload);
  window.__fsnRender();
}, draftedLeague());

/* The News screen is the reader's actual path to this bug, so walk it: open
   the News tab, then drive the week scrubber's own ‹ / › buttons rather than
   poking at the private ui.week the UI IIFE owns. */
async function openNews() {
  await page.evaluate(() => {
    const nav = document.querySelector('.tab-btn[data-tab="news"]');
    if (nav) nav.click();
  });
}

/* The scrubber prints the week it is parked on; read that rather than the
   private week state the UI IIFE keeps. Week 1 of a live season renders as
   PRESEASON, which is the same week by another name. */
async function currentWeek() {
  return page.evaluate(() => {
    const label = document.querySelector('#newsWeekScrubber .wk-label');
    const text = String((label && label.textContent) || '').trim();
    if (/PRESEASON/i.test(text)) return 1;
    const m = /(\d+)/.exec(text);
    return m ? Number(m[1]) : 0;
  });
}

/* Step the scrubber to `target`, one click at a time, the way a manager does. */
async function scrubTo(target) {
  for (let guard = 0; guard < 40; guard += 1) {
    const at = await currentWeek();
    if (at === target) return true;
    const dir = at < target ? 1 : -1;
    const clicked = await page.evaluate((d) => {
      const btn = document.querySelector('#newsWeekScrubber [data-week-nav="' + d + '"]:not([disabled])');
      if (!btn) return false;
      btn.click();
      return true;
    }, dir);
    if (!clicked) return false;
    await page.waitForTimeout(40);
  }
  return false;
}

function streamAt(week) {
  return page.evaluate((wk) => {
    const list = window.NewsDesk.getTimelineStream(wk) || [];
    return list.filter(Boolean).map((a) => ({
      id: a.id, week: a.week, declaredWeek: a.declaredWeek == null ? null : a.declaredWeek,
      topic: a.topic, kind: a.kind, eventType: a.eventType || null,
      custom: !!a.custom, tag: a.tag,
    }));
  }, week);
}

function draftPillPresent() {
  return page.evaluate(() => {
    const bar = document.getElementById('topicBar');
    return !!(bar && bar.querySelector('[data-topic="draft"]'));
  });
}

await openNews();

expect(await scrubTo(3), 'the week scrubber reaches Week 3');
const week3 = await streamAt(3);
const week3PillGone = (await draftPillPresent()) === false;

expect(await scrubTo(1), 'the week scrubber reaches Week 1');
const week1 = await streamAt(1);
const week1PillBack = (await draftPillPresent()) === true;

console.log('[draft-week-clamp-check] week 3 cards: ' + week3.length +
  ' · week 1 cards: ' + week1.length);

const isDraft = (a) => a.topic === 'draft' || a.kind === 'draft' || a.eventType === 'DRAFT';

expect(week3.length > 0, 'the Week 3 wire is populated', 'got ' + week3.length + ' cards');

const leaked = week3.filter(isDraft);
expect(leaked.length === 0, 'no draft card reaches the Week 3 wire',
  leaked.map((a) => a.id + ' (' + a.tag + ')').join(', '));

const offWire3 = week3.filter((a) => !a.custom && a.declaredWeek != null && a.declaredWeek !== 3);
expect(offWire3.length === 0, 'no card on the Week 3 wire declares another week',
  offWire3.map((a) => a.id + ' → week ' + a.declaredWeek).join(', '));

const draftCards = week1.filter(isDraft);
expect(draftCards.length > 0, 'the draft desk is still on the Week 1 wire',
  'found none of ' + week1.length + ' cards');

const misKeyed = draftCards.filter((a) => Number(a.week) !== 1 || a.declaredWeek !== 1);
expect(misKeyed.length === 0, 'every draft card is keyed to week 1',
  misKeyed.map((a) => a.id + '@week' + a.week + '/declared' + a.declaredWeek).join(', '));

const untyped = draftCards.filter((a) => a.eventType !== 'DRAFT');
expect(untyped.length === 0, "every draft card carries eventType 'DRAFT'",
  untyped.map((a) => a.id + '@' + a.eventType).join(', '));

/* The topic bar hides zero-count pills, so the Draft pill is the reader-facing
   proof that the desk moved rather than vanished. */
expect(week3PillGone, 'the Draft topic pill is gone on Week 3');
expect(week1PillBack, 'the Draft topic pill is back on Week 1');

const snag = await page.evaluate(() => document.body.innerText.includes('hit a snag'));
expect(snag === false, 'no "hit a snag" panel rendered');

expect(pageErrors.length === 0, 'zero uncaught page errors', pageErrors.join(' | '));
expect(consoleErrors.length === 0, 'zero [FSN*] console errors', consoleErrors.join(' | '));

await browser.close();
server.close();

if (failures.length) {
  console.error('\n[draft-week-clamp-check] ' + failures.length + ' failure(s)');
  process.exit(1);
}
console.log('\n[draft-week-clamp-check] clean');
