#!/usr/bin/env node
/* ============================================================================
   FSN — LEAGUE BLOG ARTICLE REPUBLISH

   `node scripts/rerun-league-articles.mjs --season=2026 --week=3 --day=mon --force`

   Regenerates one day's league blog article for every active league and writes
   it to `blog_articles`, running the generator IN THIS PROCESS against the
   checked-out code.

   ---- WHY NOT JUST CALL THE CRON ROUTE ----

   .github/workflows/generate-articles.yml and the Week 3 repair runner both
   POST to /api/cron/generate-articles, which is the right thing on a normal
   morning: production owns the schedule, the idempotency check and the audit
   trail. It has one property that makes it useless for a repair, though. The
   copy it publishes is whatever composer is DEPLOYED, so a fix to the
   generator cannot reach a reader until production has been redeployed. When
   the deploy is the thing you are waiting on (a Vercel daily deployment cap,
   for one), every republish through that route rewrites the same stale story.

   This runner closes that gap. It imports the composer out of `lib/dist`, so
   the article is written by the code at this commit, and it upserts through
   the same `generateAndPublishBlogArticle` the route calls, so the row that
   lands is byte for byte the row the next scheduled run would have written.

   ---- WHY NOT DELETE FIRST ----

   The cron route SKIPS a league that already has the week's article, which is
   why a repair through it has to delete the row first and leaves the league
   with nothing published in between. `generateAndPublishBlogArticle` upserts
   on the slug, so calling it directly replaces the row in place: no gap, and
   no window where a reader opens the desk to an empty week.

   ---- HOW IT READS ESPN ----

   Through the deployed /api/espn relay, never ESPN directly. That relay is the
   one place the league's stored SWID / espn_s2 envelope is decrypted, and it
   only attaches it to a caller presenting that league's own share token. The
   token is read from `public.leagues` with the service-role key, alongside the
   league list, so a private league is read with its own session rather than
   anonymously (which ESPN answers with a 401).

   TWO ATTEMPTS, IN THAT ORDER, because the token is not strictly better than
   going without. The relay treats a token-bearing request as a reader with no
   ESPN account of their own, so it will NOT fall back to the deployment-wide
   session if the stored envelope is stale: the read is refused rather than
   retried anonymously, by design. A league whose host has re-authenticated
   since the envelope was stored therefore reads fine WITHOUT the token and
   fails WITH it, which is exactly how league 1915228840 behaved. So the
   league's own session is tried first, and a refusal falls back to the read
   with no token, which lets the relay resolve whatever deployment-wide
   credential it holds. A league that neither can read is reported, not
   guessed at.

   The relay is deployed code and is not the thing being fixed here: it proxies
   a box score, it does not compose an article.

   ---- WHAT IT REFUSES TO DO ----

     * `--force` is required. There is no accidental invocation.
     * Season, week and day are validated before anything is read or written.
     * One league's failure never stops the others, every league's outcome is
       printed, and the exit code is non-zero if any of them failed.

   ---- --force-rerun: THE POST-CREDENTIAL REPAIR ----

   Without it this runner rewrites every league it is pointed at, which is the
   right blunt instrument when the COMPOSER is what changed. It is the wrong one
   after a credential fix: a league whose espn_s2 / SWID expired failed with a
   401 and holds no story, while its twelve neighbours published fine hours
   earlier and have readers. Rewriting those twelve to repair one is exactly the
   trade the idempotency check exists to refuse.

   `--force-rerun` narrows the run to the leagues that actually missed: the ones
   holding no `blog_articles` row for this scope, plus the ones whose LAST
   recorded outcome in `cron_article_logs` for this scope was a failure. Every
   league that published cleanly is listed as untouched and left alone. It reads
   both tables directly rather than trusting a flag, so a league fixed by an
   earlier repair is not re-attempted a second time.

   Options:
     --season=<year>    Required. 1990-2100.
     --week=<1-18>      Required.
     --day=<mon|tue|fri>  Required. Maps to the article type, same as the cron.
     --leagues=<a,b,c>  Optional. Defaults to every league in `leagues` for the
                        season. Ids only, digits.
     --base=<url>       The deployed relay. Defaults to the production app.
     --force            Required to write.
     --force-rerun      Only publish the leagues that are missing this scope's
                        article or whose last recorded outcome was a failure.
                        The mode to use after updating expired ESPN cookies.
     --self-test        Offline check of the guards and the relay URL. Writes
                        nothing and reads nothing.

   Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
============================================================================ */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const DEFAULT_BASE = 'https://app.fantasysportsnetwork.app';
const ESPN_HOST = 'https://lm-api-reads.fantasy.espn.com';
const DAYS = ['mon', 'tue', 'fri'];

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => arg.slice(2).split(/=(.*)/s).slice(0, 2)),
);
const flag = (name) => process.argv.includes('--' + name);

