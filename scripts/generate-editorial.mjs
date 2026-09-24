#!/usr/bin/env node
/* ============================================================================
   FSN — PUBLIC EDITORIAL GENERATOR
   ----------------------------------------------------------------------------
   Writes one global, league-agnostic article into `landing/content/blog/`, from
   a public source. It never reads a league id, a roster, a fantasy score or any
   provider payload, so nothing it writes can carry private league state onto a
   public page.

   ---- TWO SOURCE MODES ----

   `sleeper` (default)
       Sleeper's free, public, read-only API. No account, no key, no auth
       header. Three reads:

         GET /v1/state/nfl
             The live season, week and season type. This is the only place the
             week comes from; the generator never guesses it off the calendar.
         GET /v1/players/nfl/trending/add?lookback_hours=24&limit=10
             Platform-wide add counts for the last 24 hours, as
             [{ player_id, count }].
         GET /v1/players/nfl
             The player index, for names, positions, teams and injury
             designations. It is several megabytes and Sleeper asks that it be
             pulled at most once a day, so it is slimmed to the fields used
             here and cached under scripts/data/.cache/ for 24 hours.

       Every number in the generated article is a field Sleeper returned. The
       generator has no model call, no projection and no invented statistic: if
       Sleeper did not say it, it is not in the article.

   `rss`
       One item from a public RSS or Atom feed, rewritten as a short attributed
       brief that links back to the original report. This was the original mode
       and is unchanged.

   The default run tries Sleeper, falls back to the feeds, then to a verified
   local snapshot, and writes nothing at all if none of them verifies. A
   network-restricted environment therefore degrades to "no output" rather than
   to a fabricated one.

   ---- WHAT PUBLISHES WHERE ----

   The public blog at fantasysportsnetwork.app/blog is file backed: it serves
   the payload that `npm run build:blog` compiles out of
   `landing/content/blog/**`. Writing the source file and running that build is
   what puts an article on /blog.

   The Supabase upsert is the second half, not a substitute for it. The row
   lands in `blog_articles` with `league_id` NULL and
   `article_type = 'global_editorial'`, which is the database's definition of a
   global article: a check constraint makes NULL league and that one type
   imply each other, so a private league recap cannot become global and a
   global article cannot be attributed to a league. It needs
   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; with neither set the run says so
   and still writes the file.

   Usage:
     node scripts/generate-editorial.mjs
     node scripts/generate-editorial.mjs --mode rss --feed https://example.com/nfl.xml
     node scripts/generate-editorial.mjs --no-supabase
     node scripts/generate-editorial.mjs --self-test

   Options:
     --mode <sleeper|rss|auto>    Source mode. Default `auto`: Sleeper first,
                                  public feeds if Sleeper is unreachable.
     --sleeper-base <url>         Sleeper API origin. Default
                                  https://api.sleeper.app/v1.
     --refresh-players            Ignore the cached Sleeper player index.
     --no-supabase                Write the source file only. Skip the upsert.
     --feed <url>                 Repeatable public RSS or Atom feed URL.
     --item <n>                   Zero-based usable item in the feed (default 0).
     --category <name>            Optional explicit blog category.
     --player "Name|POSITION"     Repeatable, evidence-backed entity tag for
                                  feed mode. The supplied name must appear in
                                  the source item.
     --publish-date <YYYY-MM-DD>  Optional date override (default: source date).
     --week <1-18>                Optional source week for feed mode. It must
                                  appear in the verified source text.
     --local-state <file>         Optional local JSON fallback containing a
                                  `verifiedEditorialSource` object. It is read
                                  only after live reads fail and is never
                                  published unless its source text validates.
     --out <dir>                  Optional output directory.
     --self-test                  Network-free parser, board and upsert-shape
                                  check.

   After generation, compile the static public payload with `npm run build:blog`.
============================================================================ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'landing', 'content', 'blog');
const DEFAULT_FEED = 'https://news.google.com/rss/search?q=NFL%20fantasy%20football&hl=en-US&gl=US&ceid=US:en';
const DEFAULT_LOCAL_STATE = path.join(ROOT, 'scripts', 'data', 'weekly-editorial-source.json');
const BANNED_CHARS = /[—―]/;

/* RFC 2606 / RFC 6761 reserved names. A source URL on one of these is a
   placeholder somebody forgot to replace, not a report, and a public article
   that links to one is worse than no article at all. Refused by default; the
   self-test opts in explicitly so it can still exercise the fallback path. */
const RESERVED_SOURCE_HOST = /(?:^|\.)(?:test|invalid|localhost|local|example)$|(?:^|\.)example\.(?:com|net|org)$/i;

/* ---------------------------------------------------------------------------
   SLEEPER
--------------------------------------------------------------------------- */

const DEFAULT_SLEEPER_BASE = 'https://api.sleeper.app/v1';
const SLEEPER_CACHE_DIR = path.join(ROOT, 'scripts', 'data', '.cache');
const DEFAULT_PLAYERS_CACHE = path.join(SLEEPER_CACHE_DIR, 'sleeper-players.json');
/* Sleeper documents players/nfl as a once-a-day call. The cache honours that
   and also keeps a same-day re-run from re-downloading several megabytes. */
const PLAYERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TRENDING_LOOKBACK_HOURS = 24;
const TRENDING_LIMIT = 10;
/* Below this the board is not a board, it is an anecdote. A short list means
   something upstream is wrong (a partial response, an offseason lull), and a
   two-name waiver column is worse than no column. */
const MIN_BOARD_ROWS = 3;
const MAX_FEATURED_ROWS = 8;
const MAX_ENTITIES = 5;
const GLOBAL_ARTICLE_TYPE = 'global_editorial';
const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

/* Mirrors normName in scripts/build-blog.mjs, which does the matching on the
   other side of this list. */
