/* ============================================================================
   FSN GLOBAL BLOG — /api/blog/global

   The general-audience blog, served from the APP's own origin so the phone
   has one host to talk to.

   ---- WHAT THIS IS NOT ----

   It is not /api/blog/articles. That route reads `blog_articles`, which holds
   one league's private recaps per row, and it refuses a request that does not
   name a league. This route reads the GLOBAL blog: real-world NFL copy,
   identical for every reader, compiled from landing/content/blog by
   scripts/build-blog.mjs. The two share a file and nothing else.

   ---- WHY IT EXISTS AT ALL ----

   The compiled payload is already public and edge-cached on the landing
   deploy, and the app used to read it there directly. Two problems with that:
   the app depended on a second origin's CORS for a core screen, and there was
   no single place to change where global articles come from.

   This is that seam. Today it re-serves the compiled payload; the day global
   articles move into a table, only this file changes and the app does not.

   ---- WHY IT IS NOT ITS OWN FILE UNDER api/ ----

   Vercel makes every file under `api/` a Serverless Function and this plan
   allows twelve. The project has exactly twelve. A thirteenth builds fine and
   then fails the DEPLOY at patchBuild, taking the whole site down, which has
   happened here before. So api/blog/articles.js dispatches to this on
   `?action=global`, and vercel.json rewrites the public /api/blog/global onto
   it. `npm run check:functions` holds the budget.

     GET /api/blog/global              the manifest: every published article
     GET /api/blog/global?slug=<slug>  one article, with its rendered body

   Both carry `tracked_players`: the players each story is about, which the
   app matches against the reader's own roster.
============================================================================ */

'use strict';

/* The landing deploy, which serves the compiled payload. Overridable for a
   preview deploy or a local fixture server, and validated to a bare origin so
   a malformed value fails loudly instead of producing broken request URLs. */
const DEFAULT_CONTENT_ORIGIN = 'https://fantasysportsnetwork.app';
const INDEX_PATH = '/content/generated/blog/index.json';
const POSTS_PATH = '/content/generated/blog/posts/';

const UPSTREAM_TIMEOUT_MS = 8000;

/* A slug is a filename on the upstream. Anything outside this alphabet could
   walk the path, so it is refused rather than encoded and hoped for. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,120}$/;

function contentOrigin() {
  const raw = String(process.env.FSN_BLOG_CONTENT_ORIGIN || '').trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_CONTENT_ORIGIN;
  if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(raw)) {
    console.error(
      '[BlogGlobal] FSN_BLOG_CONTENT_ORIGIN ("' + raw + '") is not a bare origin, so it has been ' +
        'ignored and reads fall back to ' + DEFAULT_CONTENT_ORIGIN + '.',
      new Error('BAD_CONTENT_ORIGIN'),
    );
    return DEFAULT_CONTENT_ORIGIN;
  }
  return raw;
}

function queryParam(req, name) {
  const value = req && req.query && req.query[name];
  if (Array.isArray(value)) return String(value[0] == null ? '' : value[0]);
  return String(value == null ? '' : value).trim();
}

/* Public content, so any origin may read it: the app runs on
   app.fantasysportsnetwork.app on the web and on capacitor://localhost in the
   native shell. Same posture as the league read beside it, and for the same
   reason: this is published material. */
function applyHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=86400');
}

async function readUpstream(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response || !response.ok) {
    throw Object.assign(new Error('Blog content read failed (HTTP ' + (response && response.status) + ')'), {
      status: response && response.status === 404 ? 404 : 502,
    });
  }
  return response.json();
}

/* One shape whichever name the compiled payload used. `entities` was the
   original field and is still emitted beside `tracked_players`; a client must
   never have to know which build produced the file it is reading. */
function trackedPlayers(row) {
  const list = Array.isArray(row && row.tracked_players)
    ? row.tracked_players
    : Array.isArray(row && row.entities) ? row.entities : [];
  return list
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      name: String(entry.name || '').trim(),
      position: String(entry.position || '').trim(),
      sleeperPlayerId: String(entry.sleeperPlayerId || '').trim(),
    }))
    .filter((entry) => entry.name || entry.sleeperPlayerId);
}

function toSummary(row) {
  return {
    slug: String((row && row.slug) || ''),
    title: String((row && row.title) || ''),
    excerpt: String((row && row.excerpt) || ''),
    category: String((row && row.category) || ''),
    author: String((row && row.author) || ''),
    publishDate: String((row && row.publishDate) || ''),
    tracked_players: trackedPlayers(row),
  };
}

function toArticle(row) {
  return Object.assign(toSummary(row), {
    bodyHtml: typeof (row && row.bodyHtml) === 'string' ? row.bodyHtml : '',
  });
}

async function handler(req, res) {
  applyHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const slug = queryParam(req, 'slug');
  if (slug && !SLUG_PATTERN.test(slug)) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json({ error: 'INVALID_REQUEST', message: 'slug is not a valid article slug' });
    return;
  }

  const origin = contentOrigin();
  try {
    if (slug) {
      const post = await readUpstream(origin + POSTS_PATH + encodeURIComponent(slug) + '.json');
      res.status(200).json({ article: toArticle(post) });
      return;
    }
    const manifest = await readUpstream(origin + INDEX_PATH);
    const posts = (manifest && Array.isArray(manifest.posts) ? manifest.posts : []).map(toSummary);
    res.status(200).json({
      generatedAt: (manifest && manifest.generatedAt) || null,
      count: posts.length,
      posts,
    });
  } catch (err) {
    const status = Number(err && err.status) === 404 ? 404 : 502;
    /* A 404 is an article that is not published (or a slug that never
       existed), which is an ordinary answer rather than a fault. Anything
       else means the content origin is unreachable or changed shape, and
       those need different fixes, so they are logged differently. */
    if (status === 404) {
      console.warn('[BlogGlobal] no published content at ' + origin + ' for ' + (slug || 'the manifest'), err);
    } else {
      console.error('[BlogGlobal] the blog content origin ' + origin + ' could not be read for ' +
        (slug ? 'article ' + slug : 'the manifest'), err);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json({ error: status === 404 ? 'NOT_FOUND' : 'READ_FAILED' });
  }
}

module.exports = handler;
module.exports.default = handler;
module.exports.trackedPlayers = trackedPlayers;
