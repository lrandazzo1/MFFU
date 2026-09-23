/* ============================================================================
   FSN LEAGUE BLOG — SCHEDULED GENERATION — /api/cron/generate-articles

   Publishes one blog article per active league, three mornings a week.

     ?day=mon   monday_sweat        recaps the Sunday slate, previews MNF
     ?day=tue   tuesday_verdict     recaps the Monday night final
     ?day=fri   friday_tnf_preview  recaps TNF, previews the weekend slate

   ---- AUTH ----

   `CRON_SECRET` must be set, presented either as `Authorization: Bearer
   $CRON_SECRET` (what Vercel attaches to its own scheduled invocations) or as
   `x-cron-secret` (what the GitHub Actions schedule sends). The comparison is
   constant time. With no secret configured the route refuses to run rather
   than defaulting open: an unauthenticated "write an article for every league"
   endpoint is not something to leave to chance.

   ---- WHICH WEEK ----

   Resolved from the shared NFL schedule feed, the same cached row the push
   dispatcher reads, so this route costs no extra upstream request on a normal
   run. That feed reports the week ESPN currently considers live, which is what
   each of these three mornings actually wants:

     Monday and Tuesday   ESPN still reports the week whose games just played,
                          so both recap that week.
     Friday               ESPN has rolled to the new week, whose Thursday night
                          game was played the evening before.

   `?season=` and `?week=` override it for a backfill. `?dry_run=1` resolves
   the league list and the idempotency check and returns what WOULD be written
   without generating, publishing, or logging anything.

   ---- WHAT IT GUARANTEES ----

   Idempotent: a league that already has this week's article of this type is
   skipped, never rewritten, so a retry or a double fire costs nothing and no
   reader ever sees a story change under them.

   One league's failure never stops the others. Every league's outcome, good or
   bad, lands in `cron_article_logs`.
============================================================================ */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const scheduleFeed = require('../../lib/notifications/schedule-feed');
const {
  runArticleCron,
  normalizeDay,
  authorizedByCronSecret,
  cronSecretConfigured,
} = require('../../lib/dist/article-cron');

function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) }) },
  });
}

function queryParam(req, name) {
  const value = req && req.query && req.query[name];
  if (Array.isArray(value)) return String(value[0] == null ? '' : value[0]);
  return String(value == null ? '' : value);
}

function flag(req, name) {
  const value = queryParam(req, name).trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function intParam(req, name) {
  const raw = queryParam(req, name).trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : NaN;
}

/* The season and week to write about. An explicit override wins; otherwise the
   shared schedule feed answers. A feed that cannot answer is a hard stop: a
   guessed week would publish this week's story under last week's number and
   defeat the idempotency check for both. */
async function resolveScope(supabase, req, now) {
  const season = intParam(req, 'season');
  const week = intParam(req, 'week');
  if (Number.isNaN(season) || Number.isNaN(week)) {
    throw Object.assign(new Error('season and week must be whole numbers'), { status: 400 });
  }
  if (season != null && week != null) return { season, week, source: 'override' };

  let snapshot = null;
  try {
    snapshot = await scheduleFeed.refresh(supabase, now);
  } catch (err) {
    console.error('[ArticleCron] the NFL schedule feed could not be read; no week to publish for', err);
    throw Object.assign(new Error('The current NFL week could not be resolved'), { status: 503 });
  }

  const resolvedSeason = season != null ? season : Number(snapshot && snapshot.seasonYear);
  const resolvedWeek = week != null ? week : Number(snapshot && snapshot.week);
  if (!Number.isInteger(resolvedSeason) || !Number.isInteger(resolvedWeek) || resolvedWeek < 1) {
    console.error(
      '[ArticleCron] the schedule feed returned no usable season/week ' +
        '(season ' + String(snapshot && snapshot.seasonYear) + ', week ' + String(snapshot && snapshot.week) + ')',
      new Error('WEEK_UNRESOLVED'),
    );
    throw Object.assign(new Error('The current NFL week could not be resolved'), { status: 503 });
  }
  return { season: resolvedSeason, week: resolvedWeek, source: 'schedule-feed' };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  if (!authorizedByCronSecret(req)) {
    if (!cronSecretConfigured()) {
      console.error(
        '[ArticleCron] refused: CRON_SECRET is not set in this environment, so the route ' +
          'cannot authenticate its caller and will not generate anything.',
        new Error('CRON_SECRET_MISSING'),
      );
    }
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  let day;
  try {
    day = normalizeDay(queryParam(req, 'day'));
  } catch (err) {
    res.status(400).json({ error: 'INVALID_DAY', message: err.message });
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    console.error(
      '[ArticleCron] cannot reach Supabase: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is ' +
        'missing from the environment.',
      new Error('SUPABASE_NOT_CONFIGURED'),
    );
    res.status(503).json({ error: 'STORAGE_NOT_CONFIGURED' });
    return;
  }

  const now = Date.now();
  let scope;
  try {
    scope = await resolveScope(supabase, req, now);
  } catch (err) {
    res.status(err.status || 500).json({ error: 'WEEK_UNRESOLVED', message: err.message });
    return;
  }

  try {
    const summary = await runArticleCron(
      {
        day,
        season: scope.season,
        week: scope.week,
        dry_run: flag(req, 'dry_run'),
        run_id: `${scope.season}-w${scope.week}-${day}-${new Date(now).toISOString().slice(0, 10)}`,
        /* The function is configured for a 60s maxDuration in vercel.json and
           is killed at it with no chance to respond. Stop starting leagues at
           50s so the summary and the audit rows for the leagues that DID run
           survive. Anything left over is picked up by the next run, which
           still finds no article for it. */
        budget_ms: 50000,
      },
      { db: supabase, req },
    );
    // A run that reached every league still reports per-league failures, so the
    // caller (and the workflow) can see partial success rather than a bare 200.
    res.status(200).json({
      ok: summary.failed === 0 && summary.not_attempted === 0,
      week_source: scope.source,
      ...summary,
    });
  } catch (err) {
    console.error(
      '[ArticleCron] the ' + day + ' run could not start for ' + scope.season + ' week ' + scope.week,
      err,
    );
    res.status(err.status || 500).json({ error: 'RUN_FAILED', message: err.message });
  }
}

module.exports = handler;
module.exports.default = handler;