const normName = (value) => String(value == null ? '' : value)
  .replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function loadWaiverAnchors(file = path.join(ROOT, 'scripts', 'data', 'waiver-anchors.json')) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    /* An empty blocklist would quietly put consensus starters on a waiver
       board, which scripts/build-blog.mjs then fails the build over. Refuse
       here instead, where the message points at the real cause. */
    throw new Error('[generate-editorial] could not read the waiver anchor list at ' + file + ': ' + err.message);
  }
  const anchors = parsed && parsed.anchors;
  if (!Array.isArray(anchors) || !anchors.length) {
    throw new Error('[generate-editorial] ' + file + ' has no "anchors" array; refusing to build a waiver board without the blocklist.');
  }
  return new Set(anchors.map(normName).filter(Boolean));
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, raw) => {
      const code = raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : parseInt(raw, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function cleanText(value) {
  return decodeEntities(String(value == null ? '' : value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripFeedSuffix(title) {
  /* Google News appends " - Publisher". Preserve all other source copy. */
  return String(title || '').replace(/\s+-\s+[^-]{2,80}$/, '').trim();
}

function xmlTag(block, names) {
  for (const name of names) {
    const re = new RegExp('<(?:[A-Za-z0-9_-]+:)?' + name + '\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?' + name + '>', 'i');
    const match = re.exec(block);
    if (match) return cleanText(match[1]);
  }
  return '';
}

function xmlLink(block) {
  const atom = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(block);
  if (atom) return decodeEntities(atom[1]).trim();
  return xmlTag(block, ['link']);
}

function parseFeed(xml) {
  const source = String(xml || '');
  const chunks = source.match(/<(?:[A-Za-z0-9_-]+:)?(?:item|entry)\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?(?:item|entry)>/gi) || [];
  return chunks.map((chunk) => ({
    title: stripFeedSuffix(xmlTag(chunk, ['title'])),
    description: xmlTag(chunk, ['description', 'summary', 'content']),
    url: xmlLink(chunk),
    publishedAt: xmlTag(chunk, ['pubDate', 'published', 'updated', 'date']),
    author: xmlTag(chunk, ['creator', 'author']),
  })).filter((item) => item.title && item.url);
}

function parsePlayer(raw) {
  const parts = String(raw || '').split('|');
  const name = cleanText(parts.shift());
  const position = cleanText(parts.join('|')).toUpperCase();
  if (!name) throw new Error('[generate-editorial] --player requires a name, for example "CeeDee Lamb|WR".');
  return { name, position };
}

async function fetchJson(url, { timeoutMs = 15000, label = 'Sleeper' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } catch (err) {
    throw new Error('[generate-editorial] ' + label + ' request to ' + url + ' failed: ' + err.message);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  if (!res.ok) {
    throw new Error('[generate-editorial] ' + label + ' returned ' + res.status + ' ' + res.statusText + ' for ' + url + '.');
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error('[generate-editorial] ' + label + ' returned a body that is not JSON: ' + err.message);
  }
}

/**
 * The live week, from Sleeper and from nowhere else.
 *
 * The week a story is filed under decides which readers ever see it, so it is
 * never inferred from the calendar here. If Sleeper reports a week outside the
 * regular season the run refuses: an article stamped week 0 in the offseason
 * would sit in a bucket no reader opens.
 */
function normalizeSleeperState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('[generate-editorial] Sleeper state/nfl did not return an object.');
  }
  const season = Number(raw.season);
  const week = Number(raw.display_week != null && raw.display_week !== '' ? raw.display_week : raw.week);
  const seasonType = String(raw.season_type || '').trim().toLowerCase();
  if (!Number.isInteger(season) || season < 1990 || season > 2100) {
    throw new Error('[generate-editorial] Sleeper state/nfl reported season "' + raw.season + '", which is not a usable season.');
  }
  if (seasonType !== 'regular' && seasonType !== 'post') {
    throw new Error('[generate-editorial] Sleeper state/nfl reports season_type "' + seasonType + '". Refusing to publish a weekly board outside the season.');
  }
  if (!Number.isInteger(week) || week < 1 || week > 18) {
    throw new Error('[generate-editorial] Sleeper state/nfl reported week "' + raw.week + '", which is outside the 1 through 18 window. Refusing to stamp an article with a week no reader can open.');
  }
  return { season, week, seasonType };
}

function normalizeTrending(raw) {
  if (!Array.isArray(raw)) {
    throw new Error('[generate-editorial] Sleeper trending/add did not return an array.');
  }
  return raw
    .map((row) => ({
      playerId: String((row && row.player_id) == null ? '' : row.player_id).trim(),
      adds: Number(row && row.count),
    }))
    .filter((row) => row.playerId && Number.isFinite(row.adds) && row.adds > 0);
}

/* Only the fields the article actually prints. The full index is roughly a
   hundred fields across eleven thousand players; keeping the slim form is what
   makes the cache cheap to write and cheap to read back. */
function slimPlayers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('[generate-editorial] Sleeper players/nfl did not return an object keyed by player id.');
  }
  const slim = Object.create(null);
  for (const [playerId, player] of Object.entries(raw)) {
    if (!player || typeof player !== 'object') continue;
    const fullName = cleanText(player.full_name || [player.first_name, player.last_name].filter(Boolean).join(' '));
    if (!fullName) continue;
    slim[String(playerId)] = {
      full_name: fullName,
      position: cleanText(player.position).toUpperCase(),
      team: cleanText(player.team).toUpperCase(),
      injury_status: cleanText(player.injury_status),
      years_exp: Number.isFinite(Number(player.years_exp)) ? Number(player.years_exp) : null,
      depth_chart_order: Number.isFinite(Number(player.depth_chart_order)) ? Number(player.depth_chart_order) : null,
    };
  }
  if (!Object.keys(slim).length) {
    throw new Error('[generate-editorial] Sleeper players/nfl returned no named players.');
  }
  return slim;
}

async function sleeperPlayerIndex(base, { cacheFile = DEFAULT_PLAYERS_CACHE, refresh = false, now = Date.now() } = {}) {
  if (!refresh) {
    try {
      const age = now - fs.statSync(cacheFile).mtimeMs;
      if (age >= 0 && age < PLAYERS_CACHE_TTL_MS) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cached && typeof cached === 'object' && Object.keys(cached).length) {
          console.log('[generate-editorial] using the cached Sleeper player index (' +
            Object.keys(cached).length + ' players, ' + Math.round(age / 3600000) + 'h old).');
          return cached;
        }
      }
    } catch (err) {
      /* A cold, stale or corrupt cache is the normal path on a fresh runner,
         not a failure. Say which it was, then fetch. */
      console.warn('[generate-editorial] the Sleeper player cache was not usable (' + err.message + '); fetching a fresh index.');
    }
  }
  /* players/nfl is several megabytes. It gets its own, longer budget. */
  const slim = slimPlayers(await fetchJson(base + '/players/nfl', { timeoutMs: 60000, label: 'Sleeper players/nfl' }));
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(slim), 'utf8');
  } catch (err) {
    console.warn('[generate-editorial] could not write the Sleeper player cache to ' + cacheFile + ': ' + err.message);
  }
  return slim;
}

