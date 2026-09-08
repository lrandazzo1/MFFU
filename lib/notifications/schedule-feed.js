/* ============================================================================
   FSN NOTIFICATIONS — DAILY SCHEDULE FEED

   The one place in the push stack that talks to an external data source, and
   the one place that has to be rate-limited.

   ---- WHAT IT PULLS, AND WHY IT IS ONE REQUEST ----

   The dispatcher needs three facts to place a week's alerts: the season year,
   the fantasy/NFL week number, and the instant of that week's opening kickoff.
   None of them are per-league — every league in the app plays the same NFL
   week against the same schedule — so they are read from ESPN's PUBLIC NFL
   scoreboard endpoint exactly ONCE for the whole install base, not once per
   league and not once per device. A thousand registered devices still cost a
   single GET.

   Before this existed, those three facts came from whatever the client last
   reported at registration. That is a real defect, not just an inefficiency: a
   reader who opted in during Week 2 and did not reopen the app kept reporting
   week 2 forever, so every send after that collided with a Week-2 ledger row
   and the device silently went quiet for the rest of the season. The feed is
   the fix — the dispatcher now resolves the live week itself and uses the
   device's stale report only as a fallback.

   ---- THE RATE LIMIT IS THE POINT ----

   `attempted_at` — not `fetched_at` — is what gates the next pull, and it is
   stamped on every attempt including the ones that fail. A broken or throttled
   upstream therefore costs at most one request per MIN_PULL_INTERVAL_MS no
   matter how often this route is invoked: by the daily cron, by a manual
   curl, or by ten of them in a row. Gating on success instead would turn an
   upstream outage into a retry storm against the source that is already
   struggling, which is precisely the failure this module exists to prevent.

   A stale cached row is served rather than discarded when a pull fails. Alerts
   placed on yesterday's week number are far better than no alerts, and the
   staleness is reported in the dispatcher's response instead of hidden.

   ---- WHAT IT DOES NOT DO ----

   No credentials, no cookies, no per-league ESPN read, no writes anywhere but
   this one cache row. It is invoked from the serverless dispatcher only, so
   the pull never touches the repository, a webhook, or a Vercel deployment.
============================================================================ */

'use strict';

/* The public, credential-free NFL scoreboard. `site.api.espn.com` is already
   on the allowlist /api/espn.js proxies to, so this introduces no new upstream
   host. Overridable for a mirror or a test fixture, but only ever to a host on
   the allowlist below. */
const DEFAULT_FEED_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

const ALLOWED_FEED_HOSTS = new Set(['site.api.espn.com', 'fantasy.espn.com']);

/* One row, one sport. A text id rather than a boolean singleton so a second
   feed (a different league's calendar) is an INSERT later, not a migration. */
const FEED_ROW_ID = 'nfl';

/* The floor between two external requests. Twenty hours rather than a flat
   twenty-four so a cron that drifts — Hobby-plan crons are only promised
   within the hour of their scheduled time — never skips a day's refresh by
   arriving forty minutes early and finding the row still inside the window. */
const MIN_PULL_INTERVAL_MS = 20 * 3600 * 1000;

/* An upstream that has stopped answering must not hold the whole dispatch run
   open until the function times out; the cached row is the fallback. */
const FETCH_TIMEOUT_MS = 8000;

function feedUrl() {
  const configured = String(process.env.NOTIFICATIONS_SCHEDULE_URL || '').trim();
  if (!configured) return DEFAULT_FEED_URL;

  let parsed;
  try {
    parsed = new URL(configured);
  } catch (err) {
    console.error('[FSNPush] NOTIFICATIONS_SCHEDULE_URL is not a valid URL (' +
      configured + '); falling back to the default ESPN scoreboard.', err);
    return DEFAULT_FEED_URL;
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_FEED_HOSTS.has(parsed.hostname)) {
    console.error('[FSNPush] NOTIFICATIONS_SCHEDULE_URL points at ' + parsed.hostname +
      ', which is not an allowed schedule host; falling back to the default ESPN ' +
      'scoreboard rather than fetching an unvetted origin.',
      new Error('FEED_HOST_NOT_ALLOWED'));
    return DEFAULT_FEED_URL;
  }
  return parsed.toString();
}