/** The box score URL the pipeline reads, and the relay call that carries this
 *  league's own stored session to it. Kept in one place so the self-test can
 *  assert the shape without a network. */
export function boxScoreUrl(leagueId, season, week) {
  return `${ESPN_HOST}/apis/v3/games/ffl/seasons/${season}` +
    `/segments/0/leagues/${leagueId}?scoringPeriodId=${week}` +
    '&view=mMatchupScore&view=mBoxscore&view=mRoster&view=mTeam';
}

export function relayUrl(base, leagueId, season, week) {
  return `${String(base).replace(/\/+$/, '')}/api/espn?url=` +
    encodeURIComponent(boxScoreUrl(leagueId, season, week));
}

/**
 * The credential attempts for one league, in the order they are made.
 *
 * The league's own stored session first, then the relay's own resolution with
 * no token at all. See the note above for why the second is not redundant.
 */
export function credentialAttempts(token) {
  const own = String(token == null ? '' : token).trim();
  return own ? [{ label: 'league share token', token: own }, { label: 'no token', token: '' }]
    : [{ label: 'no token', token: '' }];
}

/**
 * The leagues a `--force-rerun` pass should publish, out of the leagues asked
 * for, the article rows that exist, and the recorded outcomes.
 *
 * `logs` arrives oldest-first, so the last row seen for a league is its latest
 * outcome — a league that failed at 08:00 and was repaired at 10:00 is NOT a
 * target. Pure, so the self-test can assert the decision without a database.
 */
export function repairTargets(leagueIds, publishedIds, logs) {
  const published = new Set((publishedIds || []).map((id) => String(id)));
  const latest = new Map();
  for (const row of logs || []) {
    if (!row || row.league_id == null) continue;
    latest.set(String(row.league_id), String(row.status || ''));
  }
  const targets = [];
  const untouched = [];
  for (const id of leagueIds) {
    const key = String(id);
    /* No row at all is the plain "missed" case and needs no log to justify it.
       A row plus a failed last outcome is the degraded case. Anything else
       published cleanly and is left exactly as it is. */
    if (!published.has(key) || latest.get(key) === 'failed') targets.push(key);
    else untouched.push(key);
  }
  return { targets, untouched };
}

/** True for the statuses that mean "ESPN would not accept this identity", which
 *  is the one failure no retry of this script can fix. Reported separately so a
 *  run says which leagues need a member to reconnect rather than burying it in
 *  a per-league stack trace. */
export function isAuthFailureStatus(status) {
  return Number(status) === 401 || Number(status) === 403;
}

/** Throws with the reason rather than returning a default: a scope this script
 *  cannot state exactly is a scope it must not write under. */
export function resolveScope(input) {
  const season = Number(input.season);
  const week = Number(input.week);
  const day = String(input.day || '');
  assert.ok(Number.isInteger(season) && season >= 1990 && season <= 2100,
    '--season must be a whole year between 1990 and 2100');
  assert.ok(Number.isInteger(week) && week >= 1 && week <= 18,
    '--week must be a whole number between 1 and 18');
  assert.ok(DAYS.includes(day), "--day must be one of 'mon', 'tue' or 'fri'");
  const leagues = String(input.leagues || '').split(',').map((id) => id.trim()).filter(Boolean);
  for (const id of leagues) {
    assert.match(id, /^\d{1,20}$/, 'Invalid league id in --leagues: ' + JSON.stringify(id));
  }
  return { season, week, day, leagues };
}

