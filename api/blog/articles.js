/* ============================================================================
   FSN LEAGUE BLOG — PUBLIC READ — /api/blog/articles

   The one public read of `blog_articles`. The table is RLS-protected with no
   browser policies, so a browser can never query it directly; this route is
   the boundary, exactly as /api/league is for league storage.

     GET /api/blog/articles?league_id=123456&season=2026&week=3&limit=10

   ---- WHAT IT RETURNS ----

     { league_id, season, week, count, articles: [{
         slug, title, excerpt, content_markdown, article_type,
         tracked_players, season, week, published_at }] }

   Only published columns. The table's internal id, created_at and updated_at
   are never serialized: they are operational, not editorial, and a public
   payload should carry nothing a reader has no use for.

   ---- SCOPE ----

   `league_id` is required and every query is filtered by it. A league's
   stories are its own, and no parameter combination can return a mixed set:
   the filter is applied before any other, and an absent league_id is a 400
   rather than "everything".

   `season` and `week` narrow further. With neither, the league's most recent
   articles come back newest first, which is what a blog index wants.

   ---- WHY IT IS PUBLIC ----

   These articles are published: the same rows render on the public blog. The
   numeric league id is already public — it appears in every ESPN league URL —
   so it authorises nothing on its own here, and this route deliberately
   exposes no cookie, no share token, and no roster data beyond what the
   article text already says.

   ---- CACHING ----

   Five minutes at the edge with a day of stale-while-revalidate, matching the
   static blog payload's headers in landing/vercel.json. Articles change a few
   times a week; a reader opening the News Desk twice in a row should pay for
   one read, not two.
============================================================================ */

'use strict';

/* The published columns, and only those. Listed explicitly rather than with
   select('*') so a column added to the table later is never published by
   accident. */
const PUBLIC_COLUMNS = 'slug,title,excerpt,content_markdown,article_type,tracked_players,season,week,published_at';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  /* Resolved at call time rather than destructured at module load, matching
     `database()` in lib/article-generator.ts. A route that binds the factory
     once at import cannot be exercised without a live network. */
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(8000) }) },
  });
}

/* Public content, so any origin may read it: the app runs on
   app.fantasysportsnetwork.app on the web and on capacitor://localhost in the
   native shell, and the marketing site is a third origin. An allowlist would
   have to enumerate all three plus every preview deploy, and would still be
   protecting data that is published anyway. */
function applyHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=86400');
}

function queryParam(req, name) {
  const value = req && req.query && req.query[name];
  if (Array.isArray(value)) return String(value[0] == null ? '' : value[0]);
  return String(value == null ? '' : value).trim();
}

/* A parameter that is present but unusable is a 400, never a silently dropped
   filter. Returning the whole league because `week=banana` did not parse would
   answer a question nobody asked. */
function intParam(req, name, { min, max }) {
  const raw = queryParam(req, name);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw Object.assign(new Error(name + ' must be a whole number between ' + min + ' and ' + max), { status: 400 });
  }
  return value;
}

function readScope(req) {
  const league_id = queryParam(req, 'league_id');
  if (!league_id || league_id.length > 64 || !/^[A-Za-z0-9._-]+$/.test(league_id)) {
    throw Object.assign(new Error('league_id is required'), { status: 400 });
  }
  return {
    league_id,
    season: intParam(req, 'season', { min: 1990, max: 2100 }),
    week: intParam(req, 'week', { min: 1, max: 18 }),
    limit: intParam(req, 'limit', { min: 1, max: MAX_LIMIT }) || DEFAULT_LIMIT,
  };
}

/* Shape every row the same way whatever the query asked for, so a client never
   has to branch on which filters it happened to send. `tracked_players` is
   normalized to an array here rather than in the app: a null column and a
   malformed one should both read as "no players tracked", and the phone is the
   wrong place to discover that. */
function toArticle(row) {
  return {
    slug: String(row.slug || ''),
    title: String(row.title || ''),
    excerpt: String(row.excerpt || ''),
    content_markdown: String(row.content_markdown || ''),
    article_type: String(row.article_type || ''),
    tracked_players: Array.isArray(row.tracked_players) ? row.tracked_players : [],
    season: row.season == null ? null : Number(row.season),
    week: row.week == null ? null : Number(row.week),
    published_at: row.published_at || null,
  };
}

async function handler(req, res) {
  applyHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  let scope;
  try {
    scope = readScope(req);
  } catch (err) {
    // A bad request is the caller's to fix and must not be cached as if it
    // were this league's real answer.
    res.setHeader('Cache-Control', 'no-store');
    res.status(err.status || 400).json({ error: 'INVALID_REQUEST', message: err.message });
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    console.error(
      '[BlogArticles] cannot reach Supabase: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing ' +
        'from the environment.',
      new Error('SUPABASE_NOT_CONFIGURED'),
    );
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({ error: 'STORAGE_NOT_CONFIGURED' });
    return;
  }

  try {
    let query = supabase
      .from('blog_articles')
      .select(PUBLIC_COLUMNS)
      .eq('league_id', scope.league_id);
    if (scope.season != null) query = query.eq('season', scope.season);
    if (scope.week != null) query = query.eq('week', scope.week);

    const result = await query
      .order('published_at', { ascending: false })
      .limit(scope.limit);
    if (result.error) throw result.error;

    const articles = (result.data || []).map(toArticle);
    res.status(200).json({
      league_id: scope.league_id,
      season: scope.season,
      week: scope.week,
      count: articles.length,
      articles,
    });
  } catch (err) {
    console.error(
      '[BlogArticles] read failed for league ' + scope.league_id +
        ' (season ' + String(scope.season) + ', week ' + String(scope.week) + ')',
      err,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'READ_FAILED' });
  }
}

module.exports = handler;
module.exports.default = handler;
