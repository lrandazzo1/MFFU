#!/usr/bin/env node
/* ============================================================================
   FSN — DESK SYNC CHECK

   `node scripts/desk-sync-check.mjs`

   Two Home-screen cards used to answer their questions independently of the
   engines that own them. This drives the real app against purpose-built
   synthetic boards and asserts they no longer do.

   1. MATCHUP OF THE WEEK IS THE NEWS DESK'S MATCHUP OF THE WEEK

      The Desk picks the marquee game by power rating — the two best teams
      facing each other. The Home card used to pick by highest combined score
      (or, before kickoff, highest combined projection). Those are different
      questions with different answers, so the dashboard regularly headlined one
      game while the News tab's Matchup of the Week article was about another.

      The board below is built so the two selectors MUST disagree unless the
      card is genuinely bound to the Desk: the two strongest teams play a
      low-scoring game, and the two weakest play a shootout.

   2. THE FRAUD ALERT DOES NOT ROAST A TEAM THAT HAS NOT PLAYED YET

      The card read LeagueData.getWeekExtremes().low, which ranks every side on
      the board by its raw feed score. A side whose game has not kicked off sits
      on a legitimate 0.0, so the moment ONE game went live the Fraud Alert
      handed its verdict to whoever merely happens to play Monday night.

      Two boards are asserted:
        (a) a mid-week slate where one game has not kicked off — the card must
            name a team that actually played, not the 0.0 that is just waiting;
        (b) a slate where two teams in LIVE games are genuinely tied on 0.0 —
            the tie must break on the lower projection, and the card must say
            out loud that it is a projection call rather than printing 0.0 as a
            finished verdict.
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

const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];

/* One league shape, three different week-2 boards written into it. `sides` on a
   game are raw ESPN side objects so a scenario can set totalPoints,
   totalPointsLive and totalProjectedPoints independently — which is the only
   way to build a board that is genuinely mid-slate. */
function league(week2Games) {
  const totals = {};
  const bump = (id, pf, pa) => {
    totals[id] = totals[id] || { pf: 0, pa: 0, w: 0, l: 0 };
    totals[id].pf += pf;
    totals[id].pa += pa;
    if (pf > pa) totals[id].w += 1; else totals[id].l += 1;
  };

  const week1 = [
    { home: 1, away: 4, homePts: 140.2, awayPts: 80.4 },
    { home: 2, away: 3, homePts: 138.6, awayPts: 82.1 },
    { home: 5, away: 6, homePts: 100.3, awayPts: 99.8 },
  ];
  week1.forEach((g) => { bump(g.home, g.homePts, g.awayPts); bump(g.away, g.awayPts, g.homePts); });

  const schedule = [];
  let id = 1;
  week1.forEach((g) => {
    schedule.push({
      id: id++,
      matchupPeriodId: 1,
      playoffTierType: 'NONE',
      winner: g.homePts > g.awayPts ? 'HOME' : 'AWAY',
      home: { teamId: g.home, totalPoints: g.homePts, totalProjectedPoints: g.homePts, pointsByScoringPeriod: { 1: g.homePts } },
      away: { teamId: g.away, totalPoints: g.awayPts, totalProjectedPoints: g.awayPts, pointsByScoringPeriod: { 1: g.awayPts } },
    });
  });
  week2Games.forEach((g) => {
    schedule.push({
      id: id++,
      matchupPeriodId: 2,
      playoffTierType: 'NONE',
      winner: g.winner,
      home: Object.assign({ teamId: g.home }, g.homeSide),
      away: Object.assign({ teamId: g.away }, g.awaySide),
    });
  });

  return {
    id: 999999,
    seasonId: 2026,
    scoringPeriodId: 2,
    status: { currentMatchupPeriod: 2, latestScoringPeriod: 2, finalScoringPeriod: 17, isActive: true },
    settings: { name: 'Desk Sync League', size: 6, scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 4 } },
    members: NAMES.map((n, i) => ({
      id: '{OWNER-' + (i + 1) + '}',
      displayName: 'Manager ' + (i + 1),
      firstName: 'Manager',
      lastName: String(i + 1),
    })),
    teams: NAMES.map((name, i) => {
      const tid = i + 1;
      const t = totals[tid] || { pf: 0, pa: 0, w: 0, l: 0 };
      return {
        id: tid,
        abbrev: name.slice(0, 3).toUpperCase(),
        name,
        location: name,
        nickname: '',
        owners: ['{OWNER-' + tid + '}'],
        playoffSeed: tid,
        points: t.pf,
        record: { overall: { wins: t.w, losses: t.l, ties: 0, pointsFor: t.pf, pointsAgainst: t.pa } },
      };
    }),
    schedule,
  };
}

