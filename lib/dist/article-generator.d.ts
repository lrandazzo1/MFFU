/**
 * FSN blog article pipeline: box score in, published `blog_articles` row out.
 *
 * The order is fixed and the math leads:
 *
 *   1. fetch the league's box score JSON for the week
 *   2. run `article-math.ts` to assign strict outcome flags
 *   3. compose title / excerpt / markdown against those flags
 *   4. refuse to publish copy the flags do not support
 *   5. write the record to Supabase
 *
 * Step 4 is the reason the module exists. A language model asked to write
 * about fantasy football will call anyone who scored 30 a hero; the flags are
 * the only thing standing between that instinct and a permanent, indexed page
 * claiming a player won a matchup his team lost.
 *
 * Additive by construction: nothing here reads or rewrites the News Desk
 * generators, the historical pipelines, the leagues table, or the existing
 * file-based `landing/content/blog` ingestion. It owns exactly one new table.
 */
import { type GameSlot, type KickoffIndex, type TrackedPlayer } from './article-math';
export type ArticleDay = 'mon' | 'tue' | 'fri';
export type ArticleType = 'monday_sweat' | 'tuesday_verdict' | 'friday_tnf_preview';
export interface GenerateInput {
    league_id: string;
    season: number;
    week: number;
    day: ArticleDay;
}
/** What gets persisted. Mirrors `supabase/blog_articles.sql` column for column. */
export interface BlogArticleRecord {
    league_id: string;
    slug: string;
    headline: string;
    match_impact_summary: string;
    content: string;
    category: string;
    author: string;
    title: string;
    excerpt: string;
    content_markdown: string;
    article_type: ArticleType;
    season: number;
    week: number;
    /** Trimmed to the four contract fields the schema promises, plus the
     *  evidence a reader can check the flag against. */
    tracked_players: TrackedPlayer[];
    published_at: string;
}
export interface ComposeRequest {
    system_prompt: string;
    user_prompt: string;
    league_id: string;
    season: number;
    week: number;
    day: ArticleDay;
    article_type: ArticleType;
    tracked_players: TrackedPlayer[];
    /** Every starter the math evaluated, not just the featured rows that get
     *  persisted. A preview is a story about MATCHUPS, and the eight featured
     *  rows are scattered across six of them, so a head to head cannot be
     *  reconstructed from `tracked_players` alone. Optional: a composer written
     *  before this field falls back to the featured rows. */
    all_players?: TrackedPlayer[];
    /** The publication clock, in epoch milliseconds.
     *
     *  A preview covers a week that has usually already started: the Thursday
     *  night game is played the evening before the Friday run. Without a clock a
     *  composer cannot tell a projection apart from a result, so it is passed in
     *  rather than read from `Date.now()` inside the composer. Injected for the
     *  same reason `GenerateDependencies.now` is: a given box score plus a given
     *  clock must always compose the same article. */
    now?: number;
}
export interface ArticleDraft {
    title: string;
    excerpt: string;
    content_markdown: string;
    /** Tier 2: the one line callout under the headline. Optional so a composer
     *  written before the three-tier layout still satisfies the type; the
     *  pipeline derives one from the math when a composer omits it, and never
     *  from the composer's prose. */
    match_impact_summary?: string;
    /** The editorial shelf. Defaults to the one this article type belongs to. */
    category?: string;
    /** The byline. Defaults to the desk. */
    author?: string;
}
export type Composer = (request: ComposeRequest) => ArticleDraft | Promise<ArticleDraft>;
export interface GenerateDependencies {
    /** Supabase client. Defaults to a service-role client from the environment. */
    db?: any;
    /** Box score source. Defaults to the ESPN read boundary in `api/espn`. */
    fetchBoxScores?: (input: GenerateInput & {
        req?: any;
    }) => Promise<any>;
    /** Kickoff times by NFL team for this week. Defaults to the public NFL
     *  scoreboard, the same feed the push dispatcher reads. Without it the math
     *  cannot place a starter's points in time and reports no outcome flags. */
    fetchKickoffs?: (input: {
        season: number;
        week: number;
    }) => Promise<KickoffIndex>;
    /** Copy writer. Defaults to the deterministic local composer below, so the
     *  pipeline runs end to end with no model credentials configured. */
    compose?: Composer;
    /** Incoming HTTP request, forwarded to the default ESPN reader for its
     *  cookie / share-token boundary. */
    req?: any;
    /** Publication clock. Injected so tests get a fixed `published_at`. */
    now?: () => number;
}
export interface GenerateResult {
    record: BlogArticleRecord;
    tracked_players: TrackedPlayer[];
    /** Every starter the math looked at, not just the featured ones. */
    evaluated: number;
    stored: boolean;
    /** How many NFL teams the kickoff index covered. Zero means the scoreboard
     *  could not be read and every margin in this article is unresolved, which
     *  is worth seeing in a cron summary rather than inferring from the copy. */
    kickoffs: number;
}
export declare const ARTICLE_TYPE_BY_DAY: Record<ArticleDay, ArticleType>;
/**
 * The framing rule, verbatim. It is handed to the model as a system
 * instruction AND enforced after the fact by `assertOutcomeLanguage`, because
 * an instruction a model can ignore is not a guarantee.
 */
