"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorizedByCronSecret = authorizedByCronSecret;
exports.cronSecretConfigured = cronSecretConfigured;
exports.normalizeDay = normalizeDay;
exports.activeLeagueIds = activeLeagueIds;
exports.leaguesAlreadyPublished = leaguesAlreadyPublished;
exports.classifyFailure = classifyFailure;
exports.runArticleCron = runArticleCron;
const article_generator_1 = require("./article-generator");
/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */
/** Constant-time compare so the secret cannot be recovered a byte at a time.
 *  Same construction the notifications dispatcher uses. */
function secretMatches(presented, expected) {
    const a = Buffer.from(String(presented || ''), 'utf8');
    const b = Buffer.from(String(expected || ''), 'utf8');
    if (a.length !== b.length || a.length === 0)
        return false;
    return require('crypto').timingSafeEqual(a, b);
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
function authorizedByCronSecret(req) {
    const expected = String(process.env.CRON_SECRET || '').trim();
    if (!expected)
        return false;
    const headers = (req && req.headers) || {};
    const header = String(headers.authorization || '');
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const direct = String(headers['x-cron-secret'] || '');
    return secretMatches(bearer, expected) || secretMatches(direct, expected);
}
function cronSecretConfigured() {
    return !!String(process.env.CRON_SECRET || '').trim();
}
/* ------------------------------------------------------------------ *
 * Scope
 * ------------------------------------------------------------------ */
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function normalizeDay(value) {
    const day = String(value == null ? '' : value).trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(article_generator_1.ARTICLE_TYPE_BY_DAY, day)) {
        throw fail("Invalid day (expected 'mon', 'tue' or 'fri')");
    }
    return day;
}
/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */
/**
 * Every league the app is actively tracking for this season.
 *
 * `public.leagues` is keyed by (league_id, season_year) and a row exists only
 * because a verified member of that league saved it, so a row for the current
 * season IS the definition of active. Distinct because a league can hold rows
 * for several seasons.
 */
async function activeLeagueIds(db, season) {
    const result = await db
        .from('leagues')
        .select('league_id')
        .eq('season_year', season)
        .order('league_id', { ascending: true });
    if (result.error)
        throw result.error;
    const seen = new Set();
    for (const row of result.data || []) {
        const id = row && row.league_id == null ? '' : String(row.league_id).trim();
        if (id)
            seen.add(id);
    }
    return [...seen];
}
/**
 * The leagues that already hold this week's article of this type.
 *
 * One query for the whole run rather than one per league: the fan-out is the
 * expensive part and there is no reason to pay a round trip to learn there is
 * nothing to do.
 */
async function leaguesAlreadyPublished(db, scope) {
    const result = await db
        .from('blog_articles')
        .select('league_id')
        .eq('season', scope.season)
        .eq('week', scope.week)
        .eq('article_type', scope.article_type);
    if (result.error)
        throw result.error;
    const seen = new Set();
    for (const row of result.data || []) {
        if (row && row.league_id != null)
            seen.add(String(row.league_id));
    }
    return seen;
}
/* ------------------------------------------------------------------ *
 * The audit trail
 * ------------------------------------------------------------------ */
/**
 * Record one league's outcome.
 *
 * A failure to write the audit row is logged and swallowed on purpose: losing
 * a log line must never cost the remaining leagues their articles. It is the
 * one place in this pipeline where swallowing is the correct call, and it is
 * still loud.
 */
async function recordOutcome(db, row) {
    try {
        const result = await db.from('cron_article_logs').insert({
            league_id: row.league_id,
            article_type: row.article_type,
            status: row.status,
            error_message: row.error_message,
            failure_reason: row.failure_reason || null,
            season: row.season,
            week: row.week,
            slug: row.slug,
            run_id: row.run_id,
        });
        if (result && result.error)
            throw result.error;
    }
    catch (err) {
        console.error('[ArticleCron] audit write failed for ' + row.league_id + ' (' + row.status + '); ' +
            'the run continues without it', err);
    }
}
/**
 * Sort one league's failure into a cause.
 *
 * Ordered most specific first. HTTP status is checked before message text
 * because a provider is free to reword its body and not free to change what
 * 401 means. Anything unrecognised stays OTHER rather than being forced into
 * the nearest bucket: a wrong label is worse than an honest unknown, because
 * an operator acts on it.
 */
function classifyFailure(err) {
    const status = Number(err && err.status) || 0;
    const text = String((err && err.message) || err || '').toLowerCase();
    if (status === 401 || status === 403)
        return 'ESPN_AUTH';
    if (status === 408 || status === 504)
        return 'TIMEOUT';
    if (status === 429 || (status >= 500 && status < 600))
        return 'PROVIDER_DOWN';
    if (/\b(401|403|unauthor|forbidden|not authenticated|cookie|espn_s2|swid|credential)\b/.test(text)) {
        return 'ESPN_AUTH';
    }
    if (/\b(timed out|timeout|etimedout|aborted|abort)\b/.test(text))
        return 'TIMEOUT';
    if (/\b(no matchup|no completed|no box score|missing (?:matchup|schedule|score)|empty schedule|not been played)\b/.test(text)) {
        return 'NO_MATCHUP_DATA';
    }
    if (/\b(supabase|postgrest|database|storage)\b/.test(text))
        return 'STORAGE';
    return 'OTHER';
}
/** What an operator should do about each cause, said in the log line itself so
 *  nobody has to come back to this file to interpret one. */
