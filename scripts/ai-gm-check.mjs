#!/usr/bin/env node
/* ============================================================================
   FSN — AI GM BETA CHECK

   `node scripts/ai-gm-check.mjs`
   `node scripts/ai-gm-check.mjs --no-browser`    (skip the render pass)

   Four passes, in the order a failure is cheapest to diagnose:

     1. ENGINE      lib/ai-gm.js's exported helpers, offline, against a fixture
                    league built to have exactly one right answer: lineup
                    matching, projection parsing, positional headroom, buy
                    low / sell high, waiver ranking, FAB sizing, priority
                    advice, and byte-for-byte determinism.

     2. HANDLER     the serverless entry, driven with a stub
                    resolveStoredLeagueAccess and a stub global fetch, so the
                    private-access gate, the "no stored session" paths and the
                    Supabase-cookie read are all asserted without Supabase,
                    without ESPN and without a deployment.

     3. BUDGET      the function limits this feature had to be built around:
                    12 files under api/, the /api/ai-gm rewrite resolving to a
                    real function, and no new file added. This is the check
                    that a thirteenth handler would have failed the DEPLOY, not
                    the build.

     4. RENDER      index.html in Chromium: the entry card's league gate, the
                    modal, every renderer driven against the fixture analysis,
                    the Copy Pitch clipboard, and zero tagged console errors.

   Exit code 0 means clean.
============================================================================ */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const noBrowser = process.argv.slice(2).includes('--no-browser');

let failures = 0;
const pass = (msg) => console.log('  ok    ' + msg);
const fail = (msg, detail) => {
  failures++;
  console.log('  FAIL  ' + msg + (detail ? ' — ' + detail : ''));
};
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) < (tol == null ? 1e-9 : tol);

const gm = require('../lib/ai-gm.js');

/* ============================================================================
   THE FIXTURE

   Twelve teams, because the feature's whole claim is "across all 11 opposing
   rosters" and a three-team fixture would never exercise the partner spread or
   the search budget.

   Three of them are shaped deliberately:
     team 1  MINE — WR-rich, RB-poor. A third startable WR already occupies the
             FLEX, and the RB2 is replacement level. One bench WR is running hot
             against his own pre-season forecast: the Sell High chip.
     team 2  The mirror image — RB depth on the bench, a hole at WR2 — AND a
             losing record with a high-pedigree, high-usage RB badly
             underperforming: the Buy Low target.
     team 3  Flat. Nothing spare, no hole. It must generate no offer.
   Teams 4-12 are filler at league-median level, so the benchmarks are real and
   the search has eleven opponents to walk.
============================================================================ */

let nextPlayerId = 1000;

function statRow(week, points) {
  return { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: week, appliedTotal: points };
}
function seasonForecast(total) {
  return { statSourceId: 1, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: total };
}
function actualRow(week, points) {
  return { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: week, appliedTotal: points };
}

/* One roster entry. `opts` carries only what a specific assertion needs, so a
   plain player has no pedigree, no ownership and no history and is therefore
   never eligible for a buy-low or sell-high label by accident. */
function entry(name, posId, eligibleSlots, projection, lineupSlotId, opts) {
  const o = opts || {};
  const stats = [statRow(o.week == null ? 1 : o.week, projection)];
  if (o.seasonTotal != null) stats.push(seasonForecast(o.seasonTotal));
  if (Array.isArray(o.actuals)) o.actuals.forEach((pts, i) => stats.push(actualRow(i + 1, pts)));
  return {
    lineupSlotId: lineupSlotId,
    playerPoolEntry: {
      player: {
        id: o.id != null ? o.id : nextPlayerId++,
        fullName: name,
        defaultPositionId: posId,
        proTeamId: o.proTeamId == null ? 12 : o.proTeamId,
        eligibleSlots: eligibleSlots,
        injuryStatus: o.injury || 'ACTIVE',
        stats: stats,
        draftRanksByRankType: o.draftRank == null ? undefined : { PPR: { rank: o.draftRank } },
        ownership: (o.percentOwned == null && o.percentStarted == null) ? undefined : {
          percentOwned: o.percentOwned == null ? 0 : o.percentOwned,
          percentStarted: o.percentStarted == null ? 0 : o.percentStarted,
          percentChange: o.percentChange == null ? 0 : o.percentChange,
        },
      },
    },
  };
}

const QB = (n, p, s, o) => entry(n, 1, [0, 7, 20], p, s, o);
const RB = (n, p, s, o) => entry(n, 2, [2, 3, 7, 23, 20], p, s, o);
const WR = (n, p, s, o) => entry(n, 3, [3, 4, 5, 7, 23, 20], p, s, o);
const TE = (n, p, s, o) => entry(n, 4, [5, 6, 7, 23, 20], p, s, o);

function fillerTeam(id, seed) {
  return {
    id: id,
    name: 'Filler ' + id,
    abbrev: 'F' + id,
    primaryOwner: '{F' + id + '}',
    owners: ['{F' + id + '}'],
    record: { overall: { wins: 3, losses: 3, ties: 0 } },
    waiverRank: id,
    transactionCounter: { acquisitionBudgetSpent: 10 },
    roster: { entries: [
      QB('Filler QB ' + id, 15 + seed, 0),
      RB('Filler RB1 ' + id, 12 + seed, 2),
      RB('Filler RB2 ' + id, 10 + seed, 2),
      WR('Filler WR1 ' + id, 12 + seed, 4),
      WR('Filler WR2 ' + id, 10 + seed, 4),
      TE('Filler TE ' + id, 8 + seed, 6),
      WR('Filler FLEX ' + id, 9 + seed, 23),
      RB('Filler Bench ' + id, 6 + seed, 20),
    ] },
  };
}

function fixtureLeague() {
  nextPlayerId = 1000;
  const teams = [
    {
      id: 1, name: 'My Squad', abbrev: 'MINE', primaryOwner: '{AAAA}', owners: ['{AAAA}'],
      record: { overall: { wins: 2, losses: 4, ties: 0, pointsFor: 600, pointsAgainst: 660 } },
      waiverRank: 9,
      transactionCounter: { acquisitionBudgetSpent: 40 },
      roster: { entries: [
        QB('Ace Arm', 20, 0),
        RB('Bell Cow', 16, 2),
        RB('Scrub Back', 3, 2),
        WR('Alpha Wide', 18, 4),
        WR('Beta Wide', 16, 4),
        WR('Gamma Wide', 14, 23),
        TE('Tight One', 9, 6),
        /* THE SELL HIGH CHIP: on the bench, and returning 14.0 against an 8.8
           pre-season forecast (150 / 17) across five games. */
        WR('Delta Wide', 12, 20, {
          seasonTotal: 150, actuals: [14, 14, 14, 14, 14],
          percentOwned: 60, percentStarted: 55, draftRank: 80,
        }),
        RB('Deep Cut', 2, 20),
      ] },
    },
    {
      id: 2, name: 'Ground Game', abbrev: 'GRND', primaryOwner: '{BBBB}', owners: ['{BBBB}'],
      /* A losing record, which is the fourth condition a buy-low target needs. */
      record: { overall: { wins: 1, losses: 5, ties: 0, pointsFor: 520, pointsAgainst: 700 } },
      waiverRank: 2,
      transactionCounter: { acquisitionBudgetSpent: 5 },
      roster: { entries: [
        QB('Second Arm', 18, 0),
        /* THE BUY LOW TARGET: ESPN rank 8, started in 92% of leagues, and
           returning 9.0 against a 17.6 forecast (300 / 17) over six games. */
        RB('Thunder', 17, 2, {
          seasonTotal: 300, actuals: [9, 9, 9, 9, 9, 9],
          draftRank: 8, percentOwned: 99, percentStarted: 92,
        }),
        RB('Lightning', 15, 2),
        RB('Third Down', 13, 23),
        RB('Handcuff', 11, 20),
        WR('Lone Wide', 15, 4),
        WR('Weak Wide', 4, 4),
        TE('Tight Two', 8, 6),
      ] },
    },
    {
      id: 3, name: 'Replacement Level', abbrev: 'REPL', primaryOwner: '{CCCC}', owners: ['{CCCC}'],
      record: { overall: { wins: 3, losses: 3, ties: 0 } },
      waiverRank: 5,
      transactionCounter: { acquisitionBudgetSpent: 0 },
      roster: { entries: [
        QB('Flat QB', 10, 0),
        RB('Flat RB1', 8, 2),
        RB('Flat RB2', 8, 2),
        WR('Flat WR1', 8, 4),
        WR('Flat WR2', 8, 4),
        TE('Flat TE', 8, 6),
        WR('Flat FLEX', 8, 23),
      ] },
    },
  ];
  for (let id = 4; id <= 12; id++) teams.push(fillerTeam(id, (id % 3) - 1));

  return {
    id: 57155288,
    seasonId: 2026,
    scoringPeriodId: 1,
    settings: {
      name: 'AI GM Test League',
      rosterSettings: { lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 20: 6, 21: 1 } },
      acquisitionSettings: { acquisitionType: 'WAIVERS_FAB', acquisitionBudget: 100, waiverHours: 24 },
    },
    members: [
      { id: '{AAAA}', displayName: 'me_handle', firstName: 'Lee', lastName: 'Rand' },
      { id: '{BBBB}', displayName: 'rbrich', firstName: 'Pat', lastName: 'Bench' },
      { id: '{CCCC}', displayName: 'flat', firstName: 'Sam', lastName: 'Even' },
    ],
    teams: teams,
  };
}

/* The waiver pool, in the shape kona_player_info returns: the card nested under
   `player`, ownership at the row, and `onTeamId: 0` for genuinely available. */
function fixturePool() {
  return {
    id: 57155288,
    players: [
      {
        id: 5001, onTeamId: 0, status: 'FREEAGENT',
        player: {
          id: 5001, fullName: 'Waiver Back', defaultPositionId: 2, proTeamId: 9,
          eligibleSlots: [2, 3, 7, 23, 20], injuryStatus: 'ACTIVE',
          stats: [statRow(1, 13)],
          ownership: { percentOwned: 22, percentStarted: 12, percentChange: 9 },
        },
      },
      {
        id: 5002, onTeamId: 0, status: 'WAIVERS',
        player: {
          id: 5002, fullName: 'Waiver Wideout', defaultPositionId: 3, proTeamId: 21,
          eligibleSlots: [3, 4, 5, 7, 23, 20], injuryStatus: 'QUESTIONABLE',
          stats: [statRow(1, 4)],
          ownership: { percentOwned: 8, percentStarted: 2, percentChange: 1 },
        },
      },
      {
        /* Already rostered: the filter asked for free agents, but ESPN has
           answered a stale ownership stamp before. It must be dropped. */
        id: 5003, onTeamId: 7, status: 'ONTEAM',
        player: {
          id: 5003, fullName: 'Not Actually Free', defaultPositionId: 2, proTeamId: 1,
          eligibleSlots: [2, 23, 20], stats: [statRow(1, 25)],
          ownership: { percentOwned: 99, percentStarted: 98, percentChange: 0 },
        },
      },
    ],
  };
}