/**
 * Trending ids joined to names, highest add count first.
 *
 * A trending id with no entry in the player index is dropped, loudly: an
 * unnamed row on a public board is not something to paper over with "Player
 * 4034". On a waiver board the consensus anchors go too. Sleeper counts adds
 * across every league on the platform, so a locked-in starter surfaces there
 * on ordinary drop/add churn and would fail the same realism guard in
 * scripts/build-blog.mjs the moment the file was built.
 */
function trendingBoard(trending, players, { category = '', anchors = null } = {}) {
  const blocked = /waiver/i.test(category) ? (anchors || loadWaiverAnchors()) : new Set();
  const rows = [];
  for (const entry of trending) {
    const player = players[entry.playerId];
    if (!player) {
      console.warn('[generate-editorial] Sleeper trending id ' + entry.playerId +
        ' has no entry in the player index; leaving it off the board rather than publishing an unnamed row.');
      continue;
    }
    const name = cleanText(player.full_name);
    const position = cleanText(player.position).toUpperCase();
    if (!name || !FANTASY_POSITIONS.has(position)) continue;
    if (blocked.has(normName(name))) {
      console.warn('[generate-editorial] "' + name + '" is a consensus-owned roster anchor; leaving it off a waiver board.');
      continue;
    }
    rows.push({
      playerId: entry.playerId,
      adds: entry.adds,
      name,
      position,
      team: cleanText(player.team).toUpperCase(),
      injuryStatus: cleanText(player.injury_status),
      yearsExp: Number.isFinite(Number(player.years_exp)) ? Number(player.years_exp) : null,
      depthChartOrder: Number.isFinite(Number(player.depth_chart_order)) ? Number(player.depth_chart_order) : null,
    });
  }
  rows.sort((a, b) => (b.adds - a.adds) || a.name.localeCompare(b.name));
  return rows;
}

const countOf = (value) => Number(value).toLocaleString('en-US');

/* Everything printed about a player is a field Sleeper returned. No
   projection, no efficiency read, no invented stat line.

   `index` exists to keep the board from reading like a mail merge. The line
   explaining what a backup's add spike is betting against is true of most rows
   on most weeks, so it is said once, near the top, and the rows below it get
   the bare depth chart fact. Eight identical explanatory clauses is filler,
   and filler is what a reader skims past on the way to the names. */
function rowSentences(row, index) {
  const lines = ['Added in **' + countOf(row.adds) + '** leagues in the last ' + TRENDING_LOOKBACK_HOURS + ' hours.'];
  if (row.injuryStatus) {
    lines.push('Sleeper currently carries a ' + row.injuryStatus.toLowerCase() + ' designation on this roster spot, so check the status before the claim locks.');
  }
  const spot = (row.team || 'team') + ' depth chart at ' + row.position;
  if (row.depthChartOrder === 1) {
    lines.push('Listed first on the ' + spot + '.');
  } else if (row.depthChartOrder === 2) {
    lines.push(index === 0
      ? 'Listed second on the ' + spot + ', which is what a spike in adds is usually betting against.'
      : 'Listed second on the ' + spot + '.');
  }
  if (row.yearsExp === 0) lines.push('A rookie, in a first NFL season.');
  else if (row.yearsExp === 1) lines.push('In a second NFL season.');
  return lines.join(' ');
}

function sleeperBody(state, board, featured) {
  const leader = featured[0];
  const parts = [];
  parts.push('## The most added players in the last ' + TRENDING_LOOKBACK_HOURS + ' hours');
  parts.push(
    'Sleeper publishes how many leagues across its entire platform added each player, and these are ' +
    'those counts as they stand for week ' + state.week + ' of the ' + state.season + ' season. Read them as demand, ' +
    'not as value. A name at the top of this list is being chased in every league at once, which is ' +
    'exactly when a claim costs more than the player is worth. The names further down carry the same ' +
    'information at a price somebody will still take.'
  );
  featured.forEach((row, index) => {
    const where = row.team ? ', ' + row.team : '';
    parts.push('### ' + (index + 1) + '. **' + row.name + '**, ' + row.position + where);
    parts.push(rowSentences(row, index));
  });
  parts.push('## How to read the board');
  parts.push(
    'The gap between the first name and the last one is the useful number here. **' + leader.name + '** at ' +
    countOf(leader.adds) + ' adds and the bottom of this list at ' + countOf(featured[featured.length - 1].adds) +
    ' are not the same kind of claim, even though both are trending. The first is a bidding war and the ' +
    'second is a quiet add, and in a league where everyone is looking at the same public counts, the ' +
    'quiet add is usually where the margin is.'
  );
  parts.push(
    'These counts cover every league on the platform, not yours. A player already rostered in your ' +
    'league is noise on this board no matter how hard the rest of the platform is chasing the name. ' +
    'Start from the list, then check your own wire.'
  );
  parts.push('*Source: Sleeper public API, add counts over the last ' + TRENDING_LOOKBACK_HOURS + ' hours.*');
  return parts.join('\n\n');
}

