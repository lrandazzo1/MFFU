#!/usr/bin/env node
/* ============================================================================
   FSN — LOCAL DESK CHECK (hyper-local copy + deep stat / live score blocks)

   `node scripts/local-desk-check.mjs`

   index.html has no build step and no test suite, so CLAUDE.md makes a headless
   render the non-negotiable half of verifying anything that touches a script
   block. This is that check for the Local Desk: the engine in block 1
   (FSNLocalDesk) and the section block 6 appends below every article and every
   timeline card.

   It loads the real file in Chromium against a synthetic ESPN-shaped league
   built specifically to exercise this feature — raw weekly box-score splits, a
   stamped injury designation, a FINALIZED week and a LIVE week — and asserts:

     ENGINE (block 1, called directly)
       - statLine() reads real yardage / touchdowns / receptions out of the
         statId map, and the fantasy points those stats produced
       - liveScore() reports LIVE from totalPointsLive during an open week and
         FINAL only against the platform's own finalization stamp
       - the mandated injuries/waivers phrasing is produced verbatim in shape:
         "<Player>'s <designation> — here's who actually benefits: while people
          may think <Mgr>'s <Player> benefits, that's not the only thing;
          <Mgr>'s <Player> also benefits."
       - the mandated live/recent-game phrasing produces BOTH halves: the
         "giving them the lead against <Opponent>" clause for a manager who is
         ahead and the "still behind by <X> points despite <Player>'s effort"
         clause for a manager who is not
       - determinism: the same item against the same payload produces a
         byte-identical sentence on a second call

     RENDER (block 6, in the real DOM)
       - every timeline card carries the compact block, at the BOTTOM of the
         card body and above the card's action row
       - the reader carries the full block, AFTER the copy and AFTER the
         By-the-Numbers box, and never inside it
       - the block names managers, quotes fantasy points, prints per-category
         stat chips and renders the live head-to-head
       - no anchors, no hrefs, no external assets anywhere inside it
       - no existing table structure is touched: .bn-table keeps its own
         header/row shape and gains no nested section
       - zero uncaught page errors, zero tagged console errors, no "hit a snag"

   Exit code 0 means clean.
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

let failures = 0;
function pass(msg) { console.log('  ok    ' + msg); }
function fail(msg) { failures++; console.log('  FAIL  ' + msg); }
function expect(actual, wanted, label) {
  if (actual === wanted) pass(label + ' = ' + JSON.stringify(actual));
  else fail(label + ' = ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(wanted));
}
function contains(haystack, needle, label) {
  if (String(haystack || '').includes(needle)) pass(label);
  else fail(label + ' — not found in: ' + JSON.stringify(String(haystack || '').slice(0, 260)));
}

/* The repo root plus the one API route the client boots against. `configured:
   false` is the honest answer for a local run with no APNs or VAPID keys. */
function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/notifications-register') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configured: false, apns: false, web: false, groups: [] }));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
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

/* ---------------------------------------------------------------------------
   THE FIXTURE

   ESPN-shaped, because the raw statId map this feature reads is an ESPN payload
   shape. Week 1 is finalized (the platform stamped a winner) and week 2 is
   OPEN: every game reports 'UNDECIDED' and the running score arrives in
   totalPointsLive while totalPoints holds at 0, which is exactly the live-week
   shape that used to print 0.0 next to a manager with points on the board.

   Bijan Robinson is stamped OUT and shares ATL with Drake London, who is on a
   different roster — that is the injuries/waivers phrasing under test, and the
   beneficiary genuinely is a teammate rather than a name pulled from a pool.
--------------------------------------------------------------------------- */

/* ESPN statIds: 3 pass yds, 4 pass td, 20 int, 23 car, 24 rush yds,
   25 rush td, 41 tgt, 42 rec yds, 43 rec td, 53 rec, 72 fum lost. */
function player(id, name, posId, proTeamId, options) {
  const opts = options || {};
  const out = {
    id,
    fullName: name,
    defaultPositionId: posId,
    proTeamId,
    injuryStatus: opts.injuryStatus || 'ACTIVE',
    stats: [],
  };
  if (opts.week && (opts.points != null || opts.raw)) {
    out.stats.push({
      scoringPeriodId: opts.week,
      statSourceId: 0,
      statSplitTypeId: 1,
      appliedTotal: opts.points == null ? 0 : opts.points,
      stats: opts.raw || {},
    });
  }
  return out;
}

