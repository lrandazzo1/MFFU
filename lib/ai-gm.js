/* ============================================================================
   FSN — AI GM BETA ENGINE            (private: ESPN league 57155288 only)

   WHY THIS FILE IS IN lib/ AND NOT api/
   -------------------------------------
   `api/` is at 12 of the 12 Serverless Functions this deployment plan allows
   (scripts/vercel-functions-check.mjs). A thirteenth FILE does not fail the
   build — it fails the DEPLOY at patchBuild with
   `exceeded_serverless_functions_per_deployment` and takes production down with
   it. So the handler lives here and is dispatched from an existing route behind
   an `?action=` rewrite, exactly as /api/notifications-register,
   /api/transaction-wire-dispatch, /api/auth/yahoo/callback and
   /api/blog/articles/publish already are. See vercel.json.

   WHAT IT DOES
   ------------
   1. Refuses any league that is not on AI_GM_ALLOWED_LEAGUE_IDS. This is a
      private beta; the gate is server-side because a client-side gate is a
      suggestion.
   2. Reads the espn_s2 / SWID pair ALREADY STORED IN SUPABASE for that league
      through api/league.js's resolveStoredLeagueAccess — the same share-token
      gate /api/espn uses (H-1). It never prompts for credentials and never
      reads ESPN_S2 / ESPN_SWID from the environment: a beta tester on a phone
      has neither.
   3. Pulls live rosters, records, the league's own starting-slot counts,
      weekly projections and injury designations from
      lm-api-reads.fantasy.espn.com, plus the free-agent / waiver pool and the
      pro-team bye weeks.
   4. Re-solves the OPTIMAL starting lineup for every roster in the league,
      scores positional headroom as marginal lineup points, and enumerates
      1-and-2-player packages against all opposing rosters, keeping only those
      that raise BOTH teams' projected starting score.
   5. Tags Buy-Low targets (high-pedigree, high-usage players underperforming on
      a losing roster) and Sell-High chips (bench/flex assets of mine running
      hot). The card states the numbers; there is deliberately no generated
      message copy — see section 9.
   6. Ranks the waiver wire by what a claim is actually worth to MY lineup, and
      sizes a FAB bid / waiver-priority call from record, open roster spots and
      upcoming byes.

   DETERMINISM CONTRACT
   --------------------
   No Math.random(), no Date.now() and no model call anywhere in the scoring or
   matchmaking paths. The same ESPN payload yields byte-identical
   analysis, every run. The ONE clock read is the search deadline in
   `findOffers`, which is a safety valve on serverless wall time, lives outside
   every scoring function, and reports itself in `search.truncated` rather than
   silently shortening the board. Pass `deadlineMs: 0` to disable it, which is
   what the self-test does so its determinism assertions mean something.

   The lineup math, the needs model and the matchmaking floors are ported
   verbatim in behaviour from scripts/trade-assistant.mjs, which has a self-test
   covering each of them. That script keeps its own CLI pitch generator; this
   engine no longer has one, and the script is left untouched either way.
============================================================================ */

'use strict';

/* The sanitizer api/espn.js, api/league.js and the CLI already share. Cookies
   arrive from storage clean, but a legacy plaintext row may not be, and a
   newline in a header value makes fetch() throw before the request leaves the
   process. Reuse, never re-solve. */
const { buildEspnCookieHeader } = require('./espn-cookies');
const tradeMarket = require('./trade-market');

/* ============================================================================
   0. THE GATE

   One league, named once. Everything reader-facing — the entry card in Setup,
   the modal, this handler — asks this and nothing else, so opening the beta up
   is a one-line edit with the id in the diff.
============================================================================ */

const AI_GM_ALLOWED_LEAGUE_IDS = Object.freeze(['57155288']);

function normalizeLeagueId(value) {
  const id = String(value == null ? '' : value).trim();
  return /^\d{1,20}$/.test(id) ? id : '';
}

function isAiGmLeague(value) {
  const id = normalizeLeagueId(value);
  return !!id && AI_GM_ALLOWED_LEAGUE_IDS.indexOf(id) !== -1;
}

/* ============================================================================
   1. ESPN VOCABULARY
============================================================================ */

const POS_BY_ID = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };

const PRO_TEAM_BY_ID = {
  0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
  9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN',
  17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
  25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU',
};

/* Which default positions may legally fill each ESPN lineup slot. Used only
   when a player card arrives without `eligibleSlots`; ESPN's own eligibility
   list is always preferred, because it is the one that knows a WR also carries
   RB eligibility after a position change. */
const SLOT_ELIGIBILITY = {
  0: ['QB'], 1: ['QB'], 2: ['RB'], 3: ['RB', 'WR'], 4: ['WR'], 5: ['WR', 'TE'],
  6: ['TE'], 7: ['QB', 'RB', 'WR', 'TE'], 16: ['D/ST'], 17: ['K'],
  23: ['RB', 'WR', 'TE'],
};

const SLOT_LABEL = {
  0: 'QB', 1: 'QB', 2: 'RB', 3: 'RB/WR', 4: 'WR', 5: 'WR/TE', 6: 'TE',
  7: 'SUPERFLEX', 16: 'D/ST', 17: 'K', 23: 'FLEX',
};

const BENCH_SLOT_IDS = [20, 21];                 // 20 = bench, 21 = IR
const SKILL_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/* A standard lineup, used only when mSettings does not come back readable. */
const STANDARD_SLOT_IDS = [0, 2, 2, 4, 4, 6, 23, 17, 16];

/* Every slot id the waiver read asks ESPN for. Deliberately the startable
   offensive slots plus K and D/ST — the pool a claim is made from. */
const WAIVER_SLOT_IDS = [0, 2, 4, 6, 23, 17, 16];

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const ESPN_HOST = 'https://lm-api-reads.fantasy.espn.com';

/* One read's ceiling. api/espn.js uses 15s for the same reason: a connection
   ESPN accepts and never answers burns the whole function otherwise. */
const ESPN_READ_TIMEOUT_MS = 12000;

/* The search's wall-clock ceiling, and the depth the packages are drawn at.

   Measured on a twelve-team league of sixteen-man rosters, which is the real
   shape this runs against:

     pool  packages re-solved   time
       6               4,851    140ms
       8              14,256    336ms
      10              33,275    747ms
      12              66,924  1,371ms

   The memoised solver is what makes that affordable — the enumeration re-solves
   the same roster prefixes thousands of times and pays for each only once. 10 is
   the default because the deeper pool finds meaningfully more two-way-positive
   packages (50 against 40 at pool 8) and still leaves an order of magnitude of
   margin under the deadline.

   The deadline therefore exists for a pathological league rather than a normal
   one: a very deep bench or a sixteen-slot lineup degrades into an honest
   partial board that reports itself, instead of a 504 with no body. */
const DEFAULT_SEARCH_DEADLINE_MS = 7000;
const DEFAULT_TRADE_POOL_SIZE = 10;

function isBenchSlot(slotId) {
  return BENCH_SLOT_IDS.indexOf(Number(slotId)) !== -1;
}

