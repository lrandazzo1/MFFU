#!/usr/bin/env node
/* ============================================================================
   FSN — AI GM TRADE ASSISTANT  (private, ESPN league 57155288 by default)

     node scripts/trade-assistant.mjs
     node scripts/trade-assistant.mjs --team="Team Name" --week=4
     node scripts/trade-assistant.mjs --json --out=/tmp/offers.json
     node scripts/trade-assistant.mjs --self-test

   WHY A SCRIPT AND NOT AN ENDPOINT
   --------------------------------
   `api/` is at 12 of the 12 Serverless Functions the deployment plan allows
   (scripts/vercel-functions-check.mjs). A thirteenth file does not fail the
   build — it fails the DEPLOY at patchBuild and takes production down. This
   tool is a private GM aid, not a reader-facing feature, so it lives here and
   costs the deployment nothing. If it ever needs to be served, it goes behind
   an `?action=` rewrite on an existing route, never a new file.

   WHAT IT DOES
   ------------
   1. Reads the league from ESPN (mRoster + mTeam + mSettings), authenticating
      with ESPN_S2 / ESPN_SWID when they are set.
   2. Rebuilds every team's OPTIMAL starting lineup against the league's own
      lineup-slot counts, using each player's ESPN `eligibleSlots` — so a
      2QB/3WR league is graded by its own rules, not a standard template.
   3. Scores positional surplus and deficit as *marginal lineup points*: what
      the next man up at each slot is actually worth, which is the only figure
      a trade can move.
   4. Enumerates 1-for-1, 2-for-1, 1-for-2 and 2-for-2 packages against every
      opposing roster, re-solves BOTH lineups for each package, and keeps only
      those that raise both teams' projected starting scores.
   5. Prints the top offers with team, owner, give/receive, net impact, and a
      ready-to-send DM.

   DETERMINISM
   -----------
   No Math.random(), no Date.now() in any scoring or copy path, no model call.
   The same payload yields byte-identical output, every run — which is what
   makes `--self-test` meaningful and what lets you re-run an offer list after
   a waiver claim and diff the two.
============================================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The sanitizer api/espn.js and api/league.js already share. Cookies pasted
   out of DevTools arrive wrapped in quotes, braces, `name=` prefixes or — the
   quiet killer — a soft line WRAP, and a newline in a header value makes
   fetch() throw before a request leaves the process. Reuse, never re-solve. */
let buildEspnCookieHeader;
try {
  ({ buildEspnCookieHeader } = require('../lib/espn-cookies'));
} catch (err) {
  console.error('[TradeAssistant] could not load lib/espn-cookies; ESPN cookies will be sent raw', err);
  buildEspnCookieHeader = (swid, s2) => ({
    header: [swid ? 'SWID=' + swid : '', s2 ? 'espn_s2=' + s2 : ''].filter(Boolean).join('; '),
    swid: swid || '', espn_s2: s2 || '', count: 0, faults: [], reason: '',
  });
};

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

const BENCH_SLOTS = new Set([20, 21]);          // 20 = bench, 21 = IR
const SKILL_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/* A standard lineup, used only when mSettings does not come back readable. */
const STANDARD_SLOT_IDS = [0, 2, 2, 4, 4, 6, 23, 17, 16];

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/* ============================================================================
   2. ARGUMENTS
============================================================================ */

function parseArgs(argv) {
  const out = {
    league: '57155288',
    season: '2026',
    week: null,
    team: '',
    limit: 3,
    json: false,
    out: '',
    fixture: '',
    dump: '',
    minPartnerGain: 0.5,
    poolSize: 10,
    selfTest: false,
    help: false,
  };
  for (const raw of argv) {
    const arg = String(raw);
    if (arg === '--self-test') { out.selfTest = true; continue; }
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    const m = /^--([a-zA-Z-]+)=(.*)$/.exec(arg);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (key === 'league') out.league = value.trim();
    else if (key === 'season') out.season = value.trim();
    else if (key === 'week') out.week = Number(value);
    else if (key === 'team') out.team = value.trim();
    else if (key === 'limit') out.limit = Math.max(1, Number(value) || 3);
    else if (key === 'out') out.out = value.trim();
    else if (key === 'fixture') out.fixture = value.trim();
    else if (key === 'dump') out.dump = value.trim();
    else if (key === 'min-partner-gain') out.minPartnerGain = Number(value) || 0;
    else if (key === 'pool') out.poolSize = Math.max(3, Math.min(16, Number(value) || 10));
  }
  return out;
}

const USAGE = [
  'FSN AI GM Trade Assistant',
  '',
  '  node scripts/trade-assistant.mjs [options]',
  '',
  '  --league=ID            ESPN league id            (default 57155288)',
  '  --season=YYYY          season                    (default 2026)',
  '  --week=N               scoring period to project (default: league current week)',
  '  --team=ID|NAME|OWNER   which roster is mine      (default: matched from ESPN_SWID)',
  '  --limit=N              how many offers to print  (default 3)',
  '  --pool=N               tradeable players per side considered (3-16, default 10)',
  '  --min-partner-gain=X   minimum pts/week the other team must gain (default 0.5)',
  '  --json                 emit machine-readable JSON instead of the report',
  '  --out=FILE             write the output to FILE as well as stdout',
  '  --fixture=FILE         analyse a saved ESPN payload instead of fetching',
  '  --dump=FILE            save the fetched ESPN payload to FILE',
  '  --self-test            run the offline determinism + lineup-math checks',
  '',
  '  Env: ESPN_S2 / ESPN_SWID are sent as cookies when present. A public league',
  '       reads fine without them; a private one returns 401 without them.',
].join('\n');

/* ============================================================================
   3. FETCH
============================================================================ */

function espnUrl(season, leagueId) {
  return 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' +
    encodeURIComponent(season) + '/segments/0/leagues/' + encodeURIComponent(leagueId) +
    '?view=mRoster&view=mTeam&view=mSettings';
}