/* proTeamId 9 = GB, on bye in week 3 — the same position the fixture's lineup
   needs, so the bye-coverage reasoning has something true to say. */
const fixtureByes = { 9: 3, 12: 5, 21: 7 };

const baseOptions = {
  week: 1, season: 2026, team: '1', swid: '{AAAA}',
  poolSize: 8, limit: 4, waiverLimit: 6, minPartnerGain: 0.5,
  /* Determinism assertions are only meaningful with the clock out of the loop. */
  deadlineMs: 0,
};

function buildAnalysis(overrides) {
  return gm.analyze(
    {
      league: fixtureLeague(),
      freeAgents: gm.freeAgentsFrom(fixturePool(), 1, fixtureByes),
      byeWeeks: fixtureByes,
    },
    Object.assign({}, baseOptions, overrides || {}),
  );
}

/* ============================================================================
   PASS 1 — ENGINE
============================================================================ */
function checkEngine() {
  console.log('\n[ai-gm-check] 1/4  engine helpers (lib/ai-gm.js)\n');

  /* ---- the gate ---- */
  if (gm.isAiGmLeague('57155288')) pass('the allowlisted league passes the gate');
  else fail('the allowlisted league is refused by its own gate');

  const refused = ['12345', '5715528', '571552880', '', null, undefined, 'abc',
    ' 57155288 ', '57155288x', '0057155288'];
  const leaked = refused.filter((id) => gm.isAiGmLeague(id) && String(id).trim() !== '57155288');
  if (!leaked.length) pass('every other league id is refused, including near-misses and padding');
  else fail('the gate admits a league it should not', JSON.stringify(leaked));
  /* A whitespace-padded copy of the real id SHOULD pass — it normalises to the
     same league — and that is asserted separately so the line above cannot
     accidentally be the thing that makes this vacuous. */
  if (gm.isAiGmLeague(' 57155288 ')) pass('whitespace around the real id still resolves to it');
  else fail('a padded copy of the allowlisted id is refused');

  /* ---- lineup math ---- */
  const slots = [0, 2, 2, 4, 4, 6, 23];
  const P = (id, pos, projection, eligibleSlots) => ({
    id: id, name: id, pos: pos, proTeam: 'KC', injury: 'ACTIVE',
    eligibleSlots: eligibleSlots, projection: projection, benched: false,
  });

  const simple = gm.optimalLineup([
    P('q', 'QB', 20, [0]), P('r1', 'RB', 16, [2, 23]), P('r2', 'RB', 3, [2, 23]),
    P('w1', 'WR', 18, [4, 23]), P('w2', 'WR', 16, [4, 23]), P('w3', 'WR', 14, [4, 23]),
    P('t', 'TE', 9, [6, 23]),
  ], slots);
  if (near(simple.points, 96)) pass('optimal lineup seats the third WR in FLEX (96.0)');
  else fail('optimal lineup', 'got ' + simple.points + ', expected 96');

  /* The case a most-constrained-slot-first filler gets wrong: RB/WR (3) and
     WR/TE (5) overlap without nesting, so only an exact matching finds 30. */
  const crossed = gm.optimalLineup(
    [P('wr', 'WR', 20, [3, 4, 5]), P('te', 'TE', 10, [5, 6])], [3, 5],
  );
  if (near(crossed.points, 30)) pass('non-nested slots (RB/WR + WR/TE) are matched exactly');
  else fail('non-nested slot matching', 'got ' + crossed.points + ', expected 30');

  const unfillable = gm.optimalLineup([P('q', 'QB', 20, [0])], [0, 2]);
  if (unfillable.lineup[1].player === null && near(unfillable.points, 20)) {
    pass('an unfillable slot scores zero and reports an empty seat, not a crash');
  } else fail('unfillable slot');

  const noEligibility = gm.optimalLineup([
    { id: 'a', name: 'a', pos: 'RB', eligibleSlots: null, projection: 12, injury: 'ACTIVE' },
    { id: 'b', name: 'b', pos: 'WR', eligibleSlots: null, projection: 9, injury: 'ACTIVE' },
  ], [2, 23]);
  if (near(noEligibility.points, 21)) pass('a card without eligibleSlots falls back to its position');
  else fail('eligibility fallback', 'got ' + noEligibility.points + ', expected 21');

  if (gm.lineupPoints([], slots) === 0) pass('an empty roster scores 0 rather than throwing');
  else fail('empty roster');

  /* ---- the memoised solver must not change a single number ---- */
  const roster = [
    P('q', 'QB', 20, [0]), P('r1', 'RB', 16, [2, 23]), P('w1', 'WR', 18, [4, 23]),
    P('w2', 'WR', 16, [4, 23]), P('w3', 'WR', 14, [4, 23]), P('t', 'TE', 9, [6, 23]),
  ];
  const solver = gm.lineupSolver(slots);
  if (near(solver(roster), gm.lineupPoints(roster, slots)) &&
      near(solver(roster), gm.lineupPoints(roster, slots))) {
    pass('the memoised solver agrees with the direct solve, cold and warm');
  } else fail('lineup solver cache changes the answer');
  /* Two different sets whose ids sort to different keys must not collide. */
  const shorter = roster.slice(0, 4);
  if (!near(solver(shorter), solver(roster))) pass('the solver cache keys on the exact player set');
  else fail('solver cache collision', 'two different rosters returned the same score');

  /* ---- projections and actuals ---- */
  const exact = gm.projectionFor({ playerPoolEntry: { player: { stats: [
    { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 11 },
    { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 7, appliedTotal: 22 },
    { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 7, appliedTotal: 99 },
  ] } } }, 7);
  if (near(exact, 22)) pass('week 7 forecast is read, not week 3 and not week 7 actuals');
  else fail('weekly projection', 'got ' + exact);

  const seasonOnly = gm.projectionFor({ playerPoolEntry: { player: { stats: [
    { statSourceId: 1, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: 170 },
  ] } } }, 4);
  if (near(seasonOnly, 10)) pass('a season-only forecast falls back to a per-week share');
  else fail('season projection fallback', 'got ' + seasonOnly);

  if (gm.projectionFor({ playerPoolEntry: { player: { stats: [] } } }, 4) === null) {
    pass('no forecast returns null rather than a fabricated number');
  } else fail('missing projection');

  const acts = gm.actualsFor({ playerPoolEntry: { player: { stats: [
    { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 1, appliedTotal: 10 },
    { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 2, appliedTotal: 20 },
    { statSourceId: 0, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: 999 },
    { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 500 },
  ] } } });
  if (acts.games === 2 && near(acts.total, 30) && near(acts.ppg, 15)) {
    pass('actuals sum weekly results only — not the season aggregate, not a forecast');
  } else fail('actuals', JSON.stringify(acts));

  if (gm.actualsFor({ playerPoolEntry: { player: { stats: [] } } }).ppg === null) {
    pass('a player who has not played reports ppg null, never 0.0');
  } else fail('actuals for an unplayed player');

  if (near(gm.seasonBaselinePerGame({ playerPoolEntry: { player: { stats: [seasonForecast(170)] } } }), 10)) {
    pass('the pre-season baseline is the season forecast over 17 games');
  } else fail('season baseline');

  if (gm.draftRankOf({ draftRanksByRankType: { PPR: { rank: 8 } } }) === 8 &&
      gm.draftRankOf({ draftRanksByRankType: { STANDARD: { rank: 41 } } }) === 41 &&
      gm.draftRankOf({}) === null) {
    pass('draft pedigree reads PPR then STANDARD, and is null when absent');
  } else fail('draft rank');

  /* ---- the league's own lineup, not a template ---- */
  const slotRead = gm.lineupSlotIds(fixtureLeague());
  if (slotRead.ids.join(',') === '0,2,2,4,4,6,23' && !slotRead.fallback) {
    pass('starting slots are read from lineupSlotCounts, bench and IR excluded');
  } else fail('lineup slot read', slotRead.ids.join(',') + ' fallback=' + slotRead.fallback);

  const noSettings = gm.lineupSlotIds({ id: 1, settings: {} });
  if (noSettings.fallback && noSettings.ids.length === 9) {
    pass('an unreadable settings payload falls back to the standard template and says so');
  } else fail('slot fallback');

  if (gm.benchSlotCapacity(fixtureLeague()) === 7) pass('bench capacity counts BN + IR (7)');
  else fail('bench capacity', String(gm.benchSlotCapacity(fixtureLeague())));

  const rules = gm.acquisitionRules(fixtureLeague());
  if (rules.usesFab && rules.budget === 100) pass('FAB rules are read from acquisitionSettings');
  else fail('acquisition rules', JSON.stringify(rules));
  const priorityLeague = gm.acquisitionRules({ settings: { acquisitionSettings: { acquisitionType: 'WAIVERS' } } });
  if (!priorityLeague.usesFab) pass('a rolling-priority league is not told to bid money');
  else fail('acquisition rules misread a priority league as FAB');
}