export declare const OUTCOME_FRAMING_RULE: string;
export declare function normalizeInput(input: GenerateInput): GenerateInput;
/** Deterministic and unique: one article per league, season, week and day. A
 *  re-run overwrites its own row instead of stacking duplicates. */
export declare function articleSlug(input: GenerateInput): string;
export declare function buildSystemPrompt(articleType: ArticleType): string;
export declare function buildUserPrompt(request: Omit<ComposeRequest, 'system_prompt' | 'user_prompt'>): string;
/**
 * Reject a draft whose copy overclaims. Checked sentence by sentence so the
 * test is about the player being praised, not about the article containing the
 * word "hero" somewhere.
 *
 * Throws rather than editing: silently rewriting a model's sentence produces
 * copy nobody reviewed, and a thrown error means the row is never written.
 */
export declare function assertOutcomeLanguage(draft: ArticleDraft, tracked: TrackedPlayer[]): void;
export type Archetype = 'PRIMETIME_COMEBACK' | 'RAZOR_THIN_COMEBACK' | 'SINGLE_HANDED_OVERHAUL' | 'HEAVYWEIGHT_BLOWOUT' | 'WASTED_ERUPTION' | 'HEARTBREAK_LOSS' | 'NECESSARY_INSURANCE' | 'STRAIGHT_COMEBACK' | 'GENERAL_SWING';
/**
 * The first archetype whose trigger the row satisfies.
 *
 * Note that PRIMETIME_COMEBACK requires the GAME_WINNER flag and not merely
 * "trailed, then won". Its copy credits the player with erasing the deficit,
 * and only the flag establishes that his own points covered it. Without that
 * check a team could come back on somebody else's points and this would hand
 * the credit to whoever happened to play last, which is the exact overclaim
 * the outcome contract exists to prevent.
 */
export declare function archetypeFor(row: TrackedPlayer): Archetype;
/**
 * Which of the two phrasings this row gets:
 * `(player id + week + rotation index) % 2`.
 *
 * Deterministic, which the whole pipeline requires: a reader who reloads must
 * get the same article. The player id keeps a given player from reading the
 * same way regardless of where he lands, and the week stops him reading
 * identically every week of the season.
 *
 * This is the SEED for an archetype's first appearance. `rotateVariants()`
 * below alternates from it, because adding an index to this sum cannot
 * guarantee anything on its own: see the note there.
 *
 * `player_id` is an ESPN numeric id in practice, but `article-math.ts` falls
 * back to the player's NAME when a payload carries no id, so a non-numeric id
 * is hashed rather than dropped. Coercing it to 0 would hand every unnamed
 * row variant A.
 */
