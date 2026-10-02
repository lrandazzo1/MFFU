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
                    that no pitch copy survives, and zero tagged console errors.

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
const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
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
   PASS 1c — MATCHMAKING, PITCH REMOVAL AND DETERMINISM
============================================================================ */
function checkMatchmaking() {
  console.log('\n[ai-gm-check] 1c/4  trade matchmaking, pitch removal, determinism\n');

  const analysis = buildAnalysis();

  if (analysis.search.rostersAnalyzed === 11 && analysis.search.rostersTotal === 11) {
    pass('all eleven opposing rosters were re-solved');
  } else fail('roster coverage', analysis.search.rostersAnalyzed + ' of ' + analysis.search.rostersTotal);
  if (!analysis.search.truncated) pass('the search completed inside its budget');
  else fail('the search truncated on a twelve-team fixture');

  /* The defaults the whole time budget rests on, asserted rather than assumed.
     A pool raised past what the deadline affords would start truncating real
     boards, and the truncation notice is a worse product than a slightly
     shallower search. */
  if (gm.DEFAULT_TRADE_POOL_SIZE === 10 && gm.DEFAULT_SEARCH_DEADLINE_MS === 7000) {
    pass('the tuning defaults are pool ' + gm.DEFAULT_TRADE_POOL_SIZE + ' under a ' +
      gm.DEFAULT_SEARCH_DEADLINE_MS + 'ms deadline');
  } else fail('the tuning defaults moved without the benchmark being revisited',
    'pool ' + gm.DEFAULT_TRADE_POOL_SIZE + ' / ' + gm.DEFAULT_SEARCH_DEADLINE_MS + 'ms');
  if (gm.findOffers(gm.normalize(fixtureLeague(), { week: 1 }),
      gm.resolveMyTeam(gm.normalize(fixtureLeague(), { week: 1 }), '1', ''),
      { deadlineMs: 0 }).poolSize === gm.DEFAULT_TRADE_POOL_SIZE) {
    pass('findOffers actually applies that default when no depth is requested');
  } else fail('findOffers does not use the exported pool default');

  /* A realistic-shaped league must finish well inside the deadline, not merely
     inside it — otherwise the first slow cold start truncates a real board. The
     bound is deliberately loose (a shared CI runner is not a benchmark rig);
     what it catches is an algorithmic regression, such as the solver cache being
     keyed wrongly and no longer hitting. */
  const timedStart = Date.now();
  buildAnalysis({ deadlineMs: 0, poolSize: gm.DEFAULT_TRADE_POOL_SIZE });
  const elapsed = Date.now() - timedStart;
  if (elapsed < gm.DEFAULT_SEARCH_DEADLINE_MS / 2) {
    pass('a full twelve-roster search finished in ' + elapsed + 'ms, well inside the ' +
      gm.DEFAULT_SEARCH_DEADLINE_MS + 'ms budget');
  } else fail('the search is too close to its deadline (' + elapsed + 'ms of ' +
    gm.DEFAULT_SEARCH_DEADLINE_MS + 'ms) — the solver cache has most likely stopped hitting');

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

  /* ---- the pitch generator is GONE, and must stay gone ----
     These are removal guards. The feature shipped with a deterministic DM
     generator and a Copy Pitch button; both were removed because the card is
     meant to read as numbers. A guard that only checked the UI would let the
     generator creep back in on the server and ship an unused pitch string in
     every response, so the payload, the exports and the source are all checked. */
  const withPitch = analysis.trades.filter((t) => 'pitch' in t);
  if (!withPitch.length) pass('no proposal carries a pitch field');
  else fail('the analysis still emits pitch copy', withPitch.length + ' proposal(s)');

  for (const name of ['buildPitch', 'honestSurplus', 'solvedNeeds', 'playerLabel', 'listNames']) {
    if (!(name in gm)) continue;
    fail('lib/ai-gm.js still exports the pitch helper ' + name);
  }
  pass('none of the pitch-copy helpers are exported any more');

  /* packagePositions outlived the pitch because the bye-week desk reads it. */
  if (typeof gm.packagePositions === 'function' &&
      gm.packagePositions([{ pos: 'RB' }, { pos: 'WR' }, { pos: 'RB' }]).join(',') === 'RB,WR') {
    pass('packagePositions survives for the bye desk and still de-duplicates');
  } else fail('packagePositions was removed or broken; the bye-week desk reads it');

  /* The buy-low / sell-high rows must carry NUMBERS, not a sentence — that is
     what the card renders now, and the prose field is what was deleted. */
  const buyLowRows = analysis.buyLow || [];
  const sellHighRows = analysis.sellHigh || [];
  const prose = buyLowRows.concat(sellHighRows).filter((r) => 'reason' in r);
  if (!prose.length) pass('no buy-low / sell-high row carries a generated sentence');
  else fail('a generated reason sentence survived', prose.length + ' row(s)');

  const numeric = buyLowRows.every((r) =>
    Number.isFinite(r.actualPpg) && Number.isFinite(r.baselinePpg) &&
    Number.isFinite(r.shortfall) && Number.isFinite(r.games)) &&
    sellHighRows.every((r) =>
      Number.isFinite(r.actualPpg) && Number.isFinite(r.baselinePpg) &&
      Number.isFinite(r.surplus) && Number.isFinite(r.games));
  if (numeric && (buyLowRows.length || sellHighRows.length)) {
    pass('every watchlist row carries actual, forecast and the gap as numbers');
  } else fail('a watchlist row is missing the numbers the card renders',
    JSON.stringify(buyLowRows.concat(sellHighRows).slice(0, 1)));

  /* Injury designations are facts on the card, not copy, so they stay. */
  const hurtLeague = fixtureLeague();
  hurtLeague.teams[1].roster.entries[2].playerPoolEntry.player.injuryStatus = 'QUESTIONABLE';
  const hurt = gm.analyze({
    league: hurtLeague,
    freeAgents: gm.freeAgentsFrom(fixturePool(), 1, fixtureByes),
    byeWeeks: fixtureByes,
  }, baseOptions);
  if (hurt.trades.every((t) => Array.isArray(t.designations))) {
    pass('injury designations still travel with every proposal');
  } else fail('designations were lost with the pitch');

  /* No prose field anywhere in a proposal. Anything long and sentence-shaped is
     the generator growing back under another name. */
  const sentences = [];
  for (const trade of analysis.trades) {
    for (const [key, value] of Object.entries(trade)) {
      if (typeof value === 'string' && value.length > 120) sentences.push(key);
    }
  }
  if (!sentences.length) pass('no proposal field holds a long prose string');
  else fail('a proposal carries prose copy', sentences.join(', '));

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
  if (!clockHits.length) pass('no Math.random or new Date in the scoring or matchmaking paths');
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
  const state = gm.normalize(fixtureLeague(), { week: 1, byeWeeks: fixtureByes });
  const me = gm.resolveMyTeam(state, '1', '');
  const starved = gm.findOffers(state, me, Object.assign({}, baseOptions, { deadlineMs: 1e-9 }));
  if (starved.truncated && starved.rostersAnalyzed < starved.rostersTotal) {
    pass('an exhausted budget reports truncation and how far it got');
  } else fail('the search budget does not report truncation');
}

