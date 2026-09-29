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
/**
 * Why a league produced no article, in one word an operator can group by.
 *
 * The message alone is not enough. "Articles show up in some leagues and not
 * others" is answered by counting these, not by reading twelve provider
 * strings: ESPN_AUTH means that league's saved connection no longer
 * authenticates and a member has to reconnect it, which no amount of retrying
 * fixes, while TIMEOUT or PROVIDER_DOWN means try again. They need opposite
 * responses and the raw message buries the difference.
 */
export type CronFailureReason = 'ESPN_AUTH' | 'NO_MATCHUP_DATA' | 'TIMEOUT' | 'PROVIDER_DOWN' | 'STORAGE' | 'OTHER';
export interface CronLeagueResult {
    league_id: string;
    article_type: ArticleType;
    status: CronStatus;
    slug: string;
    error_message: string | null;
    /** Set only on a failure. Null on 'created' and 'skipped'. */
    failure_reason?: CronFailureReason | null;
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
    /** Failures tallied by cause, so one glance says whether this run needs a
     *  retry or needs somebody to reconnect a league. Absent keys are zero. */
    failed_by_reason: Partial<Record<CronFailureReason, number>>;
    dry_run: boolean;
    /** Whether this run was allowed to re-attempt previously failed leagues. */
    force_rerun: boolean;
    /** Leagues re-attempted only because `force_rerun` was set: they hold a row
     *  for this scope AND their last recorded outcome was a failure. Zero on a
     *  normal run. */
    forced: number;
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
    /**
     * Re-attempt the leagues whose last recorded outcome for THIS scope was a
     * failure, even though a row now exists for them.
     *
     * The repair this exists for: a league's stored espn_s2 / SWID expire, ESPN
     * answers 401, `classifyFailure` files it as ESPN_AUTH and the league gets no
     * article. A member reconnects the league in Supabase — and nothing picks the
     * missed story back up, because the next run of this day is a week later and
     * resolves a different week. An operator has to be able to say "that week,
     * that day, again" once the credential is fixed.
     *
     * Deliberately NOT "regenerate everything". A league whose article published
     * cleanly is still skipped: rewriting a story a reader has already opened is
     * the one thing the idempotency check exists to prevent, and a credential
     * repair is no reason to do it. The forced set is exactly the leagues
     * `cron_article_logs` last recorded as failed — missed leagues need no flag,
     * since they hold no row and a plain re-invocation already publishes them.
     */
    force_rerun?: boolean;
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
 * The leagues whose LAST recorded outcome for this scope was a failure.
 *
 * `cron_article_logs` holds one row per league per attempt, so a league that
 * failed on the 08:00 run and published on a repair run has both. Only the
 * latest row counts: anything else would re-attempt a league that has since
 * been fixed and rewrite the story it now holds.
 *
 * Read-only, and tolerant by design. A deployment whose logs table is missing
 * or unreadable gets an empty set and a loud warning rather than a dead run:
 * without the audit trail a forced run simply has nothing extra to attempt,
 * which is the same as a normal run and can never rewrite anything.
 */
export declare function leaguesWithFailedRuns(db: any, scope: {
    season: number;
    week: number;
    article_type: ArticleType;
}): Promise<Set<string>>;
/**
 * Sort one league's failure into a cause.
 *
 * Ordered most specific first. HTTP status is checked before message text
 * because a provider is free to reword its body and not free to change what
 * 401 means. Anything unrecognised stays OTHER rather than being forced into
 * the nearest bucket: a wrong label is worse than an honest unknown, because
 * an operator acts on it.
 */
export declare function classifyFailure(err: any): CronFailureReason;
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