function buildSleeperArticle(state, board, options) {
  if (board.length < MIN_BOARD_ROWS) {
    throw new Error('[generate-editorial] Sleeper trending data resolved to only ' + board.length +
      ' usable player(s), below the ' + MIN_BOARD_ROWS + ' needed for a board. Refusing to publish a stub.');
  }
  const featured = board.slice(0, MAX_FEATURED_ROWS);
  const publishDate = options.publishDate || new Date(options.now || Date.now()).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishDate)) throw new Error('[generate-editorial] publish date must be YYYY-MM-DD.');
  const title = 'Week ' + state.week + ' trending adds: where the waiver money is going';
  const top = featured.slice(0, 3).map((row) => row.name);
  const excerpt = ('Sleeper\'s platform-wide add counts for week ' + state.week + '. ' + top.slice(0, -1).join(', ') +
    (top.length > 1 ? ' and ' + top[top.length - 1] : top[0]) +
    ' are the most claimed players of the last ' + TRENDING_LOOKBACK_HOURS + ' hours, and the gap between the top of ' +
    'the board and the bottom is the part worth acting on.').slice(0, 420);
  const article = {
    title,
    slug: slugify(publishDate + '-' + title),
    publishDate,
    category: options.category || 'Waiver Wire',
    excerpt,
    author: 'FSN Desk',
    week: state.week,
    entities: featured.slice(0, MAX_ENTITIES).map((row) => ({
      name: row.name,
      position: row.position,
      sleeperPlayerId: row.playerId,
    })),
    body: sleeperBody(state, board, featured),
    impactSummary: '**' + featured[0].name + '** leads the platform with ' + countOf(featured[0].adds) +
      ' adds in the last ' + TRENDING_LOOKBACK_HOURS + ' hours.',
    scope: { season: state.season, week: state.week },
  };
  return article;
}

async function sleeperSource(options) {
  const base = String(options.sleeperBase || DEFAULT_SLEEPER_BASE).replace(/\/+$/, '');
  const state = normalizeSleeperState(await fetchJson(base + '/state/nfl', { label: 'Sleeper state/nfl' }));
  console.log('[generate-editorial] Sleeper reports ' + state.seasonType + ' season ' + state.season + ', week ' + state.week + '.');
  const trending = normalizeTrending(await fetchJson(
    base + '/players/nfl/trending/add?lookback_hours=' + TRENDING_LOOKBACK_HOURS + '&limit=' + TRENDING_LIMIT,
    { label: 'Sleeper trending/add' },
  ));
  if (!trending.length) {
    throw new Error('[generate-editorial] Sleeper trending/add returned no players with a positive add count.');
  }
  const players = await sleeperPlayerIndex(base, { cacheFile: options.playersCache, refresh: options.refreshPlayers, now: options.now });
  const board = trendingBoard(trending, players, { category: options.category || 'Waiver Wire' });
  return buildSleeperArticle(state, board, options);
}

/* ---------------------------------------------------------------------------
   SUPABASE — the global row

   PostgREST directly rather than @supabase/supabase-js, because this script is
   an ESM module run by `node scripts/...` with no bundler and no install step
   in the path that matters, and the whole call is one POST.

   `league_id: null` plus `article_type: 'global_editorial'` is the database's
   definition of a global article. supabase/blog_articles.sql carries a check
   constraint making the two imply each other in both directions, so this write
   cannot land in a league's feed (every league read is an equality filter on
   league_id, which never matches NULL) and a league recap can never be
   promoted to global by flipping one column.
--------------------------------------------------------------------------- */

function supabaseConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  return { url, key };
}

/* Both naming generations are written, same as lib/blog-publish.js: the table's
   legacy columns are NOT NULL and the three-tier columns are what the app
   reads, and a row that fills only one side depends on a trigger that a
   database mid-migration may not have yet. */
function globalArticleRow(article, nowIso) {
  if (!article.scope || !Number.isInteger(article.scope.season) || !Number.isInteger(article.scope.week)) {
    throw new Error('[generate-editorial] this article has no verified season and week, so it cannot be stored. ' +
      'Only the Sleeper board carries them, and they come from state/nfl rather than the calendar.');
  }
  return {
    league_id: null,
    article_type: GLOBAL_ARTICLE_TYPE,
    slug: article.slug,
    headline: article.title,
    title: article.title,
    match_impact_summary: article.impactSummary || '',
    content: article.body,
    content_markdown: article.body,
    excerpt: article.excerpt,
    category: article.category,
    author: article.author,
    season: article.scope.season,
    week: article.scope.week,
    tracked_players: (article.entities || []).map((entity) => ({
      player_name: entity.name,
      position: entity.position || '',
      sleeper_player_id: entity.sleeperPlayerId || '',
    })),
    published_at: nowIso,
  };
}

async function upsertGlobalArticle(config, row, { timeoutMs = 20000 } = {}) {
  const endpoint = config.url + '/rest/v1/blog_articles?on_conflict=slug';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: config.key,
      Authorization: 'Bearer ' + config.key,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify([row]),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error('[generate-editorial] Supabase refused the global article upsert (HTTP ' + res.status + '): ' + body.slice(0, 500));
  }
  let saved = null;
  try { saved = JSON.parse(body); } catch (err) { saved = null; }
  return Array.isArray(saved) ? saved[0] || null : saved;
}

async function publishGlobalArticle(article, options) {
  if (options.noSupabase) {
    console.log('[generate-editorial] --no-supabase: wrote the source file only.');
    return null;
  }
  if (!article.scope) {
    console.warn('[generate-editorial] this article carries no verified season and week, so it was not stored in Supabase. ' +
      'The source file is written and "npm run build:blog" publishes it to /blog.');
    return null;
  }
  const config = supabaseConfig(options.env || process.env);
  if (!config) {
    console.warn('[generate-editorial] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not both set, so the global row ' +
      'was not written. The source file is written and "npm run build:blog" publishes it to /blog.');
    return null;
  }
  const row = globalArticleRow(article, new Date(options.now || Date.now()).toISOString());
  const saved = await upsertGlobalArticle(config, row);
  console.log('[generate-editorial] upserted the global article into blog_articles as "' + row.slug +
    '" (league_id null, ' + GLOBAL_ARTICLE_TYPE + ', season ' + row.season + ' week ' + row.week + ').');
  return saved || row;
}

const MODES = ['auto', 'sleeper', 'rss'];