const settled = (pts) => ({ totalPoints: pts, totalProjectedPoints: pts, pointsByScoringPeriod: { 2: pts } });
const live = (pts, projected) => ({ totalPoints: 0, totalPointsLive: pts, totalProjectedPoints: projected, pointsByScoringPeriod: { 2: pts } });
const notKickedOff = (projected) => ({ totalPoints: 0, totalProjectedPoints: projected, pointsByScoringPeriod: {} });

/* ---- Board A: the two selectors must disagree unless the card is bound ----
   Alpha and Bravo are the league's two best teams after Week 1 and they play
   each other — that is the Desk's marquee. Delta and Foxtrot are the two worst
   and their game is a 299-point shootout, which is what the old highest-combined
   ranking would have headlined. */
const BOARD_MARQUEE = [
  { home: 1, away: 2, winner: 'HOME', homeSide: settled(60.5), awaySide: settled(58.2) },
  { home: 3, away: 5, winner: 'HOME', homeSide: settled(90.1), awaySide: settled(88.4) },
  { home: 4, away: 6, winner: 'HOME', homeSide: settled(150.3), awaySide: settled(149.1) },
];

/* ---- Board B: mid-slate, one game has not kicked off ----
   Charlie/Echo are sitting on a real 0.0 because they play later. Foxtrot is
   0.0 inside a game that IS live. The seat belongs to Foxtrot. */
const BOARD_PREMATURE = [
  { home: 1, away: 2, winner: 'HOME', homeSide: settled(130.4), awaySide: settled(95.2) },
  { home: 3, away: 5, winner: 'UNDECIDED', homeSide: notKickedOff(118.0), awaySide: notKickedOff(104.0) },
  { home: 4, away: 6, winner: 'UNDECIDED', homeSide: live(60.5, 121.0), awaySide: live(0, 99.0) },
];

/* ---- Board C: two live sides genuinely tied on 0.0 ----
   Bravo is projected 92.0 and Foxtrot 71.0. The seat is Foxtrot's, on the
   projection, and the card has to say so. */
const BOARD_TIED_ZERO = [
  { home: 1, away: 2, winner: 'UNDECIDED', homeSide: live(55.2, 128.0), awaySide: live(0, 92.0) },
  { home: 3, away: 5, winner: 'HOME', homeSide: settled(101.5), awaySide: settled(96.3) },
  { home: 4, away: 6, winner: 'UNDECIDED', homeSide: live(48.7, 110.0), awaySide: live(0, 71.0) },
];

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

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[desk-sync-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  process.exit(1);
}

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
await page.addInitScript(() => {
  try { window.localStorage.setItem('hasCompletedOnboarding', 'true'); } catch (err) { /* private mode */ }
});

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (/\[(FSN|NewsDesk|Standings|Matchups|Home)/.test(text)) consoleErrors.push(text);
});

let failed = false;
const fail = (message) => { failed = true; console.error('  FAIL  ' + message); };
const pass = (message) => console.log('  ok    ' + message);

async function seed(board) {
  await page.evaluate((data) => {
    window.LeagueData.setEspnData(data);
    window.__fsnRender();
  }, league(board));
  await page.waitForTimeout(900);
  if (await page.getAttribute('#profilePicker', 'data-open') === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(400);
  }
  await page.click('#tabBar .tab-btn[data-tab="home"]');
  await page.waitForTimeout(500);
}

