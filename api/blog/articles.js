/* ============================================================================
   FSN LEAGUE BLOG — PUBLIC READ — /api/blog/articles

   The one public read of `blog_articles`. The table is RLS-protected with no
   browser policies, so a browser can never query it directly; this route is
   the boundary, exactly as /api/league is for league storage.

     GET /api/blog/articles?league_id=123456&season=2026&week=3&limit=10
     GET /api/blog/articles?league_id=123456&active=1&limit=6

   ---- WHAT IT RETURNS ----

     { league_id, season, week, count, articles: [{
         slug, headline, match_impact_summary, content, category, author,
         title, excerpt, content_markdown, article_type,
         tracked_players, season, week, published_at }] }

   Only published columns. The table's internal id, created_at and updated_at
   are never serialized: they are operational, not editorial, and a public
   payload should carry nothing a reader has no use for.

   ---- THE THREE TIERS, AND THE LEGACY SHAPE ----

   A card reads in three tiers: `headline`, then `match_impact_summary` in its
   callout, then `content` as the markdown narrative, with `category` and
   `author` as the meta line.

   Articles published before those columns existed carry only `title` and
   `content_markdown`. Both namings are resolved HERE rather than on the
   phone, so a client never has to know which generation of row it received:

     headline = row.headline || row.title
     content  = row.content  || row.content_markdown

   The legacy fields are still published alongside the resolved ones. They are
   what the static blog build and any older client read, and dropping them to
   tidy the payload would break a reader this route has no way to see.

   A deployment whose database has not run the new columns yet is not a
   failure either: the select falls back to the legacy allowlist, logs it once
   per read, and serves the same resolved shape.

   ---- SCOPE ----

   `league_id` is required and every query is filtered by it. A league's
   stories are its own, and no parameter combination can return a mixed set:
   the filter is applied before any other, and an absent league_id is a 400
   rather than "everything".

   `season` and `week` narrow further. With neither, the league's most recent
   articles come back newest first, which is what a blog index wants.

   ---- THE ACTIVE READ ----

   `active=1` asks for the league's currently live stories: everything already
   published, newest first, with no week coordinate. It is what the News Desk
   uses to show the league's latest coverage when the week on screen has
   nothing of its own.

   The only thing it adds over an unfiltered read is the `published_at <= now`
   floor, which excludes a row dated into the future. The pipeline does not
   write those, but a backfill and the publish route both accept an explicit
   `published_at`, so a story staged for tomorrow morning exists as a real
   possibility and must not appear on a phone tonight.

   It composes with the other filters rather than replacing them, so
   `active=1&season=2026` is a legal narrowing and means what it reads like.

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
const LEGACY_COLUMNS = 'slug,title,excerpt,content_markdown,article_type,tracked_players,season,week,published_at';
const PUBLIC_COLUMNS = LEGACY_COLUMNS + ',headline,match_impact_summary,content,category,author';

/* PostgREST's code for "column does not exist". The three-tier columns are
   added by supabase/blog_articles.sql, and a deployment can reach this route
   before that file has been run against its database. That is a schema the
   operator still has to migrate, not a reason to serve a 502 over articles
   that are sitting right there in the legacy columns. */
const UNDEFINED_COLUMN = '42703';

function isMissingColumn(err) {
  if (!err) return false;
  if (String(err.code || '') === UNDEFINED_COLUMN) return true;
  return /column .* does not exist/i.test(String(err.message || ''));
}

/* The editorial shelf a legacy row belongs to, worked out from the only thing
   it recorded about itself. A row with its own `category` always wins; this
   is the answer for rows written before the column existed. */
const CATEGORY_BY_TYPE = {
  monday_sweat: 'Matchup Recap',
  tuesday_verdict: 'Matchup Recap',
  friday_tnf_preview: 'Matchup Preview',
  league_dispatch: 'League Dispatch',
};

const DEFAULT_AUTHOR = 'FFU News Desk';

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

/* A flag is either set or not, and an unrecognised value is a typo in the
   caller rather than a filter to guess at. `active=maybe` is a 400 for the
   same reason `week=banana` is. */
function flagParam(req, name) {
  const raw = queryParam(req, name).toLowerCase();
  if (!raw) return false;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  throw Object.assign(new Error(name + " must be 1 or 0"), { status: 400 });
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
    active: flagParam(req, 'active'),
    limit: intParam(req, 'limit', { min: 1, max: MAX_LIMIT }) || DEFAULT_LIMIT,
  };
}

/* Shape every row the same way whatever the query asked for, so a client never
   has to branch on which filters it happened to send. `tracked_players` is
   normalized to an array here rather than in the app: a null column and a
   malformed one should both read as "no players tracked", and the phone is the
   wrong place to discover that. */
function toArticle(row) {
  const title = String(row.title || '').trim();
  const contentMarkdown = String(row.content_markdown || '');
  const articleType = String(row.article_type || '');
  return {
    slug: String(row.slug || ''),

    /* Tier 1, 2 and 3. The legacy fallbacks are applied here so the client
       reads one shape whatever generation the row is. */
    headline: String(row.headline || '').trim() || title,
    match_impact_summary: String(row.match_impact_summary || '').trim(),
    content: String(row.content || '') || contentMarkdown,
    category: String(row.category || '').trim() || CATEGORY_BY_TYPE[articleType] || '',
    author: String(row.author || '').trim() || DEFAULT_AUTHOR,

    /* The legacy names, still published: the static blog build and any client
       older than the three-tier layout read these. */
    title,
    excerpt: String(row.excerpt || ''),
    content_markdown: contentMarkdown,

    article_type: articleType,
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

  /* One query builder, two possible column lists. Built as a function rather
     than reused so the retry is a clean second query instead of a mutated
     first one. */
  const runQuery = (columns) => {
    let query = supabase
      .from('blog_articles')
      .select(columns)
      .eq('league_id', scope.league_id);
    if (scope.season != null) query = query.eq('season', scope.season);
    if (scope.week != null) query = query.eq('week', scope.week);
    /* The active floor. Applied as part of the query rather than by filtering
       the rows afterwards, so a league whose next few stories are staged ahead
       does not quietly get a short page back. */
    if (scope.active) query = query.lte('published_at', new Date().toISOString());
    return query
      .order('published_at', { ascending: false })
      .limit(scope.limit);
  };

  try {
    let result = await runQuery(PUBLIC_COLUMNS);
    if (result.error && isMissingColumn(result.error)) {
      console.warn(
        '[BlogArticles] the three-tier columns are not on this database yet for league ' +
          scope.league_id + '; serving the legacy shape. Run supabase/blog_articles.sql.',
        result.error,
      );
      result = await runQuery(LEGACY_COLUMNS);
    }
    if (result.error) throw result.error;

    const articles = (result.data || []).map(toArticle);
    res.status(200).json({
      league_id: scope.league_id,
      season: scope.season,
      week: scope.week,
      active: scope.active,
      count: articles.length,
      articles,
    });
  } catch (err) {
    console.error(
      '[BlogArticles] read failed for league ' + scope.league_id +
        ' (season ' + String(scope.season) + ', week ' + String(scope.week) +
        ', active ' + String(scope.active) + ')',
      err,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'READ_FAILED' });
  }
}

module.exports = handler;
module.exports.default = handler;