function entry(slotId, playerObj, points) {
  return {
    lineupSlotId: slotId,
    appliedStatTotal: points,
    playerPoolEntry: { id: playerObj.id, appliedStatTotal: points, player: playerObj },
  };
}

function syntheticLeague() {
  const team = (id, name, wins, losses, pf, pa) => ({
    id,
    abbrev: name.slice(0, 3).toUpperCase(),
    name,
    location: name,
    nickname: '',
    primaryOwner: '{OWNER-' + id + '}',
    owners: ['{OWNER-' + id + '}'],
    playoffSeed: id,
    points: pf,
    record: { overall: { wins, losses, ties: 0, pointsFor: pf, pointsAgainst: pa } },
  });

  /* ---- Week 2 lineups (the live week) ---- */
  const bijan = player(101, 'Bijan Robinson', 2, 1, {
    week: 2, points: 8.4, injuryStatus: 'OUT',
    raw: { '23': 7, '24': 24, '41': 2, '53': 2, '42': 10 },
  });
  const london = player(102, 'Drake London', 3, 1, {
    week: 2, points: 26.7,
    raw: { '41': 13, '53': 9, '42': 127, '43': 2 },
  });
  const allen = player(103, 'Josh Allen', 1, 2, {
    week: 2, points: 31.2,
    raw: { '3': 288, '4': 3, '20': 1, '23': 9, '24': 54, '25': 1 },
  });
  const cook = player(104, 'James Cook', 2, 2, {
    week: 2, points: 14.6,
    raw: { '23': 18, '24': 96, '25': 1, '53': 2, '42': 10 },
  });
  const lamb = player(105, 'CeeDee Lamb', 3, 6, {
    week: 2, points: 9.1,
    raw: { '41': 8, '53': 5, '42': 41 },
  });
  const pitts = player(106, 'Kyle Pitts', 4, 1, {
    week: 2, points: 4.3, injuryStatus: 'QUESTIONABLE',
    raw: { '41': 4, '53': 3, '42': 13 },
  });
  /* A provider row with no raw split at all — the honest degradation path. */
  const noSplits = player(107, 'Chuba Hubbard', 2, 29, { week: 2, points: 11.5 });

  /* ---- Week 1 lineups (finalized) ---- */
  const w1 = (id, name, posId, proTeamId, points, raw) =>
    player(id, name, posId, proTeamId, { week: 1, points, raw });

  const side = (teamId, entries, settled, live) => {
    const out = {
      teamId,
      totalPoints: settled,
      rosterForCurrentScoringPeriod: { entries },
    };
    if (live != null) out.totalPointsLive = live;
    return out;
  };

  const week1 = [
    {
      id: 1, period: 1, winner: 'HOME',
      home: side(1, [
        entry(2, w1(101, 'Bijan Robinson', 2, 1, 19.1, { '23': 17, '24': 88, '25': 1 }), 19.1),
        entry(4, w1(106, 'Kyle Pitts', 4, 1, 7.2, { '41': 5, '53': 4, '42': 32 }), 7.2),
      ], 121.4),
      away: side(4, [
        entry(2, w1(105, 'CeeDee Lamb', 3, 6, 12.0, { '41': 9, '53': 6, '42': 60 }), 12.0),
      ], 98.2),
    },
    {
      id: 2, period: 1, winner: 'AWAY',
      home: side(2, [
        entry(0, w1(103, 'Josh Allen', 1, 2, 18.5, { '3': 240, '4': 1 }), 18.5),
      ], 96.1),
      away: side(3, [
        entry(2, w1(102, 'Drake London', 3, 1, 15.4, { '41': 10, '53': 7, '42': 84 }), 15.4),
      ], 110.9),
    },
  ];

  /* Week 2 is open: winner UNDECIDED, totalPoints 0, running score in
     totalPointsLive. Alpha (Manager 1) is BEHIND Bravo, which is the branch
     that produces the "still behind by X points despite ..." clause; Charlie
     is AHEAD of Delta, which produces the "giving them the lead against ..."
     clause. Both halves of the mandated phrasing get exercised. */
  const week2 = [
    {
      id: 3, period: 2, winner: 'UNDECIDED',
      home: side(1, [
        entry(2, bijan, 8.4),
        entry(4, pitts, 4.3),
        entry(20, noSplits, 11.5),
      ], 0, 74.6),
      away: side(2, [
        entry(0, allen, 31.2),
        entry(2, cook, 14.6),
      ], 0, 91.3),
    },
    {
      id: 4, period: 2, winner: 'UNDECIDED',
      home: side(3, [
        entry(2, london, 26.7),
      ], 0, 88.8),
      away: side(4, [
        entry(2, lamb, 9.1),
      ], 0, 61.2),
    },
  ];

  const games = (rows) => rows.map((r) => ({
    id: r.id,
    matchupPeriodId: r.period,
    scoringPeriodId: r.period,
    playoffTierType: 'NONE',
    winner: r.winner,
    home: r.home,
    away: r.away,
  }));

  return {
    id: 777777,
    seasonId: 2026,
    scoringPeriodId: 2,
    status: { currentMatchupPeriod: 2, latestScoringPeriod: 2, finalScoringPeriod: 17, isActive: true },
    settings: {
      name: 'Local Desk Check League',
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
      team(1, 'Alpha', 1, 0, 196.0, 159.4),
      team(2, 'Bravo', 0, 1, 187.4, 202.8),
      team(3, 'Charlie', 1, 0, 199.7, 157.3),
      team(4, 'Delta', 0, 1, 159.4, 196.0),
    ],
    schedule: games(week1).concat(games(week2)),
  };
}