/* ============================================================================
   PASS 1d — THREE-TEAM PATHWAYS

   Fixtures engineered so the answer is known in advance:

     me (1)   a spare WR on the bench and a replacement-level RB2 — needs an RB.
     B  (2)   RB-rich with a spare RB, a TE hole, and NO use for a WR, so it
              refuses my WR for its RB straight up. The direct trade fails.
     A  (3)   a WR hole and a spare TE — exactly what B is missing.
     C  (4)   flat filler that should only ever appear as a weak route.

   So   me ──WR──▶ A ──TE──▶ B ──RB──▶ me   is a win-win-win that no 2-team
   trade can reach. The BLOCKBUSTER variant makes my WR a starter instead of a
   bench piece, so the first leg alone costs me points.
============================================================================ */
function cycleLeague(variant) {
  nextPlayerId = 5000;
  const blockbuster = variant === 'blockbuster';
  const bWantsWr = variant === 'b-wants-wr';
  const t = (id, name, rec, entries) => ({
    id: id, name: name, abbrev: name.replace(/[^A-Z]/g, '').slice(0, 4) || ('T' + id),
    primaryOwner: '{P' + id + '}', owners: ['{P' + id + '}'],
    record: { overall: rec }, roster: { entries: entries },
  });
  return {
    id: 57155288, seasonId: 2026, scoringPeriodId: 1,
    settings: { name: 'Cycle League', rosterSettings: { lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 20: 6 } } },
    members: [],
    teams: [
      t(1, 'Me Team', { wins: 2, losses: 4, ties: 0 }, blockbuster ? [
        QB('M QB', 20, 0), RB('M RB1', 16, 2), RB('M RB2', 3, 2),
        WR('M WR1', 18, 4), WR('M WR2', 16, 4), WR('M Flex WR', 13, 23), TE('M TE', 9, 6),
      ] : [
        QB('M QB', 20, 0), RB('M RB1', 16, 2), RB('M RB2', 3, 2),
        WR('M WR1', 18, 4), WR('M WR2', 16, 4), WR('M WR3', 14, 23), TE('M TE', 9, 6),
        WR('M Spare WR', 13, 20),
      ]),
      t(2, 'RB Rich', { wins: 3, losses: 3, ties: 0 }, [
        QB('B QB', 18, 0), RB('B RB1', 17, 2), RB('B RB2', 15, 2), RB('B Spare RB', 14, 20),
        WR('B WR1', 17, 4), bWantsWr ? WR('B WR2', 2, 4) : WR('B WR2', 16, 4),
        WR('B Flex', 15, 23), TE('B TE', 2, 6),
      ]),
      t(3, 'TE Rich', { wins: 1, losses: 5, ties: 0 }, [
        QB('A QB', 17, 0), RB('A RB1', 15, 2), RB('A RB2', 14, 2), WR('A WR1', 16, 4), WR('A WR2', 3, 4),
        RB('A Flex', 12, 23), TE('A TE', 12, 6), TE('A Spare TE', 11, 20),
      ]),
      t(4, 'Flat', { wins: 3, losses: 3, ties: 0 }, [
        QB('C QB', 10, 0), RB('C RB1', 8, 2), RB('C RB2', 8, 2), WR('C WR1', 8, 4), WR('C WR2', 8, 4),
        WR('C Flex', 8, 23), TE('C TE', 8, 6),
      ]),
    ],
  };
}

/* Exhaustive oracle: no search gates or candidate ordering. */
function pathwayAcceptance(state, team, out, inn, floor) {
  const solve = gm.lineupSolver(state.slotIds);
  const before = gm.pathwayRosterRead(team, state, solve);
  const after = gm.pathwayRosterRead({ players: gm.applySwap(team.players, [out], [inn]) }, state, solve);
  return gm.pathwayFit(before, after, out, inn, after.points - before.points, floor);
}
function pathwayOracle(state, me, minPartnerGain, poolSize) {
  const opponents = state.teams.filter((t) => t.id !== me.id);
  const pool = (team) => gm.tradeablePool(team, poolSize);
  const keys = [];
  for (const X of pool(me)) {
    for (const B of opponents) {
      for (const Z of pool(B)) {
        if (!gm.pathwayMarketMatch(X, Z, state.benchmarks)) continue;
        if (!pathwayAcceptance(state, me, X, Z, 0.05).accepted) continue;
        if (pathwayAcceptance(state, B, Z, X, minPartnerGain).accepted) continue;
        for (const A of opponents) {
          if (A.id === B.id) continue;
          for (const Y of pool(A)) {
            if (!gm.pathwayMarketMatch(X, Y, state.benchmarks) ||
                !gm.pathwayMarketMatch(Y, Z, state.benchmarks)) continue;
            if (pathwayAcceptance(state, A, Y, X, minPartnerGain).accepted &&
                pathwayAcceptance(state, B, Z, Y, minPartnerGain).accepted) {
              keys.push([X.id, A.id, Y.id, B.id, Z.id].join('|'));
            }
          }
        }
      }
    }
  }
  return keys.sort();
}