if (flag('self-test')) {
  assert.equal(
    relayUrl('https://example.test/', '123', 2026, 3),
    'https://example.test/api/espn?url=' + encodeURIComponent(boxScoreUrl('123', 2026, 3)),
  );
  assert.ok(boxScoreUrl('123', 2026, 3).startsWith(ESPN_HOST + '/apis/v3/games/ffl/seasons/2026/'));
  assert.deepEqual(resolveScope({ season: '2026', week: '3', day: 'mon' }),
    { season: 2026, week: 3, day: 'mon', leagues: [] });
  assert.deepEqual(resolveScope({ season: 2026, week: 3, day: 'tue', leagues: '1, 22 ,333' }).leagues,
    ['1', '22', '333']);
  assert.deepEqual(credentialAttempts('tok').map((a) => a.token), ['tok', '']);
  assert.deepEqual(credentialAttempts('  ').map((a) => a.token), ['']);
  assert.deepEqual(credentialAttempts(null).map((a) => a.token), ['']);

  /* --force-rerun targets: missing rows and last-failed rows, nothing else. */
  const repair = repairTargets(['1', '2', '3', '4'], ['2', '3', '4'], [
    { league_id: '2', status: 'failed' },
    { league_id: '3', status: 'failed' },
    { league_id: '3', status: 'created' },   // repaired since; not a target
    { league_id: '4', status: 'created' },
  ]);
  assert.deepEqual(repair.targets, ['1', '2']);
  assert.deepEqual(repair.untouched, ['3', '4']);
  // No logs at all: only the leagues holding no row are attempted.
  assert.deepEqual(repairTargets(['1', '2'], ['2'], []).targets, ['1']);
  // Nothing missing and nothing failed is a clean no-op, not a full rewrite.
  assert.deepEqual(repairTargets(['1', '2'], ['1', '2'], []).targets, []);
  assert.equal(isAuthFailureStatus(401), true);
  assert.equal(isAuthFailureStatus(403), true);
  assert.equal(isAuthFailureStatus(504), false);
  assert.equal(isAuthFailureStatus(200), false);
  for (const bad of [
    { season: 1900, week: 3, day: 'mon' },
    { season: 2026, week: 0, day: 'mon' },
    { season: 2026, week: 19, day: 'mon' },
    { season: 2026, week: 3, day: 'wed' },
    { season: 2026, week: 3, day: 'mon', leagues: '12x' },
  ]) {
    assert.throws(() => resolveScope(bad), 'a bad scope must be refused: ' + JSON.stringify(bad));
  }
  console.log('[rerun-league-articles] self-test clean');
  process.exit(0);
}

const scope = resolveScope(args);
assert.ok(flag('force'), 'The --force flag is required; nothing was written');
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  assert.ok(process.env[key], key + ' is unavailable; no article was changed');
}

const { createClient } = await import('@supabase/supabase-js');
const { generateAndPublishBlogArticle, ARTICLE_TYPE_BY_DAY } =
  require('../lib/dist/article-generator.js');

const base = String(args.base || DEFAULT_BASE);
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

/* The league list and each league's share token, in one read. The token is
   what lets the relay hand this league's own ESPN session to the box score
   call; a league without one is still attempted, it just reads anonymously and
   ESPN decides. */
const { data: rows, error: listError } = await db
  .from('leagues')
  .select('league_id, share_token')
  .eq('season_year', String(scope.season));
if (listError) throw listError;

const byLeague = new Map();
for (const row of rows || []) {
  const id = String(row.league_id || '').trim();
  if (!/^\d{1,20}$/.test(id)) {
    console.warn('[rerun-league-articles] skipping a league row whose id is not numeric: ' +
      JSON.stringify(row.league_id));
    continue;
  }
  if (!byLeague.has(id)) byLeague.set(id, row.share_token || '');
}

let targets = scope.leagues.length
  ? scope.leagues.filter((id) => {
    if (byLeague.has(id)) return true;
    console.warn('[rerun-league-articles] ' + id + ' is not an active ' + scope.season +
      ' league, so it is skipped');
    return false;
  })
  : Array.from(byLeague.keys()).sort();
assert.ok(targets.length, 'No leagues resolved for ' + scope.season + '; nothing was written');

/* ---- --force-rerun ----
   Narrow the run to the leagues that actually missed this scope's article. The
   reads are the same two the cron makes, so this agrees with the route by
   construction rather than by convention. A read failure is fatal HERE on
   purpose: a repair that cannot tell which leagues published must not guess and
   rewrite the ones that did. */
let untouched = [];
if (flag('force-rerun')) {
  const articleType = ARTICLE_TYPE_BY_DAY[scope.day];
  const publishedRead = await db
    .from('blog_articles')
    .select('league_id')
    .eq('season', scope.season)
    .eq('week', scope.week)
    .eq('article_type', articleType);
  if (publishedRead.error) throw publishedRead.error;

  const logRead = await db
    .from('cron_article_logs')
    .select('league_id, status, executed_at')
    .eq('season', scope.season)
    .eq('week', scope.week)
    .eq('article_type', articleType)
    .order('executed_at', { ascending: true });
  if (logRead.error) throw logRead.error;

  const decided = repairTargets(
    targets,
    (publishedRead.data || []).map((row) => row.league_id),
    logRead.data || [],
  );
  targets = decided.targets;
  untouched = decided.untouched;
  console.log('[rerun-league-articles] --force-rerun: ' + targets.length +
    ' league(s) missing this article or last recorded as failed; ' + untouched.length +
    ' league(s) published cleanly and are left untouched' +
    (untouched.length ? ' (' + untouched.join(', ') + ')' : ''));
  if (!targets.length) {
    console.log('[rerun-league-articles] nothing to repair for ' + ARTICLE_TYPE_BY_DAY[scope.day] +
      ', ' + scope.season + ' week ' + scope.week + '; no article was changed');
    process.exit(0);
  }
}