const REASON_HINT = {
    ESPN_AUTH: 'ESPN rejected this league\'s stored connection, so a member has to reconnect it',
    NO_MATCHUP_DATA: 'the week has no completed matchup data to write about yet',
    TIMEOUT: 'the provider read ran out of time and is worth retrying',
    PROVIDER_DOWN: 'the provider answered with an error of its own and is worth retrying',
    STORAGE: 'the article could not be stored, so the database is the thing to look at',
    OTHER: 'an unrecognised failure, so read the message',
};
/** Keep a provider's error readable in a text column without truncating the
 *  part an operator actually needs. */
function errorMessage(err) {
    const status = err && err.status ? ' (status ' + err.status + ')' : '';
    const code = err && err.code ? ' [' + err.code + ']' : '';
    return (String((err && err.message) || err || 'Unknown error') + status + code).slice(0, 500);
}
/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */
/**
 * Generate and publish this day's article for every active league that does
 * not already have one.
 *
 * Never throws on a per-league problem. It throws only when the run itself
 * cannot start: a bad day, an unreadable league list, an unreadable
 * `blog_articles` (without which "already published" is unknowable and a
 * second run would republish every league).
 */
async function runArticleCron(input, dependencies = {}) {
    const day = normalizeDay(input.day);
    const articleType = article_generator_1.ARTICLE_TYPE_BY_DAY[day];
    const season = Number(input.season);
    const week = Number(input.week);
    if (!Number.isInteger(season) || season < 1990 || season > 2100)
        throw fail('Invalid season');
    if (!Number.isInteger(week) || week < 1 || week > 18)
        throw fail('Invalid week');
    const dryRun = !!input.dry_run;
    const runId = String(input.run_id || `${season}-w${week}-${day}`);
    const db = dependencies.db;
    if (!db)
        throw fail('Blog article storage is not configured', 503);
    const leagueIds = await (dependencies.listLeagues || activeLeagueIds)(db, season);
    const published = await leaguesAlreadyPublished(db, { season, week, article_type: articleType });
    const summary = {
        day, article_type: articleType, season, week, run_id: runId,
        leagues: leagueIds.length, created: 0, skipped: 0, failed: 0, not_attempted: 0,
        failed_by_reason: {}, dry_run: dryRun, results: [],
    };
    if (!leagueIds.length) {
        console.warn('[ArticleCron] no active leagues for season ' + season + '; nothing to publish for ' + runId, new Error('NO_ACTIVE_LEAGUES'));
        return summary;
    }
    const generate = dependencies.generate || article_generator_1.generateAndPublishBlogArticle;
    const clock = dependencies.now || Date.now;
    const startedAt = clock();
    const budget = Number(input.budget_ms);
    const outOfTime = () => Number.isFinite(budget) && budget > 0 && clock() - startedAt >= budget;
    for (let index = 0; index < leagueIds.length; index++) {
        const league_id = leagueIds[index];
        if (outOfTime()) {
            summary.not_attempted = leagueIds.length - index;
            console.warn('[ArticleCron] time budget spent after ' + index + ' of ' + leagueIds.length +
                ' leagues on ' + runId + '; the remaining ' + summary.not_attempted +
                ' are left for the next run, which will still find no article for them', new Error('BUDGET_EXHAUSTED'));
            break;
        }
        const slug = (0, article_generator_1.articleSlug)({ league_id, season, week, day });
        const result = {
            league_id, article_type: articleType, status: 'skipped', slug,
            error_message: null, failure_reason: null,
        };
        if (published.has(league_id)) {
            // Already written by an earlier run. Re-generating would rewrite a story
            // a reader may have already seen, so it is left exactly as it is.
            summary.skipped++;
            summary.results.push(result);
            if (!dryRun)
                await recordOutcome(db, { ...result, season, week, run_id: runId });
            continue;
        }
        if (dryRun) {
            result.status = 'created';
            summary.created++;
            summary.results.push(result);
            continue;
        }
        try {
            await generate({ league_id, season, week, day }, dependencies);
            result.status = 'created';
            summary.created++;
        }
        catch (err) {
            // The whole point of the loop: this league is lost, the rest are not.
            const reason = classifyFailure(err);
            console.error('[ArticleCron] ' + articleType + ' generation failed for league ' + league_id +
                ' (' + season + ' week ' + week + ') with reason ' + reason + ': ' + REASON_HINT[reason] +
                '. Continuing with the remaining ' + (leagueIds.length - index - 1) + ' league(s)', err);
            result.status = 'failed';
            result.error_message = errorMessage(err);
            result.failure_reason = reason;
            summary.failed++;
            summary.failed_by_reason[reason] = (summary.failed_by_reason[reason] || 0) + 1;
        }
        summary.results.push(result);
        await recordOutcome(db, { ...result, season, week, run_id: runId });
    }
    /* One line that answers "why do only some leagues have articles". Without
       it the answer is twelve scattered per-league errors nobody reads, and a
       run where every league failed for the same fixable reason looks the same
       as a run where each failed differently. */
    if (summary.failed) {
        const tally = Object.keys(summary.failed_by_reason)
            .map((reason) => reason + '=' + summary.failed_by_reason[reason])
            .sort()
            .join(' ');
        console.warn('[ArticleCron] ' + runId + ': ' + summary.created + ' created, ' + summary.skipped +
            ' already published, ' + summary.failed + ' failed of ' + leagueIds.length +
            ' league(s). Failures by cause: ' + tally + '.' +
            (summary.failed_by_reason.ESPN_AUTH
                ? ' ' + summary.failed_by_reason.ESPN_AUTH + ' league(s) need a member to reconnect ESPN; ' +
                    'retrying the run will not produce their articles.'
                : ''), new Error('LEAGUES_WITHOUT_ARTICLES'));
    }
    return summary;
}