function parseArgs(argv) {
  const args = {
    mode: 'auto', sleeperBase: DEFAULT_SLEEPER_BASE, refreshPlayers: false, playersCache: DEFAULT_PLAYERS_CACHE,
    noSupabase: false, feeds: [], item: 0, category: '', players: [], publishDate: '', week: 0,
    localState: '', out: DEFAULT_OUT_DIR, selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('[generate-editorial] ' + arg + ' requires a value.');
      return value;
    };
    if (arg === '--mode') {
      args.mode = cleanText(next()).toLowerCase();
      if (!MODES.includes(args.mode)) throw new Error('[generate-editorial] --mode must be one of ' + MODES.join(', ') + '.');
    }
    else if (arg === '--sleeper-base') args.sleeperBase = next();
    else if (arg === '--refresh-players') args.refreshPlayers = true;
    else if (arg === '--players-cache') args.playersCache = path.resolve(next());
    else if (arg === '--no-supabase') args.noSupabase = true;
    else if (arg === '--feed') args.feeds.push(next());
    else if (arg === '--item') args.item = Number(next());
    else if (arg === '--category') args.category = cleanText(next());
    else if (arg === '--player') args.players.push(parsePlayer(next()));
    else if (arg === '--publish-date') args.publishDate = next();
    else if (arg === '--week') args.week = Number(next());
    else if (arg === '--local-state') args.localState = path.resolve(next());
    else if (arg === '--out') args.out = path.resolve(next());
    else if (arg === '--self-test') args.selfTest = true;
    else throw new Error('[generate-editorial] unknown option "' + arg + '". This generator accepts public sources only; league options are not supported.');
  }
  if (!Number.isInteger(args.item) || args.item < 0) throw new Error('[generate-editorial] --item must be a non-negative integer.');
  if (!Number.isInteger(args.week) || args.week < 0 || args.week > 18) throw new Error('[generate-editorial] --week must be an integer from 1 through 18.');
  if (!args.feeds.length) args.feeds.push(DEFAULT_FEED);
  return args;
}

async function fetchFeed(url) {
  let res;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1' },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error('[generate-editorial] request to ' + url + ' failed: ' + err.message);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  if (!res.ok) throw new Error('[generate-editorial] feed returned ' + res.status + ' ' + res.statusText + ' for ' + url + '.');
  const items = parseFeed(body);
  if (!items.length) throw new Error('[generate-editorial] no usable RSS or Atom items were found at ' + url + '.');
  return items;
}

/* A local fallback is intentionally narrow. It may hold a previously verified
   public-source snapshot, but never raw league data, scores, rosters, cookies
   or provider payloads. That keeps a network-restricted run deterministic and
   prevents private state from becoming a public blog post. */
function localVerifiedSource(file, { allowReservedHost = false } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error('[generate-editorial] local state ' + file + ' could not be read: ' + err.message);
  }
  const source = parsed && parsed.verifiedEditorialSource;
  if (!source || typeof source !== 'object') {
    throw new Error('[generate-editorial] local state has no verifiedEditorialSource; no public output will be created.');
  }
  const title = cleanText(source.title);
  const description = cleanText(source.description || source.summary);
  const url = cleanText(source.url);
  const sourceText = cleanText(source.sourceText || source.text);
  if (!title || !url || !sourceText) {
    throw new Error('[generate-editorial] local verifiedEditorialSource requires title, url, and sourceText; no public output will be created.');
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('[generate-editorial] local verifiedEditorialSource url must be http(s); no public output will be created.');
  }
  const host = new URL(url).hostname;
  if (!allowReservedHost && RESERVED_SOURCE_HOST.test(host)) {
    throw new Error('[generate-editorial] local verifiedEditorialSource url points at the reserved placeholder host "' + host +
      '". Replace it with a real, currently live public report; no public output will be created against an example domain.');
  }
  return {
    title,
    description: description || sourceText,
    url,
    publishedAt: cleanText(source.publishedAt || source.publishDate),
    author: cleanText(source.author),
    sourceText,
  };
}

function sourceTextFor(item) {
  return cleanText([item && item.title, item && item.description, item && item.sourceText].filter(Boolean).join(' '));
}

function resolveSourceWeek(item, requestedWeek) {
  const sourceText = sourceTextFor(item);
  const weeks = Array.from(sourceText.matchAll(/\bweek\s+([1-9]|1[0-8])\b/gi), match => Number(match[1]));
  const uniqueWeeks = Array.from(new Set(weeks));
  if (requestedWeek) {
    if (!uniqueWeeks.includes(requestedWeek)) {
      throw new Error('[generate-editorial] --week ' + requestedWeek + ' is not present in the verified source text. Refusing to assign an unsupported week bucket.');
    }
    return requestedWeek;
  }
  return uniqueWeeks.length === 1 ? uniqueWeeks[0] : null;
}

function sourceDate(value, fallback) {
  if (fallback) return fallback;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function slugify(value) {
  const slug = cleanText(value).toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 72).replace(/-+$/g, '');
  return slug || 'nfl-news-brief';
}

function inferCategory(item, explicit) {
  if (explicit) return explicit;
  const text = (item.title + ' ' + item.description).toLowerCase();
  if (/\b(?:waiver|faab|pickup|streamer|claim)\b/.test(text)) return 'Waiver Wire';
  if (/\b(?:injury|injured|questionable|out|inactive|practice)\b/.test(text)) return 'Injury Report';
  if (/\b(?:preview|start sit|matchup|lineup|projection)\b/.test(text)) return 'Matchup Preview';
  if (/\b(?:recap|results|final|highs|lows|standout)\b/.test(text)) return 'Recap';
  return 'Analysis';
}

function dedupeEntities(players, sourceText) {
  const lower = sourceText.toLowerCase();
  const seen = new Set();
  return players.filter((player) => {
    const key = player.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    if (!lower.includes(key)) {
      throw new Error('[generate-editorial] "' + player.name + '" was supplied with --player but does not appear in the selected public feed item. Refusing to create a ghost entity.');
    }
    return true;
  });
}

function buildArticle(item, options) {
  const publishDate = sourceDate(item.publishedAt, options.publishDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishDate)) throw new Error('[generate-editorial] publish date must be YYYY-MM-DD.');
  const summary = cleanText(item.description).slice(0, 420);
  const title = item.title;
  const sourceText = sourceTextFor(item);
  const entities = dedupeEntities(options.players, sourceText);
  const excerpt = summary || 'A public NFL news brief from the FSN desk.';
  const sourceLabel = cleanText(item.author) || new URL(item.url).hostname.replace(/^www\./, '');
  const body = [
    '## Public news brief',
    summary || 'This brief links directly to the original public report.',
    '[Read the original report](' + item.url + ')',
    '*Source: ' + sourceLabel + '*',
  ].join('\n\n');
  return {
    title, slug: slugify(publishDate + '-' + title), publishDate,
    category: inferCategory(item, options.category), excerpt, author: 'FSN Desk',
    week: resolveSourceWeek(item, options.week), entities, body,
  };
}