try {
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(1300);

  /* ---- 1. Matchup of the Week is the News Desk's ------------------------ */
  console.log('\n[1] Matchup of the Week is bound to the News Desk');
  await seed(BOARD_MARQUEE);

  /* Each section stands on its own: a seam that has gone missing here must not
     hide whether the Fraud Alert below still behaves. */
  let desk = null;
  try {
    desk = await page.evaluate(() => {
    const g = window.NewsDesk.marqueeMatchup(2);
    const stream = window.NewsDesk.getTimelineStream(2) || [];
    const article = stream.find((a) => a && a.kind === 'motw') || null;
    const strip = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    return {
      marquee: g ? { home: g.homeTeam.name, away: g.awayTeam.name } : null,
      articleText: article ? strip(article.headline) + ' ' + strip(article.dek) : '',
      articleId: article ? article.id : '',
      /* What the old ranking would have chosen: the highest combined actual. */
      highestCombined: (() => {
        const games = window.LeagueData.getWeekMatchups(2) || [];
        let best = null, top = -1;
        games.forEach((game) => {
          const total = (parseFloat(game.homeActual) || 0) + (parseFloat(game.awayActual) || 0);
          if (total > top) { top = total; best = { home: game.homeTeam.name, away: game.awayTeam.name }; }
        });
        return best;
      })(),
    };
    });
  } catch (err) {
    fail('the Home screen could not ask the News Desk for its marquee game: ' + ((err && err.message) || err));
  }

  const cardText = await page.evaluate(() => String(document.getElementById('motwCard').innerText || ''));

  if (!desk) {
    /* Already reported above. Fall through so sections 2 and 3 still run. */
  } else if (!desk.marquee) {
    fail('NewsDesk.marqueeMatchup(2) returned nothing for a board with three games');
  } else {
    pass('the News Desk names a marquee game: ' + desk.marquee.away + ' at ' + desk.marquee.home);

    const namesBoth = cardText.includes(desk.marquee.home.toUpperCase()) &&
                      cardText.includes(desk.marquee.away.toUpperCase());
    if (namesBoth) pass('the Home marquee card shows the same two teams');
    else fail('the Home marquee card shows different teams than the News Desk. card=' +
      JSON.stringify(cardText.replace(/\s+/g, ' ').slice(0, 160)));

    if (desk.articleId) {
      const articleNamesBoth = new RegExp(desk.marquee.home, 'i').test(desk.articleText) &&
                               new RegExp(desk.marquee.away, 'i').test(desk.articleText);
      if (articleNamesBoth) pass('the News tab\'s "' + desk.articleId + '" article is written about those same two teams');
      else fail('the Matchup of the Week article names different teams than marqueeMatchup(): ' + desk.articleText);
    } else {
      fail('no kind="motw" article was generated for week 2');
    }

    /* The board is deliberately built so these differ. If they ever stop
       differing the assertion above stops proving anything, so say so. */
    const differs = desk.highestCombined &&
      (desk.highestCombined.home !== desk.marquee.home || desk.highestCombined.away !== desk.marquee.away);
    if (differs) {
      pass('the old highest-combined ranking would have headlined ' + desk.highestCombined.away + ' at ' +
        desk.highestCombined.home + ' instead — the binding is doing real work');
    } else {
      fail('this board no longer separates the two selectors, so the assertion above proves nothing. ' +
        'Fix the fixture, not the app.');
    }
  }

  /* ---- 2. No fraud verdict against a team that has not played ----------- */
  console.log('\n[2] The Fraud Alert ignores a side whose game has not kicked off');
  await seed(BOARD_PREMATURE);
  const premature = await page.evaluate(() => String(document.getElementById('hotSeatCard').innerText || '').toUpperCase());

  if (premature.includes('FOXTROT')) pass('the seat goes to Foxtrot — 0.0 inside a game that is actually live');
  else fail('the seat did not go to Foxtrot. card=' + JSON.stringify(premature.replace(/\s+/g, ' ').slice(0, 200)));

  for (const waiting of ['CHARLIE', 'ECHO']) {
    if (!premature.includes(waiting)) pass(waiting + ' plays later and was not roasted for it');
    else fail(waiting + ' has not kicked off yet and was still named by the Fraud Alert');
  }
  if (premature.includes('IN PROGRESS')) pass('the card marks the verdict as still in progress');
  else fail('a mid-slate verdict is not marked as provisional. card=' +
    JSON.stringify(premature.replace(/\s+/g, ' ').slice(0, 200)));

  /* ---- 3. A tie on 0.0 breaks on the lower projection -------------------- */
  console.log('\n[3] Two live sides tied on 0.0 break on the lower projection');
  await seed(BOARD_TIED_ZERO);
  const tied = await page.evaluate(() => String(document.getElementById('hotSeatCard').innerText || '').toUpperCase());

  if (tied.includes('FOXTROT')) pass('the lower-projected side (Foxtrot, 71.0) takes the seat');
  else fail('the tie did not break on the lower projection. card=' +
    JSON.stringify(tied.replace(/\s+/g, ' ').slice(0, 200)));
  if (!tied.includes('BRAVO')) pass('the higher-projected side (Bravo, 92.0) was not named');
  else fail('the higher-projected side was named over the lower one');
  if (tied.includes('PROJECTED')) pass('the card says out loud that this is a projection call, not a final verdict');
  else fail('the card printed a 0.0 verdict with no indication it came from a projection. card=' +
    JSON.stringify(tied.replace(/\s+/g, ' ').slice(0, 200)));

  /* ---- 4. Runtime health ------------------------------------------------ */
  console.log('\n[4] Runtime health');
  if (!pageErrors.length) pass('zero uncaught page errors');
  else pageErrors.forEach((e) => fail('page error: ' + e));
  if (!consoleErrors.length) pass('zero tagged console errors');
  else consoleErrors.forEach((e) => fail('console error: ' + e));

  const snag = await page.evaluate(() => /hit a snag/i.test(String(document.body.innerText || '')));
  if (!snag) pass('no "hit a snag" fallback on the Desk');
  else fail('a "hit a snag" fallback is on screen');
} catch (err) {
  fail('the check itself threw: ' + ((err && err.stack) || err));
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? '\n[desk-sync-check] FAILED' : '\n[desk-sync-check] clean');
process.exit(failed ? 1 : 0);