console.log('[rerun-league-articles] ' + ARTICLE_TYPE_BY_DAY[scope.day] + ', ' + scope.season +
  ' week ' + scope.week + ', ' + targets.length + ' league(s), relay ' + base);

const fetchBoxScoresFor = (leagueId) => async (input) => {
  const url = relayUrl(base, input.league_id, input.season, input.week);
  const attempts = credentialAttempts(byLeague.get(leagueId));
  let last = null;

  for (const attempt of attempts) {
    const response = await fetch(url, {
      headers: attempt.token ? { 'x-league-token': attempt.token } : {},
      signal: AbortSignal.timeout(45000),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body && typeof body === 'object' && !body.error) return body;

    const detail = body && (body.error || body.message) ? ': ' + (body.error || body.message) : '';
    last = Object.assign(
      new Error('ESPN box score read failed for ' + leagueId + ' with the ' + attempt.label +
        ' (HTTP ' + response.status + ')' + detail),
      { status: response.status },
    );
    /* Reported every time, not only on the last one: a league that publishes
       off the fallback still had a stale stored session, and that is the thing
       its host has to fix. */
    console.warn('[rerun-league-articles] ' + last.message);
  }
  throw last;
};

const results = [];
for (const leagueId of targets) {
  try {
    const outcome = await generateAndPublishBlogArticle(
      { league_id: leagueId, season: scope.season, week: scope.week, day: scope.day },
      { db, fetchBoxScores: fetchBoxScoresFor(leagueId) },
    );
    results.push({
      league_id: leagueId,
      status: 'published',
      slug: outcome.record.slug,
      title: outcome.record.title,
      evaluated: outcome.evaluated,
      kickoffs: outcome.kickoffs,
      error: null,
      auth_failure: false,
    });
    console.log('  published  ' + leagueId + '  ' + outcome.record.title);
  } catch (err) {
    /* One league's failure never stops the others, exactly as the cron
       contract promises. It is reported, not swallowed. */
    console.error('[rerun-league-articles] ' + leagueId + ' did not publish', err);
    results.push({
      league_id: leagueId,
      status: 'failed',
      slug: null,
      title: null,
      evaluated: 0,
      kickoffs: 0,
      error: String((err && err.message) || err),
      /* The one failure this script cannot retry its way out of. Separated so a
         run ends by naming the leagues whose ESPN session has to be renewed,
         instead of leaving that to whoever reads twelve stack traces. */
      auth_failure: isAuthFailureStatus(err && err.status),
    });
  }
}

const published = results.filter((row) => row.status === 'published');
const failed = results.filter((row) => row.status === 'failed');
const needReconnect = failed.filter((row) => row.auth_failure);
console.log(JSON.stringify({
  season: scope.season, week: scope.week, day: scope.day,
  article_type: ARTICLE_TYPE_BY_DAY[scope.day],
  force_rerun: flag('force-rerun'),
  leagues: results.length, published: published.length, failed: failed.length,
  untouched: untouched.length,
  espn_auth_failures: needReconnect.map((row) => row.league_id),
  results,
}, null, 2));

if (needReconnect.length) {
  console.error('[rerun-league-articles] ESPN refused the identity for ' + needReconnect.length +
    ' league(s): ' + needReconnect.map((row) => row.league_id).join(', ') + '. Re-running this ' +
    'script will not fix them — a member of each has to re-save the league from Setup with a ' +
    'current ESPN sign-in, and then this can be run again with --force-rerun.');
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  const lines = [
    '### ' + ARTICLE_TYPE_BY_DAY[scope.day] + ', ' + scope.season + ' week ' + scope.week,
    '',
    published.length + ' published, ' + failed.length + ' failed.',
    '',
    '| League | Status | Article |',
    '| --- | --- | --- |',
    ...results.map((row) => '| ' + row.league_id + ' | ' + row.status + ' | ' +
      (row.title || row.error || '') + ' |'),
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

if (failed.length) {
  console.error('::error title=Some leagues did not publish::' + failed.length +
    ' of ' + results.length + ' league(s) failed. See the per-league errors above.');
  process.exit(1);
}