/* ============================================================================
   PASS 1b — THE MODELS ON THE FIXTURE
============================================================================ */
function checkModels() {
  console.log('\n[ai-gm-check] 1b/4  headroom, buy low / sell high, waivers\n');

  const state = gm.normalize(fixtureLeague(), { week: 1, byeWeeks: fixtureByes });
  if (state.teams.length === 12) pass('all twelve rosters normalise');
  else fail('normalise', state.teams.length + ' teams');
  /* The fixture league starts 1 QB / 2 RB / 2 WR / 1 TE / 1 FLEX = 7, and
     benches 6 BN + 1 IR = 7. Capacity is those two summed, read from the
     league's own slot counts and never a default. */
  if (state.rosterCapacity === 14) pass('roster capacity = 7 starting + 7 bench, from the league\'s own counts');
  else fail('roster capacity', String(state.rosterCapacity) + ', expected 14');

  const me = gm.resolveMyTeam(state, '', '{AAAA}');
  if (me && me.name === 'My Squad') pass('my team resolves from the STORED SWID, with no team named');
  else fail('swid team resolution', me ? me.name : 'null');
  if (gm.resolveMyTeam(state, '', '{ZZZZ}') === null) {
    pass('an unknown SWID resolves to null rather than guessing a roster');
  } else fail('swid resolution guessed a team');

  const solve = gm.lineupSolver(state.slotIds);
  const read = gm.teamRead(me, state.slotIds, state.benchmarks, solve);

  /* The regression the whole needs model exists for: ranking the deficit by
     "what would I lose if this starter vanished" names QB — the one position on
     this roster that is a strength — because the elite QB has no backup and the
     replacement-level RB2 does. Upgrade headroom names RB, which is the hole. */
  if (read.needs[0].pos === 'RB') pass('the RB hole is named as the biggest deficit');
  else fail('deficit detection', 'got ' + read.needs[0].pos + ' (' +
    read.needs.map((r) => r.pos + ' +' + r.needValue.toFixed(2)).join(', ') + ')');
  if (read.profile.QB.needValue === 0) pass('the elite QB is not mistaken for a need');
  else fail('QB scored as a need', '+' + read.profile.QB.needValue);
  if (read.profile.WR.rostered === 4 && read.profile.WR.starting === 3) {
    pass('WR surplus is seen: 4 rostered, 3 already starting');
  } else fail('surplus detection', JSON.stringify({
    rostered: read.profile.WR.rostered, starting: read.profile.WR.starting,
  }));
  if (read.surplus[0].pos === 'WR') pass('WR is named as the clearest surplus');
  else fail('surplus ranking', 'got ' + read.surplus[0].pos);

  /* needValue must be exactly the lineup delta a median starter produces — the
     one claim the UI puts on screen as "+N.N". Recomputed here from the solver
     directly so a change to positionProfile cannot quietly redefine it. */
  const base = solve(me.players);
  const phantom = {
    id: '__probe_RB__', name: 'probe', pos: 'RB', eligibleSlots: null,
    injury: 'ACTIVE', projection: state.benchmarks.RB, benched: false,
  };
  if (near(read.profile.RB.needValue, solve(me.players.concat([phantom])) - base, 1e-6)) {
    pass('needValue is literally the lineup delta of a median starter at that position');
  } else fail('needValue definition drifted from the lineup delta');

  /* ---- buy low / sell high ---- */
  const buyLow = gm.buyLowCandidates(state, me.id);
  const thunder = buyLow.find((r) => r.name === 'Thunder');
  if (thunder) pass('the underperforming high-pedigree RB on the losing roster is a Buy Low target');
  else fail('buy low', 'Thunder was not found in ' + JSON.stringify(buyLow.map((r) => r.name)));
  if (thunder && near(thunder.shortfall, 8.6, 0.1)) {
    pass('the Buy Low shortfall is the real gap (9.0 actual vs 17.6 forecast)');
  } else fail('buy low shortfall', thunder ? String(thunder.shortfall) : 'n/a');
  if (!buyLow.some((r) => r.teamId === me.id)) pass('no player on my own roster is a Buy Low target');
  else fail('buy low included my own roster');
  /* The four conditions, each removed in turn. Any one of them alone is noise,
     and a model that fires on three is a model that recommends hurt players. */
  const noPedigree = gm.buyLowCandidates(gm.normalize((() => {
    const l = fixtureLeague();
    l.teams[1].roster.entries[1].playerPoolEntry.player.draftRanksByRankType = { PPR: { rank: 400 } };
    return l;
  })(), { week: 1 }), '1');
  if (!noPedigree.some((r) => r.name === 'Thunder')) {
    pass('a slumping player with no draft pedigree is NOT called a Buy Low');
  } else fail('buy low fired without pedigree');
  const benched = gm.buyLowCandidates(gm.normalize((() => {
    const l = fixtureLeague();
    l.teams[1].roster.entries[1].playerPoolEntry.player.ownership.percentStarted = 4;
    return l;
  })(), { week: 1 }), '1');
  if (!benched.some((r) => r.name === 'Thunder')) {
    pass('a slumping player the league has stopped starting is NOT called a Buy Low');
  } else fail('buy low fired on an abandoned player');
  const winning = gm.buyLowCandidates(gm.normalize((() => {
    const l = fixtureLeague();
    l.teams[1].record.overall = { wins: 5, losses: 1, ties: 0 };
    return l;
  })(), { week: 1 }), '1');
  if (!winning.some((r) => r.name === 'Thunder')) {
    pass('a slump on a WINNING roster is NOT called a Buy Low — that manager is not selling');
  } else fail('buy low fired on a winning roster');

  const sellHigh = gm.sellHighCandidates(me, read);
  const delta = sellHigh.find((r) => r.name === 'Delta Wide');
  if (delta) pass('the hot bench WR is a Sell High chip');
  else fail('sell high', JSON.stringify(sellHigh.map((r) => r.name)));
  if (delta && delta.role === 'bench') pass('the chip is correctly labelled a bench asset');
  else fail('sell high role', delta ? delta.role : 'n/a');
  if (!sellHigh.some((r) => read.starters.has(r.playerId) && r.role === 'bench')) {
    pass('no player in my optimal lineup is labelled a bench chip');
  } else fail('sell high mislabelled a starter as bench depth');

  /* ---- waivers ---- */
  const pool = gm.freeAgentsFrom(fixturePool(), 1, fixtureByes);
  if (pool.length === 2) pass('the waiver pool drops the already-rostered row (2 of 3 available)');
  else fail('free agent parse', pool.length + ' players');
  if (pool.every((p) => p.name !== 'Not Actually Free')) pass('a row stamped with a team id is excluded');
  else fail('a rostered player reached the waiver board');
  const backOnBye = pool.find((p) => p.name === 'Waiver Back');
  if (backOnBye && backOnBye.byeWeek === 3) pass('a free agent carries his pro team\'s bye week');
  else fail('bye week join', backOnBye ? String(backOnBye.byeWeek) : 'n/a');

  const waivers = gm.rankWaiverTargets(state, me, read, pool, { limit: 6, byeWeeks: fixtureByes });
  if (waivers.board.length === 2) pass('the board ranks every available player');
  else fail('waiver board size', String(waivers.board.length));
  if (waivers.board[0].name === 'Waiver Back') {
    pass('the RB is ranked first — it is the position this lineup actually has headroom at');
  } else fail('waiver ranking', waivers.board[0].name);
  if (waivers.board[0].lineupGain > 0.05) {
    pass('the top claim carries a real lineup delta (+' + waivers.board[0].lineupGain + ')');
  } else fail('waiver lineup gain', String(waivers.board[0].lineupGain));
  if (waivers.board[1].lineupGain === 0 &&
      /Speculative|does not crack/i.test(waivers.board[1].reasons.join(' '))) {
    pass('a claim worth nothing to the lineup says so instead of being ranked as an upgrade');
  } else fail('waiver honesty', JSON.stringify(waivers.board[1].reasons));
  if (waivers.context.fabRemaining === 60) pass('FAB remaining is budget minus spent (100 - 40)');
  else fail('fab remaining', String(waivers.context.fabRemaining));
  if (waivers.context.openRosterSpots === 5) pass('open roster spots = capacity 14 - 9 rostered');
  else fail('open roster spots', String(waivers.context.openRosterSpots) + ', expected 5');
  if (gm.openRosterSpots(me, null) === null) {
    pass('an unreadable roster capacity yields null rather than a guessed number of spots');
  } else fail('open roster spots invented a number with no capacity');
  if (waivers.board[0].fab && waivers.board[0].fab.amount > 0 &&
      waivers.board[0].fab.amount <= waivers.context.fabRemaining) {
    pass('the suggested bid is positive and never exceeds the budget left');
  } else fail('fab bid', JSON.stringify(waivers.board[0].fab));
  if (waivers.board[1].fab && waivers.board[1].fab.speculative) {
    pass('a speculative add is a minimum bid, not a percentage of the budget');
  } else fail('speculative bid', JSON.stringify(waivers.board[1].fab));

  /* The bid ceiling. Half of what is left, never more — the one week you are
     certain about is never the last week you will need money. */
  const overs = [];
  for (const remaining of [1, 5, 37, 100]) {
    for (const urgency of [0, 0.5, 1]) {
      const bid = gm.suggestFab(50, 50, remaining, urgency);
      if (bid && bid.amount > Math.max(1, remaining * 0.5)) overs.push(remaining + '/' + urgency + '=' + bid.amount);
    }
  }
  if (!overs.length) pass('no FAB suggestion ever exceeds half the remaining budget');
  else fail('fab ceiling breached', overs.join(', '));
  if (gm.suggestFab(5, 5, null, 0.5) === null) pass('no budget means no bid advice, not a guessed one');
  else fail('fab with no budget');

  /* Urgency must actually respond to a losing record, or the whole term is
     decoration. */
  const losing = gm.claimUrgency(me, state, [], 7);
  const winner = gm.claimUrgency(Object.assign({}, me, { wins: 5, losses: 1, winPct: 5 / 6 }), state, [], 7);
  if (losing > winner) pass('a losing record raises claim urgency above a winning one');
  else fail('claim urgency', 'losing ' + losing + ' vs winning ' + winner);
  const pressured = gm.claimUrgency(Object.assign({}, me, { players: me.players }), state,
    [{ week: 2, starters: [], positions: ['RB'] }], 0);
  if (pressured !== losing) pass('bye exposure and a full roster both move urgency');
  else fail('urgency ignores byes and roster pressure');
  const clamped = [gm.claimUrgency(me, state, [{ week: 2, positions: [] }, { week: 3, positions: [] },
    { week: 4, positions: [] }], 12)];
  if (clamped.every((u) => u >= 0 && u <= 1)) pass('urgency stays inside [0, 1]');
  else fail('urgency clamp', JSON.stringify(clamped));

  const spend = gm.priorityAdvice(3.0, 1, 12);
  const hold = gm.priorityAdvice(1.0, 1, 12);
  if (spend.spend && !hold.spend) {
    pass('waiver priority is spent on a lineup upgrade and held for marginal depth');
  } else fail('priority advice', JSON.stringify({ spend: spend.spend, hold: hold.spend }));
  if (gm.priorityAdvice(1.0, 11, 12).spend) {
    pass('a late waiver position is not hoarded for a small gain');
  } else fail('priority advice ignores position');

  const byeRows = gm.upcomingByeExposure(me, read, { 12: 2 }, 1, 3);
  if (byeRows.length && byeRows[0].week === 2 && byeRows[0].starters.length) {
    pass('upcoming byes name the exact starters missing that week');
  } else fail('bye exposure', JSON.stringify(byeRows));
  if (!gm.upcomingByeExposure(me, read, {}, 1, 3).length) {
    pass('no bye data yields no bye claims rather than invented ones');
  } else fail('bye exposure invented rows');
}