/* ---------------------------------------------------------------------------
   Chromium. The environment pre-installs it under PLAYWRIGHT_BROWSERS_PATH but
   its build number will not always match whatever playwright version npm
   resolved, and downloading a second copy is blocked — so resolve the binary
   on disk rather than trusting playwright's version-derived path.
--------------------------------------------------------------------------- */
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
  console.error('[local-desk-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  server.close();
  process.exit(1);
}
console.log('[local-desk-check] chromium: ' + executablePath);

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (/\[(FSN|NewsDesk|LocalDesk|Standings|Matchups|Timeline)/.test(m.text())) consoleErrors.push(m.text());
});
/* Nothing in this check may reach the network. A real ESPN or blog read would
   make the assertions depend on somebody else's uptime. */
await page.route('https://**/*', (r) => r.abort());

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__fsnRender === 'function' &&
    !!(window.LeagueData && window.LeagueData.setEspnData) && !!window.FSNLocalDesk, null, { timeout: 20000 });
  pass('the page booted with FSNLocalDesk published at global scope');

  await page.evaluate((data) => {
    window.LeagueData.setEspnData(data);
    window.__fsnRender();
  }, syntheticLeague());
  await page.waitForTimeout(700);
  pass('seeded the synthetic league and repainted');

  /* The first live payload opens the team-profile chooser, which is modal and
     intercepts every tap until it is answered. Answer it the way a reader
     without a claimed team would, so the walk below exercises the real app
     rather than fighting an overlay — and so the localized copy under test is
     the league-wide framing rather than the reader-relative one. */
  if (await page.getAttribute('#profilePicker', 'data-open') === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(500);
    pass('dismissed the first-run profile picker (continue as guest)');
  } else pass('no profile picker to dismiss');

  /* And the first-run tour, which is the other modal that intercepts taps on a
     fresh origin. Skipped rather than walked: this check is about the News
     Desk, and render-check.mjs already owns the tour itself. */
  if (await page.getAttribute('#ftuModal', 'data-open') === 'true') {
    await page.click('#ftuSkip');
    await page.waitForTimeout(500);
    pass('skipped the first-run tour');
  } else pass('no first-run tour to skip');

  /* ======================================================================
     1. THE ENGINE — called directly, so a copy or stat failure is reported
        against the function that produced it rather than against a card.
     ====================================================================== */
  console.log('\n[1] The engine: stats, live score, and the mandated phrasing');

  const engine = await page.evaluate(() => {
    const D = window.FSNLocalDesk;
    const seed = 'fixture-seed';
    const cook = D.statLine('James Cook', 2);
    const allen = D.statLine('Josh Allen', 2);
    const bijan = D.statLine('Bijan Robinson', 2);
    const london = D.statLine('Drake London', 2);
    const noSplits = D.statLine('Chuba Hubbard', 2);
    const catsOf = (row) => (row && row.cats ? row.cats.map((c) => c.label + ':' + c.value) : null);
    const beneficiaries = D.beneficiariesOf(bijan, 2, 3);
    return {
      cook: cook && { name: cook.name, points: cook.points, pos: cook.pos, proTeam: cook.proTeam,
                      manager: D.managerName(cook.owner), cats: catsOf(cook), line: cook.statLine },
      allenCats: catsOf(allen),
      bijan: bijan && { designation: bijan.designation, points: bijan.points, manager: D.managerName(bijan.owner) },
      londonManager: london && D.managerName(london.owner),
      noSplitsCats: catsOf(noSplits),
      noSplitsPoints: noSplits && noSplits.points,
      beneficiaries: beneficiaries.map((b) => b.name),
      /* Week 1 is finalized; week 2 is open. */
      liveAlpha: (() => { const s = D.liveScore(1, 2); return s && { state: s.state, us: s.us.score, them: s.them.score, margin: s.margin }; })(),
      finalAlpha: (() => { const s = D.liveScore(1, 1); return s && { state: s.state, us: s.us.score, them: s.them.score }; })(),
      /* Both halves of the mandated live/recent-game structure. Alpha trails,
         Charlie leads. */
      behindLine: D.gameLine(bijan, D.liveScore(1, 2), 'injury', seed),
      aheadLine: D.gameLine(london, D.liveScore(3, 2), 'recap', seed),
      /* The mandated injuries/waivers structure. */
      benefitLine: D.benefitLine(bijan, beneficiaries, seed),
      /* A week the payload has no lineups for at all (Week 9 here) must fall
         back to the LATEST week that does, never the earliest — serving Week
         1's box score under a Week 9 headline is the stale-number failure the
         exact week match exists to prevent. */
      emptyWeek: (() => { const r = D.roster(9); return { week: r.week, count: r.count }; })(),
      emptyWeekCook: (() => { const row = D.statLine('James Cook', 9); return row && row.points; })(),
      /* ...and the section must LABEL the week it actually read, not the week
         it was asked about, or the header lies about correct numbers. */
      emptyWeekDeepLabel: (() => {
        const d = D.deepData({ id: 'label-probe', week: 9, slot: 'recap', crest: 'Alpha' });
        return d && d.week;
      })(),
      /* Determinism: the same inputs, a second time. */
      benefitAgain: D.benefitLine(bijan, D.beneficiariesOf(bijan, 2, 3), seed),
      aheadAgain: D.gameLine(london, D.liveScore(3, 2), 'recap', seed),
    };
  });

  /* ---- real stats, read not inferred ---- */
  if (engine.cook) {
    expect(engine.cook.points, 14.6, 'James Cook fantasy points');
    expect(engine.cook.manager, 'Manager 2', 'James Cook is attributed to his manager');
    expect(engine.cook.proTeam, 'BUF', 'the pro team is resolved from proTeamId');
    expect(JSON.stringify(engine.cook.cats),
      JSON.stringify(['CAR:18', 'RUSH YDS:96', 'RUSH TD:1', 'REC:2', 'REC YDS:10']),
      'the raw box-score splits are read out of the statId map');
    expect(engine.cook.line, '18 car, 96 rush yds, 1 rush td, 2 rec, 10 rec yds',
      'the stat sentence reads like a box score');
  } else fail('statLine() found no James Cook in the fixture');

  expect(JSON.stringify(engine.allenCats),
    JSON.stringify(['PASS YDS:288', 'PASS TD:3', 'INT:1', 'CAR:9', 'RUSH YDS:54', 'RUSH TD:1']),
    'a passer reports passing AND rushing categories, interceptions included');

  expect(JSON.stringify(engine.noSplitsCats), '[]',
    'a provider row with no raw split invents no categories');
  expect(engine.noSplitsPoints, 11.5, 'that row still reports the fantasy points it really scored');

  /* ---- the live head-to-head ---- */
  if (engine.liveAlpha) {
    expect(engine.liveAlpha.state, 'LIVE', 'an open week reports LIVE');
    expect(engine.liveAlpha.us, 74.6, "the live score is read from totalPointsLive, not the 0 in totalPoints");
    expect(engine.liveAlpha.them, 91.3, "the opponent's live score is read the same way");
    expect(engine.liveAlpha.margin, -16.7, 'the signed margin is the real deficit');
  } else fail('liveScore() found no Week 2 matchup for Alpha');

  if (engine.finalAlpha) {
    expect(engine.finalAlpha.state, 'FINAL', "a week the platform stamped reports FINAL");
    expect(engine.finalAlpha.us, 121.4, 'a finalized week reports the settled score');
  } else fail('liveScore() found no Week 1 matchup for Alpha');

  /* ---- the mandated injuries/waivers structure ---- */
  expect(engine.bijan && engine.bijan.designation, 'OUT', "the platform's own designation is carried through");
  expect(JSON.stringify(engine.beneficiaries), JSON.stringify(['Drake London', 'Kyle Pitts']),
    "the beneficiaries are the injured player's real NFL teammates on rosters in this league");
  contains(engine.benefitLine, 'Bijan Robinson’s ruled out',
    'the benefit line opens on the player and the designation');
  contains(engine.benefitLine, 'while people may think',
    'the benefit line uses the mandated "while people may think" structure');
  contains(engine.benefitLine, 'that’s not the only thing;',
    'the benefit line carries the mandated pivot');
  contains(engine.benefitLine, 'also benefits.',
    'the benefit line closes on the second beneficiary');
  contains(engine.benefitLine, 'Manager 3’s Drake London',
    'the first beneficiary is named as "<Manager>’s <Player>"');
  contains(engine.benefitLine, 'Manager 1’s Kyle Pitts',
    'the second beneficiary is named as "<Manager>’s <Player>"');

  /* ---- the mandated live/recent-game structure, both halves ---- */
  contains(engine.aheadLine, 'Last night in MNF',
    'the recap slot opens on the right television window');
  contains(engine.aheadLine, 'Manager 3’s Drake London went off',
    'a 20+ point performance reads as "went off"');
  contains(engine.aheadLine, 'giving them the lead against Manager 4',
    'a manager who is ahead gets the mandated "giving them the lead against" clause');
  contains(engine.aheadLine, '127 rec yds',
    'the ahead line quotes the real receiving yardage');

  contains(engine.behindLine, 'Last night in TNF',
    'the injury slot opens on the right television window');
  contains(engine.behindLine, 'leaving them still behind Manager 2 by 16.7 points',
    'a manager who is behind gets the mandated "still behind by X points" clause');
  contains(engine.behindLine, 'despite Bijan Robinson’s effort.',
    'the behind line closes on the mandated "despite <Player>’s effort"');

  /* ---- the no-lineup week ---- */
  expect(engine.emptyWeek && engine.emptyWeek.week, 2,
    'a week with no lineups falls back to the latest week that has them');
  expect(engine.emptyWeekCook, 14.6, 'that fallback reports the latest real box score, not the first');
  expect(engine.emptyWeekDeepLabel, 2, 'the block labels the week it actually read, not the week it was asked for');

  /* ---- determinism ---- */
  expect(engine.benefitAgain, engine.benefitLine, 'the benefit line is byte-identical on a second call');
  expect(engine.aheadAgain, engine.aheadLine, 'the game line is byte-identical on a second call');

  /* ======================================================================
     2. THE TIMELINE — the compact block, at the bottom of every card.
     ====================================================================== */
  console.log('\n[2] The timeline: localized phrasing and the deep block at the bottom');

  await page.click('#tabBar .tab-btn[data-tab="news"]');
  await page.waitForTimeout(900);

  const feed = await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll('#timelineFeed .tl-item'));
    const read = (item) => {
      const body = item.querySelector('.tl-body');
      const block = item.querySelector('.deepstat');
      const foot = item.querySelector('.tl-foot');
      if (!block || !body) return { hasBlock: false };
      const kids = Array.prototype.slice.call(body.children);
      return {
        hasBlock: true,
        compact: block.classList.contains('ds-compact'),
        /* "cleanly at the bottom": below the copy, above the card's own
           action row, and a direct child of the card body rather than
           something smuggled into the headline group. */
        directChild: block.parentElement === body,
        beforeFoot: !!foot && kids.indexOf(block) < kids.indexOf(foot),
        lastBeforeFoot: !!foot && kids.indexOf(block) === kids.indexOf(foot) - 1,
        local: (block.querySelector('.ds-local') || {}).textContent || '',
        players: Array.prototype.slice.call(block.querySelectorAll('.ds-player')).map((n) => ({
          name: (n.querySelector('.ds-name') || {}).textContent || '',
          who: (n.querySelector('.ds-who') || {}).textContent || '',
          points: (n.querySelector('.ds-pts') || {}).textContent || '',
          cats: Array.prototype.slice.call(n.querySelectorAll('.ds-cat')).map((c) => c.textContent.trim()),
        })),
        scoreStates: Array.prototype.slice.call(block.querySelectorAll('.ds-score .st')).map((n) => n.textContent.trim()),
        scoreValues: Array.prototype.slice.call(block.querySelectorAll('.ds-score .sc')).map((n) => n.textContent.trim()),
        anchors: block.querySelectorAll('a, [href], img, iframe').length,
        html: block.outerHTML,
      };
    };
    return {
      cards: items.length,
      blocks: items.map(read).filter((r) => r.hasBlock),
      snag: /hit a snag/i.test(document.body.innerText),
    };
  });

  if (feed.cards > 0) pass('the timeline painted ' + feed.cards + ' card(s)');
  else fail('the timeline painted no cards at all');

  if (feed.blocks.length) pass(feed.blocks.length + ' of ' + feed.cards + ' timeline card(s) carry a deep data block');
  else fail('no timeline card carried a deep data block');

  const badCompact = feed.blocks.filter((b) => !b.compact);
  expect(badCompact.length, 0, 'every timeline block uses the compact feed variant');
  const notDirect = feed.blocks.filter((b) => !b.directChild);
  expect(notDirect.length, 0, 'every timeline block is a direct child of the card body');
  const misplaced = feed.blocks.filter((b) => !b.beforeFoot || !b.lastBeforeFoot);
  expect(misplaced.length, 0, 'every timeline block sits at the bottom of the copy, directly above the action row');
  const linked = feed.blocks.filter((b) => b.anchors > 0);
  expect(linked.length, 0, 'no timeline block links out or loads an external asset');

  const withLocal = feed.blocks.filter((b) => /Manager [1-4]’s /.test(b.local));
  if (withLocal.length) {
    pass(withLocal.length + ' timeline block(s) lead with a "<Manager>’s <Player>" callout, e.g. ' +
      JSON.stringify(withLocal[0].local.replace('The Local Read', '').slice(0, 190)));
  } else {
    fail('no timeline block carried an ownership callout: ' +
      JSON.stringify(feed.blocks.map((b) => b.local).slice(0, 4)));
  }

  const allPlayers = feed.blocks.flatMap((b) => b.players);
  const attributed = allPlayers.filter((p) => /Manager [1-4]/.test(p.who));
  if (allPlayers.length && attributed.length === allPlayers.length) {
    pass('all ' + allPlayers.length + ' deep-data player row(s) name the manager who rosters them');
  } else {
    fail(attributed.length + ' of ' + allPlayers.length + ' deep-data player rows name a manager');
  }

  const scoring = allPlayers.filter((p) => /\d+\.\d\s*PTS/.test(p.points));
  if (scoring.length) pass('deep-data rows quote real fantasy points, e.g. ' + scoring[0].points);
  else fail('no deep-data row quoted fantasy points: ' + JSON.stringify(allPlayers.map((p) => p.points)));

  const withCats = allPlayers.filter((p) => p.cats.length);
  const catText = withCats.flatMap((p) => p.cats).join(' | ');
  if (withCats.length) pass(withCats.length + ' deep-data row(s) print per-category splits: ' + catText.slice(0, 190));
  else fail('no deep-data row printed a per-category split');
  if (/RUSH YDS|REC YDS|PASS YDS/.test(catText)) pass('the splits include real yardage');
  else fail('the splits include no yardage category: ' + catText);
  if (/TD/.test(catText)) pass('the splits include touchdowns');
  else fail('the splits include no touchdown category: ' + catText);

  const states = feed.blocks.flatMap((b) => b.scoreStates);
  if (states.length) pass('the live head-to-head rendered on ' + states.length + ' matchup(s): ' + JSON.stringify(states));
  else fail('no live head-to-head rendered on any timeline card');
  if (states.some((s) => /LIVE/.test(s))) pass('an open week is labelled LIVE on the card');
  else fail('no card labelled the open week LIVE: ' + JSON.stringify(states));
  const values = feed.blocks.flatMap((b) => b.scoreValues);
  if (values.some((v) => v === '74.6' || v === '91.3' || v === '88.8' || v === '61.2')) {
    pass('the head-to-head prints the real running scores: ' + JSON.stringify(values.slice(0, 6)));
  } else {
    fail('the head-to-head printed no recognizable running score: ' + JSON.stringify(values.slice(0, 8)));
  }

  expect(feed.snag, false, '"hit a snag" anywhere on the News Desk');

  /* Determinism in the DOM: a second paint of the same payload produces the
     same block, byte for byte. */
  await page.evaluate(() => window.__fsnRender());
  await page.waitForTimeout(600);
  const repaint = await page.evaluate(() => {
    const block = document.querySelector('#timelineFeed .tl-item .deepstat');
    return block ? block.outerHTML : '';
  });
  if (feed.blocks.length) {
    expect(repaint, feed.blocks[0].html, 'a repaint produces a byte-identical deep data block');
  }

  /* ======================================================================
     3. THE READER — the full block, below the copy and below the tables.
     ====================================================================== */
  console.log('\n[3] The reader: the full block below the copy and the tables');

  /* Every painted card, not just the first: the By-the-Numbers box differs by
     story type and only some carry a data table, so walking the whole feed is
     what actually proves the block lands below the tables rather than in the
     middle of them. */
  const readReader = () => page.evaluate(() => {
    const open = document.querySelector('#reader[data-open="true"]');
    if (!open) return { open: false };
    const body = document.querySelector('#readerBody .article-body');
    const block = document.querySelector('#readerBody .deepstat');
    if (!body) return { open: true, hasBody: false };
    if (!block) return { open: true, hasBody: true, hasBlock: false };
    const kids = Array.prototype.slice.call(body.children);
    const numbers = body.querySelector('.bynumbers');
    const table = body.querySelector('.bn-table');
    return {
      open: true,
      hasBody: true,
      hasBlock: true,
      compact: block.classList.contains('ds-compact'),
      directChild: block.parentElement === body,
      last: kids.indexOf(block) === kids.length - 1,
      afterNumbers: !numbers || kids.indexOf(numbers) < kids.indexOf(block),
      insideNumbers: !!block.closest('.bynumbers'),
      numbersHasBlock: !!(numbers && numbers.querySelector('.deepstat')),
      /* The existing table keeps its own shape: a By-the-Numbers table is
         still a thead/tbody table with nothing of ours nested inside it. */
      numbersPresent: !!numbers,
      numbersRows: numbers ? numbers.querySelectorAll('.bn-row').length : -1,
      tablePresent: !!table,
      tableNested: !!(table && table.querySelector('.deepstat')),
      tableHeaders: table ? table.querySelectorAll('thead th').length : -1,
      tableRows: table ? table.querySelectorAll('tbody tr').length : -1,
      local: (block.querySelector('.ds-local') || {}).textContent || '',
      players: block.querySelectorAll('.ds-player').length,
      cats: block.querySelectorAll('.ds-cat').length,
      scores: block.querySelectorAll('.ds-score').length,
      note: (block.querySelector('.ds-note') || {}).textContent || '',
      anchors: block.querySelectorAll('a, [href], img, iframe').length,
    };
  });

  const cardCount = await page.evaluate(() =>
    document.querySelectorAll('#timelineFeed .tl-item .tl-card').length);
  let opened = 0;
  let withBlock = 0;
  let withTable = 0;
  let withNumbers = 0;
  const readerFaults = [];
  for (let i = 0; i < cardCount; i++) {
    await page.evaluate((idx) => {
      const card = document.querySelectorAll('#timelineFeed .tl-item .tl-card')[idx];
      if (card) card.click();
    }, i);
    await page.waitForTimeout(320);
    const r = await readReader();
    if (!r.open) { readerFaults.push('card ' + i + ': the reader did not open'); continue; }
    opened++;
    if (!r.hasBody) { readerFaults.push('card ' + i + ': the reader painted no article body'); }
    else if (!r.hasBlock) { readerFaults.push('card ' + i + ': the reader painted no deep data block'); }
    else {
      withBlock++;
      if (r.compact) readerFaults.push('card ' + i + ': the reader used the compact feed variant');
      if (!r.directChild) readerFaults.push('card ' + i + ': the block is not a direct child of the article body');
      if (!r.last) readerFaults.push('card ' + i + ': the block is not the last thing in the article body');
      if (!r.afterNumbers) readerFaults.push('card ' + i + ': the block sits ABOVE the By-the-Numbers box');
      if (r.insideNumbers) readerFaults.push('card ' + i + ': the block is nested inside the By-the-Numbers box');
      if (r.numbersHasBlock) readerFaults.push('card ' + i + ': the By-the-Numbers box gained one of ours');
      if (r.anchors) readerFaults.push('card ' + i + ': the block carries ' + r.anchors + ' link(s) or external asset(s)');
      if (!r.players) readerFaults.push('card ' + i + ': the block named no players');
      if (!r.scores) readerFaults.push('card ' + i + ': the block printed no live head-to-head');
      if (!/Manager [1-4]/.test(r.local)) readerFaults.push('card ' + i + ': the block leads with no manager callout');
      if (!/box score|fantasy totals/i.test(r.note)) readerFaults.push('card ' + i + ': the block carries no provenance note');
      if (r.numbersPresent) {
        withNumbers++;
        if (!(r.numbersRows > 0)) {
          readerFaults.push('card ' + i + ': the By-the-Numbers box lost its rows (' + r.numbersRows + ')');
        }
      }
      if (r.tablePresent) {
        withTable++;
        if (r.tableNested) readerFaults.push('card ' + i + ': the existing data table gained a nested section');
        if (!(r.tableHeaders > 0 && r.tableRows > 0)) {
          readerFaults.push('card ' + i + ': the existing data table lost its structure (' +
            r.tableHeaders + ' headers, ' + r.tableRows + ' rows)');
        }
      }
    }
    await page.evaluate(() => {
      const close = document.querySelector('#readerClose') ||
        document.querySelector('#reader [data-reader-close]');
      if (close) close.click();
      else document.getElementById('reader').dataset.open = 'false';
    });
    await page.waitForTimeout(180);
  }

  expect(opened, cardCount, 'every timeline card opened its reader');
  expect(withBlock, cardCount, 'every reader carried the full deep data block');
  /* The By-the-Numbers box is the data table every deterministic story carries,
     and it must come through this change untouched: same box, same rows, with
     the new section strictly below it and nothing of ours nested inside.
     `.bn-table` itself is only emitted by payloads that supply numbers.table,
     which the deterministic generators do not, so it is asserted when present
     rather than required. */
  if (withNumbers > 0) pass(withNumbers + ' of ' + cardCount +
    ' stories carry a By-the-Numbers box, and every one kept its rows');
  else fail('no story in the feed rendered a By-the-Numbers box, so the ' +
    'table-preservation assertions never ran');
  if (withTable > 0) pass(withTable + ' story/stories also carried a .bn-table, and it kept its structure');
  else pass('no story in this feed supplies numbers.table; .bn-table has nothing to preserve here');
  if (!readerFaults.length) pass('every reader block sits below the copy and the tables, links out nowhere, ' +
    'names a manager, quotes stats and prints the live head-to-head');
  else readerFaults.forEach(fail);

  /* ======================================================================
     4. RUNTIME HEALTH
     ====================================================================== */
  console.log('\n[4] Runtime health');
  if (!pageErrors.length) pass('zero uncaught page errors');
  else fail(pageErrors.length + ' uncaught page error(s):\n    ' + pageErrors.join('\n    '));
  if (!consoleErrors.length) pass('zero tagged console errors');
  else fail(consoleErrors.length + ' tagged console error(s):\n    ' + consoleErrors.join('\n    '));
} catch (err) {
  failures++;
  console.error('\n[local-desk-check] the harness itself threw:');
  console.error(err);
} finally {
  await browser.close();
  server.close();
}

if (failures) {
  console.error('\n[local-desk-check] FAILED: ' + failures + ' assertion(s)');
  process.exit(1);
}
console.log('\n[local-desk-check] clean');
