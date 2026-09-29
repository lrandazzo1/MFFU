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
export interface FsnIndexTeam {
    id: string;
    name: string;
    abbrev: string;
}
export interface FsnIndexRow {
    team: FsnIndexTeam;
    /** 0–100 composite. */
    index: number;
    /** 1-based, best first. */
    rank: number;
    /** Finalized regular-season weeks this row is built from. */
    weeks: number;
    allPlay: {
        wins: number;
        ties: number;
        losses: number;
        games: number;
        /** 0–100. */
        pct: number;
        hasData: boolean;
    };
    ppg: {
        avg: number;
        max: number;
        norm: number;
    };
    consistency: {
        /** The pillar as scored, after early-season shrinkage. */
        cf: number;
        cfRaw: number;
        cvPct: number;
        weeks: number;
        shrunk: boolean;
    };
    context: {
        score: number;
        mode: 'optimal' | 'sos';
        label: string;
        oppPpg: number;
    };
}
export interface FsnIndexMover {
    team: FsnIndexTeam;
    index: number;
    previousIndex: number;
    /** Current minus previous. Positive is a climb. */
    indexDelta: number;
    rank: number;
    previousRank: number;
    /** Previous minus current, so positive is a climb up the board. */
    rankDelta: number;
    direction: 'up' | 'down' | 'flat';
}
/** The client's weights, in the client's order. Exported so the cross-check
 *  can compare them against index.html rather than trusting a comment. */
export declare const FSN_INDEX_WEIGHTS: {
    readonly allPlay: 0.5;
    readonly pf: 0.2;
    readonly consistency: 0.15;
    readonly context: 0.15;
};
/** Below this many scored weeks the consistency pillar is shrunk toward the
 *  league median. Same threshold as the client. */
export declare const CONSISTENCY_SHRINKAGE_WEEKS = 4;
/** Median, ignoring non-finite values. Port of `fsnMedian()`. */
export declare function fsnMedian(values: number[]): number;
/**
 * Has the platform OFFICIALLY finalized this matchup? Port of
 * `scheduleGameFinal()`.
 *
 * This, not the presence of a score, is what may enter the pillars. A live
 * UNDECIDED partial total seeding all-play, PPG or consistency is the mid-week
 * corruption the client guard exists to prevent, and a scheduled Tuesday run
 * can land while a Monday night game is still settling.
 */
export declare function scheduleGameFinal(game: any): boolean;
/** Team identity as the client's `getTeams()` derives it: location + nickname
 *  first, then `name`, then a positional label. */
export declare function fsnIndexTeams(payload: any): FsnIndexTeam[];
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
export declare function computeFsnIndex(payload: any, week: number): FsnIndexRow[];
/**
 * Who moved between two boards, biggest mover first.
 *
 * Ordered on rank movement rather than index points, because that is what the
 * segment says out loud ("up four spots"). Index points break the tie so a
 * league where nobody changed rank still has a lead story. A team absent from
 * the previous board is skipped rather than reported as a giant climb: it had
 * no rank to climb from, and calling that a jump would be a false claim.
 */
export declare function fsnIndexMovers(previous: FsnIndexRow[], current: FsnIndexRow[]): FsnIndexMover[];
