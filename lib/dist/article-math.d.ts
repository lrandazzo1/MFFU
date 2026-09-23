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
export type OutcomeFlag = 'GAME_WINNER' | 'GARBAGE_TIME_BLOWOUT' | 'VALIANT_LOSS' | 'DUD_COST_WIN';
/** Cosmetic label for the window a player's NFL game kicked off in. Ordering
 *  is always done on the raw kickoff timestamp, never on this string. */
export type GameSlot = 'TNF' | 'SUNDAY' | 'SNF' | 'MNF' | 'SPECIAL' | 'UNKNOWN';
/** Why a player could not be classified. Absent when `outcome_flag` is trusted
 *  (including a trusted `null`, which means "nothing dramatic happened"). */
export type UnresolvedReason = 'MISSING_KICKOFF_DATA' | 'MISSING_SCORES' | 'NO_OPPONENT';
export interface TrackedPlayer {
    player_id: string;
    player_name: string;
    /** The fantasy team that started him, by name. */
    owner_team: string;
    outcome_flag: OutcomeFlag | null;
    player_points: number;
    projected_points: number | null;
    /** Matchup lead (+) or deficit (-) for `owner_team` BEFORE this player's NFL
       game kicked off. Null when the box score cannot place points in time. */
    entering_margin: number | null;
    /** Final matchup lead (+) or deficit (-) for `owner_team`. */
    final_margin: number | null;
    slot: GameSlot;
    kickoff: number | null;
    opponent_team: string;
    matchup_id: string;
    unresolved_reason?: UnresolvedReason;
}
export interface OutcomeInput {
    entering_margin: number | null;
    final_margin: number | null;
    player_points: number;
    projected_points: number | null;
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
export declare function classifyOutcome(input: OutcomeInput): OutcomeFlag | null;
export interface OutcomeOptions {
    /** Scoring period to evaluate. Required for a raw ESPN season payload, which
     *  carries every week's schedule in one array. */
    week?: number | null;
    /** Restrict the returned rows to these kickoff windows. Defaults to the
     *  featured windows the desk writes about. */
    slots?: GameSlot[];
}
/**
 * Assign a math outcome flag to every starter in a league's box scores.
 *
 * Margins are always stated from the perspective of the team that started the
 * player: positive is a lead, negative is a deficit.
 */
export declare function calculatePlayerOutcomeFlags(leagueBoxScores: any, options?: OutcomeOptions): TrackedPlayer[];
/**
 * The rows a story should actually be built around: flagged performances
 * first, then the biggest raw weeks, capped so a 12-team league does not hand
 * a model 120 players to choose from.
 */
export declare function featuredTrackedPlayers(tracked: TrackedPlayer[], limit?: number): TrackedPlayer[];