function validateArticle(article) {
  for (const key of ['title', 'slug', 'publishDate', 'category', 'excerpt', 'author', 'body']) {
    if (!article[key]) throw new Error('[generate-editorial] generated article is missing required field "' + key + '".');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug)) throw new Error('[generate-editorial] generated slug is not lowercase kebab-case.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(article.publishDate)) throw new Error('[generate-editorial] generated publishDate is not YYYY-MM-DD.');
  const haystack = cleanText(article.title + ' ' + article.body).toLowerCase();
  for (const entity of article.entities) {
    if (!haystack.includes(entity.name.toLowerCase())) throw new Error('[generate-editorial] entity "' + entity.name + '" is not named in the public brief.');
  }
  const fields = [article.title, article.slug, article.category, article.excerpt, article.author, article.body, ...article.entities.map((e) => e.name)];
  if (fields.some((field) => BANNED_CHARS.test(String(field)))) throw new Error('[generate-editorial] em dash found in generated content.');
  if (article.week != null && (!Number.isInteger(article.week) || article.week < 1 || article.week > 18)) {
    throw new Error('[generate-editorial] generated week must be an integer from 1 through 18.');
  }
}

function serializeFrontmatter(article) {
  const lines = ['---'];
  for (const key of ['title', 'slug', 'publishDate', 'category', 'excerpt', 'author']) lines.push(key + ': ' + article[key]);
  if (article.week != null) lines.push('week: ' + article.week);
  if (article.entities.length) {
    lines.push('entities:');
    for (const entity of article.entities) {
      lines.push('  - name: ' + entity.name);
      if (entity.position) lines.push('    position: ' + entity.position);
      /* Quoted: Sleeper player ids are numeric strings, and an unquoted 8138
         reads back as a number that no longer matches the id the roster
         matcher compares against. */
      if (entity.sleeperPlayerId) lines.push('    sleeperPlayerId: "' + entity.sleeperPlayerId + '"');
    }
  }
  lines.push('---', '', article.body);
  return lines.join('\n') + '\n';
}

/**
 * One verified article, or null.
 *
 * The order is deliberate. Sleeper is live public data and is tried first.
 * Public feeds are next. The local snapshot is last and is only read after the
 * live reads have actually failed. If none of them verifies, nothing is
 * written: a blog post that says nothing true is worse than no blog post, and
 * the pipeline downstream of this script cannot tell the difference.
 */
async function resolveArticle(options) {
  const failures = [];

  if (options.mode === 'auto' || options.mode === 'sleeper') {
    try {
      const article = await sleeperSource(options);
      console.log('[generate-editorial] built the week ' + article.week + ' board from live Sleeper data.');
      return article;
    } catch (err) {
      failures.push(err);
      if (options.mode === 'sleeper') throw err;
      console.warn('[generate-editorial] Sleeper was not usable: ' + err.message);
    }
  }

  if (options.mode === 'auto' || options.mode === 'rss') {
    let item = null;
    for (const feed of options.feeds) {
      try {
        const items = await fetchFeed(feed);
        item = items[options.item] || null;
        if (!item) throw new Error('[generate-editorial] feed ' + feed + ' has no usable item #' + options.item + '.');
        console.log('[generate-editorial] selected public feed item from ' + feed + '.');
        break;
      } catch (err) {
        failures.push(err);
        console.warn('[generate-editorial] skipping public feed ' + feed + ': ' + err.message);
      }
    }
    const localStatePath = options.localState || (fs.existsSync(DEFAULT_LOCAL_STATE) ? DEFAULT_LOCAL_STATE : '');
    if (!item && localStatePath) {
      try {
        item = localVerifiedSource(localStatePath, { allowReservedHost: options.allowReservedHost === true });
        console.warn('[generate-editorial] live sources were unavailable; using the verified local editorial source at ' +
          path.relative(ROOT, localStatePath) + '.');
      } catch (err) {
        failures.push(err);
        console.warn('[generate-editorial] local fallback rejected: ' + err.message);
      }
    }
    if (item) return buildArticle(item, options);
  }

  const last = failures.length ? failures[failures.length - 1] : null;
  console.warn('[generate-editorial] no verified source is available; no blog, News Desk, or database write was attempted.' +
    (last ? ' Last verification failure: ' + last.message : ''));
  return null;
}

async function generate(options) {
  const article = await resolveArticle(options);
  if (!article) return null;
  validateArticle(article);
  fs.mkdirSync(options.out, { recursive: true });
  const outFile = path.join(options.out, article.slug + '.md');
  fs.writeFileSync(outFile, serializeFrontmatter(article), 'utf8');
  console.log('[generate-editorial] wrote ' + outFile);
  await publishGlobalArticle(article, options);
  return outFile;
}

function fixtureXml() {
  return `<?xml version="1.0"?><rss><channel><title>Fixture</title><item><title>CeeDee Lamb returns to practice - Example Sports</title><link>https://news.example.test/ceedee-lamb-practice</link><description><![CDATA[The Cowboys listed CeeDee Lamb as a full participant in Monday's practice.]]></description><pubDate>Mon, 14 Sep 2026 12:00:00 GMT</pubDate><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">Example Sports</dc:creator></item></channel></rss>`;
}

/* --------------------------------------------------------------------------
   SELF-TEST

   Network free by construction: every source the generator knows how to read
   is served from a local fixture server on 127.0.0.1, including the Supabase
   upsert. That is the point. The environments this runs in (CI, a restricted
   container) cannot reach Sleeper or Supabase, and a check that silently
   skipped itself there would be worth nothing.
-------------------------------------------------------------------------- */

function fixtureState() {
  return { week: 4, display_week: 4, season: '2026', season_type: 'regular', league_season: '2026' };
}

/* Four usable names, one consensus anchor that a waiver board must drop, one
   id with no entry in the player index, and one non-fantasy position. */
