"use strict";
/**
 * Outcome math for the FSN blog article pipeline.
 *
 * This module is the only thing allowed to decide what a fantasy performance
 * MEANT. Everything downstream (the model prompt, the published markdown, the
 * `tracked_players` column) quotes it rather than re-deriving it, because the
 * whole point of the pipeline is that copy can never claim a player won a
 * matchup the math says he did not win.
 *
 * It is additive and self-contained: it reads a league box-score payload and
 * returns plain data. It never touches LeagueData, the News Desk generators,
 * the historical pipelines, or Supabase.
 *
 * Determinism: no `Math.random()`, no `Date.now()`, no network. The same box
 * score in always produces the same flags out.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyOutcome = classifyOutcome;
exports.calculatePlayerOutcomeFlags = calculatePlayerOutcomeFlags;
exports.featuredTrackedPlayers = featuredTrackedPlayers;
/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
/** Bench and IR cannot score for a team, so their points are not on the board
 *  at any point in the matchup. Mirrors the lineup-slot handling in index.html
 *  (20 bench, 21 IR, 88 taxi/reserve on the schedule adapter). */
const BENCH_SLOT_IDS = new Set([20, 21, 88]);
const num = (value) => {
    if (value == null || value === '')
        return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};
/** Fantasy scoring carries two decimals. Keep the arithmetic there so a
 *  0.30000000000000004 never becomes the difference between a win and a loss. */
const round2 = (value) => Math.round(value * 100) / 100;
const text = (value) => (value == null ? '' : String(value)).trim();
/** Accepts epoch milliseconds, epoch seconds, or anything Date can parse.
 *  Returns null rather than guessing: a wrong kickoff silently rewrites the
 *  entering margin, which is the one number this module exists to protect. */
function kickoffMs(value) {
    if (value == null || value === '')
        return null;
    if (value instanceof Date) {
        const t = value.getTime();
        return Number.isFinite(t) ? t : null;
    }
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
        // Ten digits is seconds (through the year 2286), thirteen is milliseconds.
        return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}
const SLOT_NAMES = new Set(['TNF', 'SUNDAY', 'SNF', 'MNF', 'SPECIAL', 'UNKNOWN']);
/** Label the kickoff window in US Eastern, the clock the NFL schedule is
 *  published on. Purely descriptive: ordering never uses it. */
function slotOf(kickoff, declared) {
    const stated = text(declared).toUpperCase();
    if (SLOT_NAMES.has(stated) && stated !== 'UNKNOWN')
        return stated;
    if (stated === 'SUN' || stated === 'SUNDAY_AFTERNOON')
        return 'SUNDAY';
    if (stated === 'THURSDAY' || stated === 'THU')
        return 'TNF';
    if (stated === 'MONDAY' || stated === 'MON')
        return 'MNF';
    if (kickoff == null)
        return 'UNKNOWN';
    let weekday = '';
    let hour = 0;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            weekday: 'short',
            hour: 'numeric',
            hour12: false,
        }).formatToParts(new Date(kickoff));
        for (const part of parts) {
            if (part.type === 'weekday')
                weekday = part.value;
            if (part.type === 'hour')
                hour = Number(part.value);
        }
    }
    catch (err) {
        console.warn('[ArticleMath] kickoff slot label unavailable for ' + kickoff, err);
        return 'UNKNOWN';
    }
    if (weekday === 'Thu')
        return 'TNF';
    if (weekday === 'Mon' || weekday === 'Tue')
        return 'MNF';
    if (weekday === 'Sun')
        return hour >= 19 ? 'SNF' : 'SUNDAY';
    return 'SPECIAL';
}
/* ------------------------------------------------------------------ *
 * Normalization
 *
 * Two payload shapes are accepted, because both already exist in this repo:
 *   - raw ESPN (`schedule[].home.rosterForCurrentScoringPeriod.entries[]`)
 *   - the flat adapter shape the app's own feeds publish
 *     (`matchups[].home.starters[]`)
 * Anything a shape cannot answer comes back null, never zero.
 * ------------------------------------------------------------------ */