function checkPathways() {
  console.log('\n[ai-gm-check] 1d/4  three-team pathways\n');

  const POOL = 10;
  const FLOOR = 0.5;
  const all = { pathwayLimit: 9999, pathwayDeadlineMs: 0, minPartnerGain: FLOOR, pathwayPoolSize: POOL };

  const pState = gm.normalize(cycleLeague('pathway'), { week: 1 });
  const pMe = gm.resolveMyTeam(pState, '1', '');
  const pRun = gm.findPathways(pState, pMe, all);
  const bState = gm.normalize(cycleLeague('blockbuster'), { week: 1 });
  const bMe = gm.resolveMyTeam(bState, '1', '');
  const bRun = gm.findPathways(bState, bMe, all);

  /* ---- the known cycle is found ---- */
  const known = pRun.pathways.find((p) =>
    p.give.name === 'M Spare WR' && p.teamA.name === 'TE Rich' && p.broker.name === 'A Spare TE' &&
    p.teamB.name === 'RB Rich' && p.target.name === 'B Spare RB');
  if (known) pass('the engineered cycle is found: spare WR -> TE Rich, spare TE -> RB Rich, spare RB -> me');
  else fail('the known 3-cycle was not found', pRun.pathways.length + ' cycle(s) returned');
  if (known && known.kind === 'PATHWAY' && known.interimGain >= 0) {
    pass('a bench WR for a TE that starts for me is a safe PATHWAY (after step 1 ' +
      known.interimGain.toFixed(1) + ')');
  } else fail('the known cycle is misclassified', known && known.kind);

  /* All three managers must benefit; weekly deltas may be neutral or negative. */
  const everyRun = pRun.pathways.concat(bRun.pathways);
  const invalid = everyRun.filter((p) =>
    !pathwayAcceptance(pRun.pathways.includes(p) ? pState : bState, p.me, p.give, p.target, 0.05).accepted ||
    !pathwayAcceptance(pRun.pathways.includes(p) ? pState : bState, p.teamA, p.broker, p.give, FLOOR).accepted ||
    !pathwayAcceptance(pRun.pathways.includes(p) ? pState : bState, p.teamB, p.target, p.broker, FLOOR).accepted ||
    [[p.give, p.broker], [p.broker, p.target], [p.give, p.target]].some(([a, b]) =>
      !gm.pathwayMarketMatch(a, b, (pRun.pathways.includes(p) ? pState : bState).benchmarks)));
  if (everyRun.length && !invalid.length) pass('every manager benefits within roster-fit and tier protections');
  else fail('an invalid cycle survived', invalid.length);

  /* Recompute every team's delta from scratch — the engine's arithmetic is not
     taken on trust. */
  const solveP = gm.lineupSolver(pState.slotIds);
  const recompute = (state, solve, team, out, inn) =>
    solve(gm.applySwap(team.players, [out], [inn])) - solve(team.players);
  const drift = pRun.pathways.filter((p) =>
    Math.abs(recompute(pState, solveP, p.me, p.give, p.target) - p.myGain) > 1e-9 ||
    Math.abs(recompute(pState, solveP, p.teamA, p.broker, p.give) - p.aGain) > 1e-9 ||
    Math.abs(recompute(pState, solveP, p.teamB, p.target, p.broker) - p.bGain) > 1e-9);
  if (!drift.length) pass('every team\'s delta matches an independent re-solve of its final roster');
  else fail('engine deltas disagree with an independent re-solve', drift.length + ' cycle(s)');

  const badLedger = everyRun.filter((p) =>
    Math.abs((p.myAfter - p.myBefore) - p.myGain) > 1e-9 ||
    Math.abs((p.aAfter - p.aBefore) - p.aGain) > 1e-9 ||
    Math.abs((p.bAfter - p.bBefore) - p.bGain) > 1e-9);
  if (!badLedger.length) pass('all three ledgers reconcile: after − before = the stated delta');
  else fail('a pathway ledger does not reconcile', badLedger.length + ' cycle(s)');

  /* ---- the cycle's shape ---- */
  const malformed = everyRun.filter((p) => {
    const ids = new Set([p.me.id, p.teamA.id, p.teamB.id]);
    return ids.size !== 3 ||
      !p.me.players.some((x) => x.id === p.give.id) ||
      !p.teamA.players.some((x) => x.id === p.broker.id) ||
      !p.teamB.players.some((x) => x.id === p.target.id);
  });
  if (!malformed.length) pass('every cycle spans three distinct teams, each piece starting on its own roster');
  else fail('a malformed cycle', malformed.length + ' cycle(s)');

  /* ---- value on the table: the direct swap must be refused ---- */
  const directOk = everyRun.filter((p) => pathwayAcceptance(
    pRun.pathways.includes(p) ? pState : bState, p.teamB, p.target, p.give, FLOOR).accepted);
  if (!directOk.length) {
    pass('every cycle routes around a direct swap refused by roster-fit checks');
  } else fail('a cycle duplicates a direct 2-team deal', directOk.length + ' cycle(s)');

  /* And the converse, checked generically rather than on one hand-picked pair:
     independently find every (X, Z) whose DIRECT swap is win-win, and require
     that none of them was brokered — those belong to the 2-team board.

     (An earlier version asserted one specific pair in this fixture was directly
     available. It is not: dropping B's WR2 to 2 pushes B's RBs into its FLEX, so
     its "spare" RB is a starter and B scores -1 taking my WR13 for it. The engine
     was right to broker that pair; the assertion was wrong. Hence the generic
     form, which cannot be fooled by a fixture that is subtler than intended.) */
  const wState = gm.normalize(cycleLeague('b-wants-wr'), { week: 1 });
  const wMe = gm.resolveMyTeam(wState, '1', '');
  const wRun = gm.findPathways(wState, wMe, all);
  const solveW = gm.lineupSolver(wState.slotIds);
  const directPairs = new Set();
  for (const X of gm.tradeablePool(wMe, POOL)) {
    for (const B of wState.teams.filter((t) => t.id !== wMe.id)) {
      for (const Z of gm.tradeablePool(B, POOL)) {
        if (!gm.pathwayMarketMatch(X, Z, wState.benchmarks) ||
            !pathwayAcceptance(wState, wMe, X, Z, 0.05).accepted) continue;
        if (pathwayAcceptance(wState, B, Z, X, FLOOR).accepted) directPairs.add(X.id + '|' + Z.id);
      }
    }
  }
  const brokered = wRun.pathways.filter((p) => directPairs.has(p.give.id + '|' + p.target.id));
  if (directPairs.size > 0 && !brokered.length) {
    pass('none of the ' + directPairs.size + ' directly-tradeable pairs was brokered into a 3-way — ' +
      'they are left to the 2-team board');
  } else fail('a directly-available swap was brokered anyway', JSON.stringify({
    directPairs: directPairs.size, brokered: brokered.length }));
  if (directPairs.size === wRun.stats.pairsDirectlyAvailable) {
    pass('the engine\'s own count of directly-available pairs matches the independent count (' +
      directPairs.size + ')');
  } else fail('the engine miscounts directly-available pairs',
    wRun.stats.pairsDirectlyAvailable + ' vs ' + directPairs.size);

  /* ---- PATHWAY vs BLOCKBUSTER ---- */
  const solveB = gm.lineupSolver(bState.slotIds);
  const misKinded = everyRun.filter((p) => {
    const state = pRun.pathways.indexOf(p) !== -1 ? pState : bState;
    const solve = pRun.pathways.indexOf(p) !== -1 ? solveP : solveB;
    const interim = recompute(state, solve, p.me, p.give, p.broker);
    return Math.abs(interim - p.interimGain) > 1e-9 ||
      (p.kind === 'PATHWAY') !== (interim >= -1e-9);
  });
  if (!misKinded.length) {
    pass('PATHWAY exactly when step 1 alone leaves me no worse; BLOCKBUSTER otherwise');
  } else fail('a cycle is labelled against its own interim', misKinded.length + ' cycle(s)');

  const kinds = new Set(everyRun.map((p) => p.kind));
  if (kinds.has('PATHWAY') && kinds.has('BLOCKBUSTER')) pass('both kinds are produced across the fixtures');
  else fail('only one kind was ever produced', [...kinds].join(','));
  const starterOut = bRun.pathways.filter((p) => p.give.name === 'M Flex WR');
  if (starterOut.length && starterOut.every((p) => p.kind === 'BLOCKBUSTER')) {
    pass('sending a starting WR makes every route a BLOCKBUSTER — step 1 alone costs me the flex');
  } else fail('a starter-out route was not a blockbuster', JSON.stringify(starterOut.map((p) => p.kind)));

  /* ---- lossless pruning ---- */
  for (const [label, state, me, run] of [['pathway', pState, pMe, pRun], ['blockbuster', bState, bMe, bRun],
    ['b-wants-wr', wState, wMe, wRun]]) {
    const engine = run.pathways.map((p) => [p.give.id, p.teamA.id, p.broker.id, p.teamB.id, p.target.id].join('|')).sort();
    const oracle = pathwayOracle(state, me, FLOOR, POOL);
    if (engine.length === oracle.length && engine.every((k, i) => k === oracle[i])) {
      pass('the gates are lossless on the ' + label + ' fixture: engine and brute force agree on all ' +
        oracle.length + ' cycles');
    } else fail('pruning discarded or invented a cycle on the ' + label + ' fixture',
      'engine ' + engine.length + ' vs oracle ' + oracle.length);
  }

  /* The property every gate stands on: removing a player can never raise an
     optimal lineup, so gain(T, -out +in) <= gain(T, +in). Checked exhaustively
     across the fixture rather than assumed. */
  let violations = 0;
  let samples = 0;
  for (const team of pState.teams) {
    const others = pState.teams.filter((t) => t.id !== team.id);
    for (const out of gm.tradeablePool(team, POOL)) {
      for (const other of others) {
        for (const inn of gm.tradeablePool(other, POOL)) {
          samples++;
          const swap = solveP(gm.applySwap(team.players, [out], [inn]));
          const add = solveP(team.players.concat([inn]));
          if (swap > add + 1e-9) violations++;
        }
      }
    }
  }
  if (!violations) pass('monotonicity holds on all ' + samples + ' swaps: −out +in never beats +in alone');
  else fail('monotonicity violated — the gates are unsound', violations + ' of ' + samples);

  /* ---- ranking, dedupe, limit ---- */
  const shown = gm.findPathways(pState, pMe, { pathwayDeadlineMs: 0, minPartnerGain: FLOOR, pathwayPoolSize: POOL });
  let ordered = true;
  for (let i = 1; i < shown.pathways.length; i++) {
    if (shown.pathways[i].fitScore > shown.pathways[i - 1].fitScore + 1e-9 ||
        (near(shown.pathways[i].fitScore, shown.pathways[i - 1].fitScore) &&
         shown.pathways[i].myGain > shown.pathways[i - 1].myGain + 1e-9)) ordered = false;
  }
  if (ordered) pass('pathways rank positional fit before projection gain');
  else fail('pathway ranking');
  if (shown.pathways.length <= gm.DEFAULT_PATHWAY_POOL_SIZE && shown.pathways.length <= 4) {
    pass('output is limited to the top ' + shown.pathways.length + ' of ' + shown.survivors + ' cycles');
  } else fail('the pathway limit was not applied', String(shown.pathways.length));
  const targets = shown.pathways.map((p) => p.target.id);
  const distinctTargets = new Set(pRun.pathways.map((p) => p.target.id)).size;
  if (new Set(targets).size === Math.min(targets.length, distinctTargets)) {
    pass('shown pathways land distinct targets before repeating one');
  } else fail('pathway dedupe', targets.join(','));

  /* ---- determinism ---- */
  const once = JSON.stringify(gm.findPathways(pState, pMe, all).pathways.map((p) =>
    [p.give.id, p.broker.id, p.target.id, p.myGain, p.aGain, p.bGain, p.kind]));
  const twice = JSON.stringify(gm.findPathways(pState, pMe, all).pathways.map((p) =>
    [p.give.id, p.broker.id, p.target.id, p.myGain, p.aGain, p.bGain, p.kind]));
  if (once === twice) pass('two pathway searches over the same payload are identical');
  else fail('pathway determinism');

  /* ---- bounds, reported rather than silent ---- */
  const budgeted = gm.findPathways(pState, pMe, Object.assign({}, all, { pathwayCheckBudget: 3 }));
  if (budgeted.truncated && budgeted.truncatedBy === 'budget' && budgeted.stats.cycleChecks === 3) {
    pass('an exhausted check budget stops at exactly the budget and says so');
  } else fail('the check budget is not enforced or not reported', JSON.stringify({
    truncated: budgeted.truncated, by: budgeted.truncatedBy, checks: budgeted.stats.cycleChecks }));
  if (budgeted.pathways.every((p) => p.benefits.me.accepted && p.benefits.a.accepted && p.benefits.b.accepted)) {
    pass('a truncated search still returns only accepted roster-fit cycles');
  } else fail('truncation returned an invalid cycle');
  const starved = gm.findPathways(pState, pMe, Object.assign({}, all, { pathwayDeadlineMs: 1e-9 }));
  if (starved.truncated && starved.truncatedBy === 'deadline') pass('an exhausted deadline is reported as such');
  else fail('the pathway deadline is not reported', JSON.stringify({ t: starved.truncated, by: starved.truncatedBy }));

  /* Explicit behavioral regressions: zero and negative weekly points are
     accepted for usable depth, while large losses and elite flips are refused. */
  for (const [label, rb, te, expected] of [['neutral depth', 14, 11, 0], ['negative depth', 16, 11, -1]]) {
    const league = cycleLeague('pathway');
    const rows = league.teams[1].roster.entries;
    rows.find((r) => r.playerPoolEntry.player.fullName === 'B TE').playerPoolEntry.player.stats[0].appliedTotal = te;
    rows.find((r) => r.playerPoolEntry.player.fullName === 'B Spare RB').playerPoolEntry.player.stats[0].appliedTotal = rb;
    const state = gm.normalize(league, { week: 1 });
    const run = gm.findPathways(state, state.teams[0], all);
    const route = run.pathways.find((p) => p.give.name === 'M Spare WR' &&
      p.broker.name === 'A Spare TE' && p.target.name === 'B Spare RB');
    if (route && near(route.bGain, expected) && route.benefits.b.reasons.includes('gains TE depth') &&
        route.benefits.b.reasons.includes('clears RB surplus')) pass(label + ' trade survives with honest rationale');
    else fail(label + ' route was rejected or misexplained', route && route.bGain);
    const oracle = pathwayOracle(state, state.teams[0], FLOOR, POOL);
    if (run.pathways.length === oracle.length) pass(label + ' search matches exhaustive roster-fit oracle');
    else fail(label + ' pruning lost a route', run.pathways.length + ' vs ' + oracle.length);
  }
  const depthLeague = cycleLeague('pathway');
  const myRows = depthLeague.teams[0].roster.entries;
  myRows.find((r) => r.playerPoolEntry.player.fullName === 'M RB2').playerPoolEntry.player.stats[0].appliedTotal = 15;
  myRows.find((r) => r.playerPoolEntry.player.fullName === 'M WR3').playerPoolEntry.player.stats[0].appliedTotal = 13;
  myRows.splice(myRows.findIndex((r) => r.playerPoolEntry.player.fullName === 'M Spare WR'), 1);
  depthLeague.teams[1].roster.entries.find((r) => r.playerPoolEntry.player.fullName === 'B Spare RB')
    .playerPoolEntry.player.stats[0].appliedTotal = 12;
  const depthState = gm.normalize(depthLeague, { week: 1 });
  const depthRun = gm.findPathways(depthState, depthState.teams[0], all);
  const myDepth = depthRun.pathways.find((p) => p.give.name === 'M WR3' && p.target.name === 'B Spare RB' &&
    p.broker.name === 'A Spare TE');
  if (myDepth && near(myDepth.myGain, -1) && myDepth.benefits.me.reasons.includes('gains RB depth')) {
    pass('the requesting team can accept -1 pt/wk to build RB depth');
  } else fail('the requesting team still needs strict positive points');
  const protectedPlayer = { pos: 'RB', projection: 3, seasonBaseline: 20, draftRank: 8, hasProjection: true };
  const streamer = { pos: 'TE', projection: 12, seasonBaseline: 6, draftRank: 142, hasProjection: true };
  if (!gm.pathwayMarketMatch(protectedPlayer, streamer, { RB: 15, TE: 12 }) &&
      !gm.pathwayMarketMatch(streamer, protectedPlayer, { RB: 15, TE: 12 })) {
    pass('elite pedigree stays protected even during a low-projection week, in either direction');
  } else fail('a star can be flipped for a streamer');
  const comparable = { pos: 'WR', projection: 18, seasonBaseline: 20, draftRank: 10, hasProjection: true };
  if (gm.pathwayMarketMatch(protectedPlayer, comparable, { RB: 15, WR: 14 })) pass('comparable elite assets can be exchanged');
  else fail('elite-for-elite was rejected');
  const invalidLeague = cycleLeague('pathway');
  invalidLeague.teams[1].roster.entries.find((r) => r.playerPoolEntry.player.fullName === 'B TE')
    .playerPoolEntry.player.stats[0].appliedTotal = 11;
  invalidLeague.teams[1].roster.entries.find((r) => r.playerPoolEntry.player.fullName === 'B Spare RB')
    .playerPoolEntry.player.stats[0].appliedTotal = 19;
  const lossState = gm.normalize(invalidLeague, { week: 1 });
  const rb = lossState.teams[1].players.find((p) => p.name === 'B Spare RB');
  const te = lossState.teams[2].players.find((p) => p.name === 'A Spare TE');
  if (!pathwayAcceptance(lossState, lossState.teams[1], rb, te, FLOOR).accepted) pass('depth never excuses a loss larger than 2 pt/wk');
  else fail('an excessive weekly loss was excused by depth');

  /* ---- through analyze(), on the twelve-team fixture ---- */
  const analysis = buildAnalysis();
  if (Array.isArray(analysis.pathways) && analysis.search3 && analysis.search3.stats) {
    pass('analyze() returns ' + analysis.pathways.length + ' pathways and the search stats');
  } else fail('analyze() is missing pathways or search3');
  const shapeOk = analysis.pathways.every((p) =>
    p.me && p.a && p.b && p.give && p.broker && p.target && p.teamA && p.teamB &&
    (p.kind === 'PATHWAY' || p.kind === 'BLOCKBUSTER') && typeof p.hasTwoTeamAlternative === 'boolean');
  if (shapeOk) pass('every pathway in the payload carries all three ledgers, the pieces and the kind');
  else fail('a pathway payload is malformed');
  if (analysis.pathways.every((p) => [p.benefits.me, p.benefits.a, p.benefits.b].every((f) => f.accepted && f.reasons.length))) {
    pass('the payload explains why all three managers agree');
  } else fail('a pathway lacks a participant benefit');
  const longProse = [];
  for (const p of analysis.pathways) {
    for (const [k, v] of Object.entries(p)) if (typeof v === 'string' && v.length > 120) longProse.push(k);
  }
  if (!longProse.length) pass('no pathway field holds prose — the card is numbers, like the 2-team one');
  else fail('a pathway carries prose', longProse.join(','));
  const s3 = analysis.search3;
  if (!s3.truncated && s3.stats.cycleChecks < gm.DEFAULT_PATHWAY_CHECK_BUDGET / 10) {
    pass('the twelve-team fixture finished in ' + s3.stats.cycleChecks + ' checks, under a tenth of the budget');
  } else fail('the pathway search is too close to its budget', JSON.stringify(s3.stats));
  const twoTeamGain = analysis.search3.bestTwoTeamGain;
  const upliftsHonest = analysis.pathways.every((p) =>
    Math.abs(p.upliftVsBestTwoTeam - round1(p.me.gain - twoTeamGain)) < 0.11 &&
    p.beatsBestTwoTeam === (p.upliftVsBestTwoTeam > 0.05));
  if (upliftsHonest) pass('every pathway reports its uplift against the best 2-team deal honestly');
  else fail('a pathway misreports its comparison to the 2-team board');

  /* When the 2-team board is empty a pathway is the only win-win going, and says
     so. The cycle league has no direct deal for the RB at all. */
  const lonely = gm.analyze({ league: cycleLeague('pathway'), freeAgents: [], byeWeeks: {} },
    Object.assign({}, baseOptions, { minPartnerGain: FLOOR }));
  if (lonely.pathways.length && lonely.pathways.every((p) => p.hasTwoTeamAlternative === !!lonely.trades.length)) {
    pass('hasTwoTeamAlternative tracks whether the 2-team board has anything (' + lonely.trades.length +
      ' direct deal(s) here)');
  } else fail('hasTwoTeamAlternative does not track the 2-team board');

  /* Realistic scale: twelve teams of sixteen. */
  const t0 = Date.now();
  const big = gm.analyze({ league: fixtureLeague(), freeAgents: [], byeWeeks: {} },
    Object.assign({}, baseOptions, { pathwayDeadlineMs: 0 }));
  const ms = Date.now() - t0;
  if (ms < gm.DEFAULT_PATHWAY_DEADLINE_MS / 2) {
    pass('full analysis with the 3-team search finished in ' + ms + 'ms (' + big.search3.found + ' cycles)');
  } else fail('the 3-team search is too slow for the request budget', ms + 'ms');
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
  if (!/aigm-card|aigm-swap-side/.test(modalMarkup)) {
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
        copyClass: body.querySelectorAll('.aigm-copy').length,
        pitchBlocks: body.querySelectorAll('.aigm-pitch').length,
        cards: body.querySelectorAll('.aigm-card').length,
        sections: Array.from(body.querySelectorAll('.aigm-section-head h3')).map((h) => h.textContent),
        subtitle: document.getElementById('aiGmSubtitle').textContent,
        busy: body.getAttribute('aria-busy'),
        /* Every trade card's own height and its longest run of prose, so the
           "numbers, not copy" claim is measured rather than asserted. */
        tradeCards: Array.from(body.querySelectorAll('.aigm-card')).filter(
          (c) => c.querySelector('.aigm-swap')).map((c) => ({
            height: Math.round(c.getBoundingClientRect().height),
            longestText: Math.max(0, ...Array.from(c.querySelectorAll('*'))
              .filter((el) => !el.children.length)
              .map((el) => (el.textContent || '').trim().length)),
          })),
        watchRows: body.querySelectorAll('.aigm-watch-row').length,
        /* The desk must never scroll sideways: the form chips carry player names
           now, and a chip cannot wrap inside itself. */
        overflowsX: body.scrollWidth > body.clientWidth + 1,
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

    /* ---- the pitch UI is gone ---- */
    if (!rendered.copyButtons && !rendered.copyClass && !rendered.pitchBlocks) {
      pass('no Copy Pitch button and no pitch transcript anywhere in the rendered desk');
    } else fail('the pitch UI is still rendered', JSON.stringify({
      copyButtons: rendered.copyButtons, copyClass: rendered.copyClass,
      pitchBlocks: rendered.pitchBlocks,
    }));
    if (!/COPY PITCH|ready to send|quick trade idea/i.test(rendered.text)) {
      pass('none of the pitch copy survives in the rendered text');
    } else fail('pitch copy is still on screen');

    /* ---- the card is numbers, not copy ----
       Every leaf element in a trade card is a label, a name or a figure, so none
       of them should hold a sentence. 60 characters is generous for
       "Gamma Wide (WR KC) · 14.0 proj" and far under the 200+ the old prose
       bullets ran to. */
    const wordy = rendered.tradeCards.filter((c) => c.longestText > 60);
    if (rendered.tradeCards.length && !wordy.length) {
      pass(rendered.tradeCards.length + ' trade cards carry no text run over 120 chars ' +
        '(longest ' + Math.max(...rendered.tradeCards.map((c) => c.longestText)) + ')');
    } else fail('a trade card still holds a prose run', JSON.stringify(wordy));

    /* And the vertical cost is bounded. Measured on this fixture at 414px wide,
       before and after the pitch removal:

                     tallest card   typical card   whole board
         before          694px          560px         3686px
         after           402px          294px         2582px

       440px is the guard: it clears the tallest card (402px, the one carrying
       both a BUY LOW and a SELL HIGH chip) with room for a longer team name,
       and it trips long before anything resembling the old layout — the pitch
       transcript alone was 158px and its button another 46px. */
    const TRADE_CARD_MAX_PX = 440;
    const tall = rendered.tradeCards.filter((c) => c.height > TRADE_CARD_MAX_PX);
    if (rendered.tradeCards.length && !tall.length) {
      pass('every trade card fits in ' + TRADE_CARD_MAX_PX + 'px (tallest ' +
        Math.max(...rendered.tradeCards.map((c) => c.height)) + 'px, was 694px with the pitch)');
    } else fail('a trade card is taller than ' + TRADE_CARD_MAX_PX + 'px', JSON.stringify(tall));

    if (rendered.watchRows > 0) pass('the watchlist renders ' + rendered.watchRows + ' numeric rows');
    else fail('the watchlist rendered no rows from a fixture that has both lists');

    if (!rendered.overflowsX) pass('the desk does not scroll sideways at 414px');
    else fail('the desk overflows horizontally — a chip is wider than the card');

    /* And with a pathologically long name, which is what would actually break it. */
    const longName = JSON.parse(JSON.stringify(analysis));
    if (longName.trades[0].sellHigh && longName.trades[0].sellHigh[0]) {
      longName.trades[0].sellHigh[0].name = 'Bartholomew Fitzgerald-Montgomery III';
    }
    longName.trades[0].give[0].name = 'Bartholomew Fitzgerald-Montgomery III';
    const wide = await page.evaluate((fixture) => {
      window.FSNAiGm.__setAnalysis(fixture);
      const body = document.getElementById('aiGmBody');
      return { overflowsX: body.scrollWidth > body.clientWidth + 1, scrollWidth: body.scrollWidth,
        clientWidth: body.clientWidth };
    }, longName);
    if (!wide.overflowsX) pass('a 38-character player name still does not make the desk scroll sideways');
    else fail('a long player name overflows the desk', JSON.stringify(wide));
    await page.evaluate((fixture) => window.FSNAiGm.__setAnalysis(fixture), analysis);

    /* ==== 3-TEAM PATHWAYS: the toggle and the cards ==== */
    const blockAnalysis = gm.analyze({ league: cycleLeague('blockbuster'), freeAgents: [], byeWeeks: {} },
      Object.assign({}, baseOptions, { minPartnerGain: 0.5 }));
    const pathAnalysis = gm.analyze({ league: cycleLeague('pathway'), freeAgents: [], byeWeeks: {} },
      Object.assign({}, baseOptions, { minPartnerGain: 0.5 }));

    const toggle = await page.evaluate((fixture) => {
      window.FSNAiGm.__setAnalysis(fixture);
      const group = document.querySelector('#aiGmBody .aigm-toggle');
      const btns = group ? Array.from(group.querySelectorAll('[data-aigm-view]')) : [];
      return {
        head: group && group.parentElement.querySelector('.aigm-section-count').textContent,
        role: group && group.getAttribute('role'),
        label: group && group.getAttribute('aria-label'),
        views: btns.map((b) => b.getAttribute('data-aigm-view')),
        pressed: btns.map((b) => b.getAttribute('aria-pressed')),
        text: btns.map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
        twoCards: document.querySelectorAll('#aiGmBody .aigm-swap').length,
        pathCards: document.querySelectorAll('#aiGmBody .aigm-path').length,
      };
    }, analysis);
    if (toggle.role === 'group' && toggle.views.join(',') === '2,3') {
      pass('a "Trade type" toggle offers 2-Team and 3-Team Pathways');
    } else fail('the trade-type toggle is missing or malformed', JSON.stringify(toggle));
    if (toggle.text[0] === '2-Team ' + analysis.trades.length &&
        toggle.text[1] === '3-Team Pathways ' + analysis.pathways.length) {
      pass('each toggle button carries its count (' + toggle.text.join(' | ') + ')');
    } else fail('toggle counts disagree with the payload', JSON.stringify(toggle.text));
    if (toggle.pressed.join(',') === 'true,false' && toggle.twoCards > 0 && !toggle.pathCards) {
      pass('with 2-team deals on the board the 2-Team view is the default');
    } else fail('the default view is wrong', JSON.stringify(toggle));

    if (toggle.head === 'Showing Top ' + analysis.trades.length + ' Trade Proposals (' +
        analysis.search.packagesConsidered + ' Evaluated)') pass('2-team header reports actual evaluated packages');
    else fail('the 2-team header microcopy', toggle.head);

    /* Flip to 3-team with a real click, the way a reader does. */
    await page.click('#aiGmBody [data-aigm-view="3"]');
    await page.waitForTimeout(80);
    const flipped = await page.evaluate(() => {
      const body = document.getElementById('aiGmBody');
      const btns = Array.from(body.querySelectorAll('[data-aigm-view]'));
      return {
        pressed: btns.map((b) => b.getAttribute('aria-pressed')),
        focused: document.activeElement && document.activeElement.getAttribute('data-aigm-view'),
        twoCards: body.querySelectorAll('.aigm-swap').length,
        pathCards: body.querySelectorAll('.aigm-path').length,
        tradeView: window.FSNAiGm.state().tradeView,
        head: (body.querySelectorAll('.aigm-section-head .aigm-section-count')[2] || {}).textContent,
        overflowsX: body.scrollWidth > body.clientWidth + 1,
      };
    });
    if (flipped.pressed.join(',') === 'false,true' && flipped.pathCards === analysis.pathways.length &&
        !flipped.twoCards && flipped.tradeView === '3') {
      pass('clicking 3-Team Pathways swaps in ' + flipped.pathCards + ' pathway cards and drops the 2-team ones');
    } else fail('the toggle did not switch views', JSON.stringify(flipped));
    if (flipped.focused === '3') pass('keyboard focus lands back on the toggle after the repaint');
    else fail('focus was lost when the view switched', String(flipped.focused));
    if (flipped.head === 'Showing Top ' + analysis.pathways.length + ' 3-Team Blockbusters') pass('the 3-team header uses clear microcopy');
    else fail('the 3-team section count', String(flipped.head));
    if (!flipped.overflowsX) pass('the 3-team view does not scroll sideways at 414px');
    else fail('the 3-team view overflows horizontally');

    /* ---- the PATHWAY card: STEP 1 / STEP 2 / FINAL ---- */
    const firstPath = analysis.pathways.find((p) => p.kind === 'PATHWAY');
    const pathCard = await page.evaluate(() => {
      const card = document.querySelector('#aiGmBody .aigm-path[data-kind="PATHWAY"]');
      if (!card) return null;
      return {
        tags: Array.from(card.querySelectorAll('.aigm-step-tag')).map((e) => e.textContent),
        who: Array.from(card.querySelectorAll('.aigm-step-who')).map((e) => e.textContent),
        nets: Array.from(card.querySelectorAll('.aigm-step-net')).map((e) => e.textContent),
        verbs: Array.from(card.querySelectorAll('.aigm-step-verb')).map((e) => e.textContent),
        name: (card.querySelector('.aigm-name') || {}).textContent,
        text: card.textContent,
      };
    });
    if (pathCard && pathCard.tags.join(',') === 'STEP 1,STEP 2,FINAL') {
      pass('a PATHWAY card lays out STEP 1, STEP 2 and FINAL');
    } else fail('the PATHWAY card is not step-by-step', JSON.stringify(pathCard && pathCard.tags));
    if (pathCard && firstPath &&
        pathCard.who[0] === 'Deal with ' + firstPath.teamA.name &&
        pathCard.who[1] === 'Deal with ' + firstPath.teamB.name &&
        pathCard.verbs.join(',') === 'Send,Get,Send,Get') {
      pass('step 1 deals with Team A (send / get), step 2 with Team B (flip / get)');
    } else fail('the PATHWAY steps are not the spec\'s shape', JSON.stringify(pathCard));
    if (pathCard && firstPath &&
        pathCard.nets[0].endsWith('+' + firstPath.a.gain.toFixed(1)) &&
        pathCard.nets[1].endsWith('+' + firstPath.b.gain.toFixed(1)) &&
        pathCard.nets[2] === '+' + firstPath.me.gain.toFixed(1)) {
      pass('each step shows its partner\'s own net, and FINAL shows mine (' + pathCard.nets.join(' / ') + ')');
    } else fail('a step net disagrees with the payload', JSON.stringify(pathCard && pathCard.nets));
    if (pathCard && firstPath && pathCard.name === firstPath.give.name + ' → ' + firstPath.target.name) {
      pass('the header states the net move: ' + pathCard.name);
    } else fail('the pathway header', pathCard && pathCard.name);
    if (pathCard && /after step 1 \+/.test(pathCard.text) && /refused/.test(pathCard.text)) {
      pass('a PATHWAY card proves it is safe (after step 1) and shows the refused direct swap');
    } else fail('the PATHWAY card is missing its justification chips');

    /* ---- the BLOCKBUSTER card: one row per manager ---- */
    const bb = blockAnalysis.pathways.find((p) => p.kind === 'BLOCKBUSTER');
    const bbCard = await page.evaluate((fixture) => {
      window.FSNAiGm.__setAnalysis(fixture);
      const card = document.querySelector('#aiGmBody .aigm-path[data-kind="BLOCKBUSTER"]');
      if (!card) return null;
      return {
        tags: Array.from(card.querySelectorAll('.aigm-step-tag')).map((e) => e.textContent),
        nets: Array.from(card.querySelectorAll('.aigm-step-net')).map((e) => e.textContent),
        text: card.textContent,
        height: Math.round(card.getBoundingClientRect().height),
      };
    }, blockAnalysis);
    if (bb && bbCard && bbCard.tags.join(',') === 'STEP 1,STEP 2,FINAL') {
      pass('a BLOCKBUSTER card shows two linked deals then final roster impact');
    } else fail('the BLOCKBUSTER card is not per-manager', JSON.stringify(bbCard && bbCard.tags));
    if (bb && bbCard && bbCard.nets[0].endsWith((bb.a.gain >= 0 ? '+' : '') + bb.a.gain.toFixed(1)) &&
        bbCard.nets[1].endsWith((bb.b.gain >= 0 ? '+' : '') + bb.b.gain.toFixed(1)) &&
        bbCard.nets[2] === (bb.me.gain >= 0 ? '+' : '') + bb.me.gain.toFixed(1)) {
      pass('all three managers\' weekly nets are on the card (' + bbCard.nets.slice(0, 3).join(' / ') + ')');
    } else fail('a blockbuster net disagrees with the payload', JSON.stringify(bbCard && bbCard.nets));
    if (bbCard && /step 1 alone -/.test(bbCard.text) && /agree all 3/.test(bbCard.text)) {
      pass('a BLOCKBUSTER card shows why: step 1 alone costs me, so all three must agree first');
    } else fail('the BLOCKBUSTER card does not explain its execution');

    const explained = await page.evaluate(() => {
      const card = document.querySelector('#aiGmBody .aigm-path');
      return { reasons: card ? Array.from(card.querySelectorAll('.aigm-steps .aigm-note')).map((e) => e.textContent) : [],
        final: !!card && /Final Roster Impact/.test(card.textContent) };
    });
    if (explained.reasons.length === 3 && explained.final && explained.reasons.every((r) =>
        /fills|gains|clears|upgrades|You fill|You gain|You clear|You upgrade/.test(r))) {
      pass('each manager has a visible roster benefit alongside final roster impact');
    } else fail('a manager rationale is missing', JSON.stringify(explained));
    const lossStyle = await page.evaluate((fixture) => {
      const fx = JSON.parse(JSON.stringify(fixture));
      fx.pathways[0].a.gain = -1;
      window.FSNAiGm.__setAnalysis(fx);
      const net = document.querySelector('#aiGmBody .aigm-path .aigm-step-net');
      return { text: net.textContent, tone: net.dataset.tone };
    }, blockAnalysis);
    if (lossStyle.text.endsWith('-1.0') && lossStyle.tone === 'loss') pass('negative weekly deltas are shown with loss styling');
    else fail('a negative weekly delta looks positive', JSON.stringify(lossStyle));

    /* ---- density: the same numbers-not-copy budget the 2-team cards keep ---- */
    const density = await page.evaluate((fixtures) => {
      const out = [];
      for (const fx of fixtures) {
        window.FSNAiGm.__setAnalysis(fx);
        document.querySelectorAll('#aiGmBody .aigm-path').forEach((c) => {
          out.push({
            kind: c.dataset.kind,
            height: Math.round(c.getBoundingClientRect().height),
            longest: Math.max(0, ...Array.from(c.querySelectorAll('*')).filter((e) => !e.children.length)
              .map((e) => (e.textContent || '').trim().length)),
          });
        });
      }
      return out;
    }, [blockAnalysis, analysis]);
    const tallPath = density.filter((c) => c.height > 580);
    const wordyPath = density.filter((c) => c.longest > 120);
    if (density.length && !tallPath.length) {
      pass('every pathway card fits in 580px (PATHWAY ' +
        Math.max(0, ...density.filter((c) => c.kind === 'PATHWAY').map((c) => c.height)) + 'px, BLOCKBUSTER ' +
        Math.max(0, ...density.filter((c) => c.kind === 'BLOCKBUSTER').map((c) => c.height)) + 'px)');
    } else fail('a pathway card is taller than 580px', JSON.stringify(tallPath));
    if (density.length && !wordyPath.length) {
      pass('no pathway card holds a text run over 120 chars (longest ' +
        Math.max(...density.map((c) => c.longest)) + ')');
    } else fail('a pathway card holds prose', JSON.stringify(wordyPath));

    /* ---- the view follows the board until the reader picks one ---- */
    const auto = await page.evaluate((fixture) => {
      window.LeagueData.setMeta('leagueId', '99999999');
      window.LeagueData.publish();
      window.LeagueData.setMeta('leagueId', '57155288');
      window.LeagueData.publish();
      const reset = window.FSNAiGm.state().tradeView;
      window.FSNAiGm.__setAnalysis(fixture);
      const btns = Array.from(document.querySelectorAll('#aiGmBody [data-aigm-view]'));
      return {
        reset: reset,
        pressed: btns.map((b) => b.getAttribute('aria-pressed')),
        pathCards: document.querySelectorAll('#aiGmBody .aigm-path').length,
        onlyRoute: /no 2-team deal exists/.test(document.getElementById('aiGmBody').textContent),
      };
    }, Object.assign({}, pathAnalysis, {
      trades: [],
      pathways: pathAnalysis.pathways.map((p) => Object.assign({}, p, { hasTwoTeamAlternative: false })),
    }));
    if (auto.reset === null) pass('switching league resets the chosen trade view');
    else fail('the trade view survived a league switch', String(auto.reset));
    if (auto.pressed.join(',') === 'false,true' && auto.pathCards > 0) {
      pass('with no 2-team deal but 3-team routes available, the desk opens on 3-Team Pathways');
    } else fail('the view does not follow an empty 2-team board', JSON.stringify(auto));
    if (auto.onlyRoute) pass('a pathway with no 2-team alternative says it is the only win-win going');
    else fail('the only-route case is not called out');

    /* ---- empty, and escaped ---- */
    const empty = await page.evaluate((fixture) => {
      window.FSNAiGm.__setAnalysis(fixture);
      document.querySelector('#aiGmBody [data-aigm-view="3"]').click();
      const body = document.getElementById('aiGmBody');
      return { cards: body.querySelectorAll('.aigm-path').length, text: body.textContent };
    }, Object.assign({}, analysis, { pathways: [] }));
    if (!empty.cards && /No three-team route meets the roster-fit and market-value checks/.test(empty.text)) {
      pass('an empty 3-team view says why rather than rendering nothing');
    } else fail('the empty 3-team state', JSON.stringify(empty).slice(0, 120));

    const evil = JSON.parse(JSON.stringify(blockAnalysis));
    evil.pathways[0].teamA.name = '<img src=x onerror="window.__aiGmXss=4">';
    evil.pathways[0].target.name = '<script>window.__aiGmXss=5<\/script>';
    const escaped3 = await page.evaluate((fixture) => {
      window.__aiGmXss = 0;
      window.FSNAiGm.__setAnalysis(fixture);
      document.querySelector('#aiGmBody [data-aigm-view="3"]').click();
      const body = document.getElementById('aiGmBody');
      return { xss: window.__aiGmXss, images: body.querySelectorAll('img').length,
        scripts: body.querySelectorAll('script').length,
        shown: /<img src=x/.test(body.textContent) && /<script>/.test(body.textContent) };
    }, evil);
    if (!escaped3.xss && !escaped3.images && !escaped3.scripts && escaped3.shown) {
      pass('markup in a pathway team or player name renders as text, not markup');
    } else fail('a pathway name reached the DOM as markup', JSON.stringify(escaped3));

    /* Back to the 2-team view and the standard fixture for what follows. */
    await page.evaluate((fixture) => {
      window.FSNAiGm.__setAnalysis(fixture);
      const two = document.querySelector('#aiGmBody [data-aigm-view="2"]');
      if (two) two.click();
    }, analysis);

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

    /* Escaping. A player name carrying markup must render as text, never as
       markup. Still worth its own assertion with the pitch gone: every trade
       card now renders names and positions straight into chips and swap rows. */
    const injected = JSON.parse(JSON.stringify(analysis));
    injected.trades[0].targetTeam.name = '<img src=x onerror="window.__aiGmXss=1">';
    injected.trades[0].give[0].name = '<script>window.__aiGmXss=2<\/script>';
    if (injected.buyLow[0]) injected.buyLow[0].name = '"><img src=x onerror="window.__aiGmXss=3">';
    const escaped = await page.evaluate((fixture) => {
      window.__aiGmXss = 0;
      window.FSNAiGm.__setAnalysis(fixture);
      const body = document.getElementById('aiGmBody');
      return {
        xss: window.__aiGmXss,
        images: body.querySelectorAll('img').length,
        scripts: body.querySelectorAll('script').length,
        /* The trade card's own name, not the first .aigm-name on the board —
           that one is the Your Roster header and carries nothing injected. */
        nameText: (function () {
          const card = Array.from(body.querySelectorAll('.aigm-card'))
            .find((c) => c.querySelector('.aigm-swap'));
          const el = card && card.querySelector('.aigm-name');
          return el ? el.textContent : '';
        }()),
        swapText: (function () {
          const side = body.querySelector('.aigm-swap-side[data-dir="out"]');
          return side ? side.textContent : '';
        }()),
      };
    }, injected);
    if (!escaped.xss && escaped.images === 0 && escaped.scripts === 0) {
      pass('markup in a team, player or watchlist name is escaped, not executed');
    } else fail('markup in the analysis reached the DOM as markup', JSON.stringify(escaped));
    if (escaped.nameText.includes('<img')) pass('the escaped team name renders as visible text');
    else fail('the injected team name did not render as text', escaped.nameText.slice(0, 60));
    if (escaped.swapText.includes('<script')) pass('an injected player name renders as text in the swap row');
    else fail('the injected player name did not render as text', escaped.swapText.slice(0, 60));

    /* Repaint the clean fixture for the assertions below. */
    await page.evaluate((fixture) => window.FSNAiGm.__setAnalysis(fixture), analysis);

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
      !/AI_GM_REQUEST_FAILED|\/api\/ai-gm|not deployed/i.test(text));
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
checkPathways();
await checkHandler();
checkBudget();
if (noBrowser) console.log('\n[ai-gm-check] render pass skipped (--no-browser)');
else await checkRender();

console.log(failures
  ? '\n[ai-gm-check] FAILED (' + failures + ' failure' + (failures === 1 ? '' : 's') + ')'
  : '\n[ai-gm-check] clean');
process.exit(failures ? 1 : 0);
