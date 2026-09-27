"use strict";
/**
 * FSN POWER INDEX — server-side port of the client board.
 *
 * The Studio podcast's first segment reports which teams moved on the FSN
 * Index, and a reader can open Analytics and check it. So this is a FAITHFUL
 * port of `fsnPowerIndex()` in index.html (block 3), not a new rating:
 *
 *   FSN Index = 0.50·W_all-play + 0.20·PF_norm + 0.15·CF_adj + 0.15·Context
 *
 * It is additive. It reads a raw ESPN league payload and returns plain data,
 * and it touches nothing the client owns: no LeagueData, no FSNIntel, no News
 * Desk generator, no historical pipeline, no Supabase.
 *
 * ---- WHY A SECOND COPY EXISTS, AND HOW IT IS KEPT HONEST ----
 *
 * The client model lives inside block 3's IIFE and reads `LeagueData`, so a
 * scheduled serverless run cannot call it. Two implementations of one formula
 * drift, which for this feature means the podcast telling a league something
 * its own Analytics tab contradicts. `scripts/podcast-segments-check.mjs`
 * therefore reads the weights and the pillar construction straight out of
 * index.html and fails if they no longer agree with this file. Change one, and
 * the check makes you change the other.
 *
 * ---- ONE DELIBERATE DIVERGENCE: PILLAR 4 ----
 *
 * The client's context pillar prefers managerial efficiency
 * (`lineupEfficiencyThrough`) and falls back to schedule hardship when ESPN
 * omits the bench detail it needs — which its own comment notes is frequent.
 * This port always takes the documented fallback and reports `mode: 'sos'`, so
 * a caller can say which pillar it is quoting rather than implying an
 * efficiency read it never made. Everything else is the same arithmetic in the
 * same order.
 *
 * Determinism: no `Math.random()`, no `Date.now()`, no network. The same
 * payload and week always produce the same board.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONSISTENCY_SHRINKAGE_WEEKS = exports.FSN_INDEX_WEIGHTS = void 0;
exports.fsnMedian = fsnMedian;
exports.scheduleGameFinal = scheduleGameFinal;
exports.fsnIndexTeams = fsnIndexTeams;
exports.computeFsnIndex = computeFsnIndex;
exports.fsnIndexMovers = fsnIndexMovers;
/** The client's weights, in the client's order. Exported so the cross-check
 *  can compare them against index.html rather than trusting a comment. */
exports.FSN_INDEX_WEIGHTS = {
    allPlay: 0.5,
    pf: 0.2,
    consistency: 0.15,
    context: 0.15,
};
/** Below this many scored weeks the consistency pillar is shrunk toward the
 *  league median. Same threshold as the client. */
exports.CONSISTENCY_SHRINKAGE_WEEKS = 4;
/* ------------------------------------------------------------------ *
 * Small helpers, ported as-is
 * ------------------------------------------------------------------ */
const SCHEDULE_FINAL_STATE_RE = /^(post|final|complete|completed|closed|over|finished)$/i;
const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};
const clamp100 = (value) => Math.max(0, Math.min(100, value));
/** Median, ignoring non-finite values. Port of `fsnMedian()`. */
function fsnMedian(values) {
    const list = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
    if (!list.length)
        return 0;
    const mid = Math.floor(list.length / 2);
    return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}
/**
 * Has the platform OFFICIALLY finalized this matchup? Port of
 * `scheduleGameFinal()`.
 *
 * This, not the presence of a score, is what may enter the pillars. A live
 * UNDECIDED partial total seeding all-play, PPG or consistency is the mid-week
 * corruption the client guard exists to prevent, and a scheduled Tuesday run
 * can land while a Monday night game is still settling.
 */
function scheduleGameFinal(game) {
    if (!game || !game.home || !game.away)
        return false;
    const winner = game.winner;
    if (winner != null && String(winner).trim() !== '') {
        return String(winner).toUpperCase() !== 'UNDECIDED';
    }
    const providerStatus = game.status || game.statusText || '';
    return typeof providerStatus === 'string' && SCHEDULE_FINAL_STATE_RE.test(providerStatus.trim());
}
/** Team identity as the client's `getTeams()` derives it: location + nickname
 *  first, then `name`, then a positional label. */
