/**
 * THE FOUR-SEGMENT WEEKLY RECAP SCRIPT.
 *
 * Dan and Stu's weekly episode, built from two branches of data the app
 * already computes:
 *
 *   Segment 1  FSN Index Movers     lib/fsn-index.ts, this week's board against
 *                                   last week's
 *   Segment 2  Big Performers       lib/article-math.ts tracked starters — the
 *                                   editorial branch's own outcome flags
 *   Segment 3  Matchup of the Week   lib/article-generator.ts preview matchups
 *   Segment 4  Waiver Lookout       starter shortfalls against projection, the
 *                                   evidence for who has to shop
 *
 * ---- WHAT THIS IS NOT ----
 *
 * Not an LLM prompt. There is no model in this pipeline and none is being
 * added: every sentence below is a template filled from numbers the math
 * modules already stand behind, which is what lets the episode be regenerated
 * and come out the same. Determinism, as elsewhere in the repo: no
 * `Math.random()`, no `Date.now()`, no network, no model call. The same inputs
 * always produce the same script.
 *
 * Not a change to the News Desk. The deterministic article generators in
 * index.html block 4 are untouched; this is a new generator alongside them, and
 * the existing client `studioDraft()` path still works exactly as it did.
 *
 * ---- THE CLAIM DISCIPLINE ----
 *
 * Every segment degrades to an honest empty state rather than reaching. A week
 * with one finalized game has no index movement, so segment 1 says so instead
 * of inventing a climb; a matchup nobody has finished is described as in
 * progress, never as a result. `buildWeeklyPodcastScript` returns which
 * segments carried real material in `segments[].populated`, so a caller can
 * refuse to spend money on an episode that is mostly empty rooms.
 */
import type { FsnIndexRow } from './fsn-index';
import type { TrackedPlayer } from './article-math';
import type { PreviewMatchup } from './article-generator';
export type PodcastHostTag = 'DAN' | 'STU';
export interface PodcastLine {
    host: PodcastHostTag;
    text: string;
}
export type PodcastSegmentKey = 'index_movers' | 'big_performers' | 'matchup_of_week' | 'waiver_lookout';
export interface PodcastSegment {
    key: PodcastSegmentKey;
    /** On-air name, also the reel card kicker. */
    title: string;
    lines: PodcastLine[];
    /** One headline for the Story Reel card and the episode's `stories` array. */
    headline: string;
    /** False when the data could not support the segment and it fell back to an
     *  honest "nothing to report" read. */
    populated: boolean;
}
export interface WeeklyPodcastScript {
    title: string;
    week: number;
    season: number;
    lines: PodcastLine[];
    stories: string[];
    segments: PodcastSegment[];
    /** How many of the four segments carried real material. */
    populatedSegments: number;
}
export interface BuildScriptInput {
    season: number;
    week: number;
    /** The FSN Index board through this week. */
    index: FsnIndexRow[];
    /** The board through the previous week, for movement. Empty in week 1. */
    previousIndex: FsnIndexRow[];
    /** Every evaluated starter for the week. */
    tracked: TrackedPlayer[];
    /** The week's matchups, already ordered by `orderPreviewMatchups`. */
    matchups: PreviewMatchup[];
    /** Optional league name for the cold open. */
    leagueName?: string;
}
export declare function segmentIndexMovers(input: BuildScriptInput): PodcastSegment;
export declare function segmentBigPerformers(input: BuildScriptInput): PodcastSegment;
/**
 * The matchup worth the deep dive: the highest-stakes board.
 *
 * Stakes here is the combination the brief asks for — closest, and
 * highest-scoring — resolved deterministically. A matchup with a real margin
 * and real points on the board outranks one with neither, a tighter margin
 * outranks a looser one, and total points break the tie so a nail-biter
 * between two good teams beats a nail-biter between two bad ones.
 */
export declare function pickMatchupOfWeek(matchups: PreviewMatchup[]): PreviewMatchup | null;
export declare function segmentMatchupOfWeek(input: BuildScriptInput): PodcastSegment;
export interface WaiverNeed {
    team: string;
    player: string;
    shortfall: number;
    points: number;
    projected: number;
}
/**
 * Where each team needs help, evidenced by its own starters.
 *
 * ---- WHY SHORTFALLS AND NOT NAMED PICKUPS ----
 *
 * A recommendation to add a specific free agent needs a free-agent
 * availability feed, and there is none on this path: the ESPN read this
 * pipeline makes returns the league's own box scores, not who is unowned. So
 * this segment reports the holes the week actually exposed — the starters who
 * came in furthest under their own projection — and leaves the name of the
 * replacement to the manager. Inventing an available player would be the one
 * thing this whole pipeline is built not to do.
 *
 * Minimum shortfall so a starter who missed by a point is not called a hole.
 */
export declare const WAIVER_SHORTFALL_FLOOR = 6;
export declare function waiverNeeds(tracked: TrackedPlayer[], limit?: number): WaiverNeed[];
export declare function segmentWaiverLookout(input: BuildScriptInput): PodcastSegment;
export declare const PODCAST_SEGMENT_ORDER: PodcastSegmentKey[];
/**
 * Build the week's four-segment episode.
 *
 * The line order is a cold open, the four segments in order, and a sign-off,
 * alternating Dan and Stu so the stitched audio never plays one voice twice in
 * a row. Callers hand `lines` straight to the synthesis path and `stories` to
 * the Story Reel.
 */
export declare function buildWeeklyPodcastScript(input: BuildScriptInput): WeeklyPodcastScript;