function fixtureTrending() {
  return [
    { player_id: '7001', count: 41230 },
    { player_id: '9493', count: 30110 },
    { player_id: '7002', count: 18840 },
    { player_id: '7003', count: 9120 },
    { player_id: '7004', count: 4310 },
    { player_id: '404404', count: 2200 },
    { player_id: '7005', count: 1100 },
  ];
}

function fixturePlayers() {
  return {
    7001: { full_name: 'Tank Bigsby', position: 'RB', team: 'JAX', injury_status: '', years_exp: 2, depth_chart_order: 1 },
    9493: { full_name: 'Puka Nacua', position: 'WR', team: 'LAR', injury_status: '', years_exp: 2, depth_chart_order: 1 },
    7002: { first_name: 'Jaylen', last_name: 'Wright', position: 'RB', team: 'MIA', injury_status: 'Questionable', years_exp: 1, depth_chart_order: 2 },
    7003: { full_name: 'Ray Davis', position: 'RB', team: 'BUF', injury_status: '', years_exp: 0, depth_chart_order: 2 },
    7004: { full_name: 'Jalen McMillan', position: 'WR', team: 'TB', injury_status: '', years_exp: 1, depth_chart_order: 3 },
    7005: { full_name: 'Some Longsnapper', position: 'LS', team: 'NYJ', injury_status: '', years_exp: 5, depth_chart_order: null },
  };
}