export declare function templateVariant(row: TrackedPlayer, week: number, occurrence?: number): 0 | 1;
/**
 * The phrasing to use for every row of a board, guaranteeing that two bullets
 * of the same archetype never read the same way.
 *
 * ---- WHY THIS IS NOT JUST `(id + week + index) % 2` ----
 *
 * The only repetition a reader notices is two bullets of the SAME archetype
 * reading alike; two different archetypes are different sentences whichever
 * variant they draw. Adding an index to the per-row sum cannot guarantee that
 * pair differs, because a difference in id parity simply cancels it. Both
 * shapes of index were measured against a real week 2 board of four
 * game-winners:
 *
 *   board position      CeeDee Lamb (row 1) and Dak Prescott (row 3) are two
 *                       apart, so their indices share a parity and their odd
 *                       ids share one too: both flipped together, both stayed
 *                       identical. 3 distinct shapes of 4.
 *   archetype occurrence  fixed that pair, and broke the other one: Davante
 *                       Adams (even id, occurrence 0) and Patrick Mahomes
 *                       (odd id, occurrence 1) cancelled to the same variant.
 *                       Still 3 of 4.
 *
 * So the id seeds each archetype's FIRST appearance and the rest alternate
 * strictly from there. Consecutive appearances then differ by construction
 * rather than by arithmetic luck, while the seed keeps the choice varying by
 * player and by week. 4 of 4 on the same board.
 */
export declare function rotateVariants(board: TrackedPlayer[], week: number): Array<0 | 1>;
/**
 * One row, framed by its archetype.
 *
 * Every entity is emboldened: the player, both fantasy teams, the points (with
 * "pts"), and the deficit and margin as two-decimal figures. `lbMarkdown()` in
 * index.html renders `**x**` as <strong>, and its pattern is
 * `\*\*([^*]+)\*\*`, so a value containing an asterisk simply would not
 * embolden rather than corrupting the line.
 *
 * Exported because it IS the framing contract: `OUTCOME_FRAMING_RULE` tells a
 * model what compliant copy reads like, and this is the executable version of
 * the same thing.
 */
export declare function sentenceFor(row: TrackedPlayer, week?: number, variant?: 0 | 1): string;
/** The rows that actually turned a matchup. What the headline counts, and
 *  what the callout is allowed to choose from. */
export declare function decisiveRows(rows: TrackedPlayer[]): TrackedPlayer[];
export declare function boardRows(rows: TrackedPlayer[], limit?: number): TrackedPlayer[];
export type LiveState = 'PENDING' | 'LIVE' | 'FINAL' | 'UNKNOWN';
/** How long after kickoff a game is still treated as running. Four hours
 *  covers regulation, overtime, and the stat corrections that trail a game.
 *  Erring long is the safe direction: calling a finished game LIVE understates
 *  a number that is already settled, while calling a running game FINAL
 *  asserts a result that can still move. */
export declare const GAME_WINDOW_MS: number;
export declare function liveStateOf(row: TrackedPlayer, now?: number | null): LiveState;
/** Whether this starter's points are on the board yet. */
export declare function hasPlayed(row: TrackedPlayer, now?: number | null): boolean;
export interface PreviewSide {
    team: string;
    starters: TrackedPlayer[];
    /** Starters whose games have begun, and those still to kick off. */
    played: TrackedPlayer[];
    pending: TrackedPlayer[];
    /** Sum of the projections the payload carried. Null when it carried none:
     *  zero would read as "projected to score nothing", which is a claim. */
    projected: number | null;
    /** Points already banked by the starters whose games have begun. */
    scored: number;
    /** This side's CURRENT matchup margin, summed off the board rather than read
     *  from the payload's side total. Positive is a lead, null before anyone has
     *  played. Mid week it is a running number, which is why nothing below calls
     *  it final.
     *
     *  ---- WHY NOT `final_margin` ----
     *
     *  `TrackedPlayer.final_margin` is `side.total - opponent.total`, and ESPN's
     *  fantasy endpoint reports both totals as 0 for a matchup period that has
     *  not closed. Every row of a real week 3 payload came back
     *  `final_margin: 0` while Bijan Robinson sat on 36.30 from Thursday night,
     *  so a preview that trusted it would have called every live matchup dead
     *  level. Starters are the only thing that scores in fantasy and the whole
     *  evaluated board is in hand, so the difference of the points already
     *  banked IS the margin, and it is built from per player numbers that the
     *  payload does get right. */
    margin: number | null;
}
export interface PreviewMatchup {
    matchup_id: string;
    a: PreviewSide;
    b: PreviewSide;
    /** True once either side has a starter on the board. */
    live: boolean;
    /** True only when a real clock reports every starter on both sides FINAL,
     *  AND both sides field a plausible lineup. Without a clock this stays
     *  false: "the board is in" is a result claim, and points alone cannot
     *  establish that a game is over. See `MIN_COMPLETE_ROSTER`. */
    complete: boolean;
    /** Starters yet to kick off, across both sides. */
    remaining: number;
    /** The current margin as a positive number. Null when nothing resolves one. */
    margin: number | null;
    /** The projected margin as a positive number. */
    projected_margin: number | null;
}
/**
 * The week's head to head pairings, built from the starter rows.
 *
 * A group that does not resolve to exactly two sides is skipped rather than
 * half told: one side is a bye or an unparsed half of a matchup, and more than
 * two means the payload grouped something this code does not understand.
 * Neither is a head to head, so neither gets a head to head story invented
 * for it.
 */
