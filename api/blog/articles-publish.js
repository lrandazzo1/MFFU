/* ============================================================================
   FSN LEAGUE BLOG — PUBLISH — /api/blog/articles/publish

   The write boundary onto `blog_articles`, and the counterpart to the public
   read in api/blog/articles.js. `blog_articles` is RLS-protected with no
   browser policies, so the only two ways into that table are the server-side
   pipeline (lib/article-generator.ts, which holds the service-role key
   directly) and this route.

     POST /api/blog/articles/publish
     Authorization: Bearer $CRON_SECRET
     Content-Type: application/json

     {
       "league_id": "123456",
       "season": 2026,
       "week": 3,
       "headline": "Ridgeback FC Survive The Late Window",
       "match_impact_summary": "Monday Back scored 20 points, just enough for Ridgeback FC",
       "content": "# The late window\n\n...",
       "category": "Matchup Recap",
       "author": "FFU News Desk"
     }

   ---- THE THREE TIERS ----

   `headline`, `match_impact_summary` and `content` are the card's three tiers
   in order, and `category` / `author` are its meta line. `headline` and
   `content` are the only ones a caller must supply; a legacy caller may send
   `title` and `content_markdown` under their old names instead and gets the
   same row. Both namings are written to the row, so the story reads correctly
   through either generation of client and the table's NOT NULL columns are
   satisfied whichever names the caller knew.

   ---- AUTH ----

   `CRON_SECRET`, as `Authorization: Bearer $CRON_SECRET` or `x-cron-secret`,
   compared in constant time by the same helper the scheduled generator uses.
   With no secret configured the route refuses every caller rather than
   defaulting open: an unauthenticated endpoint that writes articles into any
   league is not something to leave to chance, and it is checked before the
   body is even parsed so the route cannot be probed for valid inputs.

   There is deliberately no CORS allowance here. The read is public because
   published articles are public; the write is not, and a browser has no
   business holding a publishing secret.

   ---- IDEMPOTENCY ----

   The write is an upsert on `slug`, exactly as the pipeline's is. A caller
   that supplies no slug gets the deterministic
   `<season>-week-<n>-<category-slug>-<league_id>`, so re-publishing the same
   story for the same league week overwrites its own row instead of stacking
   duplicates, and a retry after a timeout costs nothing.
============================================================================ */

'use strict';

const { authorizedByCronSecret, cronSecretConfigured } = require('../../lib/dist/article-cron');

/* The scheduled pipeline's own three types, plus the one for a story that is
   published outside the Monday/Tuesday/Friday schedule. Mirrors the widened
   check constraint in supabase/blog_articles.sql. */
const ARTICLE_TYPES = ['monday_sweat', 'tuesday_verdict', 'friday_tnf_preview', 'league_dispatch'];
const DEFAULT_ARTICLE_TYPE = 'league_dispatch';
const DEFAULT_AUTHOR = 'FFU News Desk';

/* Long enough for a full story, bounded so a malformed or hostile caller
   cannot push an unbounded body into the table. */
const MAX_CONTENT = 120000;
const MAX_HEADLINE = 300;
const MAX_SUMMARY = 600;
const MAX_SHORT = 120;
const MAX_SLUG = 200;

function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  /* Resolved at call time rather than destructured at module load, matching
     `database()` in lib/article-generator.ts and the read route beside this
     one: a route that binds the factory once at import cannot be exercised
     without a live network. */
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) }) },
  });
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/* Vercel parses a JSON body for us, but a raw stream arrives from a plain
   Node server and from `curl --data-binary`. Both are accepted; anything that
   is not an object is a 400 rather than a silently empty article. */
