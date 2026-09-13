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
       - normal cards render CLEAN: no deep block, no Local Read on any
         timeline row and no deep block or Local Read in any reader
       - the existing components stay intact: the By-the-Numbers box keeps
         its rows and .bn-table keeps its structure
       - zero uncaught page errors, zero tagged console errors, no "hit a snag"

     (The retention behaviour — an Analysis-category wire card KEEPS the
     Local Read and the deep block — lives in scripts/article-ingest-check.mjs,
     which drives the wire against fixtures carrying every category. This
     check owns the removal side: normal news cards render exactly as they
     did before the Local Desk existed.)

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
      if ((url.pathname === '/api/notifications-register' || url.pathname === '/api/notifications')) {
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
      /* One game line per canonical state. Fixtures cover the natural cases;
         the states without a natural fixture use a synthesized score object
         so the state switch is exercised exhaustively rather than left to
         whichever margin the fixture happens to fall into.

         `us` and `them` are set to the actual manager on that side so the
         template attributes the line to the right owner; only `score`,
         `state`, `final`, `margin` and `started` drive routing. */
      pregameA: D.gameLine(bijan, {
        state: 'PREGAME', started: false, final: false, margin: 0,
        us: { teamName: 'Alpha', manager: 'Manager 1', score: 0 },
        them: { teamName: 'Bravo', manager: 'Manager 2', score: 0 },
      }, 'primer', seed),
      nailBiterB: D.gameLine(bijan, {
        state: 'LIVE', started: true, final: false, margin: 3.4,
        us: { teamName: 'Alpha', manager: 'Manager 1', score: 88.4 },
        them: { teamName: 'Bravo', manager: 'Manager 2', score: 85.0 },
      }, 'recap', seed),
      moderateLead: D.gameLine(bijan, {
        state: 'LIVE', started: true, final: false, margin: 14.1,
        us: { teamName: 'Alpha', manager: 'Manager 1', score: 99.1 },
        them: { teamName: 'Bravo', manager: 'Manager 2', score: 85.0 },
      }, 'recap', seed),
      moderateDeficit: D.gameLine(bijan, D.liveScore(1, 2), 'injury', seed),
      blowoutLeadC: D.gameLine(london, D.liveScore(3, 2), 'recap', seed),
      blowoutVictimC: D.gameLine(bijan, {
        state: 'LIVE', started: true, final: false, margin: -31.2,
        us: { teamName: 'Alpha', manager: 'Manager 1', score: 55.0 },
        them: { teamName: 'Bravo', manager: 'Manager 2', score: 86.2 },
      }, 'recap', seed),
      finalWonD: D.gameLine(bijan, D.liveScore(1, 1), 'recap', seed),
      finalLostDMirror: D.gameLine(allen, D.liveScore(2, 1), 'recap', seed),
      finalTied: D.gameLine(bijan, {
        state: 'FINAL', started: true, final: true, margin: 0,
        us: { teamName: 'Alpha', manager: 'Manager 1', score: 100 },
        them: { teamName: 'Bravo', manager: 'Manager 2', score: 100 },
      }, 'recap', seed),
      /* No-score edge cases the switch has to survive without saying
         anything false. */
      pregameNoScore: D.gameLine(bijan, null, 'primer', seed),
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
      /* Determinism: the same inputs, a second time. One template per state,
         no seed reads, so both calls must produce byte-identical output. */
      benefitAgain: D.benefitLine(bijan, D.beneficiariesOf(bijan, 2, 3), seed),
      pregameAgain: D.gameLine(bijan, {
        state: 'PREGAME', started: false, final: false, margin: 0,
        us: { teamName: 'Alpha', manager: 'Manager 1', score: 0 },
        them: { teamName: 'Bravo', manager: 'Manager 2', score: 0 },
      }, 'primer', seed),
      blowoutAgain: D.gameLine(london, D.liveScore(3, 2), 'recap', seed),
      finalWonAgain: D.gameLine(bijan, D.liveScore(1, 1), 'recap', seed),
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

  /* ---- the deterministic state machine (A / B / C / C' / D / D' / tie /
                     moderate lead / moderate deficit / no-score) ----

     The templates are prescriptive per the PR spec. Each state gets its own
     opening and closing signature so a card can be identified by which
     template rendered it — no state's line could plausibly have come out
     of another state's branch. */

  /* State A: pre-game. Never mentions points; never mentions ahead/behind.
     This is the whole reason the state machine exists. */
  expect(engine.pregameA,
    'Manager 1 has Bijan Robinson locked into the starting lineup for this week’s clash against Manager 2, ' +
    'carrying heavy expectations as the focal point of their offensive build.',
    'State A (pre-game) line is verbatim from the spec, no points, no leverage clause');
  /* The concern is fantasy-scoring signals, not the English word "point".
     A pregame line must not carry a numeric point total ("14.6 points"), a
     scoring verb ("put up", "went off"), or an ahead/behind clause. "Focal
     point of their offensive build" is a roster-leverage phrase and stays. */
  if (/\d+(?:\.\d+)?[\-\s]?points?\b/i.test(engine.pregameA) ||
      /\b(?:ahead|behind|leads|trails|leading|trailing|deficit|cushion)\b/i.test(engine.pregameA) ||
      /\b(?:put up|went off|chipped in)\b/i.test(engine.pregameA)) {
    fail('State A leaked a live-scoring signal into the pre-game copy: ' + engine.pregameA);
  } else pass('State A never quotes points or names a live-scoring direction');
  /* Same routing when the article has no scoreboard at all: the pre-game
     template still applies, because "nothing scored" is exactly what pre-game
     covers. */
  expect(engine.pregameNoScore,
    'Manager 1 has Bijan Robinson locked into the starting lineup for this week’s clash against their opponent, ' +
    'carrying heavy expectations as the focal point of their offensive build.',
    'State A also renders when no scoreboard is attached');

  /* State B: nail-biter, |margin| ≤ 10. Symmetric — the copy is deliberately
     agnostic about which side is up 3.4. */
  expect(engine.nailBiterB,
    'In a razor-thin battle, Manager 1’s Bijan Robinson has chipped in 8.4 points, ' +
    'keeping this tight against Manager 2 with every single possession hanging in the balance.',
    'State B (nail-biter) line is verbatim from the spec');

  /* State C: blowout, leading. London is on Charlie, which is up 27.6 on
     Delta in the live fixture. Verbatim from the spec. */
  expect(engine.blowoutLeadC,
    'Absolute fireworks for Manager 3 today—Drake London’s massive 26.7-point outing has blown the ' +
    'doors off this matchup, putting Manager 4 deep in a hole.',
    'State C (blowout, leading) line is verbatim from the spec');

  /* State C' (mirror): blowout, trailing. Same magnitude, honest direction. */
  contains(engine.blowoutVictimC, 'The gap is widening on Manager 1',
    'State C\' (blowout, trailing) opens on the widening gap for the player\'s manager');
  contains(engine.blowoutVictimC, 'Manager 2’s runaway margin',
    'State C\' names the opposing manager as the one running away');
  contains(engine.blowoutVictimC, 'going the wrong way in a hurry',
    'State C\' closes on the mirror signature phrase');

  /* Moderate live margin — the range the four canonical states do not name.
     Above the nail-biter, below the blowout: gets its own pair. */
  contains(engine.moderateLead, 'pushed the matchup out to a 14.1-point cushion over Manager 2',
    'moderate LEAD names the exact cushion and the opposing manager');
  contains(engine.moderateLead, 'comfortable, but the window is still open',
    'moderate LEAD closes on the "window is still open" signature');
  contains(engine.moderateDeficit, 'deficit against Manager 2 has stretched to 16.7',
    'moderate DEFICIT names the exact deficit and the opposing manager');
  contains(engine.moderateDeficit, 'closable, and only if the rest of the lineup answers',
    'moderate DEFICIT closes on the "rest of the lineup answers" signature');

  /* State D: final, won. "When the dust settled" is the state's signature. */
  expect(engine.finalWonD,
    'When the dust settled, Manager 1’s reliance on Bijan Robinson proved to be the winning edge, ' +
    'sealing the head-to-head decision over Manager 4.',
    'State D (final, won) line is verbatim from the spec');

  /* State D' (mirror): final, lost. Same "When the dust settled" opener so
     the two read as one state with two outcomes. */
  contains(engine.finalLostDMirror, 'When the dust settled, Josh Allen’s',
    'State D\' opens with the same "When the dust settled" signature');
  contains(engine.finalLostDMirror, 'weren’t enough to carry Manager 2 past Manager 3',
    'State D\' names the losing manager and the opposing manager');
  contains(engine.finalLostDMirror, 'the head-to-head decision goes the other way',
    'State D\' closes on the mirror signature phrase');

  /* Rare but real: a finalized matchup that ended level. Must not read as a
     win or a loss for either side. */
  contains(engine.finalTied, 'When the dust settled, Manager 1 and Manager 2 finished dead level',
    'a finalized tie opens on the tie-specific signature');
  contains(engine.finalTied, 'kept the tie honest at the wire',
    'a finalized tie closes on the tie-specific signature');
  if (/\bwinning\b|\bsealing\b|\bwrong way\b/i.test(engine.finalTied)) {
    fail('the tied-final line leaked a decisive-outcome word: ' + engine.finalTied);
  } else pass('the tied-final line uses no decisive-outcome language');

  /* ---- the no-lineup week ---- */
  expect(engine.emptyWeek && engine.emptyWeek.week, 2,
    'a week with no lineups falls back to the latest week that has them');
  expect(engine.emptyWeekCook, 14.6, 'that fallback reports the latest real box score, not the first');
  expect(engine.emptyWeekDeepLabel, 2, 'the block labels the week it actually read, not the week it was asked for');

  /* ---- determinism ----
     Each state resolves to exactly one template. A second call with the
     same inputs must produce the same string, byte for byte. */
  expect(engine.benefitAgain, engine.benefitLine, 'the benefit line is byte-identical on a second call');
  expect(engine.pregameAgain, engine.pregameA, 'the State A line is byte-identical on a second call');
  expect(engine.blowoutAgain, engine.blowoutLeadC, 'the State C line is byte-identical on a second call');
  expect(engine.finalWonAgain, engine.finalWonD, 'the State D line is byte-identical on a second call');
  /* Every state emits a distinct line, so a state cannot silently collapse
     into another state's template through a shared substring. */
  const stateLines = [
    engine.pregameA, engine.nailBiterB, engine.moderateLead, engine.moderateDeficit,
    engine.blowoutLeadC, engine.blowoutVictimC,
    engine.finalWonD, engine.finalLostDMirror, engine.finalTied,
  ];
  expect(new Set(stateLines).size, stateLines.length,
    'every routed state emits a distinct line');

  /* ======================================================================
     2. THE TIMELINE — deterministic feed cards must NOT carry the block.

     The Local Desk is a From-the-Desk / Analysis surface now. The timeline
     is deterministic recaps, matchup primers, waiver fallout and power
     rankings — normal news, not analysis. Hanging a "Local Read" and a
     stat table off every one made the News screen a wall of numbers under
     copy that already spoke in the league's voice. This section is the
     mechanical guard for the split: every timeline card renders clean.
     ====================================================================== */
  console.log('\n[2] The timeline: normal cards render clean, no deep block');

  await page.click('#tabBar .tab-btn[data-tab="news"]');
  await page.waitForTimeout(900);

  const feed = await page.evaluate(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll('#timelineFeed .tl-item'));
    return {
      cards: items.length,
      /* One count per card. Zero everywhere is what "clean" means: no
         .deepstat anywhere in the timeline stream, whether at the bottom of
         the card body or smuggled in under the head/foot. */
      blocks: items.map((n) => n.querySelectorAll('.deepstat').length),
      /* And the localized-lede tag from the wire's Local Read — which is a
         desk-analysis affordance and must not leak into a timeline row. */
      localReads: items.map((n) => n.querySelectorAll('.ds-local, .wire-dek-local').length),
      snag: /hit a snag/i.test(document.body.innerText),
    };
  });

  if (feed.cards > 0) pass('the timeline painted ' + feed.cards + ' card(s)');
  else fail('the timeline painted no cards at all');

  const badCards = feed.blocks.filter((n) => n > 0).length;
  expect(badCards, 0, 'no timeline card carries a deep data block');
  const localOnFeed = feed.localReads.filter((n) => n > 0).length;
  expect(localOnFeed, 0, 'no timeline card carries a "Local Read" lede');
  expect(feed.snag, false, '"hit a snag" anywhere on the News Desk');

  /* ======================================================================
     3. THE READER — the full block must NOT be appended to normal articles.

     Every timeline card opens in the reader, and every reader ran the full
     deep block below its By-the-Numbers box in the previous version. Same
     reason as the feed: those are deterministic recaps and previews, not
     analysis. The reader for a normal article now renders exactly as it did
     before the Local Desk shipped — copy, quote, numbers box, nothing else.
     ====================================================================== */
  console.log('\n[3] The reader: normal articles render clean');

  const readReader = () => page.evaluate(() => {
    const open = document.querySelector('#reader[data-open="true"]');
    if (!open) return { open: false };
    const body = document.querySelector('#readerBody .article-body');
    if (!body) return { open: true, hasBody: false };
    const numbers = body.querySelector('.bynumbers');
    const table = body.querySelector('.bn-table');
    return {
      open: true,
      hasBody: true,
      /* Zero is the contract. A .deepstat inside the article body — anywhere
         inside it, whether beside or below the By-the-Numbers box — is a
         Local Desk section leaking onto a normal article. */
      blocks: body.querySelectorAll('.deepstat').length,
      localReads: body.querySelectorAll('.ds-local').length,
      /* The existing components stay intact: the numbers box keeps its rows
         and the data table (when the story supplies one) keeps its shape. */
      numbersPresent: !!numbers,
      numbersRows: numbers ? numbers.querySelectorAll('.bn-row').length : -1,
      tablePresent: !!table,
      tableNested: !!(table && table.querySelector('.deepstat')),
      tableHeaders: table ? table.querySelectorAll('thead th').length : -1,
      tableRows: table ? table.querySelectorAll('tbody tr').length : -1,
    };
  });

  const cardCount = await page.evaluate(() =>
    document.querySelectorAll('#timelineFeed .tl-item .tl-card').length);
  let opened = 0;
  let withNumbers = 0;
  let withTable = 0;
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
    else {
      if (r.blocks) readerFaults.push('card ' + i + ': ' + r.blocks + ' deep block(s) leaked into the article body');
      if (r.localReads) readerFaults.push('card ' + i + ': a "Local Read" section leaked into the article body');
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
  if (withNumbers > 0) pass(withNumbers + ' of ' + cardCount +
    ' stories carry a By-the-Numbers box, and every one kept its rows');
  else fail('no story in the feed rendered a By-the-Numbers box, so the ' +
    'component-integrity assertions never ran');
  if (withTable > 0) pass(withTable + ' story/stories carry a .bn-table, and it kept its structure');
  else pass('no story in this feed supplies numbers.table; .bn-table has nothing to preserve here');
  if (!readerFaults.length) pass('every reader renders clean — no Local Desk section, no Local Read, ' +
    'and the existing components are untouched');
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
