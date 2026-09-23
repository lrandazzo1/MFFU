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
import { type TrackedPlayer } from './article-math';
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
export declare const CATEGORY_BY_TYPE: Record<ArticleType, string>;
export declare const DEFAULT_AUTHOR = "FFU News Desk";
/**
 * Tier 2: what one performance meant to one matchup, in a single line.
 *
 * Derived from the flag and nothing else, exactly like the body sentences. The
 * grammar is fixed per flag, so the callout can never say more than the math
 * supports: only GAME_WINNER gets "just enough", and a big score in a loss is
 * "not enough" rather than anything warmer.
 */
export declare function impactSummary(rows: TrackedPlayer[], articleType: ArticleType): string;
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