async function fetchLeague(season, leagueId) {
  const url = espnUrl(season, leagueId);
  const headers = {
    'User-Agent': BROWSER_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  /* ESPN authenticates on the PAIR. Half a credential is worse than none: it
     pairs one account's SWID with another's espn_s2 and earns a refusal that
     reads exactly like an expired session. So either both or neither. */
  const swidRaw = process.env.ESPN_SWID || process.env.SWID || '';
  const s2Raw = process.env.ESPN_S2 || process.env.espn_s2 || '';
  const pair = buildEspnCookieHeader(swidRaw, s2Raw);
  let mode = 'public';
  if (pair.swid && pair.espn_s2) {
    headers.Cookie = pair.header;
    mode = 'private';
  } else if (swidRaw || s2Raw) {
    console.warn('[TradeAssistant] ESPN credentials are incomplete (' +
      (pair.reason || 'only one of ESPN_SWID / ESPN_S2 is set') +
      '); reading the league anonymously. A private league will answer 401.');
  }

  let response;
  try {
    response = await fetch(url, { headers, redirect: 'follow' });
  } catch (err) {
    console.error('[TradeAssistant] ESPN request failed for league ' + leagueId +
      ' season ' + season + ' (' + mode + ' read)', err);
    throw new Error('ESPN is unreachable from this machine.');
  }

  const body = await response.text();
  if (!response.ok) {
    console.error('[TradeAssistant] ESPN answered HTTP ' + response.status + ' for league ' +
      leagueId + ' season ' + season + ' (' + mode + ' read). Body head: ' + body.slice(0, 300));
    if (response.status === 401) {
      throw new Error('ESPN refused the read (401). This league is private — set ESPN_S2 and ' +
        'ESPN_SWID from a browser logged into an account that is in the league.');
    }
    throw new Error('ESPN answered HTTP ' + response.status + '.');
  }

  try {
    return JSON.parse(body);
  } catch (err) {
    console.error('[TradeAssistant] ESPN returned a non-JSON body for league ' + leagueId +
      ' (HTTP ' + response.status + '). Head: ' + body.slice(0, 300), err);
    throw new Error('ESPN returned something that is not JSON.');
  }
}

/* ESPN has served both a bare league object and a single-element array over
   the years, and the leagueHistory route always serves the array. */
function unwrapLeague(payload) {
  if (Array.isArray(payload)) return payload[0] || null;
  return payload || null;
}

/* ============================================================================
   4. NORMALISE
============================================================================ */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* Projected points for one roster entry in one week.

   statSourceId 1 is the forecast (0 is actuals); statSplitTypeId 1 marks a
   single scoring period rather than a season aggregate. The week match is
   exact, because a player card carries every week of the season and a loose
   match lets week 3 answer a week 11 question — a stale number that looks live
   is worse than no number.

   Fallback chain, most specific first:
     1. this week's forecast
     2. the season forecast, spread over a 17-game season
     3. this player's actual per-game average so far
     4. null, which the caller reads as "no forecast" and scores as 0 */
function projectionFor(entry, week) {
  const player = (entry && entry.playerPoolEntry && entry.playerPoolEntry.player) ||
    (entry && entry.player) || null;
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

function playerName(player) {
  if (!player) return 'Unknown player';
  if (player.fullName) return String(player.fullName);
  const parts = [player.firstName, player.lastName].filter(Boolean);
  return parts.length ? parts.join(' ') : 'Unknown player';
}

function teamDisplayName(team) {
  if (!team) return 'Unknown team';
  if (team.name && String(team.name).trim()) return String(team.name).trim();
  const parts = [team.location, team.nickname].filter(Boolean).map((s) => String(s).trim());
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

/* Build the league's real starting requirements from its own slot counts. */
function lineupSlotIds(league) {
  const counts = league && league.settings && league.settings.rosterSettings &&
    league.settings.rosterSettings.lineupSlotCounts;
  if (!counts || typeof counts !== 'object') {
    console.warn('[TradeAssistant] mSettings carried no readable lineupSlotCounts; ' +
      'grading against the standard 1QB/2RB/2WR/1TE/1FLEX/1K/1DST template instead.');
    return STANDARD_SLOT_IDS.slice();
  }
  const ids = [];
  let unknown = [];
  for (const key of Object.keys(counts).sort((a, b) => Number(a) - Number(b))) {
    const slotId = Number(key);
    const count = Number(counts[key]) || 0;
    if (!count || BENCH_SLOTS.has(slotId)) continue;
    if (!SLOT_ELIGIBILITY[slotId]) { unknown.push(slotId); continue; }
    for (let i = 0; i < count; i++) ids.push(slotId);
  }
  if (unknown.length) {
    console.warn('[TradeAssistant] ignoring ' + unknown.length + ' starting slot(s) this tool ' +
      'does not model (ESPN slot ids ' + unknown.join(', ') + ' — IDP or special). Lineup scores ' +
      'cover the offensive slots only, which is where trades move.');
  }
  if (!ids.length) {
    console.warn('[TradeAssistant] lineupSlotCounts produced no startable slots; ' +
      'falling back to the standard template.');
    return STANDARD_SLOT_IDS.slice();
  }
  return ids;
}

function normalize(payload, options) {
  const league = unwrapLeague(payload);
  if (!league) throw new Error('The ESPN payload carried no league object.');

  const week = options.week != null && Number.isFinite(options.week) && options.week > 0
    ? Number(options.week)
    : (num(league.scoringPeriodId) || num(league.status && league.status.latestScoringPeriod) || 1);

  const slotIds = lineupSlotIds(league);

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
      const player = (entry.playerPoolEntry && entry.playerPoolEntry.player) || entry.player || null;
      if (!player) continue;
      const slotId = num(entry.lineupSlotId);
      const eligible = Array.isArray(player.eligibleSlots) && player.eligibleSlots.length
        ? player.eligibleSlots.map(Number).filter((n) => Number.isFinite(n))
        : null;
      const pos = POS_BY_ID[player.defaultPositionId] || '';
      players.push({
        id: String(player.id != null ? player.id : playerName(player)),
        name: playerName(player),
        pos: pos,
        proTeam: PRO_TEAM_BY_ID[player.proTeamId] || '',
        injury: String(player.injuryStatus || (player.injured ? 'QUESTIONABLE' : 'ACTIVE')).toUpperCase(),
        eligibleSlots: eligible,
        slotId: slotId,
        benched: slotId != null ? BENCH_SLOTS.has(slotId) : false,
        projection: projectionFor(entry, week) || 0,
      });
    }

    const ownerIds = []
      .concat(team.primaryOwner ? [team.primaryOwner] : [])
      .concat(Array.isArray(team.owners) ? team.owners : []);
    const ownerNames = [];
    for (const ownerId of ownerIds) {
      const name = memberName(membersById.get(String(ownerId)));
      if (name && !ownerNames.includes(name)) ownerNames.push(name);
    }

    teams.push({
      id: String(team.id),
      name: teamDisplayName(team),
      abbrev: team.abbrev ? String(team.abbrev) : '',
      ownerIds: ownerIds.map(String),
      owner: ownerNames.join(' & ') || 'Unknown owner',
      record: team.record && team.record.overall
        ? (team.record.overall.wins || 0) + '-' + (team.record.overall.losses || 0) +
          ((team.record.overall.ties) ? '-' + team.record.overall.ties : '')
        : '',
      players: players,
    });
  }

  if (teams.length < 2) throw new Error('The league payload carried ' + teams.length + ' team(s).');

  return {
    leagueId: String(league.id != null ? league.id : ''),
    leagueName: String((league.settings && league.settings.name) || 'League'),
    season: Number(league.seasonId) || Number(options.season) || null,
    week: week,
    slotIds: slotIds,
    teams: teams,
    /* What a median starter is worth at each position IN THIS LEAGUE. Computed
       once, off these rosters, and read by every need calculation below. */
    benchmarks: benchmarkProjections(teams, slotIds),
  };
}

/* ============================================================================
   5. OPTIMAL LINEUP

   Assigning players to lineup slots is a transversal matroid: a set of players
   is "startable together" exactly when it has a perfect matching into the
   slots. The greedy algorithm on a matroid — walk the players in descending
   projection and keep each one whose addition leaves the set still matchable —
   returns the maximum-weight basis, which is the true optimal lineup.

   The alternative, filling the most-constrained slot first, is only optimal
   when the eligibility sets nest. They do not: RB/WR (slot 3) and WR/TE (slot
   5) overlap without either containing the other, and a league that runs both
   would be mis-scored. Kuhn's augmenting path costs nothing at this size, so
   this takes the exact answer instead of the usually-right one.
============================================================================ */

function canFill(player, slotId) {
  if (player.eligibleSlots) return player.eligibleSlots.includes(slotId);
  const eligible = SLOT_ELIGIBILITY[slotId];
  return !!(eligible && player.pos && eligible.includes(player.pos));
}

function optimalLineup(players, slotIds) {
  /* Descending projection, then player id — never insertion order, so two runs
     over the same roster cannot disagree about a tie. */
  const pool = players.slice().sort((a, b) => {
    if (b.projection !== a.projection) return b.projection - a.projection;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const slotOwner = new Array(slotIds.length).fill(-1);   // slot index -> pool index
  const seated = [];

  const augment = (poolIndex, visited) => {
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

/* ============================================================================
   6. NEEDS AND SURPLUS

   A position's need is not "how many do I have" and it is not "how much would
   I lose if this starter vanished" — that second one reads a lineup backwards.
   The weakest RB2 in the league has a tiny vanish-cost precisely BECAUSE he is
   replacement level, while an elite QB with no backup has a huge one, so that
   measure ranks a strength as the deficit. It was the first thing this tool
   got wrong and the self-test caught it.

   What a trade can actually move is UPGRADE HEADROOM: plug a median starter at
   this position into the roster, re-solve the optimal lineup, and keep the
   gain. A position already above the league's middle gains nothing and is not
   a need, however thin it looks. A position below it gains exactly the points
   an acquisition would be worth.

     needValue     pts the lineup gains from a median league starter at this pos
     spareValue    pts lost if this position's best BENCH player disappeared —
                   0.0 means he is neither starting nor one injury from it,
                   which is precisely what you trade away
============================================================================ */

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* What a middle-of-the-league starter is worth at each position, measured off
   the league's own rosters rather than a table that goes stale in a week.
   Dedicated slots only — a WR sitting in FLEX says nothing about WR2 quality. */
function benchmarkProjections(teams, slotIds) {
  const dedicated = {};
  const rostered = {};
  for (const pos of SKILL_POSITIONS) { dedicated[pos] = []; rostered[pos] = []; }

  for (const team of teams) {
    for (const player of team.players) {
      if (SKILL_POSITIONS.includes(player.pos)) rostered[player.pos].push(player.projection);
    }
    for (const row of optimalLineup(team.players, slotIds).lineup) {
      if (!row.player) continue;
      const label = SLOT_LABEL[row.slotId];
      if (SKILL_POSITIONS.includes(label) && row.player.pos === label) {
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

function positionProfile(team, slotIds, benchmarks) {
  const base = optimalLineup(team.players, slotIds);
  const starters = new Set();
  for (const row of base.lineup) if (row.player) starters.add(row.player.id);

  const profile = {};
  for (const pos of SKILL_POSITIONS) {
    const atPos = team.players.filter((p) => p.pos === pos);
    const startingHere = base.lineup.filter((r) => r.player && r.player.pos === pos);
    const benchHere = atPos
      .filter((p) => !starters.has(p.id))
      .sort((a, b) => b.projection - a.projection || (a.id < b.id ? -1 : 1));

    const starterValue = startingHere.reduce((sum, r) => sum + r.player.projection, 0);

    /* Upgrade headroom. The phantom carries no eligibleSlots, so canFill falls
       back to the position table — a median RB is eligible exactly where an RB
       is, FLEX included. */
    const benchmark = (benchmarks && benchmarks[pos]) || 0;
    const phantom = {
      id: '__median_' + pos + '__', name: 'median ' + pos, pos: pos,
      proTeam: '', injury: 'ACTIVE', eligibleSlots: null, benched: false,
      projection: benchmark,
    };
    const needValue = lineupPoints(team.players.concat([phantom]), slotIds) - base.points;

    /* Remove the best non-starter at this position. If the lineup does not
       move, he is genuinely spare. */
    let spareValue = 0;
    if (benchHere.length) {
      spareValue = base.points - lineupPoints(
        team.players.filter((p) => p.id !== benchHere[0].id), slotIds,
      );
    }

    profile[pos] = {
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

/* Everything the copy and the report need about one roster, in one object.
   The starters set travels with it because a pitch has to know not merely that
   a position is deep but that the specific player it is offering is not in the
   lineup. */
function teamRead(team, slotIds, benchmarks) {
  const profile = positionProfile(team, slotIds, benchmarks);
  const ranked = needsAndSurplus(profile.profile);
  return {
    base: profile.base,
    starters: profile.starters,
    profile: profile.profile,
    needs: ranked.needs,
    surplus: ranked.surplus,
  };
}

/* The headline need/surplus read for a team, ranked. */
function needsAndSurplus(profile) {
  const rows = SKILL_POSITIONS.map((pos) => ({ pos: pos, ...profile[pos] }));
  const needs = rows
    .slice()
    .sort((a, b) => b.needValue - a.needValue || (a.pos < b.pos ? -1 : 1));
  const surplus = rows
    .filter((r) => r.benchDepth > 0)
    .sort((a, b) => a.spareValue - b.spareValue ||
      (b.topBench ? b.topBench.projection : 0) - (a.topBench ? a.topBench.projection : 0) ||
      (a.pos < b.pos ? -1 : 1));
  return { needs: needs, surplus: surplus };
}

/* ============================================================================
   7. MATCHMAKING

   For every opponent, every package of 1 or 2 players from each side is
   applied to BOTH rosters and both optimal lineups are re-solved. A package
   survives only if it raises both. That is the whole test — no heuristic
   "value" table, no trade-value chart that goes stale in a week. The lineup
   either scores more on Sunday or it does not.
============================================================================ */

/* Kickers and defenses are not traded in practice and would dominate the
   combinatorics with noise, so the packages are drawn from the skill
   positions only, capped at the best `poolSize` per team. */
function tradeablePool(team, poolSize) {
  return team.players
    .filter((p) => SKILL_POSITIONS.includes(p.pos))
    .sort((a, b) => b.projection - a.projection || (a.id < b.id ? -1 : 1))
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
  const drop = new Set(outgoing.map((p) => p.id));
  return players.filter((p) => !drop.has(p.id)).concat(incoming);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function findOffers(state, me, options) {
  const slotIds = state.slotIds;
  const myBase = lineupPoints(me.players, slotIds);
  const myPool = tradeablePool(me, options.poolSize);
  const myPackages = packagesFrom(myPool);
  const offers = [];

  for (const them of state.teams) {
    if (them.id === me.id) continue;
    const theirBase = lineupPoints(them.players, slotIds);
    const theirPackages = packagesFrom(tradeablePool(them, options.poolSize));

    for (const give of myPackages) {
      for (const receive of theirPackages) {
        const myAfter = lineupPoints(applySwap(me.players, give, receive), slotIds);
        const myGain = myAfter - myBase;
        if (myGain <= 0.05) continue;

        const theirAfter = lineupPoints(applySwap(them.players, receive, give), slotIds);
        const theirGain = theirAfter - theirBase;
        if (theirGain < options.minPartnerGain) continue;

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
        });
      }
    }
  }

  /* Rank by my gain first — this is my GM chair — then by how obviously good
     the deal looks to them, then by the smaller package, which is the easier
     sell. Every tiebreak is deterministic down to the player ids. */
  const byValue = (a, b) =>
    b.myGain - a.myGain ||
    b.theirGain - a.theirGain ||
    (a.give.length + a.receive.length) - (b.give.length + b.receive.length) ||
    (a.team.id < b.team.id ? -1 : a.team.id > b.team.id ? 1 : 0) ||
    (offerKey(a) < offerKey(b) ? -1 : 1);
  offers.sort(byValue);

  /* One offer per partner: three variations of the same deal with the same
     manager is not three options, it is one conversation. */
  const seenTeams = new Set();
  const top = [];
  for (const offer of offers) {
    if (seenTeams.has(offer.team.id)) continue;
    seenTeams.add(offer.team.id);
    top.push(offer);
    if (top.length >= options.limit) break;
  }

  /* If the league is small enough that fewer partners exist than offers asked
     for, fill the rest with the next-best deals regardless of partner. */
  if (top.length < options.limit) {
    for (const offer of offers) {
      if (top.includes(offer)) continue;
      top.push(offer);
      if (top.length >= options.limit) break;
    }
  }

  /* The fill pass walks the full list again, so it can append a second deal
     with an early partner that outranks a later partner's best. Re-sort so the
     printed list is honestly ordered — an "OFFER 3" that beats "OFFER 2" reads
     as a bug to whoever is deciding which DM to send first. */
  top.sort(byValue);

  return { myBase: myBase, offers: top, considered: offers.length };
}

function offerKey(offer) {
  return offer.give.map((p) => p.id).join(',') + '|' + offer.receive.map((p) => p.id).join(',');
}

/* ============================================================================
   8. THE PITCH

   Deterministic copy: the same offer produces the same DM every time. The
   pitch leads with what THEY get, because a manager reads the first line and
   decides whether to read the second.
============================================================================ */

function playerLabel(p) {
  const tag = [p.pos, p.proTeam].filter(Boolean).join(' ');
  return p.name + (tag ? ' (' + tag + ')' : '');
}

function listNames(players) {
  const names = players.map((p) => p.name);
  if (names.length <= 1) return names[0] || '';
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/* Which position the other team is actually solving by taking this package. */
function packagePositions(players) {
  const seen = [];
  for (const p of players) if (p.pos && !seen.includes(p.pos)) seen.push(p.pos);
  return seen;
}

/* Positions in a package that the receiving team's profile actually calls a
   need. Returns [] when the package does not solve a named hole — and the copy
   then says "depth" instead of inventing a fit. A pitch that claims to fix a
   position the manager knows is his strength is a pitch he stops reading. */
function solvedNeeds(players, profileRead) {
  const top = profileRead.needs.filter((n) => n.needValue > 0.05).slice(0, 2).map((n) => n.pos);
  const hit = [];
  for (const p of players) if (top.includes(p.pos) && !hit.includes(p.pos)) hit.push(p.pos);
  return hit;
}

/* Which of these players I can honestly call surplus. Three conditions, and
   the first two were both learned from the self-test:

     1. the position is not one of my own holes — a bench body at a position I
        need is not spare however worthless he is, and calling it spare while
        asking for that same position back is the contradiction that made the
        first draft of this pitch unsendable;
     2. the player is not in my starting lineup — a position can be deep while
        the specific piece I am offering is the one starting there;
     3. the lineup does not miss the best bench body there at all.

   Returns the PLAYERS, not the positions, so the copy names exactly who it
   means. */
function honestSurplus(players, read) {
  const holes = read.needs.filter((n) => n.needValue > 0.05).map((n) => n.pos);
  const deep = read.surplus
    .filter((r) => r.spareValue < 0.5 && !holes.includes(r.pos))
    .map((r) => r.pos);
  return players.filter((p) => deep.includes(p.pos) && !read.starters.has(p.id));
}

function headline(players) {
  return players.slice().sort((a, b) => b.projection - a.projection ||
    (a.id < b.id ? -1 : 1))[0];
}

function buildPitch(offer, me, myRead, theirRead) {
  const giving = listNames(offer.give);
  const getting = listNames(offer.receive);
  const theirFit = solvedNeeds(offer.give, theirRead);
  const spareSide = honestSurplus(offer.give, myRead);
  const sparePositions = packagePositions(spareSide);
  const myFit = solvedNeeds(offer.receive, myRead);
  const theirPiece = headline(offer.give);
  const myPiece = headline(offer.receive);

  /* Every clause below is guarded: if the fact is not there, the sentence
     changes rather than asserting it anyway. That is why the same offer can
     never produce a pitch that calls a position both my surplus and my hole. */
  const forThem = theirFit.length
    ? theirPiece.name + ' is the piece — ' + theirFit.join('/') + ' is where my read has ' +
      'your starting lineup thinnest right now, and he steps straight into it.'
    : theirPiece.name + ' is the piece — not a positional rescue, just a straight upgrade ' +
      'on what you are currently starting there.';

  /* Only the players who really are surplus get called surplus. Saying a
     starter "sits behind starters I am not benching" is the kind of line a
     manager checks against the roster page and stops trusting the rest for. */
  const costSide = offer.give.filter((p) => !spareSide.includes(p));
  const forMeParts = [];
  if (spareSide.length) {
    forMeParts.push('On my end I am genuinely long at ' + sparePositions.join('/') + ' — ' +
      listNames(spareSide) + (spareSide.length > 1 ? ' sit' : ' sits') +
      ' behind starters I am not benching, so those points are doing nothing for me.');
  }
  if (costSide.length) {
    forMeParts.push((spareSide.length ? '' : 'On my end ') + listNames(costSide) +
      (costSide.length > 1 ? ' are' : ' is') + ' a real piece to move and I know it — ' +
      'the shape of my roster just makes ' + (costSide.length > 1 ? 'them' : 'him') +
      ' worth more to you than to me.');
  }
  const forMe = forMeParts.join(' ');

  const myUse = myFit.length
    ? getting + ' fills my ' + myFit.join('/') + ' spot, which is the one hole I have not solved.'
    : getting + ' slots into my lineup ahead of what is in there now.';

  const lines = [
    'Hey — quick trade idea, and I think it is a real two-way one.',
    '',
    'You get: ' + offer.give.map(playerLabel).join(' + '),
    'I get:   ' + offer.receive.map(playerLabel).join(' + '),
    '',
    'For you: ' + forThem,
    '',
    'For me: ' + forMe + ' ' + myUse,
    '',
    'Running both rosters through my weekly lineup projections it comes out around +' +
      round1(offer.theirGain).toFixed(1) + ' pts a week for you and +' +
      round1(offer.myGain).toFixed(1) + ' for me. I am not trying to fleece anybody here — ' +
      'if the shape is right but the pieces are off, tell me who you would rather move ' +
      'and I will re-run it.',
    '',
    '— ' + me.name,
  ];
  return lines.join('\n');
}

/* Anything in a package that is not simply ACTIVE. ESPN's own weekly forecast
   already discounts a player who will not play, so these are NOT re-penalised
   here — but a designation is the first thing the other manager will check,
   and an offer that does not mention it reads as an attempt to sneak it past. */
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
   9. WHO AM I
============================================================================ */

function resolveMyTeam(state, requested) {
  const needle = String(requested || '').trim().toLowerCase();

  if (needle) {
    const byId = state.teams.find((t) => t.id === needle);
    if (byId) return byId;
    const byName = state.teams.find((t) => t.name.toLowerCase() === needle);
    if (byName) return byName;
    const byAbbrev = state.teams.find((t) => t.abbrev && t.abbrev.toLowerCase() === needle);
    if (byAbbrev) return byAbbrev;
    const loose = state.teams.filter((t) =>
      t.name.toLowerCase().includes(needle) || t.owner.toLowerCase().includes(needle));
    if (loose.length === 1) return loose[0];
    if (loose.length > 1) {
      throw new Error('--team="' + requested + '" matches ' + loose.length + ' teams (' +
        loose.map((t) => t.name).join(', ') + '). Use the team id.');
    }
    throw new Error('--team="' + requested + '" matched no team. Teams in this league: ' +
      state.teams.map((t) => t.id + ' = ' + t.name).join(', '));
  }

  /* No flag: the SWID in the environment IS an ESPN member id, and every team
     carries its owners' member ids. That is an exact match, not a guess. */
  const swid = String(process.env.ESPN_SWID || process.env.SWID || '').trim();
  if (swid) {
    const normalized = swid.replace(/^%7B/i, '{').replace(/%7D$/i, '}').replace(/^"|"$/g, '');
    const bare = normalized.replace(/[{}]/g, '').toLowerCase();
    const mine = state.teams.find((t) =>
      t.ownerIds.some((id) => id.replace(/[{}]/g, '').toLowerCase() === bare));
    if (mine) return mine;
    console.warn('[TradeAssistant] ESPN_SWID is set but matches no team owner in league ' +
      state.leagueId + '. Pass --team explicitly.');
  }

  throw new Error('Could not tell which team is yours. Pass --team=<id|name|owner>. Teams: ' +
    state.teams.map((t) => t.id + ' = ' + t.name + ' (' + t.owner + ')').join(', '));
}

/* ============================================================================
   10. REPORT
============================================================================ */

function pad(value, width) {
  const s = String(value);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function renderReport(state, me, myProfile, result) {
  const out = [];
  const hr = '='.repeat(74);
  out.push(hr);
  out.push('AI GM TRADE ASSISTANT  —  ' + state.leagueName + '  (ESPN ' + state.leagueId + ')');
  out.push('Season ' + state.season + ', week ' + state.week + '   |   ' +
    state.teams.length + ' teams   |   lineup: ' +
    state.slotIds.map((id) => SLOT_LABEL[id] || id).join(' / '));
  out.push(hr);
  out.push('');
  out.push('YOUR TEAM: ' + me.name + (me.record ? '  (' + me.record + ')' : '') + '  —  ' + me.owner);
  out.push('Projected optimal starting lineup: ' + round1(result.myBase).toFixed(1) + ' pts');
  out.push('');

  out.push('  Optimal lineup as it stands');
  for (const row of myProfile.base.lineup) {
    const p = row.player;
    out.push('    ' + pad(row.slot, 9) +
      (p ? pad(p.name, 24) + pad(p.proTeam, 5) + round1(p.projection).toFixed(1).padStart(6) +
        (p.injury && p.injury !== 'ACTIVE' ? '  ' + p.injury : '')
        : '(empty — no eligible player rostered)'));
  }
  out.push('');

  const read = { ...needsAndSurplus(myProfile.profile), starters: myProfile.starters };
  const { needs, surplus } = read;
  out.push('  Positional read  (NEED = pts this lineup gains by adding a MEDIAN league starter');
  out.push('                    at that position; 0.0 means the spot is already above the middle.');
  out.push('                    SPARE = pts lost if the best bench player there vanished; 0.0');
  out.push('                    means he is neither starting nor one injury from it.)');
  out.push('');
  out.push('    ' + pad('POS', 6) + pad('ROSTERED', 10) + pad('STARTING', 10) +
    pad('STARTER PTS', 13) + pad('LG MEDIAN', 11) + pad('NEED', 8) + 'BEST BENCH / SPARE');
  for (const pos of SKILL_POSITIONS) {
    const row = myProfile.profile[pos];
    const bench = row.topBench
      ? row.topBench.name + ' ' + round1(row.topBench.projection).toFixed(1) +
        '  (spare ' + round1(row.spareValue).toFixed(1) + ')'
      : '—';
    out.push('    ' + pad(pos, 6) + pad(row.rostered, 10) + pad(row.starting, 10) +
      pad(round1(row.starterValue).toFixed(1), 13) + pad(round1(row.benchmark).toFixed(1), 11) +
      pad('+' + round1(row.needValue).toFixed(1), 8) + bench);
  }
  out.push('');
  if (needs.length && needs[0].needValue > 0) {
    out.push('  Biggest deficit : ' + needs[0].pos + '  (a median league ' + needs[0].pos +
      ' would add ' + round1(needs[0].needValue).toFixed(1) + ' pts/week to this lineup)');
  } else {
    out.push('  Biggest deficit : none — every starting spot is at or above the league median.');
  }
  if (surplus.length && surplus[0].topBench) {
    out.push('  Clearest surplus: ' + surplus[0].pos + '  (' + surplus[0].topBench.name +
      ' is worth ' + round1(surplus[0].topBench.projection).toFixed(1) +
      ' and contributes ' + round1(surplus[0].spareValue).toFixed(1) + ' to the lineup)');
  }
  out.push('');
  out.push(hr);
  out.push('TOP ' + result.offers.length + ' OFFERS   (' + result.considered +
    ' two-way-positive packages found across ' + (state.teams.length - 1) + ' rosters)');
  out.push(hr);

  if (!result.offers.length) {
    out.push('');
    out.push('  No package of two-or-fewer players raises both lineups right now.');
    out.push('  That usually means one of three things:');
    out.push('    - your roster is already optimally shaped for this lineup');
    out.push('    - the projections are flat (pre-season, or ESPN has not posted week ' +
      state.week + ')');
    out.push('    - the league is shallow enough that every bench is replacement level');
    out.push('  Try --week=<a week ESPN has projected>, or --min-partner-gain=0 to see the');
    out.push('  deals that help you and leave them flat.');
    out.push('');
    return out.join('\n');
  }

  result.offers.forEach((offer, index) => {
    const theirRead = teamRead(offer.team, state.slotIds, state.benchmarks);
    out.push('');
    out.push('-'.repeat(74));
    out.push('OFFER ' + (index + 1) + '   [' + offer.shape + ']');
    out.push('-'.repeat(74));
    out.push('  Target team  : ' + offer.team.name + (offer.team.record ? '  (' + offer.team.record + ')' : ''));
    out.push('  ESPN owner   : ' + offer.team.owner);
    out.push('');
    out.push('  YOU GIVE     : ' + offer.give.map(playerLabel).join('  +  '));
    out.push('  YOU RECEIVE  : ' + offer.receive.map(playerLabel).join('  +  '));
    out.push('');
    out.push('  Your lineup  : ' + round1(offer.myBefore).toFixed(1) + '  ->  ' +
      round1(offer.myAfter).toFixed(1) + '   (+' + round1(offer.myGain).toFixed(1) + ' pts/week)');
    out.push('  Their lineup : ' + round1(offer.theirBefore).toFixed(1) + '  ->  ' +
      round1(offer.theirAfter).toFixed(1) + '   (+' + round1(offer.theirGain).toFixed(1) + ' pts/week)');
    const theirTopNeed = theirRead.needs.filter((n) => n.needValue > 0.05)[0];
    out.push('  Their read   : biggest deficit ' +
      (theirTopNeed ? theirTopNeed.pos + ' (+' + round1(theirTopNeed.needValue).toFixed(1) + ')' : 'none'
      ) + ', clearest surplus ' +
      (theirRead.surplus.length ? theirRead.surplus[0].pos : 'none'));

    const flags = designations(offer);
    if (flags.length) {
      out.push('  Designations : ' + flags.join('; ') +
        '   (ESPN\'s week ' + state.week + ' forecast already discounts these)');
    }
    out.push('');
    out.push('  ---- ready to send ------------------------------------------------');
    for (const line of buildPitch(offer, me, read, theirRead).split('\n')) out.push('  ' + line);
    out.push('  -------------------------------------------------------------------');
  });

  out.push('');
  out.push(hr);
  out.push('Projections are ESPN\'s own weekly forecasts for week ' + state.week +
    '. Every figure above is the change in each team\'s OPTIMAL starting lineup,');
  out.push('so it assumes both managers set their best lineup. Nothing here is sent anywhere —');
  out.push('copy a pitch into ESPN chat or a DM yourself.');
  out.push(hr);

  return out.join('\n');
}

function renderJson(state, me, myProfile, result) {
  const myRead = { ...needsAndSurplus(myProfile.profile), starters: myProfile.starters };
  const { needs, surplus } = myRead;
  return JSON.stringify({
    league: { id: state.leagueId, name: state.leagueName, season: state.season, week: state.week },
    lineupSlots: state.slotIds.map((id) => SLOT_LABEL[id] || String(id)),
    myTeam: {
      id: me.id, name: me.name, owner: me.owner, record: me.record,
      projectedLineup: round1(result.myBase),
      lineup: myProfile.base.lineup.map((row) => ({
        slot: row.slot,
        player: row.player ? {
          id: row.player.id, name: row.player.name, pos: row.player.pos,
          proTeam: row.player.proTeam, projection: round1(row.player.projection),
          injury: row.player.injury,
        } : null,
      })),
      positions: SKILL_POSITIONS.map((pos) => ({
        pos: pos,
        rostered: myProfile.profile[pos].rostered,
        starting: myProfile.profile[pos].starting,
        starterPoints: round1(myProfile.profile[pos].starterValue),
        leagueMedian: round1(myProfile.profile[pos].benchmark),
        needValue: round1(myProfile.profile[pos].needValue),
        spareValue: round1(myProfile.profile[pos].spareValue),
        topBench: myProfile.profile[pos].topBench ? myProfile.profile[pos].topBench.name : null,
      })),
      biggestDeficit: (needs.length && needs[0].needValue > 0) ? needs[0].pos : null,
      clearestSurplus: surplus.length ? surplus[0].pos : null,
    },
    packagesConsidered: result.considered,
    offers: result.offers.map((offer) => {
      const theirRead = teamRead(offer.team, state.slotIds, state.benchmarks);
      return {
        shape: offer.shape,
        targetTeam: { id: offer.team.id, name: offer.team.name, owner: offer.team.owner, record: offer.team.record },
        give: offer.give.map((p) => ({ id: p.id, name: p.name, pos: p.pos, proTeam: p.proTeam, projection: round1(p.projection) })),
        receive: offer.receive.map((p) => ({ id: p.id, name: p.name, pos: p.pos, proTeam: p.proTeam, projection: round1(p.projection) })),
        myLineup: { before: round1(offer.myBefore), after: round1(offer.myAfter), gain: round1(offer.myGain) },
        theirLineup: { before: round1(offer.theirBefore), after: round1(offer.theirAfter), gain: round1(offer.theirGain) },
        designations: designations(offer),
        pitch: buildPitch(offer, me, myRead, theirRead),
      };
    }),
  }, null, 2);
}

/* ============================================================================
   11. SELF-TEST  —  offline, no network, deterministic

   `node scripts/trade-assistant.mjs --self-test`
============================================================================ */

function fixture() {
  const stat = (week, points) => ({ statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: week, appliedTotal: points });
  let nextId = 1000;
  const mk = (name, posId, slots, points, lineupSlotId) => ({
    lineupSlotId: lineupSlotId,
    playerPoolEntry: {
      player: {
        id: nextId++, fullName: name, defaultPositionId: posId,
        proTeamId: 12, eligibleSlots: slots, injuryStatus: 'ACTIVE',
        stats: [stat(1, points)],
      },
    },
  });
  const QB = (n, p, s) => mk(n, 1, [0, 7, 20], p, s);
  const RB = (n, p, s) => mk(n, 2, [2, 3, 7, 23, 20], p, s);
  const WR = (n, p, s) => mk(n, 3, [3, 4, 5, 7, 23, 20], p, s);
  const TE = (n, p, s) => mk(n, 4, [5, 6, 7, 23, 20], p, s);

  return {
    id: 999001,
    seasonId: 2026,
    scoringPeriodId: 1,
    settings: { name: 'Self Test League', rosterSettings: { lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 20: 6 } } },
    members: [
      { id: '{AAAA}', displayName: 'me_handle', firstName: 'Lee', lastName: 'Rand' },
      { id: '{BBBB}', displayName: 'rbrich', firstName: 'Pat', lastName: 'Bench' },
      { id: '{CCCC}', displayName: 'flat', firstName: 'Sam', lastName: 'Even' },
    ],
    teams: [
      {
        /* WR-rich, RB-poor: three startable WRs for two WR slots, and an RB2
           so weak the FLEX is already a third WR. */
        id: 1, name: 'My Squad', abbrev: 'MINE', primaryOwner: '{AAAA}', owners: ['{AAAA}'],
        record: { overall: { wins: 1, losses: 0, ties: 0 } },
        roster: { entries: [
          QB('Ace Arm', 20, 0),
          RB('Bell Cow', 16, 2),
          RB('Scrub Back', 3, 2),
          WR('Alpha Wide', 18, 4),
          WR('Beta Wide', 16, 4),
          WR('Gamma Wide', 14, 23),
          TE('Tight One', 9, 6),
          WR('Delta Wide', 12, 20),
          RB('Deep Cut', 2, 20),
        ] },
      },
      {
        /* The mirror image: RB depth on the bench, a WR2 that is a hole. */
        id: 2, name: 'Ground Game', abbrev: 'GRND', primaryOwner: '{BBBB}', owners: ['{BBBB}'],
        record: { overall: { wins: 0, losses: 1, ties: 0 } },
        roster: { entries: [
          QB('Second Arm', 18, 0),
          RB('Thunder', 17, 2),
          RB('Lightning', 15, 2),
          RB('Third Down', 13, 23),
          RB('Handcuff', 11, 20),
          WR('Lone Wide', 15, 4),
          WR('Weak Wide', 4, 4),
          TE('Tight Two', 8, 6),
        ] },
      },
      {
        /* Flat roster, nothing spare — must not generate an offer. */
        id: 3, name: 'Replacement Level', abbrev: 'REPL', primaryOwner: '{CCCC}', owners: ['{CCCC}'],
        record: { overall: { wins: 0, losses: 1, ties: 0 } },
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
    ],
  };
}

function selfTest() {
  let failures = 0;
  const ok = (label) => console.log('  ok    ' + label);
  const bad = (label, detail) => { failures++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); };
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  console.log('[trade-assistant] self-test\n');

  /* --- lineup math ------------------------------------------------------- */
  const slots = [0, 2, 2, 4, 4, 6, 23];
  const P = (id, pos, projection, eligibleSlots) => ({ id: id, name: id, pos: pos, proTeam: 'KC', injury: 'ACTIVE', eligibleSlots: eligibleSlots, projection: projection, benched: false });

  const simple = optimalLineup([
    P('q', 'QB', 20, [0]), P('r1', 'RB', 16, [2, 23]), P('r2', 'RB', 3, [2, 23]),
    P('w1', 'WR', 18, [4, 23]), P('w2', 'WR', 16, [4, 23]), P('w3', 'WR', 14, [4, 23]),
    P('t', 'TE', 9, [6, 23]),
  ], slots);
  if (near(simple.points, 20 + 16 + 3 + 18 + 16 + 9 + 14)) ok('optimal lineup seats the third WR in FLEX (96.0)');
  else bad('optimal lineup', 'got ' + simple.points + ', expected 96');

  /* The case most-constrained-first gets wrong: RB/WR (3) and WR/TE (5) overlap
     without nesting. The exact matching must find the 30-point assignment. */
  const crossed = optimalLineup(
    [P('wr', 'WR', 20, [3, 4, 5]), P('te', 'TE', 10, [5, 6])],
    [3, 5],
  );
  if (near(crossed.points, 30)) ok('non-nested slots (RB/WR + WR/TE) are matched exactly');
  else bad('non-nested slot matching', 'got ' + crossed.points + ', expected 30');

  const empty = optimalLineup([P('q', 'QB', 20, [0])], [0, 2]);
  if (empty.lineup[1].player === null && near(empty.points, 20)) ok('an unfillable slot scores zero, not a crash');
  else bad('unfillable slot');

  /* A payload without eligibleSlots must fall back to the position table
     rather than seating nobody — the shape a Sleeper-style adapter produces. */
  const noEligibility = optimalLineup([
    { id: 'a', name: 'a', pos: 'RB', proTeam: '', injury: 'ACTIVE', eligibleSlots: null, projection: 12, benched: false },
    { id: 'b', name: 'b', pos: 'WR', proTeam: '', injury: 'ACTIVE', eligibleSlots: null, projection: 9, benched: false },
  ], [2, 23]);
  if (near(noEligibility.points, 21)) ok('a player card without eligibleSlots falls back to its position');
  else bad('eligibility fallback', 'got ' + noEligibility.points + ', expected 21');

  /* --- projections ------------------------------------------------------- */
  const exact = projectionFor({ playerPoolEntry: { player: { stats: [
    { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 11 },
    { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 7, appliedTotal: 22 },
    { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 7, appliedTotal: 99 },
  ] } } }, 7);
  if (near(exact, 22)) ok('week 7 forecast is read, not week 3 and not week 7 actuals');
  else bad('weekly projection', 'got ' + exact);

  const seasonOnly = projectionFor({ playerPoolEntry: { player: { stats: [
    { statSourceId: 1, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: 170 },
  ] } } }, 4);
  if (near(seasonOnly, 10)) ok('a season-only forecast falls back to a per-week share');
  else bad('season projection fallback', 'got ' + seasonOnly);

  if (projectionFor({ playerPoolEntry: { player: { stats: [] } } }, 4) === null) {
    ok('no forecast returns null rather than a fabricated number');
  } else bad('missing projection');

  /* --- end to end -------------------------------------------------------- */
  const options = { ...parseArgs([]), week: 1, limit: 3, minPartnerGain: 0.5, poolSize: 10 };
  let state;
  try {
    state = normalize(fixture(), options);
  } catch (err) {
    bad('normalize the fixture', String(err && err.message));
    console.log('\n[trade-assistant] self-test FAILED');
    process.exit(1);
  }

  if (state.slotIds.join(',') === '0,2,2,4,4,6,23') ok('lineup template is read from the league settings');
  else bad('lineup template', state.slotIds.join(','));

  const me = resolveMyTeam(state, '1');
  if (me.name === 'My Squad' && me.owner.startsWith('Lee Rand')) ok('team + ESPN owner resolve from the payload');
  else bad('team resolution', me.name + ' / ' + me.owner);

  const myProfile = positionProfile(me, state.slotIds, state.benchmarks);
  const read = needsAndSurplus(myProfile.profile);

  /* The regression this test exists for: ranking the deficit by "what would I
     lose if this starter vanished" named QB — the one position on the roster
     that is a strength — because the elite QB had no backup and the
     replacement-level RB2 did. Upgrade headroom names RB, which is the hole. */
  if (read.needs[0].pos === 'RB') ok('the RB hole is named as the biggest deficit');
  else bad('deficit detection', 'got ' + read.needs[0].pos + ' (needValues: ' +
    read.needs.map((r) => r.pos + ' +' + round1(r.needValue)).join(', ') + ')');
  if (myProfile.profile.QB.needValue === 0) ok('the elite QB is not mistaken for a need');
  else bad('QB is scored as a need', '+' + round1(myProfile.profile.QB.needValue));
  if (myProfile.profile.WR.rostered === 4 && myProfile.profile.WR.starting === 3) {
    ok('WR surplus is seen: 4 rostered, 3 already starting');
  } else bad('surplus detection');
  if (read.surplus[0].pos === 'WR') ok('WR is named as the clearest surplus');
  else bad('surplus ranking', 'got ' + read.surplus[0].pos);

  const result = findOffers(state, me, options);
  if (result.offers.length) ok('offers found (' + result.considered + ' two-way-positive packages)');
  else bad('offer generation', 'none found on a fixture built to have one');

  const best = result.offers[0];
  if (best && best.team.id === '2') ok('the inverse-need roster is the top partner');
  else bad('matchmaking', 'top partner was ' + (best && best.team.name));
  if (best && best.myGain > 0 && best.theirGain > 0) ok('the top offer raises BOTH lineups');
  else bad('two-way gain');
  if (best && best.give.some((p) => p.pos === 'WR') && best.receive.some((p) => p.pos === 'RB')) {
    ok('the offer sends a WR and returns an RB, as the profiles imply');
  } else bad('offer shape', best ? best.shape + ': ' + best.give.map((p) => p.pos) + ' for ' + best.receive.map((p) => p.pos) : 'n/a');

  /* Every surviving offer must clear both floors and be ranked by my gain —
     the guard against a deal that quietly helps only one side. */
  const floorBreaks = result.offers.filter((o) => o.myGain <= 0 || o.theirGain < options.minPartnerGain);
  if (!floorBreaks.length) ok('every returned offer clears both gain floors');
  else bad('gain floor', floorBreaks.length + ' offer(s) below the floor');

  let ranked = true;
  for (let i = 1; i < result.offers.length; i++) {
    if (result.offers[i].myGain > result.offers[i - 1].myGain + 1e-9) ranked = false;
  }
  if (ranked) ok('offers are ranked by my own lineup gain, best first');
  else bad('offer ranking');

  /* Raising the partner floor must actually filter, not merely re-sort. */
  const strict = findOffers(state, me, { ...options, minPartnerGain: 6 });
  const loose = findOffers(state, me, { ...options, minPartnerGain: 0 });
  if (strict.considered < loose.considered) ok('--min-partner-gain tightens the candidate set');
  else bad('min-partner-gain has no effect', strict.considered + ' vs ' + loose.considered);
  if (strict.offers.every((o) => o.theirGain >= 6)) ok('a raised partner floor is honoured exactly');
  else bad('partner floor not honoured');

  /* One conversation per manager: no two of the printed offers share a partner
     while an unused partner is still on the board. */
  const partners = result.offers.map((o) => o.team.id);
  const distinct = new Set(partners);
  if (distinct.size === Math.min(result.offers.length, state.teams.length - 1)) {
    ok('offers spread across distinct trade partners before repeating one');
  } else bad('partner spread', partners.join(','));

  /* --- determinism ------------------------------------------------------- */
  const runOnce = () => {
    const s = normalize(fixture(), options);
    const m = resolveMyTeam(s, '1');
    const p = positionProfile(m, s.slotIds, s.benchmarks);
    return renderReport(s, m, p, findOffers(s, m, options));
  };
  const a = runOnce();
  const b = runOnce();
  if (a === b) ok('two runs over the same payload are byte-identical');
  else bad('determinism', 'the report changed between runs');

  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const scoringBody = source.slice(source.indexOf('5. OPTIMAL LINEUP'), source.indexOf('11. SELF-TEST'));
  if (!/Math\.random|Date\.now|new Date\(/.test(scoringBody)) {
    ok('no randomness or clock in the scoring, matchmaking or pitch paths');
  } else bad('determinism contract', 'Math.random / Date found in a scoring path');

  /* --- pitch coherence --------------------------------------------------
     The first pitch this tool wrote called RB both "where I am long" and
     "where my lineup has the hole", in consecutive sentences, because the copy
     was generated from the package's positions instead of the roster's facts.
     These two checks are that bug's headstone. */
  const myRead = teamRead(me, state.slotIds, state.benchmarks);
  let coherent = true; let starterCalledSpare = '';
  for (const offer of result.offers) {
    const theirRead = teamRead(offer.team, state.slotIds, state.benchmarks);
    buildPitch(offer, me, myRead, theirRead);
    const spare = honestSurplus(offer.give, myRead);
    const holes = solvedNeeds(offer.receive, myRead);
    for (const p of spare) {
      if (holes.includes(p.pos)) coherent = false;
      if (myRead.starters.has(p.id)) starterCalledSpare = p.name;
    }
  }
  if (coherent) ok('no pitch calls one position both a surplus and a hole');
  else bad('pitch coherence', 'a position was claimed as both');
  if (!starterCalledSpare) ok('no starter is described to a rival as bench depth');
  else bad('pitch accuracy', starterCalledSpare + ' starts but is pitched as spare');

  const jsonOut = renderJson(state, me, myProfile, result);
  try {
    const parsed = JSON.parse(jsonOut);
    const first = parsed.offers[0];
    if (first.pitch && first.pitch.includes(first.receive[0].name) &&
        first.pitch.includes(first.give[0].name)) {
      ok('--json carries a parseable pitch naming the players in the deal');
    } else bad('json pitch');
    if (Array.isArray(first.designations) && first.myLineup.gain > 0 &&
        typeof first.targetTeam.owner === 'string') {
      ok('--json carries the owner, the lineup deltas and the designation flags');
    } else bad('json offer shape');
  } catch (err) {
    bad('json output is not parseable', String(err && err.message));
  }

  console.log(failures ? '\n[trade-assistant] self-test FAILED (' + failures + ')' : '\n[trade-assistant] self-test clean');
  return failures ? 1 : 0;
}

/* ============================================================================
   12. MAIN
============================================================================ */

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) { console.log(USAGE); return 0; }
  if (options.selfTest) return selfTest();

  let payload;
  if (options.fixture) {
    try {
      payload = JSON.parse(fs.readFileSync(path.resolve(root, options.fixture), 'utf8'));
    } catch (err) {
      console.error('[TradeAssistant] could not read the fixture at ' + options.fixture, err);
      return 1;
    }
  } else {
    try {
      payload = await fetchLeague(options.season, options.league);
    } catch (err) {
      console.error('[TradeAssistant] ' + (err && err.message ? err.message : String(err)));
      return 1;
    }
    if (options.dump) {
      try {
        fs.writeFileSync(path.resolve(root, options.dump), JSON.stringify(payload, null, 2));
        console.error('[TradeAssistant] raw ESPN payload written to ' + options.dump);
      } catch (err) {
        console.error('[TradeAssistant] could not write the dump to ' + options.dump, err);
      }
    }
  }

  let state; let me; let myProfile; let result;
  try {
    state = normalize(payload, options);
    me = resolveMyTeam(state, options.team);
    myProfile = positionProfile(me, state.slotIds, state.benchmarks);
    result = findOffers(state, me, options);
  } catch (err) {
    console.error('[TradeAssistant] ' + (err && err.message ? err.message : String(err)));
    return 1;
  }

  const output = options.json
    ? renderJson(state, me, myProfile, result)
    : renderReport(state, me, myProfile, result);

  console.log(output);

  if (options.out) {
    try {
      fs.writeFileSync(path.resolve(root, options.out), output + '\n');
      console.error('[TradeAssistant] written to ' + options.out);
    } catch (err) {
      console.error('[TradeAssistant] could not write the report to ' + options.out, err);
      return 1;
    }
  }

  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error('[TradeAssistant] unhandled failure', err);
  process.exitCode = 1;
});