/* ============================================================================
   PASS 1c — MATCHMAKING, PITCHES AND DETERMINISM
============================================================================ */
function checkMatchmaking() {
  console.log('\n[ai-gm-check] 1c/4  trade matchmaking, pitch coherence, determinism\n');

  const analysis = buildAnalysis();

  if (analysis.search.rostersAnalyzed === 11 && analysis.search.rostersTotal === 11) {
    pass('all eleven opposing rosters were re-solved');
  } else fail('roster coverage', analysis.search.rostersAnalyzed + ' of ' + analysis.search.rostersTotal);
  if (!analysis.search.truncated) pass('the search completed inside its budget');
  else fail('the search truncated on a twelve-team fixture');

  if (analysis.trades.length) pass(analysis.trades.length + ' proposal(s) from ' +
    analysis.search.twoWayPositive + ' win-win packages (' + analysis.search.packagesConsidered +
    ' re-solved)');
  else fail('offer generation', 'none found on a fixture built to have one');

  /* THE central claim of the feature. Every proposal on screen must raise both
     lineups — anything else is a proposal the other manager declines. */
  const oneSided = analysis.trades.filter((t) => !(t.myLineup.gain > 0) || !(t.theirLineup.gain > 0));
  if (!oneSided.length) pass('every proposal raises BOTH teams\' optimal lineups');
  else fail('one-sided proposal survived', JSON.stringify(oneSided.map((t) => t.id)));

  const belowFloor = analysis.trades.filter((t) => t.theirLineup.gain < 0.5);
  if (!belowFloor.length) pass('every proposal clears the partner gain floor (0.5 pts/wk)');
  else fail('partner floor', belowFloor.length + ' below it');

  /* The ledger must be arithmetic, not decoration: after - before = gain, on
     both sides, for every proposal. */
  const badLedger = analysis.trades.filter((t) =>
    !near(t.myLineup.after - t.myLineup.before, t.myLineup.gain, 0.051) ||
    !near(t.theirLineup.after - t.theirLineup.before, t.theirLineup.gain, 0.051));
  if (!badLedger.length) pass('both ledgers reconcile: after − before = the stated delta');
  else fail('ledger arithmetic', JSON.stringify(badLedger.map((t) => t.id)));

  let ranked = true;
  for (let i = 1; i < analysis.trades.length; i++) {
    if (analysis.trades[i].myLineup.gain > analysis.trades[i - 1].myLineup.gain + 1e-9) ranked = false;
  }
  if (ranked) pass('proposals are ordered by my own lineup gain, best first');
  else fail('proposal ranking');

  const partners = analysis.trades.map((t) => t.targetTeam.id);
  if (new Set(partners).size === partners.length) {
    pass('proposals spread across distinct trade partners — one conversation each');
  } else fail('partner spread', partners.join(','));

  const top = analysis.trades[0];
  if (top && top.targetTeam.id === '2') pass('the inverse-need roster is the top partner');
  else fail('matchmaking', 'top partner was ' + (top && top.targetTeam.name));
  if (top && top.give.some((p) => p.pos === 'WR') && top.receive.some((p) => p.pos === 'RB')) {
    pass('the top proposal sends a WR and returns an RB, as the profiles imply');
  } else fail('proposal shape', top ? top.shape : 'n/a');

  /* Tags, and the buy-low / sell-high wiring into the board. */
  const tagged = analysis.trades.filter((t) => t.tags.includes('BUY LOW'));
  if (tagged.length && tagged[0].buyLow.length) {
    pass('a proposal that brings back the Buy Low target is tagged and carries its reasoning');
  } else fail('buy low is not reaching the trade board',
    JSON.stringify(analysis.trades.map((t) => t.tags)));
  if (analysis.trades.every((t) => t.tags.length > 0)) pass('every proposal carries at least one tag');
  else fail('untagged proposal');
  const badTag = analysis.trades.filter((t) => t.tags.includes('BUY LOW') && !t.buyLow.length);
  if (!badTag.length) pass('no proposal claims BUY LOW without a candidate behind it');
  else fail('unbacked BUY LOW tag');

  /* ---- the min-partner-gain floor must filter, not merely re-sort ---- */
  const strict = buildAnalysis({ minPartnerGain: 8 });
  const loose = buildAnalysis({ minPartnerGain: 0 });
  if (strict.search.twoWayPositive < loose.search.twoWayPositive) {
    pass('raising the partner floor tightens the candidate set');
  } else fail('partner floor has no effect',
    strict.search.twoWayPositive + ' vs ' + loose.search.twoWayPositive);
  if (strict.trades.every((t) => t.theirLineup.gain >= 8)) pass('a raised partner floor is honoured exactly');
  else fail('partner floor not honoured');

  /* ---- pitch coherence ---- */
  const pitchless = analysis.trades.filter((t) => !t.pitch || t.pitch.length < 80);
  if (!pitchless.length) pass('every proposal carries a ready-to-send pitch');
  else fail('missing pitch', pitchless.length + ' proposal(s)');

  const misnamed = analysis.trades.filter((t) =>
    !t.give.every((p) => t.pitch.includes(p.name)) ||
    !t.receive.every((p) => t.pitch.includes(p.name)));
  if (!misnamed.length) pass('every pitch names every player actually in the deal');
  else fail('pitch omits a player in the deal');

  const wrongMath = analysis.trades.filter((t) =>
    !t.pitch.includes('+' + t.myLineup.gain.toFixed(1)) ||
    !t.pitch.includes('+' + t.theirLineup.gain.toFixed(1)));
  if (!wrongMath.length) pass('every pitch quotes the same two deltas the card shows');
  else fail('a pitch quotes a delta the card does not');

  /* The bug this assertion is the headstone for: the first draft of this copy
     called one position both "where I am long" and "where my lineup has the
     hole", in consecutive sentences, because it was generated from the package's
     positions rather than the roster's facts. */
  const state = gm.normalize(fixtureLeague(), { week: 1, byeWeeks: fixtureByes });
  const me = gm.resolveMyTeam(state, '1', '');
  const solve = gm.lineupSolver(state.slotIds);
  const myRead = gm.teamRead(me, state.slotIds, state.benchmarks, solve);
  const offers = gm.findOffers(state, me, Object.assign({}, baseOptions));
  let coherent = true;
  let starterCalledSpare = '';
  for (const offer of offers.offers) {
    const spare = gm.honestSurplus(offer.give, myRead);
    const holes = gm.solvedNeeds(offer.receive, myRead);
    for (const p of spare) {
      if (holes.includes(p.pos)) coherent = false;
      if (myRead.starters.has(p.id)) starterCalledSpare = p.name;
    }
  }
  if (coherent) pass('no pitch calls one position both a surplus and a hole');
  else fail('pitch coherence', 'a position was claimed as both');
  if (!starterCalledSpare) pass('no starter is described to a rival as bench depth');
  else fail('pitch accuracy', starterCalledSpare + ' starts but is pitched as spare');

  /* An injury designation must be disclosed in the copy; a buy-low read must
     not be. "I think your guy is underpriced" is the sentence that ends the
     conversation. */
  const hurtLeague = fixtureLeague();
  hurtLeague.teams[1].roster.entries[2].playerPoolEntry.player.injuryStatus = 'QUESTIONABLE';
  const hurt = gm.analyze({
    league: hurtLeague,
    freeAgents: gm.freeAgentsFrom(fixturePool(), 1, fixtureByes),
    byeWeeks: fixtureByes,
  }, baseOptions);
  const withFlag = hurt.trades.filter((t) => t.designations.length);
  if (!withFlag.length || withFlag.every((t) => t.designations.every((d) =>
    t.pitch.includes(d.split(' — ')[0])))) {
    pass('an injury designation in a deal is disclosed in the pitch');
  } else fail('a designation was hidden from the pitch');
  const leaky = analysis.trades.filter((t) => /buy low|underperform|underpriced|slump/i.test(t.pitch));
  if (!leaky.length) pass('no pitch tells the other manager his player is a buy-low target');
  else fail('the pitch leaks the buy-low read', JSON.stringify(leaky.map((t) => t.id)));

  /* ---- determinism ---- */
  const a = JSON.stringify(buildAnalysis());
  const b = JSON.stringify(buildAnalysis());
  if (a === b) pass('two analyses over the same payload are byte-identical');
  else fail('determinism', 'the analysis changed between runs');

  /* And the contract that makes that true, asserted against the source rather
     than inferred from one lucky pair of runs. The only permitted clock read is
     the search deadline and the season fallback, both outside every scoring
     function — so the scoring region of the file is checked directly. */
  const source = readFileSync(join(root, 'lib/ai-gm.js'), 'utf8');
  const scoringStart = source.indexOf('5. OPTIMAL LINEUP');
  const scoringEnd = source.indexOf('13. ESPN TRANSPORT');
  const scoring = source.slice(scoringStart, scoringEnd);
  if (scoringStart > 0 && scoringEnd > scoringStart) pass('the scoring region was located in the source');
  else fail('could not locate the scoring region to check it');
  const clockHits = scoring.match(/Math\.random|new Date\(/g) || [];
  if (!clockHits.length) pass('no Math.random or new Date in the scoring, matchmaking or pitch paths');
  else fail('determinism contract', clockHits.join(', ') + ' found in a scoring path');
  /* Every Date.now in the scoring region must belong to makeDeadline — the one
     permitted clock read, and a safety valve rather than an input to any score.
     Counted rather than merely pattern-matched, so a second clock read anywhere
     else in the region fails even if makeDeadline still looks right. */
  const nowHits = (scoring.match(/Date\.now\(/g) || []).length;
  const deadlineStart = scoring.indexOf('function makeDeadline');
  const deadlineBody = deadlineStart < 0 ? '' : scoring.slice(deadlineStart, scoring.indexOf('\n}', deadlineStart));
  const deadlineHits = (deadlineBody.match(/Date\.now\(/g) || []).length;
  if (nowHits > 0 && nowHits === deadlineHits) {
    pass('all ' + nowHits + ' Date.now reads belong to makeDeadline, outside every scoring function');
  } else fail('clock reads in the scoring path',
    nowHits + ' Date.now call(s), ' + deadlineHits + ' of them inside makeDeadline');

  /* The deadline must be a safety valve that REPORTS itself, never a silent
     truncation. Zero budget means the very first opponent trips it. */
  const starved = gm.findOffers(state, me, Object.assign({}, baseOptions, { deadlineMs: 1e-9 }));
  if (starved.truncated && starved.rostersAnalyzed < starved.rostersTotal) {
    pass('an exhausted budget reports truncation and how far it got');
  } else fail('the search budget does not report truncation');
}

/* ============================================================================
   PASS 2 — THE HANDLER

   Driven with a stub resolveStoredLeagueAccess and a stub global fetch, so the
   private-access gate, the Supabase-cookie path and every refusal are asserted
   with no Supabase, no ESPN and no deployment.
============================================================================ */
function fakeRes() {
  const res = {
    statusCode: 0, body: null, headers: {}, ended: false, headersSent: false,
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
    end() { this.ended = true; this.headersSent = true; return this; },
  };
  return res;
}

function fakeReq(query, headers) {
  const params = new URLSearchParams(query || {});
  return {
    method: 'GET',
    query: Object.fromEntries(params.entries()),
    url: '/api/espn?action=ai-gm&' + params.toString(),
    headers: Object.assign({}, headers || {}),
  };
}

/* The stub ESPN. Answers the three URLs the handler builds, records the outbound
   headers, and lets a test make any one of them fail. */
function stubFetch(options) {
  const opts = options || {};
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    seen.push({ url: target, headers: (init && init.headers) || {} });
    const reply = (payload) => ({
      ok: true, status: 200, text: async () => JSON.stringify(payload),
    });
    if (opts.failAll) {
      return { ok: false, status: opts.failAll, text: async () => '{"messages":["nope"]}' };
    }
    if (target.includes('view=kona_player_info')) {
      if (opts.failWaivers) return { ok: false, status: 500, text: async () => 'upstream fell over' };
      return reply(fixturePool());
    }
    if (target.includes('view=proTeamSchedules_wl')) {
      if (opts.failByes) return { ok: false, status: 500, text: async () => 'no schedules' };
      return reply({ settings: { proTeams: [
        { id: 9, byeWeek: 3 }, { id: 12, byeWeek: 5 }, { id: 21, byeWeek: 7 },
      ] } });
    }
    return reply(fixtureLeague());
  };
  return {
    seen: seen,
    restore() { globalThis.fetch = original; },
  };
}

const storedCookies = { espn_s2: 'AEBtestvalue0123456789', swid: '{AAAA}' };

function resolverThatLends(record) {
  return async (leagueId, season, token) => {
    if (record) record.push({ leagueId, season, token });
    return { status: 'ok', cookies: storedCookies, reason: '' };
  };
}

async function checkHandler() {
  console.log('\n[ai-gm-check] 2/4  the /api/ai-gm handler\n');

  /* ---- THE GATE, server-side ---- */
  for (const leagueId of ['12345', '', 'abc', '5715528']) {
    const res = fakeRes();
    let resolverCalled = false;
    await gm.handle(fakeReq({ league: leagueId, season: '2026' }), res, {
      resolveStoredLeagueAccess: async () => { resolverCalled = true; return { status: 'ok', cookies: storedCookies }; },
    });
    if (res.statusCode !== 403) {
      fail('the gate let league "' + leagueId + '" through', 'HTTP ' + res.statusCode);
    } else if (resolverCalled) {
      fail('the gate refused league "' + leagueId + '" but still looked up a stored session');
    }
  }
  pass('a non-allowlisted league is refused 403 BEFORE any credential is looked up');

  {
    const res = fakeRes();
    await gm.handle(fakeReq({ league: '12345' }), res, { resolveStoredLeagueAccess: async () => ({}) });
    const body = JSON.stringify(res.body || {});
    if (!body.includes('57155288')) pass('the refusal names no other league and leaks no roster');
    else fail('the 403 body leaks the allowlisted league id');
  }

  {
    const res = fakeRes();
    await gm.handle(Object.assign(fakeReq({ league: '57155288' }), { method: 'POST' }), res, {
      resolveStoredLeagueAccess: resolverThatLends(),
    });
    if (res.statusCode === 405) pass('a non-GET is refused 405');
    else fail('method guard', 'HTTP ' + res.statusCode);
  }

  {
    const res = fakeRes();
    await gm.handle(Object.assign(fakeReq({ league: '57155288' }), { method: 'OPTIONS' }), res, {
      resolveStoredLeagueAccess: resolverThatLends(),
    });
    if (res.statusCode === 200 && res.ended) pass('CORS preflight is answered immediately');
    else fail('preflight', 'HTTP ' + res.statusCode);
  }

  /* ---- THE STORED SUPABASE SESSION ---- */
  {
    const res = fakeRes();
    await gm.handle(fakeReq({ league: '57155288', season: '2026' }), res, {
      resolveStoredLeagueAccess: async () => ({ status: 'unauthorized', cookies: null, reason: 'token mismatch' }),
    });
    if (res.statusCode === 401 && /invite token/i.test(String(res.body && res.body.error))) {
      pass('a caller without this league\'s share token gets 401 and is told to use the invite link');
    } else fail('unauthorized path', 'HTTP ' + res.statusCode + ' ' + JSON.stringify(res.body));
  }

  {
    const res = fakeRes();
    await gm.handle(fakeReq({ league: '57155288', season: '2026' }), res, {
      resolveStoredLeagueAccess: async () => ({ status: 'none', cookies: null, reason: 'no league record is stored' }),
    });
    if (res.statusCode === 409 && /no league record is stored/i.test(String(res.body && res.body.error))) {
      pass('no stored session yields 409 carrying the store\'s own reason');
    } else fail('no-session path', 'HTTP ' + res.statusCode + ' ' + JSON.stringify(res.body));
  }

  {
    const res = fakeRes();
    await gm.handle(fakeReq({ league: '57155288', season: '2026' }), res, {
      resolveStoredLeagueAccess: async () => ({ status: 'ok', cookies: { espn_s2: 'AEBonly', swid: '' } }),
    });
    if (res.statusCode === 409 && res.body && res.body.code === 'AI_GM_INCOMPLETE_STORED_PAIR') {
      pass('half a stored credential is refused rather than sent — ESPN authenticates on the pair');
    } else fail('incomplete pair', 'HTTP ' + res.statusCode);
  }

  {
    const res = fakeRes();
    await gm.handle(fakeReq({ league: '57155288' }), res, {
      resolveStoredLeagueAccess: async () => { throw new Error('supabase is down'); },
    });
    if (res.statusCode === 502 && res.body.code === 'AI_GM_STORE_UNAVAILABLE') {
      pass('a throwing store is a 502 with a code, never a stack trace to the browser');
    } else fail('store failure', 'HTTP ' + res.statusCode);
  }

  {
    const res = fakeRes();
    await gm.handle(fakeReq({ league: '57155288' }), res, {});
    if (res.statusCode === 500 && res.body.code === 'AI_GM_RESOLVER_MISSING') {
      pass('a missing resolver is reported as a server misconfiguration, not a league problem');
    } else fail('missing resolver', 'HTTP ' + res.statusCode);
  }

  /* ---- THE HAPPY PATH ---- */
  {
    const calls = [];
    const net = stubFetch();
    const res = fakeRes();
    await gm.handle(
      fakeReq({ league: '57155288', season: '2026', week: '1' }, { 'x-league-token': 'a'.repeat(43) }),
      res,
      { resolveStoredLeagueAccess: resolverThatLends(calls) },
    );
    net.restore();

    if (res.statusCode === 200) pass('the allowlisted league gets a 200 analysis');
    else fail('happy path', 'HTTP ' + res.statusCode + ' ' + JSON.stringify(res.body));

    if (calls.length === 1 && calls[0].leagueId === '57155288' && calls[0].season === 2026 &&
        calls[0].token === 'a'.repeat(43)) {
      pass('the share token from x-league-token is what unlocks the stored session');
    } else fail('token transport', JSON.stringify(calls));

    const body = res.body || {};
    if (body.credentialSource === 'supabase-league-store') {
      pass('the response states the credentials came from the Supabase league store');
    } else fail('credential source', String(body.credentialSource));

    /* Every outbound read must carry BOTH cookies, in the shape ESPN expects. */
    const unauthenticated = net.seen.filter((r) => {
      const cookie = String((r.headers && r.headers.Cookie) || '');
      return !cookie.includes('SWID=') || !cookie.includes('espn_s2=');
    });
    if (net.seen.length === 3 && !unauthenticated.length) {
      pass('all three ESPN reads carry the stored SWID + espn_s2 pair');
    } else fail('outbound credentials', net.seen.length + ' read(s), ' +
      unauthenticated.length + ' unauthenticated');

    if (net.seen.every((r) => r.url.startsWith('https://lm-api-reads.fantasy.espn.com/'))) {
      pass('every read goes to lm-api-reads.fantasy.espn.com');
    } else fail('read host', JSON.stringify(net.seen.map((r) => r.url)));

    /* The read the generic relay could not make: kona_player_info behind an
       X-Fantasy-Filter. This is the reason this handler exists at all. */
    const waiverRead = net.seen.find((r) => r.url.includes('kona_player_info'));
    const filter = waiverRead && waiverRead.headers && waiverRead.headers['X-Fantasy-Filter'];
    if (filter) {
      const parsed = JSON.parse(filter);
      const status = parsed.players.filterStatus.value;
      if (status.includes('FREEAGENT') && status.includes('WAIVERS') && parsed.players.limit > 0) {
        pass('the waiver read carries an X-Fantasy-Filter scoped to free agents and waivers');
      } else fail('fantasy filter contents', filter);
    } else fail('the waiver read carried no X-Fantasy-Filter');

    if (body.league && String(body.league.id) === '57155288' && body.myTeam &&
        body.myTeam.name === 'My Squad') {
      pass('the analysis resolved MY team from the stored SWID with no team parameter sent');
    } else fail('team resolution through the handler', JSON.stringify(body.myTeam || {}));

    if (Array.isArray(body.trades) && body.trades.length &&
        Array.isArray(body.waivers.board) && body.waivers.board.length) {
      pass('the response carries both a trade board and a waiver board');
    } else fail('response shape', JSON.stringify(Object.keys(body)));

    if (body.waivers.context.byeExposure !== undefined && body.waivers.board[0].byeWeek !== undefined) {
      pass('bye weeks from the pro-team read reached the waiver board');
    } else fail('bye weeks did not reach the board');

    const cache = String(res.headers['cache-control'] || '');
    if (/no-store/.test(cache) && /private/.test(cache)) {
      pass('the response is private and never cached at a shared edge');
    } else fail('cache headers', cache);
  }

  /* ---- DEGRADATION ---- */
  {
    const net = stubFetch({ failWaivers: true });
    const res = fakeRes();
    await gm.handle(fakeReq({ league: '57155288', season: '2026', week: '1' }), res,
      { resolveStoredLeagueAccess: resolverThatLends() });
    net.restore();
    if (res.statusCode === 200 && res.body.trades.length && res.body.waivers.error &&
        !res.body.waivers.board.length) {
      pass('a failed waiver read degrades that section and says why — the trade board survives');
    } else fail('waiver degradation', 'HTTP ' + res.statusCode + ' waivers=' +
      JSON.stringify(res.body && res.body.waivers && res.body.waivers.error));
  }

  {
    const net = stubFetch({ failByes: true });
    const res = fakeRes();
    await gm.handle(fakeReq({ league: '57155288', season: '2026', week: '1' }), res,
      { resolveStoredLeagueAccess: resolverThatLends() });
    net.restore();
    if (res.statusCode === 200 && res.body.waivers.context.byeWeeksUnavailable === true) {
      pass('missing bye data is declared rather than silently omitted');
    } else fail('bye degradation', JSON.stringify(res.body && res.body.waivers && res.body.waivers.context));
  }

  {
    const net = stubFetch({ failAll: 401 });
    const res = fakeRes();
    await gm.handle(fakeReq({ league: '57155288', season: '2026' }), res,
      { resolveStoredLeagueAccess: resolverThatLends() });
    net.restore();
    if (res.statusCode === 502 && /expired|rejected/i.test(String(res.body.error))) {
      pass('an ESPN 401 on the stored pair is reported as an expired session, not an empty league');
    } else fail('expired credential message', 'HTTP ' + res.statusCode + ' ' + JSON.stringify(res.body));
  }

  {
    /* A SWID that matches no team: the handler must ask, not guess. */
    const net = stubFetch();
    const res = fakeRes();
    await gm.handle(fakeReq({ league: '57155288', season: '2026' }), res, {
      resolveStoredLeagueAccess: async () => ({ status: 'ok', cookies: { espn_s2: 'AEBx', swid: '{NOBODY}' } }),
    });
    net.restore();
    if (res.statusCode === 409 && res.body.code === 'AI_GM_TEAM_UNRESOLVED' &&
        Array.isArray(res.body.teams) && res.body.teams.length === 12) {
      pass('an unmatched SWID returns the team list to choose from rather than guessing');
    } else fail('team unresolved path', 'HTTP ' + res.statusCode + ' ' + JSON.stringify(res.body).slice(0, 160));
  }
}

/* ============================================================================
   PASS 3 — FUNCTION LIMITS AND WIRING

   The constraint this whole feature was designed around. Vercel turns every file
   under api/ into its own Serverless Function and this plan allows twelve. A
   thirteenth does NOT fail the build — the build prints "Build Completed" and
   the DEPLOY is then rejected at patchBuild with
   exceeded_serverless_functions_per_deployment, taking production down. So the
   AI GM handler is in lib/ and reached through a rewrite, and that is asserted
   here rather than assumed.
============================================================================ */
const MAX_FUNCTIONS = 12;
const MAX_CRONS = 2;
const FUNCTION_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.go', '.py', '.rb']);

function walkFunctions(dir, out) {
  const acc = out || [];
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) walkFunctions(file, acc);
    else if (FUNCTION_EXTENSIONS.has(extname(name))) acc.push(file.slice(root.length + 1));
  }
  return acc;
}