/* --------------------------------------------------------------------------
   parseScoreboard(payload)

   Pure. Pulls season year, week number and the earliest kickoff out of the
   scoreboard document, tolerating the two shapes the endpoint has shipped
   (top-level `season`/`week`, and the same values nested under `leagues[0]`).

   Every field is independently optional: a document that carries a week but no
   parseable event date still yields a usable week number, and the kickoff
   simply stays null so the Thursday trigger falls back to its weekday band.
-------------------------------------------------------------------------- */
function parseScoreboard(payload) {
  const doc = (payload && typeof payload === 'object') ? payload : {};
  const league = (Array.isArray(doc.leagues) && doc.leagues[0]) || {};

  const season = doc.season || league.season || {};
  const seasonYear = Number(season.year) || Number(league.season && league.season.year) || null;
  const seasonType = Number(season.type && season.type.type) || Number(season.type) || null;

  const weekBlock = doc.week || league.week || {};
  let week = Number(weekBlock.number) || null;

  const events = Array.isArray(doc.events) ? doc.events : [];

  /* Fall back to the events themselves when the header omits the week — the
     scoreboard has shipped both ways across seasons. */
  if (!week) {
    for (const event of events) {
      const n = Number(event && event.week && event.week.number);
      if (Number.isFinite(n) && n > 0) { week = n; break; }
    }
  }

  let firstKickoffMs = null;
  for (const event of events) {
    const stamp = event && event.date;
    if (!stamp) continue;
    const ts = new Date(stamp).getTime();
    if (!Number.isFinite(ts)) {
      console.warn('[FSNPush] unparseable kickoff stamp in the schedule feed: ' + String(stamp));
      continue;
    }
    if (firstKickoffMs == null || ts < firstKickoffMs) firstKickoffMs = ts;
  }

  return {
    seasonYear: Number.isFinite(seasonYear) && seasonYear > 0 ? seasonYear : null,
    week: Number.isFinite(week) && week > 0 ? week : null,
    seasonType: Number.isFinite(seasonType) ? seasonType : null,
    firstKickoffMs,
    events: events.length,
  };
}

/* --------------------------------------------------------------------------
   pull({ fetchImpl })

   The single outbound request. Returns the parsed snapshot, or throws with a
   message the caller records on the cache row — never a silent null, because
   "the upstream changed shape" and "the upstream is down" need different
   fixes and the cache row is where an operator looks.
-------------------------------------------------------------------------- */
async function pull(options) {
  const opts = options || {};
  const doFetch = opts.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('NO_FETCH_AVAILABLE');
  }

  const url = opts.url || feedUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response || !response.ok) {
    throw new Error('FEED_HTTP_' + String(response && response.status));
  }

  const body = await response.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    throw new Error('FEED_BODY_NOT_JSON');
  }

  const snapshot = parseScoreboard(payload);
  if (!snapshot.seasonYear && !snapshot.week) {
    throw new Error('FEED_SHAPE_UNRECOGNISED');
  }
  snapshot.source = url;
  return snapshot;
}

/* Map a cache row into the shape the dispatcher consumes. */
function fromRow(row, extra) {
  const base = row || {};
  return Object.assign({
    seasonYear: base.season_year == null ? null : Number(base.season_year),
    week: base.week == null ? null : Number(base.week),
    seasonType: base.season_type == null ? null : Number(base.season_type),
    firstKickoffMs: base.first_kickoff_ms == null ? null : Number(base.first_kickoff_ms),
    source: base.source || null,
    fetchedAt: base.fetched_at || null,
    attemptedAt: base.attempted_at || null,
    lastError: base.last_error || null,
  }, extra || {});
}

/* An empty snapshot, so every caller can read the same keys whether or not the
   cache row exists yet. */
function emptySnapshot(extra) {
  return Object.assign({
    seasonYear: null, week: null, seasonType: null, firstKickoffMs: null,
    source: null, fetchedAt: null, attemptedAt: null, lastError: null,
  }, extra || {});
}

async function readRow(supabase) {
  const { data, error } = await supabase
    .from('notification_schedule')
    .select('season_year, week, season_type, first_kickoff_ms, source, fetched_at, attempted_at, last_error')
    .eq('id', FEED_ROW_ID)
    .limit(1);

  if (error) {
    console.error('[FSNPush] could not read the cached schedule row; this run will ' +
      'fall back to the week each device last reported.', error);
    return null;
  }
  return (Array.isArray(data) && data[0]) || null;
}

/* --------------------------------------------------------------------------
   readCached(supabase)

   Cache only. No network, no writes. This is what a `?dry=1` health check
   uses: a rehearsal must not spend the day's one external request, and it must
   not move `attempted_at` and thereby suppress the real run that follows.
-------------------------------------------------------------------------- */
async function readCached(supabase) {
  if (!supabase) return emptySnapshot({ refreshed: false, reason: 'NO_STORAGE' });
  const row = await readRow(supabase);
  if (!row) return emptySnapshot({ refreshed: false, reason: 'NO_CACHE_ROW' });
  return fromRow(row, { refreshed: false, reason: 'CACHE_ONLY' });
}