export declare function previewMatchups(rows: TrackedPlayer[], now?: number | null): PreviewMatchup[];
/**
 * The order the slate reads in: what is already happening, tightest first,
 * then what is still to come, tightest first.
 *
 * Deterministic throughout. Every tie falls through to the matchup id, so the
 * same box score and the same clock always order the board the same way.
 */
export declare function orderPreviewMatchups(matchups: PreviewMatchup[]): PreviewMatchup[];
export interface LeadSwing {
    team: string;
    /** How far behind this side was, as a positive number. */
    from: number;
    /** How far ahead it is now, as a positive number. */
    to: number;
    /** The kickoff window the lead changed hands in. */
    window: GameSlot;
}
/**
 * The last time this side's matchup lead actually changed hands.
 *
 * Built from margins the math already recorded. Every starter carries the
 * margin his side held when HIS game kicked off, so the distinct kickoffs on
 * one side, in order, plus the current margin, are that side's whole
 * trajectory through the week. A sign flip between two consecutive points on
 * it is a lead change.
 *
 * It is credited to the WINDOW it happened in and never to a player: several
 * starters kick off together and nothing here can say which of them did it.
 * Handing one man the credit is the exact overclaim the outcome contract
 * exists to prevent, and `assertOutcomeLanguage` would be right to throw on
 * it.
 *
 * Null when a margin is missing, when there is no trajectory to read, or when
 * the lead simply never changed. A preview never invents one: a side that led
 * from the first whistle has no swing to report, and saying so falsely is
 * worse than saying nothing.
 */
export declare function leadSwing(side: PreviewSide): LeadSwing | null;
/**
 * One matchup, told as a story.
 *
 * A live block leads with the standing, then the number that produced it, then
 * either the lead change it came out of or what is still to come. A block
 * nobody has played yet leads with the gap and names the two performances the
 * gap rests on.
 */
export declare function previewBlock(m: PreviewMatchup, variant: 0 | 1, now?: number | null): string[];
export declare const CATEGORY_BY_TYPE: Record<ArticleType, string>;
export declare const DEFAULT_AUTHOR = "FSN News Desk";
/**
 * Tier 2: what one performance meant to one matchup, in a single line.
 *
 * Derived from the flag and nothing else, exactly like the body sentences. The
 * grammar is fixed per flag, so the callout can never say more than the math
 * supports: only GAME_WINNER gets "just enough", and a big score in a loss is
 * "not enough" rather than anything warmer.
 */
export declare function impactSummary(rows: TrackedPlayer[], articleType: ArticleType, options?: {
    now?: number | null;
    slate?: TrackedPlayer[];
}): string;
export declare const defaultComposer: Composer;
/** Service-role client. Browsers never hold this key: the article pipeline is
 *  a server-side job, same boundary as `/api/league` and the transaction wire. */
export declare function database(): any;
/**
 * Generate one league blog article for a day and publish it.
 *
 * Throws on a bad input, an unreadable box score, copy that overclaims, or a
 * failed write. Nothing is swallowed: a caller that gets a resolved promise
 * has a row in `blog_articles`.
 */
export declare function generateAndPublishBlogArticle(input: GenerateInput, dependencies?: GenerateDependencies): Promise<GenerateResult>;