function checkBudget() {
  console.log('\n[ai-gm-check] 3/4  function limits and wiring\n');

  const functions = walkFunctions(join(root, 'api')).sort();
  if (functions.length <= MAX_FUNCTIONS) {
    pass(functions.length + ' of ' + MAX_FUNCTIONS + ' Serverless Functions used — the budget holds');
  } else {
    fail(functions.length + ' function files under api/ but the plan allows ' + MAX_FUNCTIONS +
      '; the DEPLOY will be rejected at patchBuild', functions.join(', '));
  }

  /* The specific mistake this feature could have made. */
  if (!functions.some((f) => /ai-?gm/i.test(f))) {
    pass('the AI GM handler added NO new file under api/');
  } else fail('an AI GM file was added under api/', functions.filter((f) => /ai-?gm/i.test(f)).join(', '));

  if (existsSync(join(root, 'lib/ai-gm.js'))) pass('the handler lives in lib/, which costs no function slot');
  else fail('lib/ai-gm.js is missing');

  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
  const rewrites = Array.isArray(vercel.rewrites) ? vercel.rewrites : [];
  const rule = rewrites.find((r) => String(r && r.source) === '/api/ai-gm');
  if (rule) pass('vercel.json rewrites /api/ai-gm -> ' + rule.destination);
  else fail('no /api/ai-gm rewrite in vercel.json');

  if (rule) {
    const path = String(rule.destination).split('?')[0].replace(/^\/+/, '');
    if (functions.some((f) => f.replace(/\.[^.]+$/, '') === path)) {
      pass('the rewrite destination resolves to a function that exists');
    } else fail('the rewrite points at no function under api/', rule.destination);
    if (/action=ai-gm/.test(String(rule.destination))) pass('the rewrite carries the ?action=ai-gm dispatch');
    else fail('the rewrite carries no action parameter', rule.destination);
  }

  const crons = Array.isArray(vercel.crons) ? vercel.crons : [];
  if (crons.length <= MAX_CRONS) pass(crons.length + ' of ' + MAX_CRONS + ' cron slots used');
  else fail(crons.length + ' cron jobs but the plan allows ' + MAX_CRONS);

  /* The route needs headroom: three ESPN reads plus a twelve-roster search does
     not fit in the platform's default ceiling. */
  const fnConfig = (vercel.functions || {})['api/espn.js'];
  if (fnConfig && Number(fnConfig.maxDuration) >= 30) {
    pass('api/espn.js is given ' + fnConfig.maxDuration + 's, enough for three reads plus the search');
  } else fail('api/espn.js has no raised maxDuration; the AI GM route will time out');

  /* The dispatch itself: additive and first, so no existing /api/espn read can
     have changed behaviour. */
  const espn = readFileSync(join(root, 'api/espn.js'), 'utf8');
  if (/requestedAction\(req\) === 'ai-gm'/.test(espn) && /require\('\.\.\/lib\/ai-gm'\)/.test(espn)) {
    pass('api/espn.js dispatches the ai-gm action into lib/ai-gm.js');
  } else fail('api/espn.js carries no ai-gm dispatch');

  const handlerBody = espn.slice(espn.indexOf('module.exports = async function handler'));
  const firstStatement = handlerBody.slice(0, handlerBody.indexOf('applyCorsHeaders(res)'));
  if (/requestedAction\(req\) === 'ai-gm'/.test(firstStatement)) {
    pass('the dispatch is the first thing the handler does, so no existing read is affected');
  } else fail('the ai-gm dispatch is not the handler\'s first statement');

  /* lib/ must not reach back into api/ — that is what the injected resolver is
     for, and it is what lets pass 2 run with no Supabase. */
  const lib = readFileSync(join(root, 'lib/ai-gm.js'), 'utf8');
  if (!/require\(['"]\.\.\/api\//.test(lib)) pass('lib/ai-gm.js never requires anything from api/');
  else fail('lib/ai-gm.js reaches back into api/');
  if (/require\(['"]\.\/espn-cookies['"]\)/.test(lib)) {
    pass('the cookie sanitizer is reused from lib/espn-cookies, not re-solved');
  } else fail('lib/ai-gm.js does not reuse lib/espn-cookies');

  /* No environment credential path. The task's whole premise is the stored
     Supabase pair; an ESPN_S2 fallback would quietly make a broken store look
     like a working feature on the deployment and a failing one for everyone. */
  if (!/process\.env\.ESPN_S2|process\.env\.ESPN_SWID|process\.env\.SWID/.test(lib)) {
    pass('the engine reads no ESPN credential from the environment — only the stored pair');
  } else fail('lib/ai-gm.js has an environment credential fallback');

  /* ---- GATE PARITY ---- */
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const clientList = html.match(/const ALLOWED_LEAGUE_IDS = \[([^\]]*)\]/);
  if (!clientList) {
    fail('could not find ALLOWED_LEAGUE_IDS in index.html');
  } else {
    const client = clientList[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    const server = gm.AI_GM_ALLOWED_LEAGUE_IDS.slice();
    if (client.length === server.length && client.every((id, i) => id === server[i])) {
      pass('the client and server allowlists are identical (' + server.join(', ') + ')');
    } else fail('allowlist drift', 'client [' + client.join(', ') + '] vs server [' + server.join(', ') + ']');
  }

  /* ---- THE MARKUP ---- */
  if (/id="aiGmOpenBtn"[^>]*\shidden\b/.test(html)) {
    pass('the Setup entry card ships hidden in the markup');
  } else fail('the entry card is not hidden by default — every league would see it');
  if (/id="aiGmOpenBtn"[^>]*aria-hidden="true"/.test(html)) {
    pass('the hidden card is also aria-hidden, so it is out of the tab order');
  } else fail('the entry card is visually hidden but still exposed to assistive tech');

  for (const id of ['aiGmModal', 'aiGmBody', 'aiGmRefresh', 'aiGmClose', 'aiGmSubtitle', 'aiGmTitle']) {
    if (html.includes('id="' + id + '"')) continue;
    fail('the markup is missing #' + id);
  }
  pass('every element the AI GM block binds exists in the markup');

  /* The desk must not ship any roster or trade content in the static file. */
  const modalStart = html.indexOf('id="aiGmModal"');
  const modalEnd = html.indexOf('</div>\n\n<!--', modalStart);
  const modalMarkup = html.slice(modalStart, modalEnd > 0 ? modalEnd : modalStart + 2000);
  if (!/aigm-card|data-aigm-copy/.test(modalMarkup)) {
    pass('the modal ships empty — no roster or proposal exists in the static file');
  } else fail('the modal markup carries pre-rendered content');

  /* The block must be top level, per the Global Scope Rule: a copy nested inside
     the UI IIFE would be a ReferenceError everywhere else. */
  if (/^window\.FSNAiGm = \(function\(\)\{/m.test(html)) {
    pass('window.FSNAiGm is published from its own top-level block');
  } else fail('window.FSNAiGm is not a top-level assignment');
  if (/FSNBridge\.register\(\{\s*\n\s*openAiGm/.test(html)) {
    pass('the desk registers openAiGm on FSNBridge for the other blocks to call');
  } else fail('the AI GM block does not register itself on FSNBridge');

  /* Rule 3: every catch says what died. Checked over the new block only. */
  const blockStart = html.indexOf('window.FSNAiGm = (function(){');
  const block = html.slice(blockStart);
  const emptyCatches = block.match(/catch\s*\([^)]*\)\s*\{\s*\}/g) || [];
  if (!emptyCatches.length) pass('the AI GM block swallows no exception silently');
  else fail('empty catch block(s) in the AI GM block', String(emptyCatches.length));
  const catches = (block.match(/catch\s*\(/g) || []).length;
  const logged = (block.match(/console\.(error|warn)\(/g) || []).length;
  if (logged >= catches) pass('every catch in the block has a console.error / console.warn (' +
    catches + ' catches, ' + logged + ' logs)');
  else fail('fewer logs than catches in the AI GM block', catches + ' catches, ' + logged + ' logs');

  /* Rule 1's other half: never a `typeof someFn === 'function'` cross-block
     guard, which cannot throw and so degrades silently and permanently. */
  if (!/typeof\s+(FSNBridge|LeagueData|FSNNet|leagueShareHeaders|selectedLeagueId)\s*===?\s*'/.test(block)) {
    pass('no typeof probe is used as a cross-block guard');
  } else fail('the block guards a cross-block call with typeof instead of FSNBridge');
}

/* ============================================================================
   PASS 4 — RENDER

   index.html in real Chromium. Every renderer is driven against the fixture
   analysis through the block's own test seam, so the UI components are exercised
   with no network, no ESPN and no Supabase — and the league gate is exercised by
   actually switching the active league underneath it.
============================================================================ */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/* The app boots against /api/notifications-register; answer that one route the
   way an unprovisioned deployment does and 404 the rest. /api/ai-gm is
   deliberately NOT served — this pass renders from the fixture, and a stray
   network call would be a bug worth seeing. */
function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/notifications')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, configured: false }));
        return;
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const file = join(root, rel);
      if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
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

/* A minimal ESPN-shaped season for LeagueData.setEspnData, so the app's own
   renderers have something to paint and the gate has a real active league. */
function seedSeason(leagueId) {
  return {
    id: Number(leagueId),
    seasonId: 2026,
    scoringPeriodId: 1,
    settings: { name: 'AI GM Test League', rosterSettings: { lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 20: 6 } } },
    status: { latestScoringPeriod: 1, currentMatchupPeriod: 1 },
    members: [{ id: '{AAAA}', firstName: 'Lee', lastName: 'Rand' }],
    teams: [
      { id: 1, location: 'My', nickname: 'Squad', abbrev: 'MINE', primaryOwner: '{AAAA}', owners: ['{AAAA}'], record: { overall: { wins: 2, losses: 4, ties: 0, pointsFor: 600, pointsAgainst: 660 } } },
      { id: 2, location: 'Ground', nickname: 'Game', abbrev: 'GRND', primaryOwner: '{BBBB}', owners: ['{BBBB}'], record: { overall: { wins: 1, losses: 5, ties: 0, pointsFor: 520, pointsAgainst: 700 } } },
    ],
    schedule: [{
      matchupPeriodId: 1, winner: 'HOME',
      home: { teamId: 1, totalPoints: 101 }, away: { teamId: 2, totalPoints: 88 },
    }],
  };
}

async function checkRender() {
  console.log('\n[ai-gm-check] 4/4  index.html in Chromium\n');

  const executablePath = resolveChromium();
  if (!executablePath) {
    fail('no Chromium binary found under ' + (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') +
      '; set FSN_CHROMIUM_PATH or pass --no-browser');
    return;
  }

  const { chromium } = await import('playwright');
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 414, height: 896 } });

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/\[(AI GM|FSN|NewsDesk|Standings|Matchups|FSNBridge|FSNIntel)/.test(text)) consoleErrors.push(text);
  });

  await page.addInitScript(() => {
    try { window.localStorage.setItem('hasCompletedOnboarding', 'true'); } catch (err) { /* private mode */ }
    /* Grant the clipboard path a stub so the Copy Pitch assertion is about OUR
       code rather than about headless Chromium's permission model. */
    window.__aiGmClipboard = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get() {
        return { writeText: (text) => { window.__aiGmClipboard.push(text); return Promise.resolve(); } };
      },
    });
  });

  try {
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.waitForTimeout(900);

    const present = await page.evaluate(() => ({
      block: !!(window.FSNAiGm && typeof window.FSNAiGm.open === 'function'),
      bridge: !!(window.FSNBridge && window.FSNBridge.has('openAiGm')),
      renderers: !!(window.FSNAiGm && window.FSNAiGm.render &&
        typeof window.FSNAiGm.render.analysis === 'function'),
    }));
    if (present.block) pass('window.FSNAiGm is live in the page');
    else fail('window.FSNAiGm did not initialise');
    if (present.bridge) pass('FSNBridge.has("openAiGm") — the desk is reachable from any block');
    else fail('openAiGm is not registered on FSNBridge');
    if (present.renderers) pass('the renderers are exported and callable in isolation');
    else fail('the renderers are not exported');

    /* ---- THE GATE ---- */
    const gateBefore = await page.evaluate(() => {
      const card = document.getElementById('aiGmOpenBtn');
      return { hidden: card.hidden, enabled: window.FSNAiGm.isEnabledNow() };
    });
    if (gateBefore.hidden && !gateBefore.enabled) pass('with no league loaded the card is hidden');
    else fail('the card is visible before any league is loaded');

    const wrongLeague = await page.evaluate((payload) => {
      window.LeagueData.setActiveProvider('espn');
      window.LeagueData.setMeta('leagueId', '99999999');
      window.LeagueData.setEspnData(payload);
      const card = document.getElementById('aiGmOpenBtn');
      return { hidden: card.hidden, aria: card.getAttribute('aria-hidden'), enabled: window.FSNAiGm.isEnabledNow() };
    }, seedSeason(99999999));
    if (wrongLeague.hidden && wrongLeague.aria === 'true' && !wrongLeague.enabled) {
      pass('a NON-allowlisted league keeps the card hidden and aria-hidden');
    } else fail('the card leaked into another league', JSON.stringify(wrongLeague));

    const rightLeague = await page.evaluate((payload) => {
      window.LeagueData.setMeta('leagueId', '57155288');
      window.LeagueData.setEspnData(payload);
      const card = document.getElementById('aiGmOpenBtn');
      return { hidden: card.hidden, aria: card.getAttribute('aria-hidden'), enabled: window.FSNAiGm.isEnabledNow() };
    }, seedSeason(57155288));
    if (!rightLeague.hidden && rightLeague.aria === 'false' && rightLeague.enabled) {
      pass('the allowlisted league reveals the card and enables the desk');
    } else fail('the card did not appear for the allowlisted league', JSON.stringify(rightLeague));

    /* A Sleeper league that happened to share the numeric id must not open a
       desk built entirely from ESPN-only fields. */
    const sleeper = await page.evaluate(() => {
      window.LeagueData.setActiveProvider('sleeper');
      window.LeagueData.publish();
      const enabled = window.FSNAiGm.isEnabledNow();
      window.LeagueData.setActiveProvider('espn');
      window.LeagueData.publish();
      return enabled;
    });
    if (!sleeper) pass('the desk stays off for a non-ESPN provider on the same id');
    else fail('the desk opened for a Sleeper league');

    /* The "Who's watching?" picker is z-index 160 and deliberately blocks the
       whole app until it is answered — the AI GM desk at 132 correctly sits
       beneath it. Answer it as a guest so the click assertions below reach the
       desk rather than the picker's backdrop. */
    const guestDismissed = await page.evaluate(() => {
      const guest = document.getElementById('profileGuest');
      if (guest) guest.click();
      const picker = document.getElementById('profilePicker');
      return !picker || picker.dataset.open !== 'true';
    });
    if (guestDismissed) pass('the blocking profile picker is answered, leaving the desk clickable');
    else fail('the profile picker could not be dismissed; click assertions cannot run');

    /* ---- THE REAL ENTRY POINT ----
       Open Setup and click the card, rather than calling open() directly. This
       is the path a beta tester actually takes, and it is what proves the card's
       own listener is bound and that the desk (z-index 132) layers above the
       Setup screen (85) instead of behind it. */
    const viaCard = await page.evaluate(async () => {
      /* Route to Setup the way the app does, then click the card itself. */
      const tab = document.querySelector('.tab-btn[data-tab="setup"]');
      if (tab) tab.click();
      const setup = document.querySelector('.screen[data-screen="setup"]');
      const card = document.getElementById('aiGmOpenBtn');
      const beforeVisible = card.getClientRects().length > 0;
      card.click();
      await new Promise((r) => setTimeout(r, 120));
      const modal = document.getElementById('aiGmModal');
      const modalZ = Number(getComputedStyle(modal).zIndex);
      const setupZ = setup ? Number(getComputedStyle(setup).zIndex) : 0;
      return {
        cardVisible: beforeVisible,
        open: modal.dataset.open,
        aria: modal.getAttribute('aria-hidden'),
        above: !Number.isNaN(modalZ) && modalZ > setupZ,
        focused: document.activeElement === document.getElementById('aiGmClose'),
      };
    });
    if (viaCard.cardVisible) pass('the entry card is laid out and clickable inside the Setup screen');
    else fail('the entry card has no client rects inside Setup, so it cannot be tapped');
    if (viaCard.open === 'true' && viaCard.aria === 'false') {
      pass('clicking the Setup card opens the desk — the card\'s own listener is bound');
    } else fail('the entry card did not open the desk', JSON.stringify(viaCard));
    if (viaCard.above) pass('the desk layers above the Setup screen it was opened from');
    else fail('the desk opened behind the Setup screen');
    if (viaCard.focused) pass('focus moves into the desk when it opens');
    else fail('focus did not move into the desk');

    /* Escape must close it, and focus must return to the card. */
    const escaped2 = await page.evaluate(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      const modal = document.getElementById('aiGmModal');
      return {
        open: modal.dataset.open,
        /* The invariant is that focus lands back in the Setup screen — on the
           control that had it, or on the entry card when nothing did. What it
           must never be is <body> or something inside the closed dialog. */
        returnedInsideSetup: !!(document.activeElement &&
          document.activeElement.closest('.screen[data-screen="setup"]')),
        strandedInDialog: !!(document.activeElement &&
          document.activeElement.closest('#aiGmModal')),
        activeTag: document.activeElement ? document.activeElement.id || document.activeElement.tagName : 'none',
        /* Escape belongs to the topmost layer only. One keystroke must not
           close the desk AND the Setup screen it was opened from. */
        setupStillOpen: document.querySelector('.screen[data-screen="setup"]')
          .getAttribute('data-active') === 'true',
      };
    });
    if (escaped2.open === 'false') pass('Escape closes the desk');
    else fail('Escape did not close the desk');
    if (escaped2.setupStillOpen) pass('Escape closes only the desk, leaving Setup open beneath it');
    else fail('one Escape closed both the desk and the Setup screen under it');
    if (escaped2.returnedInsideSetup && !escaped2.strandedInDialog) {
      pass('focus returns into the Setup screen on close (' + escaped2.activeTag + ')');
    } else fail('focus was left outside Setup or stranded in the closed dialog', escaped2.activeTag);

    /* ---- open / close ---- */
    const opened = await page.evaluate(() => {
      window.FSNAiGm.open();
      const modal = document.getElementById('aiGmModal');
      return { open: modal.dataset.open, aria: modal.getAttribute('aria-hidden') };
    });
    if (opened.open === 'true' && opened.aria === 'false') pass('open() shows the desk');
    else fail('open()', JSON.stringify(opened));

    /* ---- the renderers, against the fixture ---- */
    const analysis = buildAnalysis();
    const rendered = await page.evaluate((fixture) => {
      window.FSNAiGm.__setAnalysis(fixture);
      const body = document.getElementById('aiGmBody');
      return {
        html: body.innerHTML,
        text: body.textContent,
        copyButtons: body.querySelectorAll('[data-aigm-copy]').length,
        cards: body.querySelectorAll('.aigm-card').length,
        sections: Array.from(body.querySelectorAll('.aigm-section-head h3')).map((h) => h.textContent),
        subtitle: document.getElementById('aiGmSubtitle').textContent,
        busy: body.getAttribute('aria-busy'),
      };
    }, analysis);

    if (rendered.cards > 0) pass('the board renders ' + rendered.cards + ' cards from the fixture');
    else fail('nothing rendered from the fixture analysis');

    for (const wanted of ['Recommended Waiver Claims', 'Targeted Trade Proposals']) {
      if (rendered.sections.includes(wanted)) pass('section rendered: ' + wanted);
      else fail('missing section', wanted + ' (got ' + rendered.sections.join(' | ') + ')');
    }
    if (rendered.sections.includes('Your Roster')) pass('section rendered: Your Roster');
    else fail('missing section', 'Your Roster');

    if (rendered.copyButtons === analysis.trades.length) {
      pass('every proposal has its own Copy Pitch button (' + rendered.copyButtons + ')');
    } else fail('copy buttons', rendered.copyButtons + ' for ' + analysis.trades.length + ' proposals');

    if (!/hit a snag/i.test(rendered.text)) pass('no "hit a snag" text in the rendered desk');
    else fail('the desk rendered a snag message');

    /* The win-win deltas must be on screen in both directions — that is the
       whole argument for sending a proposal. */
    if (/Your lineup/.test(rendered.text) && /Their lineup/.test(rendered.text)) {
      pass('both sides of the win-win ledger are on screen');
    } else fail('the ledger does not show both sides');
    const topGain = analysis.trades[0].myLineup.gain.toFixed(1);
    if (rendered.text.includes('+' + topGain)) pass('the top proposal\'s Δpts/wk is on screen (+' + topGain + ')');
    else fail('the proposal delta is not rendered', '+' + topGain);
    if (/BUY LOW|SELL HIGH|LINEUP FIT/.test(rendered.text)) pass('buy low / sell high tags render');
    else fail('no proposal tag rendered');
    if (/bid \$|min bid \$|spend the claim|hold the claim/.test(rendered.text)) {
      pass('the waiver board renders a FAB bid or a priority call');
    } else fail('no FAB / priority advice rendered');
    if (rendered.busy === 'false') pass('aria-busy is cleared once the board is painted');
    else fail('aria-busy', rendered.busy);

    /* Escaping. A player name carrying markup must render as text, and the copy
       payload must survive the attribute round-trip byte for byte. */
    const injected = JSON.parse(JSON.stringify(analysis));
    injected.trades[0].targetTeam.name = '<img src=x onerror="window.__aiGmXss=1">';
    injected.trades[0].pitch = 'Line one\n\n"quoted" & <b>bold</b>\nLine four';
    const escaped = await page.evaluate((fixture) => {
      window.__aiGmXss = 0;
      window.FSNAiGm.__setAnalysis(fixture);
      const body = document.getElementById('aiGmBody');
      const button = body.querySelector('[data-aigm-copy]');
      return {
        xss: window.__aiGmXss,
        images: body.querySelectorAll('img').length,
        nameText: body.querySelector('.aigm-name') ? body.querySelector('.aigm-name').textContent : '',
        copyPayload: button ? button.getAttribute('data-aigm-copy') : '',
        copiedText: (function () {
          window.__aiGmClipboard.length = 0;
          if (button) button.click();
          return window.__aiGmClipboard[0];
        }()),
      };
    }, injected);
    if (!escaped.xss && escaped.images === 0) pass('a player or team name carrying markup is escaped, not executed');
    else fail('markup in the analysis reached the DOM as markup', JSON.stringify(escaped));
    /* The pitch must never be IN the attribute — LeagueData.esc() does not
       escape the double quote, so a quoted pitch would close it early. The
       attribute carries a register key; the text is looked up. */
    if (escaped.copyPayload && !escaped.copyPayload.includes('\n') &&
        !escaped.copyPayload.includes('"') && escaped.copyPayload.length < 12) {
      pass('the Copy Pitch button carries only a register key, never the pitch text');
    } else fail('the pitch text is being embedded in an attribute',
      JSON.stringify(escaped.copyPayload).slice(0, 120));
    if (escaped.copiedText === injected.trades[0].pitch) {
      pass('the register resolves that key to the pitch byte for byte — newlines and quotes intact');
    } else fail('the register mangled the pitch', JSON.stringify(escaped.copiedText).slice(0, 160));

    /* ---- Copy Pitch ---- */
    await page.evaluate((fixture) => {
      /* The escaping probe above copied once to prove the register resolves;
         reset the recorder so this assertion counts only its own click. */
      window.__aiGmClipboard.length = 0;
      window.FSNAiGm.__setAnalysis(fixture);
    }, analysis);
    await page.click('#aiGmBody [data-aigm-copy]');
    await page.waitForTimeout(150);
    const clip = await page.evaluate(() => ({
      copied: window.__aiGmClipboard.slice(),
      state: document.querySelector('#aiGmBody [data-aigm-copy]').getAttribute('data-state'),
      label: document.querySelector('#aiGmBody [data-aigm-copy]').textContent,
    }));
    if (clip.copied.length === 1 && clip.copied[0] === analysis.trades[0].pitch) {
      pass('Copy Pitch puts the exact server-written pitch on the clipboard');
    } else fail('clipboard payload', JSON.stringify(clip.copied).slice(0, 160));
    if (clip.state === 'done' && /COPIED/i.test(clip.label)) pass('the button confirms the copy to the reader');
    else fail('copy confirmation', clip.state + ' / ' + clip.label);

    /* A refused clipboard must say so rather than pretend. */
    const refusedCopy = await page.evaluate(async () => {
      const real = navigator.clipboard.writeText;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        get() { return { writeText: () => Promise.reject(new Error('denied')) }; },
      });
      document.execCommand = () => false;
      const button = document.querySelector('#aiGmBody [data-aigm-copy]');
      button.click();
      await new Promise((r) => setTimeout(r, 120));
      const state = button.getAttribute('data-state');
      const label = button.textContent;
      void real;
      return { state, label };
    });
    if (refusedCopy.state === 'failed' && /FAILED/i.test(refusedCopy.label)) {
      pass('a refused clipboard reports the failure instead of claiming success');
    } else fail('clipboard failure handling', JSON.stringify(refusedCopy));

    /* ---- Re-analyze: no league served, so it must fail LOUDLY and honestly ---- */
    const reanalyzed = await page.evaluate(async () => {
      await window.FSNAiGm.analyze({ reset: true });
      const body = document.getElementById('aiGmBody');
      return {
        text: body.textContent,
        state: window.FSNAiGm.state(),
        buttonEnabled: !document.getElementById('aiGmRefresh').disabled,
        label: document.getElementById('aiGmRefreshLabel').textContent,
      };
    });
    if (reanalyzed.state.error && !reanalyzed.state.loading) {
      pass('Re-analyze against an undeployed route ends in a stated error, not a stuck spinner');
    } else fail('re-analyze state', JSON.stringify(reanalyzed.state));
    if (reanalyzed.buttonEnabled && /RE-ANALYZE/i.test(reanalyzed.label)) {
      pass('the Re-analyze button is re-enabled after a failure');
    } else fail('the refresh button stayed disabled', reanalyzed.label);
    if (/not deployed|could not be reached|HTTP/i.test(reanalyzed.text)) {
      pass('the failure text tells the tester what actually went wrong');
    } else fail('unhelpful failure text', reanalyzed.text.slice(0, 160));

    /* ---- a league switch must not leave another roster on screen ---- */
    const switched = await page.evaluate((payload) => {
      window.FSNAiGm.__setAnalysis(null);
      window.LeagueData.setMeta('leagueId', '57155288');
      window.FSNAiGm.__setAnalysis({
        ok: true,
        league: { id: '57155288', name: 'X', season: 2026, week: 1, teamCount: 12, lineup: [], lineupFromSettings: true },
        myTeam: { id: '1', name: 'Sentinel Squad', owner: 'o', record: '1-0', projectedLineup: 100, lineup: [], positions: [] },
        trades: [], buyLow: [], sellHigh: [],
        waivers: { board: [], poolSize: 0, context: {} },
        search: {},
      });
      window.LeagueData.setMeta('leagueId', '99999999');
      window.LeagueData.setEspnData(payload);
      const modal = document.getElementById('aiGmModal');
      return {
        text: document.getElementById('aiGmBody').textContent,
        open: modal.dataset.open,
        cardHidden: document.getElementById('aiGmOpenBtn').hidden,
      };
    }, seedSeason(99999999));
    if (!/Sentinel Squad/.test(switched.text)) {
      pass('switching to another league drops the previous league\'s board');
    } else fail('a previous league\'s roster survived the switch');
    if (switched.open === 'false' && switched.cardHidden) {
      pass('switching away from the beta league closes the desk and hides the card');
    } else fail('the desk stayed open after leaving the beta league', JSON.stringify(switched));

    /* ---- a malformed analysis must not blank the desk ---- */
    const broken = await page.evaluate(() => {
      window.LeagueData.setMeta('leagueId', '57155288');
      window.LeagueData.publish();
      window.FSNAiGm.__setAnalysis({
        ok: true,
        league: { id: '57155288', name: 'X', season: 2026, week: 1, teamCount: 12 },
        myTeam: { id: '1', name: 'T', owner: 'o', record: '', projectedLineup: 1 },
        trades: null, waivers: null, search: null,
      });
      return document.getElementById('aiGmBody').textContent;
    });
    if (broken && broken.trim().length > 0 && !/hit a snag/i.test(broken)) {
      pass('a half-populated analysis still renders an honest, non-empty desk');
    } else fail('a malformed analysis blanked the desk', String(broken).slice(0, 120));

    if (!pageErrors.length) pass('zero uncaught page errors across the whole pass');
    else {
      fail(pageErrors.length + ' uncaught page error(s)');
      pageErrors.forEach((e) => console.error('        ' + e.split('\n')[0]));
    }
    /* The intentional-failure assertions above log on purpose; anything OTHER
       than those is a real regression. */
    const unexpected = consoleErrors.filter((text) =>
      !/AI_GM_REQUEST_FAILED|AI_GM_CLIPBOARD_REFUSED|\/api\/ai-gm|not deployed|clipboard/i.test(text));
    if (!unexpected.length) pass('zero unexpected tagged console errors');
    else {
      fail(unexpected.length + ' unexpected tagged console error(s)');
      unexpected.forEach((e) => console.error('        ' + e));
    }
  } finally {
    await browser.close();
    server.close();
  }
}

/* ============================================================================
   RUN
============================================================================ */
console.log('[ai-gm-check] AI GM beta — engine, handler, budget' + (noBrowser ? '' : ', render'));

checkEngine();
checkModels();
checkMatchmaking();
await checkHandler();
checkBudget();
if (noBrowser) console.log('\n[ai-gm-check] render pass skipped (--no-browser)');
else await checkRender();

console.log(failures
  ? '\n[ai-gm-check] FAILED (' + failures + ' failure' + (failures === 1 ? '' : 's') + ')'
  : '\n[ai-gm-check] clean');
process.exit(failures ? 1 : 0);
