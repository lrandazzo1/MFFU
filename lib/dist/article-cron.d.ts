/**
 * Scheduled fan-out for the league blog.
 *
 * Three times a week a scheduler calls `/api/cron/generate-articles?day=…`.
 * This module is everything that route does apart from speaking HTTP, kept
 * separate so the loop, the idempotency check, the audit trail and the secret
 * comparison are all unit-testable without standing up a server.
 *
 * The contract that matters: ONE league's failure never stops the others.
 * Every league is generated inside its own try, its outcome is written to
 * `cron_article_logs` whether it succeeded or not, and the run continues.
 *
 * Additive: it reads `leagues`, reads `blog_articles`, and writes
 * `blog_articles` (through the generator) and `cron_article_logs`. It changes
 * no existing table and no existing route.
 */
import { generateAndPublishBlogArticle, type ArticleDay, type ArticleType, type GenerateDependencies } from './article-generator';
export type CronStatus = 'created' | 'skipped' | 'failed';
export interface CronLeagueResult {
    league_id: string;
    article_type: ArticleType;
    status: CronStatus;
    slug: string;
    error_message: string | null;
}
export interface CronRunSummary {
    day: ArticleDay;
    article_type: ArticleType;
    season: number;
    week: number;
    run_id: string;
    leagues: number;
    created: number;
    skipped: number;
    failed: number;
    /** Leagues the run never got to before its time budget ran out. They are not
     *  lost: the next scheduled run finds no article for them and publishes. */
    not_attempted: number;
    dry_run: boolean;
    results: CronLeagueResult[];
}
export interface CronRunInput {
    day: ArticleDay;
    season: number;
    week: number;
    /** Resolve the league list and the idempotency check, then stop. Nothing is
     *  generated and nothing is written, including the audit rows. */
    dry_run?: boolean;
    /** Identifies one invocation across every audit row it writes. */
    run_id?: string;
    /** Stop starting new leagues once this many milliseconds have elapsed. A
     *  serverless invocation is killed at its maxDuration with no chance to
     *  report, so the route leaves itself a margin and returns an honest
     *  summary instead. Omit for no limit. */
    budget_ms?: number;
}
export interface CronDependencies extends GenerateDependencies {
    /** Overrides the `leagues` sweep. Useful for a backfill or a test. */
    listLeagues?: (db: any, season: number) => Promise<string[]>;
    /** Swapped in tests; production calls the real publisher. */
    generate?: typeof generateAndPublishBlogArticle;
    /** Clock for the time budget. Injected so tests are not timing-dependent. */
    now?: () => number;
}
/**
 * True only for a caller presenting the configured `CRON_SECRET`.
 *
 * With no secret set the answer is always false. A scheduled route that
 * defaults open is a public "generate articles for every league" button, so an
 * unconfigured environment refuses to run rather than guessing.
 *
 * Vercel attaches `Authorization: Bearer $CRON_SECRET` to its own scheduled
 * invocations; `x-cron-secret` is accepted so an external scheduler (the
 * GitHub Actions workflow) can authenticate the same way.
 */
export declare function authorizedByCronSecret(req: any): boolean;
export declare function cronSecretConfigured(): boolean;
export declare function normalizeDay(value: unknown): ArticleDay;
/**
 * Every league the app is actively tracking for this season.
 *
 * `public.leagues` is keyed by (league_id, season_year) and a row exists only
 * because a verified member of that league saved it, so a row for the current
 * season IS the definition of active. Distinct because a league can hold rows
 * for several seasons.
 */
export declare function activeLeagueIds(db: any, season: number): Promise<string[]>;
/**
 * The leagues that already hold this week's article of this type.
 *
 * One query for the whole run rather than one per league: the fan-out is the
 * expensive part and there is no reason to pay a round trip to learn there is
 * nothing to do.
 */
export declare function leaguesAlreadyPublished(db: any, scope: {
    season: number;
    week: number;
    article_type: ArticleType;
}): Promise<Set<string>>;
/**
 * Generate and publish this day's article for every active league that does
 * not already have one.
 *
 * Never throws on a per-league problem. It throws only when the run itself
 * cannot start: a bad day, an unreadable league list, an unreadable
 * `blog_articles` (without which "already published" is unknowable and a
 * second run would republish every league).
 */
export declare function runArticleCron(input: CronRunInput, dependencies?: CronDependencies): Promise<CronRunSummary>;