function entryPlayer(entry) {
    return (entry && entry.playerPoolEntry && entry.playerPoolEntry.player) || (entry && entry.player) || entry || {};
}
/** ESPN hangs actual (statSourceId 0) and projected (1) totals off the player
 *  card when the entry itself does not carry them. */
function cardStat(player, week, statSourceId) {
    const stats = player && Array.isArray(player.stats) ? player.stats : [];
    let undated = null;
    for (const row of stats) {
        if (!row || Number(row.statSourceId) !== statSourceId)
            continue;
        const applied = num(row.appliedTotal);
        if (applied == null)
            continue;
        if (row.scoringPeriodId == null) {
            if (undated == null)
                undated = applied;
            continue;
        }
        if (week == null || Number(row.scoringPeriodId) === Number(week))
            return applied;
    }
    return undated;
}
/** The NFL team a fantasy starter plays for, in the two shapes ESPN uses.
 *  Both are returned because a payload may carry either. */
function proTeamKeys(entry, player) {
    const keys = [];
    const push = (value) => {
        const key = String(value == null ? '' : value).trim().toUpperCase();
        if (key && key !== '0' && !keys.includes(key))
            keys.push(key);
    };
    push(player && player.proTeamId);
    push(entry && entry.proTeamId);
    push(player && (player.proTeamAbbreviation || player.proTeamAbbrev));
    push(entry && (entry.proTeamAbbreviation || entry.proTeamAbbrev));
    return keys;
}
/** The entry's own kickoff if it has one, otherwise his NFL team's from the
 *  index. The entry wins: a payload that states a kickoff for this specific
 *  player knows something the league-wide schedule does not (a rescheduled or
 *  relocated game), and overriding it with the general answer would be the
 *  wrong way round. */