/* --------------------------------------------------------------------------
   refresh(supabase, now, { fetchImpl })

   The rate-limited pull. Reads the cache row, and:

     * inside MIN_PULL_INTERVAL_MS of the last ATTEMPT  -> serves the cache,
       makes no request at all;
     * otherwise                                        -> stamps the attempt,
       makes exactly one request, and writes the result.

   Never throws. A failed pull is logged, recorded on the row, and answered
   with the stale cache so the dispatch run continues.
-------------------------------------------------------------------------- */
async function refresh(supabase, now, options) {
  const opts = options || {};
  if (!supabase) return emptySnapshot({ refreshed: false, reason: 'NO_STORAGE' });

  const row = await readRow(supabase);
  const attemptedAt = row && row.attempted_at ? Date.parse(row.attempted_at) : NaN;

  if (Number.isFinite(attemptedAt) && !opts.force) {
    const sinceMs = now - attemptedAt;
    if (sinceMs >= 0 && sinceMs < MIN_PULL_INTERVAL_MS) {
      return fromRow(row, {
        refreshed: false,
        reason: 'RATE_LIMITED',
        nextPullInMinutes: Math.round((MIN_PULL_INTERVAL_MS - sinceMs) / 60000),
      });
    }
  }

  let snapshot = null;
  let failure = null;
  try {
    snapshot = await pull({ fetchImpl: opts.fetchImpl, url: opts.url, timeoutMs: opts.timeoutMs });
  } catch (err) {
    failure = err;
    console.error('[FSNPush] the daily schedule pull failed; serving the cached week ' +
      'instead. The next attempt is at least ' + Math.round(MIN_PULL_INTERVAL_MS / 3600000) +
      'h away, deliberately, so a failing upstream is not retried in a loop.', err);
  }

  /* `attempted_at` moves whether or not the pull succeeded — it is the rate
     limiter. `fetched_at` and the data columns move only on success, so a
     failure can never overwrite good data with nulls. */
  const patch = {
    id: FEED_ROW_ID,
    attempted_at: new Date(now).toISOString(),
    last_error: failure ? String(failure.message || failure).slice(0, 200) : null,
    last_error_at: failure ? new Date(now).toISOString() : null,
  };
  if (snapshot) {
    patch.season_year = snapshot.seasonYear;
    patch.week = snapshot.week;
    patch.season_type = snapshot.seasonType;
    patch.first_kickoff_ms = snapshot.firstKickoffMs;
    patch.source = snapshot.source;
    patch.fetched_at = new Date(now).toISOString();
  }

  const { error: writeError } = await supabase
    .from('notification_schedule')
    .upsert(patch, { onConflict: 'id' });

  if (writeError) {
    /* The pull still happened, so the data is usable for THIS run. What is
       lost is the rate-limit stamp, which is why this is an error and not a
       warning: an unwritable cache row means the next invocation pulls again. */
    console.error('[FSNPush] could not write the schedule cache row. This run has ' +
      'usable data, but the once-a-day rate limit is not recorded and the next ' +
      'invocation will pull again.', writeError);
  }

  if (snapshot) {
    return {
      seasonYear: snapshot.seasonYear,
      week: snapshot.week,
      seasonType: snapshot.seasonType,
      firstKickoffMs: snapshot.firstKickoffMs,
      source: snapshot.source,
      fetchedAt: patch.fetched_at,
      attemptedAt: patch.attempted_at,
      lastError: null,
      refreshed: true,
      reason: 'PULLED',
    };
  }

  return fromRow(row, {
    refreshed: false,
    reason: 'PULL_FAILED',
    lastError: patch.last_error,
    attemptedAt: patch.attempted_at,
  });
}

/* --------------------------------------------------------------------------
   applyTo(device, snapshot)

   Merge the feed over one device row. The feed wins when it has the fact,
   because it is live; the device's own report is the fallback for a run whose
   pull has never succeeded. Returns a NEW object — the caller's row is left
   untouched so a diagnostic can still show what the device itself claimed.
-------------------------------------------------------------------------- */
function applyTo(device, snapshot) {
  const feed = snapshot || {};
  const merged = Object.assign({}, device);
  if (Number.isFinite(feed.seasonYear) && feed.seasonYear > 0) merged.seasonYear = feed.seasonYear;
  if (Number.isFinite(feed.week) && feed.week > 0) merged.week = feed.week;
  if (Number.isFinite(feed.firstKickoffMs) && feed.firstKickoffMs > 0) {
    merged.firstKickoffMs = feed.firstKickoffMs;
  }
  return merged;
}

module.exports = {
  DEFAULT_FEED_URL,
  ALLOWED_FEED_HOSTS,
  FEED_ROW_ID,
  MIN_PULL_INTERVAL_MS,
  FETCH_TIMEOUT_MS,
  feedUrl,
  parseScoreboard,
  pull,
  readCached,
  refresh,
  applyTo,
};