function fsnIndexTeams(payload) {
    const teams = payload && Array.isArray(payload.teams) ? payload.teams : [];
    return teams
        .filter((t) => t && t.id != null)
        .map((t) => {
        const composed = ((t.location || '') + ' ' + (t.nickname || '')).trim();
        const name = composed || t.name || 'Team ' + t.id;
        const abbrev = t.abbrev || String(name).replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'TM';
        return { id: String(t.id), name: String(name), abbrev: String(abbrev) };
    });
}
/**
 * The FSN Index board through `targetWeek`, best first.
 *
 * `payload` is a raw ESPN league object carrying `teams` and `schedule` — the
 * same shape the client seeds into LeagueData, and what
 * `view=mMatchupScore&view=mTeam` returns.
 *
 * Returns `[]` when the league has no teams or no finalized regular-season
 * week yet. That is an empty board, not an error: week 1 before any game
 * finalizes genuinely has nothing to rate.
 */
function computeFsnIndex(payload, week) {
    const targetWeek = Math.max(1, Number.parseInt(String(week), 10) || 1);
    const teams = fsnIndexTeams(payload);
    if (!teams.length)
        return [];
    const schedule = payload && Array.isArray(payload.schedule) ? payload.schedule : [];
    /* Weekly scoreboards — regular season, finalized, through the selected week.
       Playoff tiers are excluded so a bracket blowout cannot distort a
       schedule-neutral roster-quality read. */
    const byWeek = Object.create(null);
    for (const game of schedule) {
        if (!game || !game.home || !game.away)
            continue;
        if (game.playoffTierType && String(game.playoffTierType).toUpperCase() !== 'NONE')
            continue;
        const wk = num(game.matchupPeriodId);
        if (!wk || wk > targetWeek)
            continue;
        if (!scheduleGameFinal(game))
            continue;
        const hs = num(game.home.totalPoints);
        const as = num(game.away.totalPoints);
        if (hs <= 0 && as <= 0)
            continue; // unplayed
        const key = String(wk);
        if (!byWeek[key])
            byWeek[key] = [];
        byWeek[key].push({ teamId: String(game.home.teamId), score: hs, oppScore: as }, { teamId: String(game.away.teamId), score: as, oppScore: hs });
    }
    const agg = Object.create(null);
    for (const team of teams) {
        agg[team.id] = {
            team,
            scores: [],
            oppScores: [],
            apWins: 0,
            apTies: 0,
            apLosses: 0,
            apGames: 0,
        };
    }
    /* Pillar 1 raw counts — each week, every team plays a head-to-head against
       every other team on that week's board. */
    for (const key of Object.keys(byWeek)) {
        const board = byWeek[key];
        for (const entry of board) {
            const row = agg[entry.teamId];
            if (!row)
                continue;
            row.scores.push(entry.score);
            row.oppScores.push(entry.oppScore);
            for (const other of board) {
                if (other === entry || other.teamId === entry.teamId)
                    continue;
                row.apGames += 1;
                if (entry.score > other.score)
                    row.apWins += 1;
                else if (entry.score === other.score)
                    row.apTies += 1;
                else
                    row.apLosses += 1;
            }
        }
    }
    /* Base pillars per team, keeping only teams that have actually scored. */
    const base = Object.keys(agg)
        .map((k) => agg[k])
        .filter((r) => r.scores.length > 0)
        .map((r) => {
        const k = r.scores.length;
        const mean = r.scores.reduce((s, v) => s + v, 0) / k;
        const variance = r.scores.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / k;
        const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
        const cfRaw = Math.max(0, (1 - cv) * 100);
        const apPct = r.apGames ? ((r.apWins + r.apTies * 0.5) / r.apGames) * 100 : null;
        const oppPpg = r.oppScores.length
            ? r.oppScores.reduce((s, v) => s + v, 0) / r.oppScores.length
            : 0;
        return { ...r, weeks: k, mean, cv, cfRaw, apPct, oppPpg };
    });
    if (!base.length)
        return [];
    const maxMean = Math.max(...base.map((r) => r.mean)) || 1;
    const maxOppPpg = Math.max(...base.map((r) => r.oppPpg)) || 1;
    const cfMedian = fsnMedian(base.map((r) => r.cfRaw));
    const scored = base.map((r) => {
        // Pillar 1 — schedule-neutral all-play win %.
        const wAllPlay = r.apPct == null ? 0 : clamp100(r.apPct);
        // Pillar 2 — scoring dominance normalized against the league ceiling.
        const pfNorm = clamp100((r.mean / maxMean) * 100);
        // Pillar 3 — consistency, shrunk toward the league median while the sample
        // is short, so three good weeks do not read as proven reliability.
        const shrunk = r.weeks < exports.CONSISTENCY_SHRINKAGE_WEEKS;
        const ratio = r.weeks / exports.CONSISTENCY_SHRINKAGE_WEEKS;
        const cfAdj = shrunk ? ratio * r.cfRaw + (1 - ratio) * cfMedian : r.cfRaw;
        // Pillar 4 — schedule hardship. See the header: the efficiency read the
        // client prefers needs bench detail this payload does not carry.
        const contextScore = clamp100((r.oppPpg / maxOppPpg) * 100);
        const index = clamp100(exports.FSN_INDEX_WEIGHTS.allPlay * wAllPlay +
            exports.FSN_INDEX_WEIGHTS.pf * pfNorm +
            exports.FSN_INDEX_WEIGHTS.consistency * cfAdj +
            exports.FSN_INDEX_WEIGHTS.context * contextScore);
        return {
            team: r.team,
            index,
            rank: 0,
            weeks: r.weeks,
            allPlay: {
                wins: r.apWins,
                ties: r.apTies,
                losses: r.apLosses,
                games: r.apGames,
                pct: wAllPlay,
                hasData: r.apGames > 0,
            },
            ppg: { avg: r.mean, max: maxMean, norm: pfNorm },
            consistency: {
                cf: cfAdj,
                cfRaw: r.cfRaw,
                cvPct: r.cv * 100,
                weeks: r.weeks,
                shrunk,
            },
            context: {
                score: contextScore,
                mode: 'sos',
                label: 'Schedule Hardship',
                oppPpg: r.oppPpg,
            },
        };
    });
    /* Same tiebreak chain as the client, so two boards over the same payload
       cannot order a tie differently. */
    scored.sort((a, b) => b.index - a.index ||
        b.allPlay.pct - a.allPlay.pct ||
        b.ppg.avg - a.ppg.avg ||
        String(a.team.name).localeCompare(String(b.team.name)));
    scored.forEach((r, i) => {
        r.rank = i + 1;
    });
    return scored;
}
/**
 * Who moved between two boards, biggest mover first.
 *
 * Ordered on rank movement rather than index points, because that is what the
 * segment says out loud ("up four spots"). Index points break the tie so a
 * league where nobody changed rank still has a lead story. A team absent from
 * the previous board is skipped rather than reported as a giant climb: it had
 * no rank to climb from, and calling that a jump would be a false claim.
 */
function fsnIndexMovers(previous, current) {
    const before = new Map();
    for (const row of previous || [])
        before.set(row.team.id, row);
    const movers = [];
    for (const row of current || []) {
        const prior = before.get(row.team.id);
        if (!prior)
            continue;
        const rankDelta = prior.rank - row.rank;
        movers.push({
            team: row.team,
            index: row.index,
            previousIndex: prior.index,
            indexDelta: row.index - prior.index,
            rank: row.rank,
            previousRank: prior.rank,
            rankDelta,
            direction: rankDelta > 0 ? 'up' : rankDelta < 0 ? 'down' : 'flat',
        });
    }
    movers.sort((a, b) => Math.abs(b.rankDelta) - Math.abs(a.rankDelta) ||
        Math.abs(b.indexDelta) - Math.abs(a.indexDelta) ||
        String(a.team.name).localeCompare(String(b.team.name)));
    return movers;
}