/* ============================================================================
   2. SMALL NUMERIC HELPERS
============================================================================ */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round1(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function median(values) {
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ============================================================================
   3. PROJECTIONS AND ACTUALS

   statSourceId 1 is the forecast (0 is actuals); statSplitTypeId 1 marks a
   single scoring period rather than a season aggregate. The week match is
   exact, because a player card carries every week of the season and a loose
   match lets week 3 answer a week 11 question — a stale number that looks live
   is worse than no number.
============================================================================ */

function playerOf(entry) {
  if (!entry) return null;
  if (entry.playerPoolEntry && entry.playerPoolEntry.player) return entry.playerPoolEntry.player;
  if (entry.player) return entry.player;
  return null;
}

/* Projected points for one roster entry in one week. Fallback chain, most
   specific first:
     1. this week's forecast
     2. ESPN's own stamped projectedStatTotal
     3. the season forecast, spread over a 17-game season
     4. this player's actual per-game average so far
     5. null, which the caller reads as "no forecast" and scores as 0 */
function projectionFor(entry, week) {
  const player = playerOf(entry);
  const stats = (player && Array.isArray(player.stats)) ? player.stats : [];

  let seasonProjection = null;
  let actualTotal = null;
  let actualGames = 0;

  for (const row of stats) {
    if (!row) continue;
    const source = Number(row.statSourceId);
    const split = row.statSplitTypeId == null ? null : Number(row.statSplitTypeId);
    const applied = num(row.appliedTotal);
    if (applied == null) continue;

    if (source === 1 && split === 1 && week != null && Number(row.scoringPeriodId) === Number(week)) {
      return applied;
    }
    if (source === 1 && (split === 0 || split == null) && seasonProjection == null) {
      seasonProjection = applied;
    }
    if (source === 0 && split === 1 && Number(row.scoringPeriodId) > 0) {
      actualTotal = (actualTotal || 0) + applied;
      actualGames++;
    }
  }

  const direct = num(entry && entry.projectedStatTotal);
  if (direct != null) return direct;
  if (seasonProjection != null) return seasonProjection / 17;
  if (actualGames > 0) return actualTotal / actualGames;
  return null;
}

/* Season-to-date production, which is what separates "underperforming" from
   "projected low". Returns { total, games, ppg } with ppg null when the player
   has not played — never 0, which would read as "played and scored nothing". */
function actualsFor(entry) {
  const player = playerOf(entry);
  const stats = (player && Array.isArray(player.stats)) ? player.stats : [];
  let total = 0;
  let games = 0;
  for (const row of stats) {
    if (!row) continue;
    if (Number(row.statSourceId) !== 0) continue;
    if (Number(row.statSplitTypeId) !== 1) continue;
    if (!(Number(row.scoringPeriodId) > 0)) continue;
    const applied = num(row.appliedTotal);
    if (applied == null) continue;
    total += applied;
    games++;
  }
  return { total: total, games: games, ppg: games > 0 ? total / games : null };
}

/* The forecast this player carried BEFORE the season judged him: ESPN's own
   season-long projection spread per game. This is the baseline an
   over/under-performance read is measured against — not the weekly number,
   which ESPN has already revised downward for exactly the player a Buy Low is
   looking for. Season projection is the pre-season opinion; the weekly one is
   the post-hoc one. */
function seasonBaselinePerGame(entry) {
  const player = playerOf(entry);
  const stats = (player && Array.isArray(player.stats)) ? player.stats : [];
  for (const row of stats) {
    if (!row) continue;
    if (Number(row.statSourceId) !== 1) continue;
    const split = row.statSplitTypeId == null ? null : Number(row.statSplitTypeId);
    if (split !== 0 && split != null) continue;
    const applied = num(row.appliedTotal);
    if (applied == null) continue;
    return applied / 17;
  }
  return null;
}

/* Draft pedigree, lower is better. ESPN carries several rank types; PPR and
   STANDARD are the two that exist for every scoring format. A player with no
   rank at all returns null and is never called a "high draft pick" on a guess. */
function draftRankOf(player) {
  const ranks = player && player.draftRanksByRankType;
  if (!ranks || typeof ranks !== 'object') return null;
  for (const key of ['PPR', 'STANDARD']) {
    const row = ranks[key];
    const rank = num(row && row.rank);
    if (rank != null && rank > 0) return rank;
  }
  return null;
}

function ownershipOf(player) {
  const own = player && player.ownership;
  return {
    percentOwned: num(own && own.percentOwned),
    percentStarted: num(own && own.percentStarted),
    percentChange: num(own && own.percentChange),
  };
}

function playerName(player) {
  if (!player) return 'Unknown player';
  if (player.fullName) return String(player.fullName);
  const parts = [player.firstName, player.lastName].filter(Boolean);
  return parts.length ? parts.join(' ') : 'Unknown player';
}

function injuryOf(player) {
  return String((player && player.injuryStatus) || (player && player.injured ? 'QUESTIONABLE' : 'ACTIVE'))
    .toUpperCase();
}

function teamDisplayName(team) {
  if (!team) return 'Unknown team';
  if (team.name && String(team.name).trim()) return String(team.name).trim();
  const parts = [team.location, team.nickname].filter(Boolean).map(function (s) { return String(s).trim(); });
  if (parts.length) return parts.join(' ');
  return 'Team ' + (team.id == null ? '?' : team.id);
}

function memberName(member) {
  if (!member) return '';
  const display = member.displayName && String(member.displayName).trim();
  const real = [member.firstName, member.lastName].filter(Boolean).join(' ').trim();
  if (real && display && real.toLowerCase() !== display.toLowerCase()) return real + ' (@' + display + ')';
  return real || display || '';
}

/* ============================================================================
   4. NORMALISE THE PAYLOAD
============================================================================ */

/* ESPN has served both a bare league object and a single-element array over the
   years, and the leagueHistory route always serves the array. */
function unwrapLeague(payload) {
  if (Array.isArray(payload)) return payload[0] || null;
  return payload || null;
}

/* Build the league's real starting requirements from its own slot counts, so a
   2QB / 3WR / superflex league is solved by its own rules rather than a
   template. Anything unreadable says so and falls back. */
function lineupSlotIds(league) {
  const counts = league && league.settings && league.settings.rosterSettings &&
    league.settings.rosterSettings.lineupSlotCounts;
  if (!counts || typeof counts !== 'object') {
    console.warn('[AI GM] mSettings carried no readable lineupSlotCounts for league ' +
      String((league && league.id) || '(unknown)') + '; solving against the standard ' +
      '1QB/2RB/2WR/1TE/1FLEX/1K/1DST template instead. Lineup deltas remain internally ' +
      'consistent but are not this league\'s own rules.');
    return { ids: STANDARD_SLOT_IDS.slice(), fallback: true, ignored: [] };
  }
  const ids = [];
  const ignored = [];
  for (const key of Object.keys(counts).sort(function (a, b) { return Number(a) - Number(b); })) {
    const slotId = Number(key);
    const count = Number(counts[key]) || 0;
    if (!count || isBenchSlot(slotId)) continue;
    if (!SLOT_ELIGIBILITY[slotId]) { ignored.push(slotId); continue; }
    for (let i = 0; i < count; i++) ids.push(slotId);
  }
  if (ignored.length) {
    console.warn('[AI GM] Ignoring ' + ignored.length + ' starting slot(s) this engine does not ' +
      'model (ESPN slot ids ' + ignored.join(', ') + ' — IDP or special). Lineup scores cover the ' +
      'offensive slots only, which is where trades move.');
  }
  if (!ids.length) {
    console.warn('[AI GM] lineupSlotCounts produced no startable slots for league ' +
      String((league && league.id) || '(unknown)') + '; falling back to the standard template.');
    return { ids: STANDARD_SLOT_IDS.slice(), fallback: true, ignored: ignored };
  }
  return { ids: ids, fallback: false, ignored: ignored };
}

/* How many bench seats the league gives, which is what "open roster spot"
   means when a waiver claim needs somewhere to land. */
function benchSlotCapacity(league) {
  const counts = league && league.settings && league.settings.rosterSettings &&
    league.settings.rosterSettings.lineupSlotCounts;
  if (!counts || typeof counts !== 'object') return null;
  let total = 0;
  let found = false;
  for (const id of BENCH_SLOT_IDS) {
    const count = num(counts[id]) || num(counts[String(id)]);
    if (count != null) { total += count; found = true; }
  }
  return found ? total : null;
}

/* The league's acquisition rules: FAB budget vs rolling waiver priority. This
   decides whether the waiver desk talks money or talks claim order — advising a
   FAB bid in a priority league is advice the reader cannot act on. */
function acquisitionRules(league) {
  const settings = (league && league.settings && league.settings.acquisitionSettings) || {};
  const type = String(settings.acquisitionType || '').toUpperCase();
  const budget = num(settings.acquisitionBudget);
  return {
    type: type || 'UNKNOWN',
    usesFab: type.indexOf('FAB') !== -1 || (budget != null && budget > 0),
    budget: budget != null && budget > 0 ? budget : null,
    waiverHours: num(settings.waiverHours),
  };
}

function normalizePlayerCard(entry, week, context) {
  const player = playerOf(entry);
  if (!player) return null;
  const slotId = num(entry && entry.lineupSlotId);
  const eligible = Array.isArray(player.eligibleSlots) && player.eligibleSlots.length
    ? player.eligibleSlots.map(Number).filter(function (n) { return Number.isFinite(n); })
    : null;
  const actual = actualsFor(entry);
  const baseline = seasonBaselinePerGame(entry);
  const own = ownershipOf(player);
  const projection = projectionFor(entry, week);
  return {
    id: String(player.id != null ? player.id : playerName(player)),
    name: playerName(player),
    pos: POS_BY_ID[player.defaultPositionId] || '',
    proTeam: PRO_TEAM_BY_ID[player.proTeamId] || '',
    proTeamId: num(player.proTeamId),
    injury: injuryOf(player),
    eligibleSlots: eligible,
    slotId: slotId,
    benched: slotId != null ? isBenchSlot(slotId) : false,
    /* A missing forecast scores as 0 in the lineup math (there is nothing else
       honest to seat him on) but `hasProjection` travels so the UI can say so
       rather than present 0.0 as a forecast. */
    projection: projection == null ? 0 : projection,
    hasProjection: projection != null,
    actualPpg: actual.ppg,
    actualGames: actual.games,
    seasonBaseline: baseline,
    draftRank: draftRankOf(player),
    percentOwned: own.percentOwned,
    percentStarted: own.percentStarted,
    percentChange: own.percentChange,
    byeWeek: context && context.byeWeeks ? (context.byeWeeks[String(num(player.proTeamId))] || null) : null,
  };
}

function normalize(payload, options) {
  const opts = options || {};
  const league = unwrapLeague(payload);
  if (!league) throw new Error('The ESPN payload carried no league object.');

  const week = opts.week != null && Number.isFinite(Number(opts.week)) && Number(opts.week) > 0
    ? Number(opts.week)
    : (num(league.scoringPeriodId) || num(league.status && league.status.latestScoringPeriod) || 1);

  const slots = lineupSlotIds(league);
  const context = { byeWeeks: opts.byeWeeks || {} };

  const membersById = new Map();
  for (const member of (Array.isArray(league.members) ? league.members : [])) {
    if (member && member.id != null) membersById.set(String(member.id), member);
  }

  const teams = [];
  for (const team of (Array.isArray(league.teams) ? league.teams : [])) {
    if (!team) continue;
    const entries = (team.roster && Array.isArray(team.roster.entries)) ? team.roster.entries : [];
    const players = [];
    for (const entry of entries) {
      const card = normalizePlayerCard(entry, week, context);
      if (card) players.push(card);
    }

    const ownerIds = []
      .concat(team.primaryOwner ? [team.primaryOwner] : [])
      .concat(Array.isArray(team.owners) ? team.owners : []);
    const ownerNames = [];
    for (const ownerId of ownerIds) {
      const name = memberName(membersById.get(String(ownerId)));
      if (name && ownerNames.indexOf(name) === -1) ownerNames.push(name);
    }

    const overall = (team.record && team.record.overall) || null;
    const wins = num(overall && overall.wins) || 0;
    const losses = num(overall && overall.losses) || 0;
    const ties = num(overall && overall.ties) || 0;
    const counter = team.transactionCounter || {};

    teams.push({
      id: String(team.id),
      name: teamDisplayName(team),
      abbrev: team.abbrev ? String(team.abbrev) : '',
      logo: team.logo ? String(team.logo) : '',
      ownerIds: ownerIds.map(String),
      owner: ownerNames.join(' & ') || 'Unknown owner',
      wins: wins,
      losses: losses,
      ties: ties,
      record: overall ? wins + '-' + losses + (ties ? '-' + ties : '') : '',
      winPct: (wins + losses + ties) > 0 ? (wins + 0.5 * ties) / (wins + losses + ties) : null,
      pointsFor: num(overall && overall.pointsFor),
      pointsAgainst: num(overall && overall.pointsAgainst),
      playoffSeed: num(team.playoffSeed),
      waiverRank: num(team.waiverRank),
      fabSpent: num(counter.acquisitionBudgetSpent),
      acquisitions: num(counter.acquisitions),
      players: players,
    });
  }

  if (teams.length < 2) throw new Error('The ESPN payload carried ' + teams.length + ' team(s).');

  const rules = acquisitionRules(league);
  const benchCapacity = benchSlotCapacity(league);

  const state = {
    leagueId: String(league.id != null ? league.id : ''),
    leagueName: String((league.settings && league.settings.name) || 'League'),
    season: num(league.seasonId) || num(opts.season) || null,
    week: week,
    slotIds: slots.ids,
    slotFallback: slots.fallback,
    slotLabels: slots.ids.map(function (id) { return SLOT_LABEL[id] || String(id); }),
    startingSlotCounts: countSlots(slots.ids),
    benchCapacity: benchCapacity,
    rosterCapacity: benchCapacity != null ? slots.ids.length + benchCapacity : null,
    rules: rules,
    marketValues: opts.marketValues || { compatible:
      Number(league.seasonId) === tradeMarket.snapshot.season && teams.length === tradeMarket.snapshot.format.numTeams &&
      slots.ids.filter(function (id) { return id === 0 || id === 1 || id === 7; }).length === tradeMarket.snapshot.format.numQbs &&
      ((league.settings && league.settings.scoringSettings && league.settings.scoringSettings.scoringItems || [])
        .find(function (row) { return Number(row.statId) === 53; }) || { points: 0 }).points === tradeMarket.snapshot.format.ppr },
    teams: teams,
  };

  /* What a median starter is worth at each position IN THIS LEAGUE. Computed
     once, off these rosters, and read by every need calculation below. */
  state.benchmarks = benchmarkProjections(teams, slots.ids);
  return state;
}

/* "1 QB / 2 RB / 2 WR / 1 TE / 1 FLEX / 1 K / 1 D/ST" as data, for the UI's
   lineup-shape line. */
function countSlots(slotIds) {
  const out = [];
  const index = new Map();
  for (const id of slotIds) {
    const label = SLOT_LABEL[id] || String(id);
    if (!index.has(label)) { index.set(label, out.length); out.push({ slot: label, count: 0 }); }
    out[index.get(label)].count++;
  }
  return out;
}

/* ============================================================================
   5. OPTIMAL LINEUP

   Assigning players to lineup slots is a transversal matroid: a set of players
   is "startable together" exactly when it has a perfect matching into the
   slots. Walking the players in descending projection and keeping each one whose
   addition leaves the set still matchable returns the maximum-weight basis,
   which is the true optimal lineup.

   Filling the most-constrained slot first is only optimal when the eligibility
   sets nest. They do not: RB/WR (slot 3) and WR/TE (slot 5) overlap without
   either containing the other, and a league running both would be mis-scored.
   Kuhn's augmenting path costs nothing at this size, so this takes the exact
   answer instead of the usually-right one.
============================================================================ */

function canFill(player, slotId) {
  if (player.eligibleSlots) return player.eligibleSlots.indexOf(slotId) !== -1;
  const eligible = SLOT_ELIGIBILITY[slotId];
  return !!(eligible && player.pos && eligible.indexOf(player.pos) !== -1);
}

function optimalLineup(players, slotIds) {
  /* Descending projection, then player id — never insertion order, so two runs
     over the same roster cannot disagree about a tie. */
  const pool = players.slice().sort(function (a, b) {
    if (b.projection !== a.projection) return b.projection - a.projection;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const slotOwner = new Array(slotIds.length).fill(-1);   // slot index -> pool index
  const seated = [];

  const augment = function (poolIndex, visited) {
    for (let s = 0; s < slotIds.length; s++) {
      if (visited[s]) continue;
      if (!canFill(pool[poolIndex], slotIds[s])) continue;
      visited[s] = true;
      if (slotOwner[s] === -1 || augment(slotOwner[s], visited)) {
        slotOwner[s] = poolIndex;
        return true;
      }
    }
    return false;
  };

  for (let i = 0; i < pool.length; i++) {
    if (seated.length >= slotIds.length) break;
    if (augment(i, new Array(slotIds.length).fill(false))) seated.push(i);
  }

  let points = 0;
  const lineup = [];
  for (let s = 0; s < slotIds.length; s++) {
    const owner = slotOwner[s];
    const player = owner === -1 ? null : pool[owner];
    if (player) points += player.projection;
    lineup.push({ slot: SLOT_LABEL[slotIds[s]] || String(slotIds[s]), slotId: slotIds[s], player: player });
  }

  return { points: points, lineup: lineup };
}

function lineupPoints(players, slotIds) {
  return optimalLineup(players, slotIds).points;
}

/* The same solve, memoised on the exact player set. The package search re-solves
   the same roster shapes thousands of times — every 2-for-1 that keeps the same
   two players I am sending produces the same "me minus those two" prefix — and
   the cache turns the enumeration from seconds into milliseconds without
   changing a single number it returns.

   Keyed on sorted ids AND the slot signature, so a cache built for one league's
   lineup can never answer for another's. */
function lineupSolver(slotIds) {
  const cache = new Map();
  const signature = slotIds.join('.');
  return function solve(players) {
    const key = signature + '|' + players.map(function (p) { return p.id; }).slice().sort().join(',');
    if (cache.has(key)) return cache.get(key);
    const points = lineupPoints(players, slotIds);
    cache.set(key, points);
    return points;
  };
}

/* ============================================================================
   6. NEEDS AND SURPLUS  —  true positional headroom

   A position's need is not "how many do I have", and it is emphatically not
   "how much would I lose if this starter vanished" — that second one reads a
   lineup backwards. The weakest RB2 in the league has a tiny vanish-cost
   precisely BECAUSE he is replacement level, while an elite QB with no backup
   has a huge one, so that measure ranks a strength as the deficit.

   What a trade can actually move is UPGRADE HEADROOM: plug a median league
   starter at this position into the roster, re-solve the optimal lineup, and
   keep the gain. A position already above the league's middle gains nothing and
   is not a need, however thin it looks. A position below it gains exactly the
   points an acquisition would be worth.

     needValue     pts the lineup gains from a median league starter at this pos
     spareValue    pts lost if this position's best BENCH player disappeared —
                   0.0 means he is neither starting nor one injury from it,
                   which is precisely what you trade away
============================================================================ */

/* What a middle-of-the-league starter is worth at each position, measured off
   the league's own rosters rather than a table that goes stale in a week.
   Dedicated slots only — a WR sitting in FLEX says nothing about WR2 quality. */
function benchmarkProjections(teams, slotIds) {
  const dedicated = {};
  const rostered = {};
  for (const pos of SKILL_POSITIONS) { dedicated[pos] = []; rostered[pos] = []; }

  for (const team of teams) {
    for (const player of team.players) {
      if (SKILL_POSITIONS.indexOf(player.pos) !== -1) rostered[player.pos].push(player.projection);
    }
    for (const row of optimalLineup(team.players, slotIds).lineup) {
      if (!row.player) continue;
      const label = SLOT_LABEL[row.slotId];
      if (SKILL_POSITIONS.indexOf(label) !== -1 && row.player.pos === label) {
        dedicated[label].push(row.player.projection);
      }
    }
  }

  const out = {};
  for (const pos of SKILL_POSITIONS) {
    /* A league with no dedicated slot for a position (a TE-less or superflex-
       only build) still has rosters; fall back to those before giving up. */
    const value = median(dedicated[pos]);
    out[pos] = value != null ? value : (median(rostered[pos]) || 0);
  }
  return out;
}

/* A phantom median starter at `pos`. Carries no eligibleSlots, so canFill falls
   back to the position table — a median RB is eligible exactly where an RB is,
   FLEX included. */
function medianPhantom(pos, benchmark) {
  return {
    id: '__median_' + pos + '__', name: 'median ' + pos, pos: pos,
    proTeam: '', injury: 'ACTIVE', eligibleSlots: null, benched: false,
    projection: benchmark || 0, hasProjection: true,
    actualPpg: null, actualGames: 0, seasonBaseline: null, draftRank: null,
    percentOwned: null, percentStarted: null, percentChange: null, byeWeek: null,
  };
}

function positionProfile(team, slotIds, benchmarks, solve) {
  const solveFn = solve || function (players) { return lineupPoints(players, slotIds); };
  const base = optimalLineup(team.players, slotIds);
  const starters = new Set();
  for (const row of base.lineup) if (row.player) starters.add(row.player.id);

  const profile = {};
  for (const pos of SKILL_POSITIONS) {
    const atPos = team.players.filter(function (p) { return p.pos === pos; });
    const startingHere = base.lineup.filter(function (r) { return r.player && r.player.pos === pos; });
    const benchHere = atPos
      .filter(function (p) { return !starters.has(p.id); })
      .sort(function (a, b) { return b.projection - a.projection || (a.id < b.id ? -1 : 1); });

    const starterValue = startingHere.reduce(function (sum, r) { return sum + r.player.projection; }, 0);
    const benchmark = (benchmarks && benchmarks[pos]) || 0;
    const needValue = solveFn(team.players.concat([medianPhantom(pos, benchmark)])) - base.points;

    /* Remove the best non-starter at this position. If the lineup does not move,
       he is genuinely spare. */
    let spareValue = 0;
    if (benchHere.length) {
      const withoutHim = team.players.filter(function (p) { return p.id !== benchHere[0].id; });
      spareValue = base.points - solveFn(withoutHim);
    }

    profile[pos] = {
      pos: pos,
      rostered: atPos.length,
      starting: startingHere.length,
      starterValue: starterValue,
      benchmark: benchmark,
      needValue: needValue,
      benchDepth: benchHere.length,
      topBench: benchHere.length ? benchHere[0] : null,
      spareValue: spareValue,
    };
  }

  return { base: base, starters: starters, profile: profile };
}

/* The headline need/surplus read for a team, ranked. */
function needsAndSurplus(profile) {
  const rows = SKILL_POSITIONS.map(function (pos) {
    return Object.assign({}, profile[pos], { pos: pos });
  });
  const needs = rows
    .slice()
    .sort(function (a, b) { return b.needValue - a.needValue || (a.pos < b.pos ? -1 : 1); });
  const surplus = rows
    .filter(function (r) { return r.benchDepth > 0; })
    .sort(function (a, b) {
      return a.spareValue - b.spareValue ||
        (b.topBench ? b.topBench.projection : 0) - (a.topBench ? a.topBench.projection : 0) ||
        (a.pos < b.pos ? -1 : 1);
    });
  return { needs: needs, surplus: surplus };
}

/* Everything the board needs about one roster, in one object. The starters set
   travels with it because the sell-high read has to know not merely that a
   position is deep but whether the specific player being offered is in the
   lineup. */
function teamRead(team, slotIds, benchmarks, solve) {
  const profile = positionProfile(team, slotIds, benchmarks, solve);
  const ranked = needsAndSurplus(profile.profile);
  return {
    team: team,
    base: profile.base,
    starters: profile.starters,
    profile: profile.profile,
    needs: ranked.needs,
    surplus: ranked.surplus,
  };
}

/* ============================================================================
   7. BUY LOW / SELL HIGH

   Both are the same measurement read in opposite directions: season-to-date
   production against the season-long forecast the player carried BEFORE the
   season had an opinion about him.

   BUY LOW — a player whose pedigree and usage say he is good, whose results say
   he has not been, on a roster whose record says its manager is losing patience.
   All four conditions, because any one alone is noise: a high draft pick with no
   usage is hurt, high usage with no pedigree is a breakout to pay for, and a
   slump on a 6-1 roster is not for sale.

   SELL HIGH — one of MY assets, not in my optimal lineup (or only reachable
   through FLEX), producing well above the forecast he carried. That combination
   is the definition of a chip: the market is pricing him off results I do not
   think he keeps, and my own lineup is not using him anyway.

   Neither classification touches the trade math. The lineup delta decides
   whether a package is good; these two decide which good packages are worth
   *leading with*, and they are what the card's form chips report.
============================================================================ */

/* Enough of a sample to mean anything. Two games is a coin flip; three is the
   floor at which "underperforming" stops being "had one bad Sunday". */
const FORM_MIN_GAMES = 3;
/* Pedigree: a top-60 pre-season rank is a starter every manager drafted on
   purpose. Beyond that the label "high draft pick" stops being true. */
const BUY_LOW_MAX_DRAFT_RANK = 60;
/* Usage: still being started in most of the leagues that own him means the
   NFL team has not moved on, whatever the box scores say. */
const BUY_LOW_MIN_PERCENT_STARTED = 50;
/* A losing record. Strictly below .500 — a .500 manager is not yet selling. */
const BUY_LOW_MAX_WIN_PCT = 0.5;
/* How far below the pre-season forecast counts as a real slump, in pts/game. */
const BUY_LOW_MIN_SHORTFALL = 1.5;
/* And how far above counts as running hot. */
const SELL_HIGH_MIN_SURPLUS = 1.5;

function formOf(player) {
  const baseline = player.seasonBaseline;
  const actual = player.actualPpg;
  if (baseline == null || actual == null || !(player.actualGames >= FORM_MIN_GAMES)) {
    return { known: false, delta: null, baseline: baseline, actual: actual, games: player.actualGames };
  }
  return {
    known: true,
    delta: actual - baseline,
    baseline: baseline,
    actual: actual,
    games: player.actualGames,
  };
}

/* Buy-low candidates across every roster that is not mine. Returned sorted by
   how far under water the player is, then by pedigree, then by id. */
function buyLowCandidates(state, myTeamId) {
  const out = [];
  for (const team of state.teams) {
    if (String(team.id) === String(myTeamId)) continue;
    if (team.winPct == null || team.winPct >= BUY_LOW_MAX_WIN_PCT) continue;
    for (const player of team.players) {
      if (SKILL_POSITIONS.indexOf(player.pos) === -1) continue;
      const form = formOf(player);
      if (!form.known || form.delta > -BUY_LOW_MIN_SHORTFALL) continue;
      if (player.draftRank == null || player.draftRank > BUY_LOW_MAX_DRAFT_RANK) continue;
      if (player.percentStarted == null || player.percentStarted < BUY_LOW_MIN_PERCENT_STARTED) continue;
      out.push({
        playerId: player.id,
        name: player.name,
        pos: player.pos,
        proTeam: player.proTeam,
        teamId: String(team.id),
        teamName: team.name,
        teamRecord: team.record,
        draftRank: player.draftRank,
        percentStarted: round1(player.percentStarted),
        shortfall: round1(-form.delta),
        baselinePpg: round1(form.baseline),
        actualPpg: round1(form.actual),
        games: form.games,
        injury: player.injury,
      });
    }
  }
  out.sort(function (a, b) {
    return b.shortfall - a.shortfall ||
      a.draftRank - b.draftRank ||
      (a.playerId < b.playerId ? -1 : 1);
  });
  return out;
}

/* Sell-high chips on MY roster. `starters` is the id set from my optimal
   lineup — a player in it is not a chip however hot he is, because moving him
   costs me the points I am counting. */
function sellHighCandidates(me, read) {
  const out = [];
  for (const player of me.players) {
    if (SKILL_POSITIONS.indexOf(player.pos) === -1) continue;
    const form = formOf(player);
    if (!form.known || form.delta < SELL_HIGH_MIN_SURPLUS) continue;

    /* Two kinds of chip. A true bench asset is not in the optimal lineup at
       all. A FLEX-only asset is in it, but only through a flex slot — he is the
       ninth-best piece on a roster with eight real jobs, and the first one a
       rival overpays for. */
    const inLineup = read.starters.has(player.id);
    let flexOnly = false;
    if (inLineup) {
      for (const row of read.base.lineup) {
        if (row.player && row.player.id === player.id) {
          flexOnly = row.slot === 'FLEX' || row.slot === 'SUPERFLEX' ||
            row.slot === 'RB/WR' || row.slot === 'WR/TE';
        }
      }
      if (!flexOnly) continue;
    }

    out.push({
      playerId: player.id,
      name: player.name,
      pos: player.pos,
      proTeam: player.proTeam,
      role: inLineup ? 'flex' : 'bench',
      surplus: round1(form.delta),
      baselinePpg: round1(form.baseline),
      actualPpg: round1(form.actual),
      games: form.games,
      injury: player.injury,
    });
  }
  out.sort(function (a, b) {
    return b.surplus - a.surplus || (a.playerId < b.playerId ? -1 : 1);
  });
  return out;
}

/* ============================================================================
   8. MATCHMAKING

   For every opponent, every package of 1 or 2 players from each side is applied
   to BOTH rosters and both optimal lineups are re-solved. The shared validator
   requires fair market values, elite packaging and preserved starter coverage.
   Gains qualify normally; a capped loss qualifies only when viable surplus
   fills severe positional scarcity. Both linked pathway legs use these rules.
============================================================================ */

/* Kickers and defenses are not traded in practice and would dominate the
   combinatorics with noise, so packages are drawn from the skill positions
   only, capped at the best `poolSize` per team. */
function tradeablePool(team, poolSize) {
  return team.players
    .filter(function (p) { return SKILL_POSITIONS.indexOf(p.pos) !== -1; })
    .sort(function (a, b) { return b.projection - a.projection || (a.id < b.id ? -1 : 1); })
    .slice(0, poolSize);
}

function packagesFrom(pool) {
  const out = [];
  for (let i = 0; i < pool.length; i++) {
    out.push([pool[i]]);
    for (let j = i + 1; j < pool.length; j++) out.push([pool[i], pool[j]]);
  }
  return out;
}

function applySwap(players, outgoing, incoming) {
  const drop = new Set(outgoing.map(function (p) { return p.id; }));
  return players.filter(function (p) { return !drop.has(p.id); }).concat(incoming);
}

function offerKey(offer) {
  return offer.give.map(function (p) { return p.id; }).join(',') + '|' +
    offer.receive.map(function (p) { return p.id; }).join(',');
}

/* The deadline. `deadlineMs: 0` disables it entirely, which is what the
   self-test passes so its determinism assertions are about the math and not
   about how fast the machine running them happens to be. Nothing inside a
   scoring function reads the clock. */
function makeDeadline(deadlineMs) {
  const budget = Number(deadlineMs);
  if (!Number.isFinite(budget) || budget <= 0) return function () { return false; };
  const startedAt = Date.now();
  return function expired() { return (Date.now() - startedAt) > budget; };
}

function findOffers(state, me, options) {
  const opts = options || {};
  const poolSize = Math.max(3, Math.min(16, Number(opts.poolSize) || DEFAULT_TRADE_POOL_SIZE));
  const minPartnerGain = Number.isFinite(Number(opts.minPartnerGain)) ? Number(opts.minPartnerGain) : 0.5;
  const limit = Math.max(1, Number(opts.limit) || 4);
  const slotIds = state.slotIds;
  const validator = opts.validator || createTradeValidator(state, opts);
  const solve = validator.solve;
  const expired = makeDeadline(opts.deadlineMs == null ? DEFAULT_SEARCH_DEADLINE_MS : opts.deadlineMs);

  const myBase = solve(me.players);
  const myPackages = packagesFrom(tradeablePool(me, poolSize));
  const offers = [];

  /* Opponents in a stable order so a truncated search truncates the same way
     twice. Team id, ascending numerically — never payload order. */
  const opponents = state.teams
    .filter(function (t) { return t.id !== me.id; })
    .sort(function (a, b) { return (Number(a.id) - Number(b.id)) || (a.id < b.id ? -1 : 1); });

  let analyzed = 0;
  let truncated = false;
  let considered = 0;

  for (const them of opponents) {
    if (expired()) { truncated = true; break; }
    const theirBase = solve(them.players);
    const theirPackages = packagesFrom(tradeablePool(them, poolSize));

    for (const give of myPackages) {
      for (const receive of theirPackages) {
        considered++;
        const valuation = validator.validate(me, them, give, receive);
        if (!valuation.accepted) continue;
        const myAfter = valuation.left.after; const myGain = valuation.left.gain;
        const theirAfter = valuation.right.after; const theirGain = valuation.right.gain;

        offers.push({
          team: them,
          give: give,
          receive: receive,
          myGain: myGain,
          theirGain: theirGain,
          myBefore: myBase,
          myAfter: myAfter,
          theirBefore: theirBase,
          theirAfter: theirAfter,
          shape: give.length + '-for-' + receive.length,
          benefits: { me: valuation.left.benefit, them: valuation.right.benefit },
          market: valuation.market,
          fitScore: valuation.left.benefit.score + valuation.right.benefit.score,
        });
      }
    }
    analyzed++;
  }

  /* Rank by my gain first — this is my GM chair — then by how obviously good the
     deal looks to them, then by the smaller package, which is the easier sell.
     Every tiebreak is deterministic down to the player ids. */
  const byValue = function (a, b) {
    return b.myGain - a.myGain ||
      b.theirGain - a.theirGain ||
      (a.give.length + a.receive.length) - (b.give.length + b.receive.length) ||
      (Number(a.team.id) - Number(b.team.id)) ||
      (offerKey(a) < offerKey(b) ? -1 : 1);
  };
  offers.sort(byValue);

  /* One offer per partner: three variations of the same deal with the same
     manager is not three options, it is one conversation. */
  const seenTeams = new Set();
  const top = opts.collectAll ? offers.slice() : [];
  for (const offer of (opts.collectAll ? [] : offers)) {
    if (seenTeams.has(offer.team.id)) continue;
    seenTeams.add(offer.team.id);
    top.push(offer);
    if (top.length >= limit) break;
  }
  /* If fewer partners exist than offers asked for, fill the rest with the
     next-best deals regardless of partner, then re-sort: an "OFFER 3" that beats
     "OFFER 2" reads as a bug to whoever is deciding which DM to send first. */
  if (!opts.collectAll && top.length < limit) {
    for (const offer of offers) {
      if (top.indexOf(offer) !== -1) continue;
      top.push(offer);
      if (top.length >= limit) break;
    }
  }
  top.sort(byValue);

  return {
    myBase: myBase,
    offers: top,
    considered: considered,
    survivors: offers.length,
    rostersAnalyzed: analyzed,
    rostersTotal: opponents.length,
    truncated: truncated,
    poolSize: poolSize,
    minPartnerGain: minPartnerGain,
  };
}

/* ============================================================================
   8b. THREE-TEAM PATHWAYS

   Two independently valid package trades link through the same manager.
   Step 2 uses the actual roster after Step 1, including retained broker assets.
   Rank roster fit first. A neutral or modest weekly loss is acceptable only
   when it fills severe positional scarcity by spending positional surplus.
   Every final exchange AND the intermediate X/Y exchange must preserve market
   tiers. Weekly projections alone never price an elite player as a streamer.
   PATHWAY means the first leg is neutral or positive; a negative first leg is
   a BLOCKBUSTER requiring agreement from all three managers before submission.
   Elite assets always require meaningful, fairly priced multi-player packages.
============================================================================ */

const DEFAULT_PATHWAY_POOL_SIZE = 10;
const DEFAULT_PATHWAY_LIMIT = 4;
const DEFAULT_PATHWAY_DEADLINE_MS = 5000;
/* Inner-loop evaluations, each two memoised lineup solves. A realistic twelve-
   team league needs a small fraction of this; it exists so a pathological one
   degrades into a reported partial result rather than a slow response. */
const DEFAULT_PATHWAY_CHECK_BUDGET = 300000;
/* Same epsilon the 2-team search uses for "this actually helps me". */
const MIN_MY_GAIN = 0.05;
const INTERIM_EPSILON = 1e-9;

function byTeamId(a, b) {
  return (Number(a.id) - Number(b.id)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function pathwayKey(p) {
  return [packageId(p.givePackage || [p.give]), p.teamA.id, packageId(p.brokerPackage || [p.broker]),
    p.teamB.id, packageId(p.targetPackage || [p.target]),
    packageId(p.step2GivePackage || [p.broker])].join('|');
}

/* Shared market rules price packages independently of weekly projections. */
function pathwayMarket(player, benchmarks, context) {
  return tradeMarket.marketOf(player, context);
}
function pathwayMarketMatch(a, b, benchmarks, context) {
  return tradeMarket.packageMarket([a], [b], context).accepted;
}

/* This roster read belongs to the shared trade validator. Waiver and
   narrative profiles retain their own contracts. */
function pathwayRosterRead(team, state, solve) {
  const points = solve(team.players);
  const positions = {};
  for (const pos of SKILL_POSITIONS) {
    const benchmark = (state.benchmarks && state.benchmarks[pos]) || 0;
    const dedicated = state.slotIds.filter(function (id) { return SLOT_LABEL[id] === pos; }).length;
    const usable = dedicated > 0 || state.slotIds.some(function (id) {
      return canFill(medianPhantom(pos, benchmark), id);
    });
    const required = dedicated || (usable ? 1 : 0);
    const viable = team.players.filter(function (p) {
      return p.pos === pos && p.hasProjection !== false && p.projection > 0 &&
        p.projection >= benchmark * 0.75 &&
        ['OUT', 'IR', 'SUSPENDED', 'SUSP', 'EXEMPT'].indexOf(p.injury) === -1;
    }).length;
    positions[pos] = {
      required: required, viable: viable, benchmark: benchmark,
      get headroom() {
        if (this._headroom == null) this._headroom = solve(team.players.concat([medianPhantom(pos, benchmark)])) - points;
        return this._headroom;
      },
    };
  }
  return { points: points, positions: positions };
}

function asPackage(players) { return Array.isArray(players) ? players : [players]; }
function packageId(players) { return players.map(function (p) { return p.id; }).sort().join(','); }

function pathwayFit(before, after, outgoing, incoming, gain, floor) {
  const give = asPackage(outgoing); const receive = asPackage(incoming);
  const reasons = []; let score = 0; let severe = false;
  const createsHole = SKILL_POSITIONS.some(function (pos) {
    const prev = before.positions[pos]; const now = after.positions[pos];
    return now.viable < Math.min(prev.viable, prev.required);
  });
  const fromSurplus = give.every(function (p) {
    const prev = before.positions[p.pos]; const now = after.positions[p.pos];
    return prev.viable > prev.required && now.viable >= prev.required;
  });
  for (const pos of packagePositions(receive)) {
    const prev = before.positions[pos]; const now = after.positions[pos];
    const relief = Math.max(0, prev.headroom - now.headroom);
    const coverage = now.viable > prev.viable && prev.viable < prev.required;
    const hole = now.required > 0 && relief > 0.25 && now.viable >= prev.viable;
    const depth = now.required > 0 && now.viable > prev.viable && prev.viable <= prev.required;
    if (coverage) severe = true;
    if (hole || coverage) { reasons.push('fills ' + pos + ' hole'); score += 3 + relief / Math.max(1, prev.benchmark); }
    else if (depth) { reasons.push('gains ' + pos + ' depth'); score += 1; }
  }
  if (fromSurplus) {
    for (const pos of packagePositions(give)) {
      if (after.positions[pos].viable < before.positions[pos].viable) reasons.push('clears ' + pos + ' surplus');
    }
    score += 0.5;
  }
  if (!reasons.length && gain >= 0.05) reasons.push('upgrades weekly lineup');
  /* Negative or neutral points require an actual unfilled/understaffed starter
     position. Merely adding a second healthy QB or TE is not severe scarcity. */
  const maxLoss = Math.min(1.5, before.points * 0.02);
  const accepted = !createsHole && (gain >= Math.max(0.05, floor) ||
    (floor <= 0.5 && gain >= -maxLoss - INTERIM_EPSILON && severe && fromSurplus));
  return { accepted: accepted, score: score, reasons: reasons, maxLoss: maxLoss, severeScarcity: severe };
}

/* The same validator drives the 2-Team board and BOTH isolated pathway legs.
   Step 2 must pass with the bridge roster after Step 1, never its old roster. */
function createTradeValidator(state, options) {
  const opts = options || {}; const solve = lineupSolver(state.slotIds); const reads = new Map();
  const keys = new WeakMap(); const marketCache = new Map(); const fits = new Map(); const owners = new Map();
  function keyOf(players) {
    if (!keys.has(players)) keys.set(players, packageId(players));
    return keys.get(players);
  }
  function idsOf(team) {
    const key = keyOf(team.players);
    if (!owners.has(key)) owners.set(key, new Set(team.players.map(function (p) { return p.id; })));
    return owners.get(key);
  }
  function read(team) {
    const key = keyOf(team.players);
    if (!reads.has(key)) reads.set(key, pathwayRosterRead(team, state, solve));
    return reads.get(key);
  }
  function fit(team, give, receive, floor) {
    const key = keyOf(team.players) + '|' + keyOf(give) + '|' + keyOf(receive) + '|' + floor;
    if (fits.has(key)) return fits.get(key);
    const before = read(team); const players = applySwap(team.players, give, receive);
    const afterPoints = solve(players); const gain = afterPoints - before.points;
    if (gain < -Math.min(1.5, before.points * 0.02) - INTERIM_EPSILON ||
        (floor > 0.5 && gain < floor)) {
      const rejected = { before: before.points, after: afterPoints, gain: gain,
        benefit: { accepted: false, score: 0, reasons: [] }, players: players };
      fits.set(key, rejected); return rejected;
    }
    const after = read({ players: players });
    const result = { before: before.points, after: after.points, gain: gain,
      benefit: pathwayFit(before, after, give, receive, gain, floor), players: players };
    fits.set(key, result); return result;
  }
  function validate(left, right, give, receive) {
    const empty = { accepted: false, reason: 'Invalid package ownership or size' };
    if (!give.length || !receive.length || give.length > 2 || receive.length > 2 || left.id === right.id ||
        new Set(give.concat(receive).map(function (p) { return p.id; })).size !== give.length + receive.length ||
        !give.every(function (p) { return idsOf(left).has(p.id); }) ||
        !receive.every(function (p) { return idsOf(right).has(p.id); })) return empty;
    const marketKey = keyOf(give) + '|' + keyOf(receive);
    if (!marketCache.has(marketKey)) marketCache.set(marketKey, tradeMarket.packageMarket(give, receive, state.marketValues));
    const market = marketCache.get(marketKey);
    if (!market.accepted) return { accepted: false, reason: market.reason, market: market };
    /* Unequal packages must fit the actual roster cap; an unmodeled drop cannot
       silently make the displayed market return cheaper than the scored one. */
    if (state.rosterCapacity != null &&
        (left.players.length - give.length + receive.length > state.rosterCapacity ||
         right.players.length - receive.length + give.length > state.rosterCapacity)) {
      return { accepted: false, reason: 'Package would exceed roster capacity', market: market };
    }
    const a = fit(left, give, receive, 0.05);
    if (!a.benefit.accepted) return { accepted: false, reason: 'The sending roster fails isolated valuation', left: a, market: market };
    const b = fit(right, receive, give, Number.isFinite(Number(opts.minPartnerGain)) ? Number(opts.minPartnerGain) : 0.5);
    return { accepted: a.benefit.accepted && b.benefit.accepted,
      reason: a.benefit.accepted && b.benefit.accepted ? '' : 'A roster fails isolated need, scarcity or point-loss checks',
      left: a, right: b, market: market };
  }
  return { validate: validate, fit: fit, solve: solve };
}
function validateTwoTeamTrade(state, left, right, give, receive, options) {
  return createTradeValidator(state, options).validate(left, right, give, receive);
}

function findPathways(state, me, options) {
  const opts = options || {};
  const poolSize = Math.max(3, Math.min(16, Number(opts.pathwayPoolSize) || DEFAULT_PATHWAY_POOL_SIZE));
  const limit = Math.max(1, Number(opts.pathwayLimit) || DEFAULT_PATHWAY_LIMIT);
  const checkBudget = Math.max(1, Number(opts.pathwayCheckBudget) || DEFAULT_PATHWAY_CHECK_BUDGET);
  const deadlineMs = opts.pathwayDeadlineMs == null ? DEFAULT_PATHWAY_DEADLINE_MS : opts.pathwayDeadlineMs;
  const expired = makeDeadline(deadlineMs);
  const validator = opts.validator || createTradeValidator(state, opts);
  const bestTwoTeamGain = Number(opts.bestTwoTeamGain) || 0;
  const opponents = state.teams.filter(function (t) { return t.id !== me.id; }).sort(byTeamId);
  const pools = new Map(opponents.map(function (t) { return [t.id, packagesFrom(tradeablePool(t, poolSize))]; }));
  /* Only independently acceptable first trades can enter the search. */
  const first = findOffers(state, me, Object.assign({}, opts, {
    validator: validator, poolSize: poolSize, limit: 999999, collectAll: true, deadlineMs: deadlineMs,
  }));
  const found = []; const directCache = new Map();
  const stats = { step1Checks: first.considered, step1Accepted: first.survivors,
    cycleChecks: 0, step2Rejected: 0, finalRejected: 0, pairsDirectlyAvailable: 0 };
  let truncated = first.truncated; let truncatedBy = first.truncated ? 'deadline' : '';
  search:
  for (const leg of first.offers) {
    if (expired()) { truncated = true; truncatedBy = 'deadline'; break; }
    const bridge = Object.assign({}, me, { players: applySwap(me.players, leg.give, leg.receive) });
    const acquired = new Set(leg.receive.map(function (p) { return p.id; }));
    const bridgePool = tradeablePool(bridge, poolSize).filter(function (p) { return !acquired.has(p.id); }).concat(leg.receive);
    const secondPackages = packagesFrom(bridgePool).filter(function (pack) {
      return pack.some(function (p) { return acquired.has(p.id); });
    }).sort(function (a, b) { return a.length - b.length || (packageId(a) < packageId(b) ? -1 : 1); });
    for (const B of opponents) {
      if (B.id === leg.team.id) continue;
      for (const secondGive of secondPackages) {
      for (const target of pools.get(B.id)) {
        if (expired()) { truncated = true; truncatedBy = 'deadline'; break search; }
        if (stats.cycleChecks >= checkBudget) { truncated = true; truncatedBy = 'budget'; break search; }
        stats.cycleChecks++;
        const step2 = validator.validate(bridge, B, secondGive, target);
        if (!step2.accepted) { stats.step2Rejected++; continue; }
        const kept = leg.receive.filter(function (p) { return !secondGive.some(function (q) { return p.id === q.id; }); });
        const netGive = leg.give.concat(secondGive.filter(function (p) { return !acquired.has(p.id); }));
        const netReceive = target.concat(kept);
        const final = validator.fit(me, netGive, netReceive, 0.05);
        const finalMarket = tradeMarket.packageMarket(netGive, netReceive, state.marketValues);
        if (!final.benefit.accepted || !finalMarket.accepted) { stats.finalRejected++; continue; }
        const directKey = B.id + '|' + packageId(netGive) + '|' + packageId(target);
        if (!directCache.has(directKey)) directCache.set(directKey, validator.validate(me, B, netGive, target));
        const direct = directCache.get(directKey);
        if (!kept.length && direct.accepted) { stats.pairsDirectlyAvailable++; continue; }
        const directGain = validator.solve(applySwap(B.players, target, netGive)) - validator.solve(B.players);
        found.push({ kind: leg.myGain >= -INTERIM_EPSILON ? 'PATHWAY' : 'BLOCKBUSTER',
          me: me, teamA: leg.team, teamB: B,
          give: leg.give[0], broker: leg.receive[0], target: target[0],
          givePackage: leg.give, brokerPackage: leg.receive, targetPackage: target,
          step2GivePackage: secondGive, netGivePackage: netGive, netReceivePackage: netReceive,
          myGain: final.gain, aGain: leg.theirGain, bGain: step2.right.gain,
          myBefore: final.before, myAfter: final.after,
          aBefore: leg.theirBefore, aAfter: leg.theirAfter,
          bBefore: step2.right.before, bAfter: step2.right.after,
          interimGain: leg.myGain, directGainForB: directGain,
          benefits: { me: final.benefit, a: leg.benefits.them, b: step2.right.benefit },
          fitScore: final.benefit.score + leg.benefits.them.score + step2.right.benefit.score,
          steps: [
            { accepted: true, shape: leg.shape, myBefore: leg.myBefore, myAfter: leg.myAfter,
              myGain: leg.myGain, partnerGain: leg.theirGain, market: leg.market },
            { accepted: true, shape: secondGive.length + '-for-' + target.length,
              myBefore: step2.left.before, myAfter: step2.left.after,
              myGain: step2.left.gain, partnerGain: step2.right.gain, market: step2.market },
          ],
          upliftVsBestTwoTeam: final.gain - bestTwoTeamGain,
        });
      }
      }
    }
  }
  const byValue = function (a, b) {
    return b.fitScore - a.fitScore || b.myGain - a.myGain ||
      Math.min(b.aGain, b.bGain) - Math.min(a.aGain, a.bGain) ||
      (pathwayKey(a) < pathwayKey(b) ? -1 : 1);
  };
  found.sort(byValue);
  /* Vary the opening exchange and target before repeating the same route. */
  const top = []; const selected = new Set(); const seenOpeners = new Set(); const seenTargets = new Set();
  for (const p of found) {
    const opener = packageId(p.givePackage) + '|' + p.teamA.id + '|' + packageId(p.brokerPackage);
    const targetKey = packageId(p.targetPackage);
    if (seenOpeners.has(opener) || seenTargets.has(targetKey)) continue;
    seenOpeners.add(opener); seenTargets.add(targetKey); top.push(p); selected.add(p);
    if (top.length >= limit) break;
  }
  for (const p of found) { if (top.length >= limit) break; if (!selected.has(p)) { top.push(p); selected.add(p); } }
  top.sort(byValue);
  return { pathways: top, survivors: found.length, truncated: truncated, truncatedBy: truncatedBy,
    poolSize: poolSize, minPartnerGain: opts.minPartnerGain == null ? 0.5 : opts.minPartnerGain,
    checkBudget: checkBudget, stats: stats };
}

/* ============================================================================
   9. PACKAGE SHAPE

   What used to be a prose-pitch generator. The DM copy, and the six private
   helpers that only ever fed it (playerLabel, listNames, solvedNeeds,
   honestSurplus, headline and the pitch builder itself) are gone: the card
   states the numbers and the reader writes their own message.

   `packagePositions` survives because the bye-week desk reads it too — it is
   the distinct positions in a group of players, which is data rather than copy.
============================================================================ */

function packagePositions(players) {
  const seen = [];
  for (const p of players) if (p.pos && seen.indexOf(p.pos) === -1) seen.push(p.pos);
  return seen;
}

/* Anything in a package that is not simply ACTIVE. ESPN's own weekly forecast
   already discounts a player who will not play, so these are NOT re-penalised
   here — but a designation is the first thing the other manager will check. */
function designations(offer) {
  const flagged = [];
  for (const p of offer.give.concat(offer.receive)) {
    if (p.injury && p.injury !== 'ACTIVE' && p.injury !== 'NORMAL') {
      flagged.push(p.name + ' — ' + p.injury);
    }
  }
  return flagged;
}

/* ============================================================================
   10. THE WAIVER DESK

   The whole point is that a waiver board is worthless generically. "Top
   available players" is a list every manager in the league is already looking
   at; what matters is what a claim is worth to THIS lineup, which is the same
   measurement the trade math uses: add him, re-solve, keep the delta.

   A free agent who would not crack my starting lineup has a delta of 0.0. He may
   still be worth a claim as insurance against a bye or an injury, and the board
   says so explicitly rather than ranking him as though he were an upgrade.
============================================================================ */

/* Which pro teams are on bye in each of the next few weeks, and therefore which
   of MY starters I am about to be short. `byeWeeks` maps proTeamId -> week. */
function upcomingByeExposure(me, read, byeWeeks, week, horizon) {
  const span = Math.max(1, Number(horizon) || 3);
  const rows = [];
  for (let offset = 1; offset <= span; offset++) {
    const target = Number(week) + offset;
    const missing = [];
    for (const row of read.base.lineup) {
      const player = row.player;
      if (!player) continue;
      const bye = byeWeeks ? num(byeWeeks[String(player.proTeamId)]) : null;
      if (bye != null && bye === target) {
        missing.push({ name: player.name, pos: player.pos, proTeam: player.proTeam, slot: row.slot });
      }
    }
    if (missing.length) {
      rows.push({
        week: target,
        starters: missing.sort(function (a, b) { return a.name < b.name ? -1 : 1; }),
        positions: packagePositions(missing),
      });
    }
  }
  return rows;
}

/* Open roster spots. `rosterCapacity` comes from the league's own slot counts;
   a league whose settings did not come back readable reports null rather than a
   guessed number, and the FAB advice below drops the roster-pressure term
   instead of inventing one. */
function openRosterSpots(me, rosterCapacity) {
  if (rosterCapacity == null) return null;
  return Math.max(0, rosterCapacity - me.players.length);
}

/* FAB / priority urgency, in [0, 1]. Three inputs, each of which a real manager
   actually weighs:

     record        a team under .500 in the back half of the season is buying
                   now or not at all; a team above it is protecting an asset
     open spots    no open spot means a claim costs a drop, which raises the bar
     bye exposure  a hole I already know is coming is worth paying ahead for

   Deterministic and clamped. Nothing here reads a clock — "back half of the
   season" is derived from the league's own scoring period, not from today. */
function claimUrgency(me, state, byeRows, openSpots) {
  const totalGames = me.wins + me.losses + me.ties;
  const pct = me.winPct;

  /* Losing teams press. The weight rises with how far under .500 and how late
     it is, because week 11 at 3-7 is a different decision from week 2 at 0-2. */
  let recordTerm = 0.35;
  if (pct != null) {
    const under = Math.max(0, 0.5 - pct);           // 0 .. 0.5
    const lateness = totalGames > 0 ? Math.min(1, Number(state.week) / 14) : 0;
    recordTerm = 0.35 + (under * 2) * 0.35 * (0.5 + 0.5 * lateness);
    if (pct > 0.5) recordTerm = 0.35 - Math.min(0.15, (pct - 0.5) * 0.3);
  }

  const spaceTerm = openSpots == null ? 0 : (openSpots > 0 ? 0.12 : -0.05);
  const byeTerm = byeRows.length ? Math.min(0.18, 0.09 * byeRows.length) : 0;

  return Math.max(0, Math.min(1, recordTerm + spaceTerm + byeTerm));
}

/* A FAB bid, as a percentage of the budget REMAINING, scaled by what the claim
   is actually worth relative to the best thing on the board and by urgency.

   The ceiling is deliberate: no single in-season claim is worth more than half
   of what is left, because the one week you are certain about is never the last
   week you will need money. */
function suggestFab(gain, bestGain, remaining, urgency) {
  if (remaining == null || !(remaining > 0)) return null;
  const share = bestGain > 0 ? Math.max(0, Math.min(1, gain / bestGain)) : 0;
  /* A claim worth nothing to the lineup is a speculative add, and a speculative
     add is a minimum bid, not a percentage of the budget. */
  if (!(gain > 0.05)) return { amount: Math.min(remaining, 1), pct: null, speculative: true };
  const pct = Math.min(0.5, 0.08 + share * 0.34 * (0.5 + 0.5 * urgency));
  const amount = Math.max(1, Math.round(remaining * pct));
  return { amount: Math.min(remaining, amount), pct: Math.round(pct * 100), speculative: false };
}

/* Should I burn my waiver priority on this? In a rolling-priority league the
   claim itself is the cost, so the bar is higher than in FAB: spend the position
   on a lineup upgrade, not on depth you can stream. */
function priorityAdvice(gain, rank, teamCount) {
  if (rank == null) return { spend: gain > 1.5, note: 'ESPN did not report a waiver position for this team.' };
  const early = teamCount ? rank <= Math.ceil(teamCount / 3) : rank <= 4;
  if (gain > 2.5) {
    return { spend: true, note: 'Worth the claim at any position — this is a starting-lineup upgrade, not depth.' };
  }
  if (gain > 0.75) {
    return early
      ? { spend: false, note: 'Priority #' + rank + ' is too valuable for a ' + round1(gain).toFixed(1) +
          ' pt/wk gain. Let it come to you on a later claim or a free add.' }
      : { spend: true, note: 'At priority #' + rank + ' the position is not worth hoarding — take the ' +
          round1(gain).toFixed(1) + ' pts.' };
  }
  return { spend: false, note: 'Free-agent add if he clears waivers; not worth a claim.' };
}

/* Rank the available pool by what a claim is worth to MY optimal lineup. */
function rankWaiverTargets(state, me, read, freeAgents, options) {
  const opts = options || {};
  const limit = Math.max(1, Number(opts.limit) || 8);
  const slotIds = state.slotIds;
  const solve = lineupSolver(slotIds);
  const myBase = solve(me.players);

  const holes = read.needs
    .filter(function (n) { return n.needValue > 0.05; })
    .map(function (n) { return n.pos; });

  const scored = [];
  for (const fa of freeAgents) {
    if (!fa || !fa.id) continue;
    const gain = solve(me.players.concat([fa])) - myBase;
    /* Position need is what makes a 0.0-gain add still worth a look: the FLEX is
       filled today, but the hole is real and he is the best thing available at
       it. Both numbers travel so the board can be honest about which is which. */
    const needValue = holes.indexOf(fa.pos) !== -1
      ? (read.profile[fa.pos] ? read.profile[fa.pos].needValue : 0)
      : 0;
    scored.push({
      player: fa,
      gain: gain,
      needValue: needValue,
      fillsNeed: needValue > 0.05,
    });
  }

  scored.sort(function (a, b) {
    return b.gain - a.gain ||
      b.needValue - a.needValue ||
      (b.player.percentOwned || 0) - (a.player.percentOwned || 0) ||
      (a.player.id < b.player.id ? -1 : 1);
  });

  const byeRows = upcomingByeExposure(me, read, opts.byeWeeks, state.week, 3);
  const openSpots = openRosterSpots(me, state.rosterCapacity);
  const urgency = claimUrgency(me, state, byeRows, openSpots);
  const remaining = state.rules.budget != null
    ? Math.max(0, state.rules.budget - (me.fabSpent || 0))
    : null;
  const bestGain = scored.length ? Math.max(0, scored[0].gain) : 0;

  const board = scored.slice(0, limit).map(function (row, index) {
    const p = row.player;
    const byeClash = byeRows.filter(function (b) {
      return p.byeWeek != null && b.week === p.byeWeek;
    }).length > 0;
    /* A player whose bye lands on the very week I am already short is the one
       add that does not solve the problem it is being claimed for. */
    const coversBye = byeRows.filter(function (b) {
      return b.positions.indexOf(p.pos) !== -1 && p.byeWeek !== b.week;
    }).map(function (b) { return b.week; });

    const fab = state.rules.usesFab ? suggestFab(row.gain, bestGain, remaining, urgency) : null;
    const priority = state.rules.usesFab
      ? null
      : priorityAdvice(row.gain, me.waiverRank, state.teams.length);

    const reasons = [];
    if (row.gain > 0.05) {
      reasons.push('Slots straight into the optimal lineup for +' + round1(row.gain).toFixed(1) + ' pts/wk.');
    } else if (row.fillsNeed) {
      reasons.push('Does not crack this week\'s lineup, but ' + p.pos + ' is the position a median ' +
        'starter would add ' + round1(row.needValue).toFixed(1) + ' pts/wk to — this is the best ' +
        'available body at the hole.');
    } else {
      reasons.push('No lineup gain this week. Speculative depth only.');
    }
    if (coversBye.length) {
      reasons.push('Covers the week ' + coversBye.join(' and ') + ' bye at ' + p.pos + '.');
    }
    if (byeClash) {
      reasons.push('Note: his own bye is week ' + p.byeWeek + ', the same week you are already short.');
    }
    if (p.percentChange != null && p.percentChange > 3) {
      reasons.push('Rostered in ' + Math.round(p.percentOwned || 0) + '% of leagues and climbing (+' +
        round1(p.percentChange).toFixed(1) + ' this week) — he will not be here next week.');
    }
    if (p.injury && p.injury !== 'ACTIVE' && p.injury !== 'NORMAL') {
      reasons.push('Designation: ' + p.injury + '.');
    }

    return {
      rank: index + 1,
      playerId: p.id,
      name: p.name,
      pos: p.pos,
      proTeam: p.proTeam,
      injury: p.injury,
      byeWeek: p.byeWeek,
      projection: round1(p.projection),
      hasProjection: p.hasProjection,
      percentOwned: p.percentOwned == null ? null : round1(p.percentOwned),
      percentStarted: p.percentStarted == null ? null : round1(p.percentStarted),
      percentChange: p.percentChange == null ? null : round1(p.percentChange),
      lineupGain: round1(row.gain),
      fillsNeed: row.fillsNeed,
      needValue: round1(row.needValue),
      fab: fab,
      priority: priority,
      reasons: reasons,
    };
  });

  return {
    board: board,
    poolSize: freeAgents.length,
    context: {
      acquisitionType: state.rules.type,
      usesFab: state.rules.usesFab,
      fabBudget: state.rules.budget,
      fabSpent: me.fabSpent == null ? null : me.fabSpent,
      fabRemaining: remaining,
      waiverRank: me.waiverRank,
      openRosterSpots: openSpots,
      rosterCapacity: state.rosterCapacity,
      rosterSize: me.players.length,
      urgency: round1(urgency * 100),
      byeExposure: byeRows,
    },
  };
}

/* ============================================================================
   11. WHO AM I

   The SWID stored for this league IS an ESPN member id, and every team carries
   its owners' member ids. That is an exact match, not a guess — and it is why
   this feature works without asking the reader which team is theirs.
============================================================================ */

function bareSwid(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^%7B/i, '{')
    .replace(/%7D$/i, '}')
    .replace(/^"|"$/g, '')
    .replace(/[{}]/g, '')
    .toLowerCase();
}

function resolveMyTeam(state, requested, swid) {
  const needle = String(requested == null ? '' : requested).trim().toLowerCase();
  if (needle) {
    const byId = state.teams.find(function (t) { return t.id === needle; });
    if (byId) return byId;
    const byName = state.teams.find(function (t) { return t.name.toLowerCase() === needle; });
    if (byName) return byName;
    const byAbbrev = state.teams.find(function (t) { return t.abbrev && t.abbrev.toLowerCase() === needle; });
    if (byAbbrev) return byAbbrev;
  }

  const bare = bareSwid(swid);
  if (bare) {
    const mine = state.teams.find(function (t) {
      return t.ownerIds.some(function (id) { return bareSwid(id) === bare; });
    });
    if (mine) return mine;
    console.warn('[AI GM] The stored SWID for league ' + state.leagueId + ' matches no team owner in ' +
      'the payload. The caller must name a team explicitly.');
  }

  return null;
}

/* ============================================================================
   12. THE ANALYSIS

   One pure function from payloads to the object the UI renders. No network, no
   clock (bar the search deadline), no randomness — which is what makes the
   self-test's determinism assertion meaningful and what lets a tester re-run
   after a claim and diff the two boards.
============================================================================ */

function analyze(input, options) {
  const opts = options || {};
  const state = normalize(input.league, {
    week: opts.week,
    season: opts.season,
    byeWeeks: input.byeWeeks || {},
    marketValues: input.marketValues || opts.marketValues,
  });

  const me = resolveMyTeam(state, opts.team, opts.swid);
  if (!me) {
    const error = new Error('Could not tell which team in league ' + state.leagueId + ' is yours.');
    error.code = 'TEAM_UNRESOLVED';
    /* Non-enumerable: the handler needs this list to answer the caller, but a
       console.error(msg, err) would otherwise dump twelve rosters into the
       function log on every occurrence. The message says what happened; the
       payload is for the response. */
    Object.defineProperty(error, 'teams', {
      value: state.teams.map(function (t) {
        return { id: t.id, name: t.name, owner: t.owner, record: t.record };
      }),
      enumerable: false, configurable: true, writable: true,
    });
    throw error;
  }

  const solve = lineupSolver(state.slotIds);
  const myRead = teamRead(me, state.slotIds, state.benchmarks, solve);
  const validator = createTradeValidator(state, opts);
  const search = findOffers(state, me, Object.assign({}, opts, { validator: validator }));

  const buyLow = buyLowCandidates(state, me.id);
  const sellHigh = sellHighCandidates(me, myRead);
  const buyLowIds = new Set(buyLow.map(function (r) { return r.playerId; }));
  const sellHighIds = new Set(sellHigh.map(function (r) { return r.playerId; }));

  /* A trade's tags are read off the pieces actually in it, so a package can be
     "buy low" and "sell high" at once — which is the deal you want most — and a
     package that is neither is still on the board on its lineup delta alone. */
  const trades = search.offers.map(function (offer) {
    const theirRead = teamRead(offer.team, state.slotIds, state.benchmarks, solve);
    const incomingBuyLow = offer.receive
      .filter(function (p) { return buyLowIds.has(p.id); })
      .map(function (p) { return buyLow.find(function (r) { return r.playerId === p.id; }); });
    const outgoingSellHigh = offer.give
      .filter(function (p) { return sellHighIds.has(p.id); })
      .map(function (p) { return sellHigh.find(function (r) { return r.playerId === p.id; }); });

    const tags = [];
    if (incomingBuyLow.length) tags.push('BUY LOW');
    if (outgoingSellHigh.length) tags.push('SELL HIGH');
    if (!tags.length) tags.push('LINEUP FIT');

    const theirTopNeed = theirRead.needs.filter(function (n) { return n.needValue > 0.05; })[0] || null;

    return {
      id: offerKey(offer),
      shape: offer.shape,
      tags: tags,
      targetTeam: {
        id: offer.team.id,
        name: offer.team.name,
        abbrev: offer.team.abbrev,
        owner: offer.team.owner,
        record: offer.team.record,
        logo: offer.team.logo,
      },
      give: offer.give.map(describePiece),
      receive: offer.receive.map(describePiece),
      myLineup: {
        before: round1(offer.myBefore),
        after: round1(offer.myAfter),
        gain: round1(offer.myGain),
      },
      theirLineup: {
        before: round1(offer.theirBefore),
        after: round1(offer.theirAfter),
        gain: round1(offer.theirGain),
      },
      theirRead: {
        biggestDeficit: theirTopNeed ? theirTopNeed.pos : null,
        deficitValue: theirTopNeed ? round1(theirTopNeed.needValue) : null,
        clearestSurplus: theirRead.surplus.length ? theirRead.surplus[0].pos : null,
      },
      buyLow: incomingBuyLow.filter(Boolean),
      sellHigh: outgoingSellHigh.filter(Boolean),
      designations: designations(offer),
      benefits: offer.benefits,
      market: offer.market,
    };
  });

  /* Three-team pathways, seeded with my best 2-team gain so every cycle can say
     whether it beats the board I already have. */
  const bestTwoTeamGain = search.offers.length ? search.offers[0].myGain : 0;
  const search3 = findPathways(state, me, Object.assign({}, opts, { bestTwoTeamGain: bestTwoTeamGain, validator: validator }));
  const describeTeam = function (t) {
    return { id: t.id, name: t.name, abbrev: t.abbrev, owner: t.owner, record: t.record, logo: t.logo };
  };
  const pathways = search3.pathways.map(function (p) {
    return {
      id: pathwayKey(p),
      kind: p.kind,
      fitScore: round1(p.fitScore),
      benefits: p.benefits,
      teamA: describeTeam(p.teamA),
      teamB: describeTeam(p.teamB),
      give: describePiece(p.give),
      broker: describePiece(p.broker),
      target: describePiece(p.target),
      givePackage: p.givePackage.map(describePiece),
      brokerPackage: p.brokerPackage.map(describePiece),
      targetPackage: p.targetPackage.map(describePiece),
      step2GivePackage: p.step2GivePackage.map(describePiece),
      netGivePackage: p.netGivePackage.map(describePiece),
      netReceivePackage: p.netReceivePackage.map(describePiece),
      steps: p.steps.map(function (step) {
        return Object.assign({}, step, { myBefore: round1(step.myBefore), myAfter: round1(step.myAfter),
          myGain: round1(step.myGain), partnerGain: round1(step.partnerGain) });
      }),
      /* Honest weekly ledgers alongside each manager's roster benefit. */
      me: { before: round1(p.myBefore), after: round1(p.myAfter), gain: round1(p.myGain) },
      a: { before: round1(p.aBefore), after: round1(p.aAfter), gain: round1(p.aGain) },
      b: { before: round1(p.bBefore), after: round1(p.bAfter), gain: round1(p.bGain) },
      /* My lineup after step 1 alone — what decides PATHWAY vs BLOCKBUSTER. */
      interimGain: round1(p.interimGain),
      /* B's weekly delta for the direct swap rejected by roster-fit checks. */
      directGainForB: round1(p.directGainForB),
      upliftVsBestTwoTeam: round1(p.upliftVsBestTwoTeam),
      beatsBestTwoTeam: p.upliftVsBestTwoTeam > 0.05,
      /* False when the 2-team board is empty — the strongest case for a 3-way,
         since then a third manager is the only route to any win-win at all. */
      hasTwoTeamAlternative: search.offers.length > 0,
      designations: designations({ give: p.netGivePackage.concat(p.brokerPackage), receive: p.netReceivePackage }),
    };
  });

  const waivers = rankWaiverTargets(state, me, myRead, input.freeAgents || [], {
    limit: opts.waiverLimit,
    byeWeeks: input.byeWeeks || {},
  });

  const topNeed = myRead.needs.filter(function (n) { return n.needValue > 0.05; })[0] || null;

  return {
    ok: true,
    beta: true,
    market: { source: state.marketValues.source || (state.marketValues.byId ? 'Explicit market override' : tradeMarket.snapshot.source),
      asOf: state.marketValues.asOf || tradeMarket.snapshot.asOf,
      format: tradeMarket.snapshot.format, elitePackagingRequired: true },
    league: {
      id: state.leagueId,
      name: state.leagueName,
      season: state.season,
      week: state.week,
      teamCount: state.teams.length,
      lineup: state.startingSlotCounts,
      lineupSlots: state.slotLabels,
      lineupFromSettings: !state.slotFallback,
      rosterCapacity: state.rosterCapacity,
      acquisition: state.rules,
    },
    myTeam: {
      id: me.id,
      name: me.name,
      abbrev: me.abbrev,
      owner: me.owner,
      record: me.record,
      logo: me.logo,
      playoffSeed: me.playoffSeed,
      projectedLineup: round1(search.myBase),
      lineup: myRead.base.lineup.map(function (row) {
        return {
          slot: row.slot,
          player: row.player ? describePiece(row.player) : null,
        };
      }),
      positions: SKILL_POSITIONS.map(function (pos) {
        const row = myRead.profile[pos];
        return {
          pos: pos,
          rostered: row.rostered,
          starting: row.starting,
          starterPoints: round1(row.starterValue),
          leagueMedian: round1(row.benchmark),
          needValue: round1(row.needValue),
          spareValue: round1(row.spareValue),
          topBench: row.topBench ? describePiece(row.topBench) : null,
        };
      }),
      biggestDeficit: topNeed ? topNeed.pos : null,
      biggestDeficitValue: topNeed ? round1(topNeed.needValue) : null,
      clearestSurplus: myRead.surplus.length ? myRead.surplus[0].pos : null,
    },
    trades: trades,
    pathways: pathways,
    buyLow: buyLow.slice(0, 8),
    sellHigh: sellHigh.slice(0, 8),
    waivers: waivers,
    search: {
      packagesConsidered: search.considered,
      twoWayPositive: search.survivors,
      rostersAnalyzed: search.rostersAnalyzed,
      rostersTotal: search.rostersTotal,
      truncated: search.truncated,
      poolSize: search.poolSize,
      minPartnerGain: search.minPartnerGain,
    },
    search3: {
      found: search3.survivors,
      truncated: search3.truncated,
      truncatedBy: search3.truncatedBy,
      poolSize: search3.poolSize,
      checkBudget: search3.checkBudget,
      bestTwoTeamGain: round1(bestTwoTeamGain),
      stats: search3.stats,
    },
  };
}

function describePiece(p) {
  return {
    id: p.id,
    name: p.name,
    pos: p.pos,
    proTeam: p.proTeam,
    projection: round1(p.projection),
    hasProjection: p.hasProjection !== false,
    injury: p.injury,
    byeWeek: p.byeWeek == null ? null : p.byeWeek,
    actualPpg: p.actualPpg == null ? null : round1(p.actualPpg),
    seasonBaseline: p.seasonBaseline == null ? null : round1(p.seasonBaseline),
    draftRank: p.draftRank == null ? null : p.draftRank,
    percentStarted: p.percentStarted == null ? null : round1(p.percentStarted),
  };
}

/* ============================================================================
   13. ESPN TRANSPORT

   Three reads, all against lm-api-reads.fantasy.espn.com, all carrying the pair
   this league already has stored in Supabase:

     1. the league        mRoster + mTeam + mSettings + mNav at this week
     2. the waiver pool   kona_player_info behind an X-Fantasy-Filter. This is
                          the read that cannot go through /api/espn: that relay
                          builds its own outbound headers and does not forward a
                          fantasy filter, so an unfiltered kona_player_info would
                          return the entire player universe. Hence this handler.
     3. the bye weeks     the season's proTeamSchedules, which is where
                          proTeams[].byeWeek lives

   Read 3 is non-fatal: without it the waiver desk drops its bye-week reasoning
   and says so, rather than refusing the whole analysis.
============================================================================ */

function leagueReadUrl(season, leagueId, week) {
  return ESPN_HOST + '/apis/v3/games/ffl/seasons/' + encodeURIComponent(season) +
    '/segments/0/leagues/' + encodeURIComponent(leagueId) +
    '?view=mRoster&view=mTeam&view=mSettings&view=mNav' +
    (week ? '&scoringPeriodId=' + encodeURIComponent(week) : '');
}

function waiverReadUrl(season, leagueId, week) {
  return ESPN_HOST + '/apis/v3/games/ffl/seasons/' + encodeURIComponent(season) +
    '/segments/0/leagues/' + encodeURIComponent(leagueId) +
    '?view=kona_player_info' + (week ? '&scoringPeriodId=' + encodeURIComponent(week) : '');
}

function proTeamsUrl(season) {
  return ESPN_HOST + '/apis/v3/games/ffl/seasons/' + encodeURIComponent(season) +
    '?view=proTeamSchedules_wl';
}

/* The filter ESPN reads for the waiver pool. `limit` is the one number worth
   tuning: 150 is deep enough that a 12-team league's genuinely startable free
   agents are all in it, and small enough that the response stays inside a
   serverless response budget. */
function waiverFilter(limit) {
  return JSON.stringify({
    players: {
      filterStatus: { value: ['FREEAGENT', 'WAIVERS'] },
      filterSlotIds: { value: WAIVER_SLOT_IDS },
      limit: Math.max(25, Math.min(300, Number(limit) || 150)),
      offset: 0,
      sortPercOwned: { sortAsc: false, sortPriority: 1 },
      sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'STANDARD' },
    },
  });
}

async function readEspn(url, cookieHeader, extraHeaders, label) {
  const headers = Object.assign({
    Accept: 'application/json',
    'User-Agent': BROWSER_USER_AGENT,
  }, extraHeaders || {});
  if (cookieHeader) headers.Cookie = cookieHeader;

  console.log('[AI GM] → ESPN GET ' + url + ' (' + label + ', ' +
    (cookieHeader ? 'authenticated' : 'ANONYMOUS') + ')');

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(ESPN_READ_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('[AI GM] The ' + label + ' read did not complete for ' + url, err);
    const error = new Error('ESPN did not answer the ' + label + ' read in time.');
    error.status = 504;
    throw error;
  }

  const body = await response.text();
  console.log('[AI GM] ← ESPN ' + response.status + ' (' + body.length + ' bytes) for ' + label);

  if (!response.ok) {
    console.error('[AI GM] ESPN answered HTTP ' + response.status + ' for the ' + label +
      ' read. Body head: ' + body.slice(0, 300));
    const error = new Error(response.status === 401 || response.status === 403
      ? 'ESPN rejected the stored league session for this read (HTTP ' + response.status + '). ' +
        'The saved espn_s2 / SWID pair has most likely expired — a league member needs to re-save ' +
        'the league from Setup.'
      : 'ESPN answered HTTP ' + response.status + ' for the ' + label + ' read.');
    error.status = response.status === 401 || response.status === 403 ? 502 : 502;
    error.upstreamStatus = response.status;
    throw error;
  }

  try {
    return JSON.parse(body);
  } catch (err) {
    console.error('[AI GM] ESPN returned a non-JSON body for the ' + label + ' read (HTTP ' +
      response.status + '). Head: ' + body.slice(0, 300), err);
    const error = new Error('ESPN returned something that is not JSON for the ' + label + ' read.');
    error.status = 502;
    throw error;
  }
}

/* proTeamId -> bye week, from the season's pro-team schedule view. */
function byeWeeksFrom(payload) {
  const league = unwrapLeague(payload);
  const proTeams = (league && league.settings && league.settings.proTeams) || null;
  const out = {};
  if (!Array.isArray(proTeams)) return out;
  for (const team of proTeams) {
    const id = num(team && team.id);
    const bye = num(team && team.byeWeek);
    if (id != null && bye != null && bye > 0) out[String(id)] = bye;
  }
  return out;
}

/* The free-agent pool, normalised into the same player card shape the roster
   walk produces, so the lineup solver cannot tell the two apart. */
function freeAgentsFrom(payload, week, byeWeeks) {
  const league = unwrapLeague(payload);
  const rows = (league && Array.isArray(league.players)) ? league.players : [];
  const out = [];
  for (const row of rows) {
    if (!row) continue;
    /* ESPN nests the card under `player` on this view and stamps ownership at
       the row level. A row that names a team is not available, whatever the
       filter asked for. */
    if (num(row.onTeamId) != null && num(row.onTeamId) > 0) continue;
    const card = normalizePlayerCard({ playerPoolEntry: { player: row.player || row } }, week,
      { byeWeeks: byeWeeks });
    if (!card) continue;
    card.waiverStatus = String(row.status || '').toUpperCase() || 'FREEAGENT';
    card.benched = false;
    card.slotId = null;
    out.push(card);
  }
  /* Stable order before any scoring touches it, so a tie in lineup gain resolves
     identically on every run. */
  out.sort(function (a, b) {
    return (b.percentOwned || 0) - (a.percentOwned || 0) || (a.id < b.id ? -1 : 1);
  });
  return out;
}

/* ============================================================================
   14. THE HANDLER    GET /api/ai-gm?league=…&season=…&week=…

   Reached through the vercel.json rewrite onto /api/espn?action=ai-gm, because
   a thirteenth file under api/ fails the DEPLOY. See the header.

   `deps.resolveStoredLeagueAccess` is injected by the caller rather than
   required here, for two reasons: it keeps lib/ from reaching back into api/,
   and it lets the self-test drive the whole handler with a stub resolver and no
   Supabase at all.
============================================================================ */

function applyCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-league-token');
  /* Never cached at a shared edge: the response is derived from one league's
     private ESPN session and is scoped to one team inside it. */
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'x-league-token');
}

/* The share token for the league being read. Two transports, mirroring
   api/espn.js: the app sends x-league-token on every relay read, and a link
   pasted straight at the route carries ?token=. */
function requestShareToken(req) {
  const header = req && req.headers && req.headers['x-league-token'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader && String(fromHeader).trim()) return String(fromHeader).trim();
  const q = req && req.query && req.query.token;
  const fromQuery = Array.isArray(q) ? q[0] : q;
  return fromQuery ? String(fromQuery).trim() : '';
}

function queryValue(req, key) {
  const q = req && req.query ? req.query[key] : undefined;
  const value = Array.isArray(q) ? q[0] : q;
  if (value != null && String(value).trim()) return String(value).trim();
  if (req && req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const fallback = parsed.searchParams.get(key);
      if (fallback != null && String(fallback).trim()) return String(fallback).trim();
    } catch (err) {
      console.warn('[AI GM] Could not parse req.url to recover the "' + key + '" parameter.', err);
    }
  }
  return '';
}

/* A season for the read. The client always sends one; the fallback is the
   calendar year, which is the only defensible guess and is logged when used. */
function resolveSeason(raw) {
  const year = Number(raw);
  if (Number.isInteger(year) && year >= 2018 && year <= 2100) return year;
  const fallback = new Date().getFullYear();
  console.warn('[AI GM] No usable season parameter ("' + String(raw) + '"); reading season ' +
    fallback + '. The client should always send one.');
  return fallback;
}

async function handle(req, res, deps) {
  applyCorsHeaders(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const requestedLeague = normalizeLeagueId(queryValue(req, 'league'));

  /* ---- THE GATE ----
     Server-side, before anything else happens and before a single credential is
     looked up. A client-side gate is a suggestion; this is the feature's actual
     boundary. The message names no other league and leaks no roster. */
  if (!isAiGmLeague(requestedLeague)) {
    console.warn('[AI GM] Refusing an analysis request for league ' +
      (requestedLeague || '(no valid league id)') + ' — the AI GM beta is enabled for ' +
      AI_GM_ALLOWED_LEAGUE_IDS.length + ' league(s) and this is not one of them.');
    return res.status(403).json({
      error: 'The AI GM beta is not enabled for this league.',
      code: 'AI_GM_NOT_ENABLED',
    });
  }

  const season = resolveSeason(queryValue(req, 'season'));
  const weekRaw = Number(queryValue(req, 'week'));
  const week = Number.isInteger(weekRaw) && weekRaw > 0 && weekRaw <= 25 ? weekRaw : null;
  const team = queryValue(req, 'team');
  const shareToken = requestShareToken(req);

  const resolver = deps && deps.resolveStoredLeagueAccess;
  if (typeof resolver !== 'function') {
    console.error('[AI GM] No resolveStoredLeagueAccess was injected; the stored ESPN session ' +
      'cannot be looked up and the analysis cannot run.',
      new Error('AI_GM_RESOLVER_MISSING'));
    return res.status(500).json({
      error: 'The AI GM beta is misconfigured on the server.',
      code: 'AI_GM_RESOLVER_MISSING',
    });
  }

  /* ---- THE STORED SUPABASE SESSION ----
     This is the whole point of the feature: the cookies are already in the
     leagues table for 57155288, encrypted, and this is the same gate /api/espn
     passes through to borrow them. Nothing is prompted for and nothing is read
     from the environment. */
  let access;
  try {
    access = await resolver(requestedLeague, season, shareToken);
  } catch (err) {
    console.error('[AI GM] The stored-session lookup threw for league ' + requestedLeague +
      ' season ' + season + '.', err);
    return res.status(502).json({
      error: 'The stored league session could not be read.',
      code: 'AI_GM_STORE_UNAVAILABLE',
    });
  }

  const status = String((access && access.status) || 'none');
  if (status !== 'ok' || !access.cookies) {
    console.error('[AI GM] No usable stored ESPN session for league ' + requestedLeague +
      ' (status "' + status + '": ' + String((access && access.reason) || 'no reason given') + ').',
      new Error('AI_GM_NO_STORED_SESSION:' + status));
    return res.status(status === 'unauthorized' ? 401 : 409).json({
      error: status === 'unauthorized'
        ? 'This device is not carrying the invite token for league ' + requestedLeague + ', so the ' +
          'stored ESPN session cannot be replayed for it. Open the league from Setup once, or use ' +
          'the invite link a league-mate sent you.'
        : 'No ESPN session is stored for league ' + requestedLeague + ' yet — ' +
          String((access && access.reason) || 'the league record holds no cookie pair') +
          '. Save the league from Setup with both cookies present and try again.',
      code: 'AI_GM_NO_STORED_SESSION',
      storeStatus: status,
    });
  }

  const pair = buildEspnCookieHeader(access.cookies.swid, access.cookies.espn_s2);
  if (!pair.swid || !pair.espn_s2) {
    console.error('[AI GM] The stored envelope for league ' + requestedLeague + ' did not yield a ' +
      'complete pair (' + (pair.reason || 'one half is missing') + '). ESPN authenticates on the ' +
      'pair, so the read is refused rather than sent half-credentialed.',
      new Error('AI_GM_INCOMPLETE_STORED_PAIR'));
    return res.status(409).json({
      error: 'The stored ESPN session for this league is incomplete. A league member needs to ' +
        're-save both espn_s2 and SWID from Setup.',
      code: 'AI_GM_INCOMPLETE_STORED_PAIR',
    });
  }

  /* ---- THE READS ---- */
  let leaguePayload;
  let waiverPayload;
  let byeWeeks = {};
  try {
    leaguePayload = await readEspn(leagueReadUrl(season, requestedLeague, week), pair.header, null, 'league');
  } catch (err) {
    return res.status(Number(err && err.status) || 502).json({
      error: String((err && err.message) || 'The league read failed.'),
      code: 'AI_GM_LEAGUE_READ_FAILED',
    });
  }

  /* The waiver pool is the one read that needs the fantasy filter, and the one
     the generic relay could not carry. A failure here degrades the waiver
     section rather than the whole analysis — the trade board does not depend on
     it. */
  let waiverError = '';
  try {
    waiverPayload = await readEspn(
      waiverReadUrl(season, requestedLeague, week),
      pair.header,
      { 'X-Fantasy-Filter': waiverFilter(queryValue(req, 'pool')) },
      'waiver pool',
    );
  } catch (err) {
    console.error('[AI GM] The waiver-pool read failed for league ' + requestedLeague +
      '; the trade board will still be built and the waiver section will say why it is empty.', err);
    waiverError = String((err && err.message) || 'The waiver-pool read failed.');
    waiverPayload = null;
  }

  /* Bye weeks are a nicety: without them the waiver desk drops its bye reasoning
     and every other number is unaffected. */
  try {
    byeWeeks = byeWeeksFrom(await readEspn(proTeamsUrl(season), pair.header, null, 'pro-team schedules'));
  } catch (err) {
    console.warn('[AI GM] Could not read the pro-team bye weeks for season ' + season +
      '; the waiver desk will omit bye-week reasoning.', err);
    byeWeeks = {};
  }

  const effectiveWeek = week ||
    num(unwrapLeague(leaguePayload) && unwrapLeague(leaguePayload).scoringPeriodId) || null;
  const freeAgents = waiverPayload ? freeAgentsFrom(waiverPayload, effectiveWeek, byeWeeks) : [];

  let analysis;
  try {
    analysis = analyze(
      { league: leaguePayload, freeAgents: freeAgents, byeWeeks: byeWeeks },
      {
        week: week,
        season: season,
        team: team,
        swid: access.cookies.swid,
        poolSize: Number(queryValue(req, 'depth')) || DEFAULT_TRADE_POOL_SIZE,
        limit: Number(queryValue(req, 'limit')) || 4,
        waiverLimit: Number(queryValue(req, 'waivers')) || 8,
        minPartnerGain: 0.5,
      },
    );
  } catch (err) {
    if (err && err.code === 'TEAM_UNRESOLVED') {
      console.error('[AI GM] Could not match the stored SWID to a team in league ' + requestedLeague +
        '. The caller must name a team.', err);
      return res.status(409).json({
        error: 'Could not tell which team in this league is yours from the stored ESPN session. ' +
          'Pick a team and retry.',
        code: 'AI_GM_TEAM_UNRESOLVED',
        teams: err.teams || [],
      });
    }
    console.error('[AI GM] The analysis threw for league ' + requestedLeague + ' season ' + season +
      ' week ' + String(week || '(current)') + '.', err);
    return res.status(500).json({
      error: 'The AI GM analysis could not be completed: ' + String((err && err.message) || err),
      code: 'AI_GM_ANALYSIS_FAILED',
    });
  }

  if (waiverError) {
    analysis.waivers.error = waiverError;
  }
  if (!Object.keys(byeWeeks).length) {
    analysis.waivers.context.byeWeeksUnavailable = true;
  }
  analysis.credentialSource = 'supabase-league-store';

  return res.status(200).json(analysis);
}

/* ============================================================================
   15. EXPORTS

   Every pure function the self-test drives is exported deliberately. A helper
   that is not exported is a helper no test can hold to account.
============================================================================ */

module.exports = {
  /* gate */
  AI_GM_ALLOWED_LEAGUE_IDS: AI_GM_ALLOWED_LEAGUE_IDS,
  isAiGmLeague: isAiGmLeague,
  normalizeLeagueId: normalizeLeagueId,
  /* vocabulary */
  POS_BY_ID: POS_BY_ID,
  SLOT_LABEL: SLOT_LABEL,
  SLOT_ELIGIBILITY: SLOT_ELIGIBILITY,
  SKILL_POSITIONS: SKILL_POSITIONS,
  WAIVER_SLOT_IDS: WAIVER_SLOT_IDS,
  /* parsing */
  projectionFor: projectionFor,
  actualsFor: actualsFor,
  seasonBaselinePerGame: seasonBaselinePerGame,
  draftRankOf: draftRankOf,
  lineupSlotIds: lineupSlotIds,
  benchSlotCapacity: benchSlotCapacity,
  acquisitionRules: acquisitionRules,
  normalize: normalize,
  unwrapLeague: unwrapLeague,
  /* lineup math */
  canFill: canFill,
  optimalLineup: optimalLineup,
  lineupPoints: lineupPoints,
  lineupSolver: lineupSolver,
  /* needs */
  benchmarkProjections: benchmarkProjections,
  positionProfile: positionProfile,
  needsAndSurplus: needsAndSurplus,
  teamRead: teamRead,
  /* buy low / sell high */
  formOf: formOf,
  buyLowCandidates: buyLowCandidates,
  sellHighCandidates: sellHighCandidates,
  /* matchmaking */
  tradeablePool: tradeablePool,
  packagesFrom: packagesFrom,
  applySwap: applySwap,
  findOffers: findOffers,
  findPathways: findPathways,
  pathwayMarket: pathwayMarket,
  pathwayMarketMatch: pathwayMarketMatch,
  pathwayRosterRead: pathwayRosterRead,
  pathwayFit: pathwayFit,
  createTradeValidator: createTradeValidator,
  validateTwoTeamTrade: validateTwoTeamTrade,
  packageMarket: tradeMarket.packageMarket,
  DEFAULT_PATHWAY_POOL_SIZE: DEFAULT_PATHWAY_POOL_SIZE,
  DEFAULT_PATHWAY_CHECK_BUDGET: DEFAULT_PATHWAY_CHECK_BUDGET,
  DEFAULT_PATHWAY_DEADLINE_MS: DEFAULT_PATHWAY_DEADLINE_MS,
  designations: designations,
  packagePositions: packagePositions,
  /* waivers */
  upcomingByeExposure: upcomingByeExposure,
  openRosterSpots: openRosterSpots,
  claimUrgency: claimUrgency,
  suggestFab: suggestFab,
  priorityAdvice: priorityAdvice,
  rankWaiverTargets: rankWaiverTargets,
  /* assembly + transport */
  resolveMyTeam: resolveMyTeam,
  analyze: analyze,
  waiverFilter: waiverFilter,
  freeAgentsFrom: freeAgentsFrom,
  byeWeeksFrom: byeWeeksFrom,
  leagueReadUrl: leagueReadUrl,
  waiverReadUrl: waiverReadUrl,
  proTeamsUrl: proTeamsUrl,
  /* tuning constants, exported so the check can assert the defaults rather
     than restate them */
  DEFAULT_SEARCH_DEADLINE_MS: DEFAULT_SEARCH_DEADLINE_MS,
  DEFAULT_TRADE_POOL_SIZE: DEFAULT_TRADE_POOL_SIZE,
  /* handler */
  handle: handle,
};