function kickoffFor(entry, player, kickoffs) {
    const declared = kickoffMs(entry.kickoff != null ? entry.kickoff :
        entry.game_start != null ? entry.game_start :
            entry.gameDate != null ? entry.gameDate :
                player.proGameDate != null ? player.proGameDate :
                    player.gameDate);
    if (declared != null)
        return declared;
    if (!kickoffs)
        return null;
    for (const key of proTeamKeys(entry, player)) {
        const ts = Number(kickoffs[key]);
        if (Number.isFinite(ts) && ts > 0)
            return ts;
    }
    return null;
}
function normalizeEntry(entry, week, kickoffs) {
    if (!entry)
        return null;
    const player = entryPlayer(entry);
    const id = text(entry.player_id != null ? entry.player_id : entry.playerId != null ? entry.playerId : player.id);
    const name = text(player.fullName || player.full_name || entry.player_name || entry.name);
    if (!id && !name)
        return null;
    const points = num(entry.appliedStatTotal) ??
        num(entry.playerPoolEntry && entry.playerPoolEntry.appliedStatTotal) ??
        num(entry.player_points) ??
        num(entry.points) ??
        cardStat(player, week, 0) ??
        0;
    const projected = num(entry.projected_points) ??
        num(entry.projectedStatTotal) ??
        num(entry.playerPoolEntry && entry.playerPoolEntry.projectedStatTotal) ??
        cardStat(player, week, 1);
    const kickoff = kickoffFor(entry, player, kickoffs);
    return {
        player_id: id || name,
        player_name: name || id,
        points: round2(points),
        projected: projected == null ? null : round2(projected),
        kickoff,
        slot: slotOf(kickoff, entry.game_slot || entry.slot),
    };
}
function normalizeSide(side, week, kickoffs) {
    if (!side)
        return null;
    const roster = side.rosterForCurrentScoringPeriod || side.rosterForMatchupPeriod || null;
    const rawEntries = Array.isArray(side.starters)
        ? side.starters
        : roster && Array.isArray(roster.entries)
            ? roster.entries.filter((entry) => entry && !BENCH_SLOT_IDS.has(Number(entry.lineupSlotId)))
            : Array.isArray(side.entries)
                ? side.entries.filter((entry) => entry && !BENCH_SLOT_IDS.has(Number(entry.lineupSlotId)))
                : [];
    const starters = [];
    for (const raw of rawEntries) {
        const entry = normalizeEntry(raw, week, kickoffs);
        if (entry)
            starters.push(entry);
    }
    const total = num(side.total_points) ??
        num(side.totalPoints) ??
        num(side.points) ??
        (starters.length ? round2(starters.reduce((sum, entry) => sum + entry.points, 0)) : null);
    const teamId = text(side.team_id != null ? side.team_id : side.teamId);
    return {
        team_id: teamId,
        team_name: text(side.team_name || side.teamName || side.name) || (teamId ? 'Team ' + teamId : 'Unknown team'),
        total: total == null ? null : round2(total),
        starters,
    };
}
function normalizeMatchups(leagueBoxScores, week, kickoffs) {
    const raw = Array.isArray(leagueBoxScores)
        ? leagueBoxScores
        : Array.isArray(leagueBoxScores && leagueBoxScores.schedule)
            ? leagueBoxScores.schedule
            : Array.isArray(leagueBoxScores && leagueBoxScores.matchups)
                ? leagueBoxScores.matchups
                : [];
    const out = [];
    raw.forEach((matchup, index) => {
        if (!matchup)
            return;
        // A scoring period filter matters on the raw ESPN payload, which returns
        // the full season schedule in one array.
        if (week != null && matchup.matchupPeriodId != null && Number(matchup.matchupPeriodId) !== week)
            return;
        if (week != null && matchup.week != null && Number(matchup.week) !== week)
            return;
        out.push({
            matchup_id: text(matchup.id != null ? matchup.id : matchup.matchup_id) || String(index + 1),
            home: normalizeSide(matchup.home, week, kickoffs),
            away: normalizeSide(matchup.away, week, kickoffs),
        });
    });
    return out;
}
/* ------------------------------------------------------------------ *
 * The margins
 * ------------------------------------------------------------------ */
/** Points a side had actually banked before `kickoff`.
 *
 *  Only players whose own game had already kicked off count. A player who has
 *  not taken the field has scored nothing yet, whatever he finishes with. */
function pointsBefore(side, kickoff) {
    let total = 0;
    for (const entry of side.starters) {
        if (entry.kickoff != null && entry.kickoff < kickoff)
            total += entry.points;
    }
    return round2(total);
}
/** Every starter must carry a kickoff, or the "before" sum silently drops
 *  points that were already on the board and manufactures a deficit that never
 *  existed. Partial data is refused rather than approximated. */
function kickoffsComplete(side) {
    return side.starters.length > 0 && side.starters.every((entry) => entry.kickoff != null);
}
/**
 * The strict flag table. Every threshold is exactly as specified, and a case
 * that matches nothing returns null: "nothing notable happened" is a real
 * answer and is never upgraded into a story.
 *
 * Precedence is the declared order. GAME_WINNER (entering < 0) and
 * GARBAGE_TIME_BLOWOUT (entering > 20) cannot both match, and neither can
 * co-occur with a loss. The one genuine overlap is a player who scored more
 * than 20 but still fell 5+ short of his projection in a matchup his team led
 * before he played and then lost: VALIANT_LOSS wins there, because he did put
 * up a real number and the copy should say the team wasted it.
 */
function classifyOutcome(input) {
    const entering = input.entering_margin;
    const final = input.final_margin;
    const points = input.player_points;
    const projected = input.projected_points;
    if (entering == null || final == null || !Number.isFinite(points))
        return null;
    if (entering < 0 && final > 0 && points >= Math.abs(entering))
        return 'GAME_WINNER';
    if (entering > 20 && final > 20)
        return 'GARBAGE_TIME_BLOWOUT';
    if (final < 0 && points > 20)
        return 'VALIANT_LOSS';
    if (entering > 0 && final < 0 && projected != null && points < projected - 5)
        return 'DUD_COST_WIN';
    return null;
}
/**
 * Assign a math outcome flag to every starter in a league's box scores.
 *
 * Margins are always stated from the perspective of the team that started the
 * player: positive is a lead, negative is a deficit.
 */