async function runSelfTest() {
  const upserts = [];
  const server = createServer((req, res) => {
    const url = String(req.url || '');
    const json = (payload) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url === '/feed.xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(fixtureXml());
      return;
    }
    if (url === '/v1/state/nfl') return json(fixtureState());
    if (url === '/v1/state/offseason') return json({ ...fixtureState(), season_type: 'off', week: 0, display_week: 0 });
    if (url.startsWith('/v1/players/nfl/trending/add')) return json(fixtureTrending());
    if (url.startsWith('/v1/thin/players/nfl/trending/add')) return json([{ player_id: '7001', count: 10 }]);
    if (url === '/v1/players/nfl' || url === '/v1/thin/players/nfl') return json(fixturePlayers());
    if (url === '/v1/thin/state/nfl') return json(fixtureState());
    if (url.startsWith('/rest/v1/blog_articles')) {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        try { upserts.push({ url, headers: req.headers, rows: JSON.parse(raw) }); }
        catch (err) { upserts.push({ url, headers: req.headers, rows: null, parseError: err.message }); }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(upserts[upserts.length - 1].rows || []));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsn-editorial-selftest-'));
  const localState = path.join(tmp, 'verified-editorial-source.json');
  const playersCache = path.join(tmp, 'sleeper-players.json');
  const failures = [];
  const check = (value, message) => { if (!value) failures.push(message); };
  const base = (opts) => ({
    mode: 'rss', sleeperBase: origin + '/v1', refreshPlayers: true, playersCache,
    noSupabase: true, feeds: [origin + '/feed.xml'], item: 0, category: '', players: [],
    publishDate: '', week: 0, localState: '', out: tmp, env: {}, allowReservedHost: true, ...opts,
  });

  try {
    /* ---- Sleeper: the live board ---- */
    const sleeperFile = await generate(base({ mode: 'sleeper', publishDate: '2026-09-24' }));
    const sleeper = fs.readFileSync(sleeperFile, 'utf8');
    check(/^title: Week 4 trending adds/m.test(sleeper), 'the Sleeper board did not take its week from state/nfl');
    check(/^week: 4$/m.test(sleeper), 'the Sleeper board did not serialize the live week');
    check(sleeper.includes('Tank Bigsby'), 'the top trending player is missing from the board');
    check(sleeper.includes('**41,230**'), 'the add count was not printed with its thousands separator');
    check(/sleeperPlayerId: "7001"/.test(sleeper), 'the Sleeper player id was not serialized as a quoted string');
    check(!sleeper.includes('Puka Nacua'), 'a consensus-owned roster anchor was left on a waiver board');
    check(!sleeper.includes('404404') && !sleeper.includes('Player 404404'), 'a trending id with no player record reached the board');
    check(!sleeper.includes('Longsnapper'), 'a non-fantasy position reached the board');
    check(!BANNED_CHARS.test(sleeper), 'the Sleeper board contains banned punctuation');
    check(!/league_id|blog_articles|supabase/i.test(sleeper), 'the Sleeper board leaked a league or database reference into public copy');
    const entityBlock = sleeper.slice(sleeper.indexOf('entities:'), sleeper.indexOf('\n---', sleeper.indexOf('entities:')));
    for (const name of ['Tank Bigsby', 'Jaylen Wright', 'Ray Davis']) {
      check(entityBlock.includes(name), 'entity "' + name + '" is missing from the tracked player tray');
      check(sleeper.includes(name), 'entity "' + name + '" is tagged but never named in the copy');
    }
    check(fs.existsSync(playersCache), 'the Sleeper player index was not cached');

    /* ---- Sleeper: the refusals ---- */
    let offseasonRefused = false;
    try { normalizeSleeperState({ season: 2026, week: 0, display_week: 0, season_type: 'off' }); }
    catch (err) { offseasonRefused = /outside the season/.test(err.message); }
    check(offseasonRefused, 'an offseason state was not refused');

    let badWeekRefused = false;
    try { normalizeSleeperState({ season: 2026, week: 23, display_week: 23, season_type: 'regular' }); }
    catch (err) { badWeekRefused = /1 through 18/.test(err.message); }
    check(badWeekRefused, 'a week outside 1 through 18 was not refused');

    let thinBoardRefused = false;
    try {
      buildSleeperArticle({ season: 2026, week: 4, seasonType: 'regular' },
        [{ playerId: '1', adds: 10, name: 'Only One', position: 'RB', team: 'BUF', injuryStatus: '', yearsExp: 1, depthChartOrder: 1 }],
        { publishDate: '2026-09-24' });
    } catch (err) { thinBoardRefused = /below the 3 needed/.test(err.message); }
    check(thinBoardRefused, 'a board too thin to publish was not refused');

    /* ---- Supabase: the global row ---- */
    const board = trendingBoard(normalizeTrending(fixtureTrending()), slimPlayers(fixturePlayers()), { category: 'Waiver Wire' });
    const article = buildSleeperArticle({ season: 2026, week: 4, seasonType: 'regular' }, board, { publishDate: '2026-09-24' });
    const row = globalArticleRow(article, '2026-09-24T12:00:00.000Z');
    check(row.league_id === null, 'the global row did not set league_id to null');
    check(row.article_type === 'global_editorial', 'the global row did not use the global_editorial type');
    check(row.season === 2026 && row.week === 4, 'the global row did not carry the live season and week');
    check(row.title === row.headline && row.content === row.content_markdown, 'the global row did not fill both naming generations');
    check(row.tracked_players.length > 0 && row.tracked_players[0].sleeper_player_id === '7001',
      'the global row did not carry the Sleeper ids the roster matcher joins on');

    let scopelessRefused = false;
    try { globalArticleRow({ ...article, scope: null }, '2026-09-24T12:00:00.000Z'); }
    catch (err) { scopelessRefused = /no verified season and week/.test(err.message); }
    check(scopelessRefused, 'an article with no verified season and week was offered to the database anyway');

    await generate(base({
      mode: 'sleeper', publishDate: '2026-09-24', noSupabase: false, out: path.join(tmp, 'upsert'),
      env: { SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: 'selftest-service-role' },
    }));
    check(upserts.length === 1, 'the generator did not send exactly one Supabase upsert');
    const sent = upserts[0] || {};
    check(String(sent.url).includes('on_conflict=slug'), 'the upsert was not keyed on slug, so a re-run would stack duplicates');
    check(String(sent.headers && sent.headers.prefer).includes('resolution=merge-duplicates'), 'the upsert was not a merge, so a re-run would conflict');
    check(sent.rows && sent.rows[0] && sent.rows[0].league_id === null, 'the upserted row was not global');
    check(sent.rows && sent.rows[0] && sent.rows[0].article_type === 'global_editorial', 'the upserted row was not typed global_editorial');

    const beforeSkip = upserts.length;
    await generate(base({ mode: 'sleeper', publishDate: '2026-09-24', noSupabase: false, out: path.join(tmp, 'noenv') }));
    check(upserts.length === beforeSkip, 'the generator attempted an upsert with no Supabase credentials configured');

    /* ---- RSS: unchanged behaviour ---- */
    const file = await generate(base({ players: [parsePlayer('CeeDee Lamb|WR')] }));
    const content = fs.readFileSync(file, 'utf8');
    check(content.includes('CeeDee Lamb returns to practice'), 'source headline was not preserved');
    check(content.includes('position: WR'), 'player position was not serialized');
    check(content.includes('[Read the original report](https://news.example.test/ceedee-lamb-practice)'), 'original report link is missing');
    check(!/league\/.+matchup|points:/.test(content), 'output contains a league or fabricated-stat dependency');
    check(!BANNED_CHARS.test(content), 'output contains banned punctuation');
    check(!/^week:/m.test(content), 'unverified fixture did not infer an unsupported week');

    fs.writeFileSync(localState, JSON.stringify({ verifiedEditorialSource: {
      title: 'Week 1 CeeDee Lamb practice update',
      description: 'CeeDee Lamb practiced in full before Week 2.',
      url: 'https://news.example.test/week-1-lamb',
      publishedAt: '2026-09-14', author: 'Example Sports',
      sourceText: 'Week 1 CeeDee Lamb practice update. CeeDee Lamb practiced in full before Week 2.',
    } }), 'utf8');
    const fallbackFile = await generate(base({
      feeds: [origin + '/blocked.xml'], players: [parsePlayer('CeeDee Lamb|WR')], week: 1, localState,
    }));
    const fallbackContent = fs.readFileSync(fallbackFile, 'utf8');
    check(/^week: 1$/m.test(fallbackContent), 'verified local fallback did not preserve its source week');
    check(fallbackContent.includes('CeeDee Lamb'), 'verified local fallback dropped its source entity');

    /* ---- Nothing verified: nothing written ---- */
    const quiet = path.join(tmp, 'quiet');
    fs.mkdirSync(quiet, { recursive: true });
    const noOutput = await generate(base({
      mode: 'auto', sleeperBase: origin + '/v1/blocked', feeds: [origin + '/blocked.xml'],
      localState: path.join(tmp, 'missing-state.json'), out: quiet, noSupabase: false,
      env: { SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: 'selftest-service-role' },
    }));
    check(noOutput === null, 'unverified fallback did not return the safe no-write result');
    check(fs.readdirSync(quiet).length === 0, 'unverified fallback wrote a blog artifact');
    check(upserts.length === beforeSkip, 'unverified fallback still wrote a database row');

    let reservedHostRejected = false;
    try { localVerifiedSource(localState); }
    catch (err) { reservedHostRejected = /reserved placeholder host/.test(err.message); }
    check(reservedHostRejected, 'a placeholder source host was accepted as a real public report');

    let leagueOptionRejected = false;
    try { parseArgs(['--league', '123']); }
    catch (err) { leagueOptionRejected = /league options are not supported/.test(err.message); }
    check(leagueOptionRejected, 'legacy league input was not rejected');

    let ghostRejected = false;
    try { buildArticle(parseFeed(fixtureXml())[0], { players: [parsePlayer('Ghost Player|QB')], category: '', publishDate: '', week: 0 }); }
    catch (err) { ghostRejected = /ghost entity/.test(err.message); }
    check(ghostRejected, 'unmentioned player entity was not rejected');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error('[generate-editorial] SELF-TEST FAILED:');
    failures.forEach((failure) => console.error('  - ' + failure));
    process.exit(1);
  }
  console.log('[generate-editorial] self-test passed: live Sleeper ingestion, waiver realism filtering, ' +
    'attributed Markdown, evidence-backed player entities, a global (league_id null) Supabase upsert, ' +
    'and no league or fabricated-stat dependency.');
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(err.message); process.exit(1); }
  if (args.selfTest) { await runSelfTest(); return; }
  try {
    const file = await generate(args);
    if (file) console.log('[generate-editorial] done. Run "npm run build:blog" to compile ' + path.relative(ROOT, file) + ' onto /blog.');
    else console.log('[generate-editorial] skipped safely: no verified source, no output written.');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