async function readBody(req) {
  if (req && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = '';
  if (req && typeof req.body === 'string') {
    raw = req.body;
  } else if (Buffer.isBuffer(req && req.body)) {
    raw = req.body.toString('utf8');
  } else if (req && typeof req.on === 'function') {
    raw = await new Promise((resolve, reject) => {
      let text = '';
      req.on('data', (chunk) => {
        text += chunk;
        if (text.length > MAX_CONTENT * 2) reject(fail('Request body is too large', 413));
      });
      req.on('end', () => resolve(text));
      req.on('error', reject);
    });
  }
  if (!String(raw).trim()) throw fail('A JSON body is required');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (err) {
    throw fail('The request body is not valid JSON');
  }
}

/**
 * One string field, bounded and reported by name.
 *
 * `preserve` keeps the value exactly as sent and only uses the trimmed form to
 * decide whether it is empty. That is for the markdown body: a trailing
 * newline is part of what the generator wrote, and trimming it would mean a
 * story read back out of the table is not byte for byte the story that was
 * published.
 */
function text(body, name, { max, required = false, fallback = '', preserve = false }) {
  const raw = String(body[name] == null ? '' : body[name]);
  const trimmed = raw.trim();
  if (!trimmed) {
    if (required) throw fail(name + ' is required');
    return fallback;
  }
  if (raw.length > max) throw fail(name + ' is longer than ' + max + ' characters');
  return preserve ? raw : trimmed;
}

function integer(body, name, { min, max, required = true }) {
  const raw = body[name];
  if (raw == null || raw === '') {
    if (required) throw fail(name + ' is required');
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw fail(name + ' must be a whole number between ' + min + ' and ' + max);
  }
  return value;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/* An ISO timestamp the caller chose, or now. A backfill needs to publish a
   story under the date it belongs to; an unparseable one is refused rather
   than quietly becoming today. */
function publishedAt(body, now) {
  const raw = String(body.published_at == null ? '' : body.published_at).trim();
  if (!raw) return new Date(now).toISOString();
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) throw fail('published_at is not a valid timestamp');
  return when.toISOString();
}

/* Only the four contract fields plus the math evidence, and only from rows
   that are objects. A malformed entry is dropped rather than stored: the
   column is what a reader audits a published claim against, and a half-row
   there is worse than one fewer chip. */
function trackedPlayers(body) {
  const rows = body.tracked_players;
  if (rows == null) return [];
  if (!Array.isArray(rows)) throw fail('tracked_players must be an array');
  if (rows.length > 200) throw fail('tracked_players carries more than 200 rows');
  return rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

/**
 * The record to write, assembled from either naming generation.
 *
 * Both generations are written every time. The database trigger would fill in
 * whichever side was missing, but doing it here as well means the route works
 * against a database that has not run the new schema file yet, and means the
 * record this route returns is the record it sent.
 */
function buildRecord(body, now) {
  const league_id = text(body, 'league_id', { max: 64, required: true });
  if (!/^[A-Za-z0-9._-]+$/.test(league_id)) throw fail('league_id has characters that are not allowed');

  const season = integer(body, 'season', { min: 1990, max: 2100 });
  const week = integer(body, 'week', { min: 1, max: 18 });

  /* Tier 1 and tier 3 under either name. `headline` and `content` win when
     both are sent; `title` and `content_markdown` are what a caller written
     against the old shape sends. */
  const headline = text(body, 'headline', { max: MAX_HEADLINE }) ||
    text(body, 'title', { max: MAX_HEADLINE, required: true });
  const content = text(body, 'content', { max: MAX_CONTENT, preserve: true }) ||
    text(body, 'content_markdown', { max: MAX_CONTENT, required: true, preserve: true });

  const article_type = text(body, 'article_type', { max: 40, fallback: DEFAULT_ARTICLE_TYPE });
  if (!ARTICLE_TYPES.includes(article_type)) {
    throw fail('article_type must be one of ' + ARTICLE_TYPES.join(', '));
  }

  const category = text(body, 'category', { max: MAX_SHORT });
  const slug = text(body, 'slug', { max: MAX_SLUG }) ||
    season + '-week-' + week + '-' + (slugify(category) || slugify(article_type) || 'dispatch') + '-' + league_id;

  return {
    league_id,
    slug,

    /* Tier 1, 2, 3 and the meta line. */
    headline,
    match_impact_summary: text(body, 'match_impact_summary', { max: MAX_SUMMARY }),
    content,
    category,
    author: text(body, 'author', { max: MAX_SHORT, fallback: DEFAULT_AUTHOR }),

    /* The legacy columns, kept in lockstep. They are NOT NULL on the table and
       they are what the static blog build reads. */
    title: headline,
    content_markdown: content,

    excerpt: text(body, 'excerpt', { max: MAX_SUMMARY }),
    article_type,
    season,
    week,
    tracked_players: trackedPlayers(body),
    published_at: publishedAt(body, now),
  };
}

/* The columns added by the three-tier block of supabase/blog_articles.sql. A
   database that has not run it yet rejects the write with PostgREST's
   "column does not exist"; the retry below drops exactly these and keeps the
   story, in the legacy columns, rather than losing it to a pending
   migration. */
const TIER_COLUMNS = ['headline', 'match_impact_summary', 'content', 'category', 'author'];
const UNDEFINED_COLUMN = '42703';

function isMissingColumn(err) {
  if (!err) return false;
  if (String(err.code || '') === UNDEFINED_COLUMN) return true;
  return /column .* does not exist/i.test(String(err.message || ''));
}

function withoutTierColumns(record) {
  const legacy = {};
  for (const key of Object.keys(record)) {
    if (!TIER_COLUMNS.includes(key)) legacy[key] = record[key];
  }
  return legacy;
}

async function store(supabase, record) {
  const write = (row) => supabase
    .from('blog_articles')
    .upsert(row, { onConflict: 'slug' })
    .select()
    .single();

  let result = await write(record);
  if (result.error && isMissingColumn(result.error)) {
    console.warn(
      '[BlogPublish] the three-tier columns are not on this database yet; storing "' + record.slug +
        '" in the legacy columns. Run supabase/blog_articles.sql.',
      result.error,
    );
    result = await write(withoutTierColumns(record));
  }
  if (result.error) throw result.error;
  if (!result.data) throw fail('The article write returned no row', 502);
  return result.data;
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST' && req.method !== 'PUT') {
    res.setHeader('Allow', 'POST, PUT');
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  /* Checked before the body is parsed, so an unauthorized caller learns
     nothing about which inputs this route would have accepted. */
  if (!authorizedByCronSecret(req)) {
    if (!cronSecretConfigured()) {
      console.error(
        '[BlogPublish] refused: CRON_SECRET is not set in this environment, so the route cannot ' +
          'authenticate its caller and will not publish anything.',
        new Error('CRON_SECRET_MISSING'),
      );
      res.status(503).json({ error: 'PUBLISHING_NOT_CONFIGURED' });
      return;
    }
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  let record;
  try {
    record = buildRecord(await readBody(req), Date.now());
  } catch (err) {
    console.warn('[BlogPublish] rejected a publish request: ' + (err && err.message), err);
    res.status(err && err.status ? err.status : 400).json({
      error: 'INVALID_REQUEST',
      message: String((err && err.message) || 'The request could not be read'),
    });
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    console.error(
      '[BlogPublish] cannot reach Supabase: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing ' +
        'from the environment.',
      new Error('SUPABASE_NOT_CONFIGURED'),
    );
    res.status(503).json({ error: 'STORAGE_NOT_CONFIGURED' });
    return;
  }

  try {
    const saved = await store(supabase, record);
    res.status(200).json({
      ok: true,
      slug: record.slug,
      league_id: record.league_id,
      season: record.season,
      week: record.week,
      article: {
        slug: record.slug,
        headline: record.headline,
        match_impact_summary: record.match_impact_summary,
        content: record.content,
        category: record.category,
        author: record.author,
        article_type: record.article_type,
        season: record.season,
        week: record.week,
        published_at: saved && saved.published_at ? saved.published_at : record.published_at,
      },
    });
  } catch (err) {
    console.error(
      '[BlogPublish] write failed for league ' + record.league_id +
        ' (season ' + record.season + ', week ' + record.week + ', slug ' + record.slug + ')',
      err,
    );
    /* The upstream message stays in the logs. A publishing caller gets the
       fact and the slug it failed on, which is what a retry needs. */
    res.status(502).json({ error: 'WRITE_FAILED', slug: record.slug });
  }
}

module.exports = handler;
module.exports.default = handler;
module.exports.buildRecord = buildRecord;