function calculatePlayerOutcomeFlags(leagueBoxScores, options = {}) {
    const week = options.week == null ? null : Number(options.week);
    const slotFilter = options.slots && options.slots.length ? new Set(options.slots) : null;
    const kickoffs = options.kickoffs && typeof options.kickoffs === 'object' ? options.kickoffs : null;
    const matchups = normalizeMatchups(leagueBoxScores, week, kickoffs);
    if (!matchups.length) {
        console.warn('[ArticleMath] no matchups found in box score payload for week ' + (week == null ? 'any' : week), new Error('EMPTY_BOX_SCORE'));
        return [];
    }
    const tracked = [];
    for (const matchup of matchups) {
        const sides = [
            [matchup.home, matchup.away],
            [matchup.away, matchup.home],
        ];
        for (const [side, opponent] of sides) {
            if (!side)
                continue;
            // A bye (or an unparsed half of the matchup) has no margin to compute.
            const unresolved = !opponent
                ? 'NO_OPPONENT'
                : side.total == null || opponent.total == null
                    ? 'MISSING_SCORES'
                    : !kickoffsComplete(side) || !kickoffsComplete(opponent)
                        ? 'MISSING_KICKOFF_DATA'
                        : null;
            if (unresolved) {
                console.warn('[ArticleMath] matchup ' + matchup.matchup_id + ' cannot be classified for ' + side.team_name +
                    ' (' + unresolved + ')', new Error(unresolved));
            }
            const finalMargin = unresolved || !opponent || side.total == null || opponent.total == null
                ? null
                : round2(side.total - opponent.total);
            for (const entry of side.starters) {
                if (slotFilter && !slotFilter.has(entry.slot))
                    continue;
                const enteringMargin = unresolved || !opponent || entry.kickoff == null
                    ? null
                    : round2(pointsBefore(side, entry.kickoff) - pointsBefore(opponent, entry.kickoff));
                const row = {
                    player_id: entry.player_id,
                    player_name: entry.player_name,
                    owner_team: side.team_name,
                    outcome_flag: classifyOutcome({
                        entering_margin: enteringMargin,
                        final_margin: finalMargin,
                        player_points: entry.points,
                        projected_points: entry.projected,
                    }),
                    player_points: entry.points,
                    projected_points: entry.projected,
                    entering_margin: enteringMargin,
                    final_margin: finalMargin,
                    slot: entry.slot,
                    kickoff: entry.kickoff,
                    opponent_team: opponent ? opponent.team_name : '',
                    matchup_id: matchup.matchup_id,
                };
                if (unresolved)
                    row.unresolved_reason = unresolved;
                tracked.push(row);
            }
        }
    }
    return tracked;
}
/** How loudly a row deserves to be written about. Flagged rows outrank plain
 *  ones; within a tier, the bigger number leads. Stable and seed-free. */
function newsWeight(row) {
    const flagged = row.outcome_flag ? 1000 : 0;
    return flagged + row.player_points;
}
/**
 * The rows a story should actually be built around: flagged performances
 * first, then the biggest raw weeks, capped so a 12-team league does not hand
 * a model 120 players to choose from.
 */
function featuredTrackedPlayers(tracked, limit = 8) {
    return tracked
        .slice()
        .sort((a, b) => {
        const delta = newsWeight(b) - newsWeight(a);
        if (delta !== 0)
            return delta;
        // Ties break on identity so the ordering is total and reproducible.
        return a.player_id < b.player_id ? -1 : a.player_id > b.player_id ? 1 : 0;
    })
        .slice(0, Math.max(0, limit));
}
