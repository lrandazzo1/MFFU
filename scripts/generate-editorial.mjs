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
       Sleeper's free, public, read-only API for the week and the add counts,
       plus ESPN's public NFL scoreboard for the week's schedule and results. No account, no key, no auth
       header. Four reads, three from Sleeper and one from the public NFL
       scoreboard:

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

         GET site.api.espn.com/.../nfl/scoreboard?dates=<season>&week=<week>
             The week's games, each with a kickoff time, a state (`pre`, `in`
             or `post`), the final score once there is one, and the
             scoreboard's own statistical leaders. This is the only public
             source in reach that carries per game STATE, which is what lets
             the generator preview the games that have not been played and
             recap the ones that have, instead of writing the same column
             every day. Same host and same document that
             lib/notifications/schedule-feed.js already reads for the push
             dispatcher, so this adds no new upstream to the project.

       Every number in the generated article is a field Sleeper or the
       scoreboard returned. The generator has no model call, no projection and
       no invented statistic: if a public source did not say it, it is not in
       the article. Neither source publishes a fantasy projection, so no day's
       column carries one.

   ---- THE DAY DECIDES THE STORY ----

       Thursday   Thursday Night Kickoff Preview: Week N Slate
       Friday     Friday Morning Recap & Weekend Preview: Week N
       Sunday     Sunday Gameday Preview: Week N Final Lineup Decisions
       Monday     Monday Night Preview: What's at Stake & Sunday Recap
       Tuesday    Tuesday Morning Final Recap: Week N Winners & Losers
       Wed / Sat  the evergreen platform-wide add board

   The angle is resolved from the EASTERN weekday, because the NFL's day
   boundaries are Eastern and the interesting runs sit right on top of one: a
   Monday night kickoff is already Tuesday in UTC. No preview names a game or a
   player whose game has kicked off. Wednesday and Saturday, a failed
   scoreboard read, and a preview day whose slate has already moved on all fall
   back to the evergreen board, which makes no per game claim and is therefore
   true at any hour. See THE WEEK'S CLOCK, further down.

   The column has no view of any league, on any day. Two public sources let it
   say which NFL games are still to be played and which players the platform is
   claiming; they cannot tell it what a reader's own matchup needs, and it does
   not pretend otherwise.

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
     node scripts/generate-editorial.mjs --angle monday --no-supabase
     node scripts/generate-editorial.mjs --now 2026-09-28T13:00:00Z
     node scripts/generate-editorial.mjs --mode rss --feed https://example.com/nfl.xml
     node scripts/generate-editorial.mjs --no-supabase
     node scripts/generate-editorial.mjs --self-test

   Options:
     --mode <sleeper|rss|auto>    Source mode. Default `auto`: Sleeper first,
                                  public feeds if Sleeper is unreachable.
     --sleeper-base <url>         Sleeper API origin. Default
                                  https://api.sleeper.app/v1.
     --scoreboard-base <url>      Public NFL scoreboard URL. Default ESPN's.
     --angle <name>               Force the day's angle: thursday, friday,
                                  sunday, monday, tuesday or midweek. Default:
                                  resolved from the Eastern weekday.
     --now <date>                 Treat this instant as now, both for the
                                  weekday and for the played/unplayed split.
                                  Rehearses a day's output without waiting for
                                  that day.
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
function trendingBoard(trending, players, { anchors = null } = {}) {
  /* Unconditional, on every day. This board is framed as a claim list under
     all five of the week's angles, not only under the Waiver Wire category, so
     gating the blocklist on the category string is what would let a consensus
     starter onto a Tuesday "early waiver targets" column. */
  const blocked = anchors || loadWaiverAnchors();
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
      console.warn('[generate-editorial] "' + name + '" is a consensus-owned roster anchor; leaving it off a claim board.');
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

/* ---------------------------------------------------------------------------
   THE WEEK'S CLOCK — the day's angle, and the slate split

   An NFL fantasy week is not one story, it is five, and which one is true
   depends on the hour the generator runs. Before this section existed every
   run wrote the same midweek waiver board, so a Thursday run previewed a week
   that had not started as though it were over, and a Tuesday run filed a
   preview for games whose final scores were already public. The headline was
   the same either way, which is the part a reader notices.

   Two rules hold the whole section together:

   1. THE DAY IS RESOLVED IN EASTERN TIME, NOT UTC. The NFL's day boundaries
      are Eastern, and the interesting runs sit right on top of the boundary: a
      Monday night game kicks off at 20:15 ET, which is already Tuesday in UTC.
      A generator that asked `new Date().getUTCDay()` would file the "Tuesday
      morning final recap" while the Monday night game was still in the second
      quarter, and stamp it with tomorrow's date. Every weekday, hour and
      publish date below comes out of `easternParts()`.

   2. NOTHING IS PREVIEWED THAT HAS ALREADY BEEN PLAYED. The public NFL
      scoreboard carries a per game state (`pre`, `in`, `post`), and every
      preview in this file is built from the `pre` games only. A player whose
      NFL team has kicked off is removed from a preview board, because "start
      him" is not advice once the game is running, it is a record of something
      the reader can already look up.

   ---- WHERE THE SLATE COMES FROM ----

   ESPN's public, credential free NFL scoreboard, the same host and the same
   document `lib/notifications/schedule-feed.js` already reads for the push
   dispatcher. It is the only public source in reach that carries per game
   STATE, which is the fact this section is built on; Sleeper's public v1 API
   publishes the league's week and its platform wide add counts but no NFL game
   schedule or result. The parser below is deliberately a local copy rather
   than an import of that module: this script is dependency free by design and
   runs as ESM with no build step, and schedule-feed.js is part of the
   notification path, which is not this script's to change.

   No credentials, no cookies, no league id, no roster. Every number printed
   from the slate is a field the scoreboard returned: a kickoff time, a game
   state, a team score, a statistical leader's own `displayValue`. There is no
   projection anywhere in this file, on any day, because the public sources it
   reads do not publish one and a made up number on a public page is worse than
   a missing section.

   ---- WHEN THE DAY'S ANGLE IS NOT AVAILABLE ----

   Two cases fall back to the midweek board rather than failing the run:

     * the scoreboard read failed or returned no games for the week, so there
       is no verified split between played and unplayed; and
     * a preview day whose slate has moved on far enough that fewer than
       MIN_BOARD_ROWS of the board still have a game to come.

   The midweek board is the right fallback for both because it makes no claim
   about any individual game: it is a platform wide add count and nothing else,
   so it stays true on a Sunday evening with the whole slate in the book. Both
   fallbacks log loudly with the reason.
--------------------------------------------------------------------------- */

const EDITORIAL_TIME_ZONE = 'America/New_York';

/* The public, credential free NFL scoreboard. `site.api.espn.com` is already
   the host lib/notifications/schedule-feed.js pulls and the one /api/espn.js
   proxies, so this adds no new upstream to the project. */
const DEFAULT_SCOREBOARD_BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

/* seasontype 2 is the regular season, which is the only part of the calendar
   this generator publishes into (its week is checked 1..18 everywhere else). */
const REGULAR_SEASON_TYPE = 2;

/* A margin at or above this is called a blowout in the recap copy. Three
   scores. Below it the copy prints the margin and says nothing about it. */
const BLOWOUT_MARGIN = 17;

const ET_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: EDITORIAL_TIME_ZONE,
  weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * One instant, read as an Eastern time wall clock.
 *
 * Returns the weekday index, the full weekday name, the ET calendar date as
 * YYYY-MM-DD and the ET hour. The date is what a generated article is stamped
 * with, so that a run at 01:00 UTC on Tuesday files under the Monday it
 * actually belongs to rather than a day the reader has not reached.
 */
function easternParts(ms) {
  const at = Number(ms);
  if (!Number.isFinite(at)) {
    throw new Error('[generate-editorial] cannot resolve the editorial day from "' + ms + '"; it is not a timestamp.');
  }
  const parts = Object.create(null);
  for (const part of ET_CLOCK.formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const weekday = WEEKDAY_INDEX[parts.weekday];
  if (weekday == null) {
    throw new Error('[generate-editorial] the runtime reported Eastern weekday "' + parts.weekday +
      '", which is not one of the seven this generator knows. Refusing to guess the day a story files under.');
  }
  return {
    at,
    weekday,
    weekdayName: WEEKDAY_NAMES[weekday],
    date: parts.year + '-' + parts.month + '-' + parts.day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/* Assembled from the parts rather than handed to an ICU pattern. The runtime's
   own "weekday at time" pattern has moved between ICU releases: the comma comes
   and goes, and the space before AM/PM has been a narrow no-break space that is
   invisible in a diff. A sentence in a published article should not change
   shape because the runner upgraded Node. */
function kickoffLabel(ms) {
  const at = Number(ms);
  if (!Number.isFinite(at)) return '';
  const clock = easternParts(at);
  const hour = clock.hour % 12 === 0 ? 12 : clock.hour % 12;
  return clock.weekdayName + ' ' + hour + ':' + String(clock.minute).padStart(2, '0') + ' ' +
    (clock.hour < 12 ? 'AM' : 'PM') + ' ET';
}

/* ---- Team abbreviations across the two sources -------------------------- */

/* Sleeper and ESPN agree on thirty one of the thirty two current teams. The
   exception is Washington, which Sleeper calls WAS and ESPN calls WSH, and a
   single unmapped abbreviation is enough to file a player as "no game this
   week" and quietly drop him off a preview board. The relocations are here for
   an older cached player index, which may still carry the old codes. */
const TEAM_ALIASES = {
  WAS: ['WSH'], WSH: ['WAS'],
  OAK: ['LV'], LV: ['OAK'],
  SD: ['LAC'], LAC: ['SD'],
  STL: ['LAR'], LAR: ['STL', 'LA'], LA: ['LAR'],
};

function teamKeys(abbr) {
  const key = String(abbr == null ? '' : abbr).trim().toUpperCase();
  if (!key) return [];
  return [key].concat(TEAM_ALIASES[key] || []);
}

function teamIn(set, abbr) {
  if (!set) return false;
  return teamKeys(abbr).some((key) => set.has(key));
}

/* ---- The scoreboard ---------------------------------------------------- */

function scoreboardUrl(base, state) {
  const url = new URL(String(base || DEFAULT_SCOREBOARD_BASE));
  url.searchParams.set('dates', String(state.season));
  url.searchParams.set('week', String(state.week));
  url.searchParams.set('seasontype', String(REGULAR_SEASON_TYPE));
  return url.toString();
}

function competitorSide(competitor) {
  const team = (competitor && competitor.team) || {};
  const score = Number(competitor && competitor.score);
  return {
    abbr: cleanText(team.abbreviation).toUpperCase(),
    name: cleanText(team.shortDisplayName || team.displayName || team.name || team.abbreviation),
    score: Number.isFinite(score) ? score : null,
  };
}

/* The top name in each of the scoreboard's leader groups, printed with the
   scoreboard's own `displayValue`. Never recomputed, never ranked here: the
   value is a string ESPN formatted ("291 YDS, 2 TD") and reformatting it is
   how a stat line stops matching the box score it came from. */
function gameLeaders(competition) {
  const groups = (competition && Array.isArray(competition.leaders)) ? competition.leaders : [];
  const out = [];
  for (const group of groups) {
    const entries = (group && Array.isArray(group.leaders)) ? group.leaders : [];
    const top = entries[0];
    if (!top) continue;
    const athlete = cleanText((top.athlete && (top.athlete.displayName || top.athlete.fullName)) || '');
    const value = cleanText(top.displayValue);
    const label = cleanText(group.displayName || group.shortDisplayName || group.name);
    if (!athlete || !value) continue;
    out.push({ athlete, value, label: label || 'leader' });
  }
  return out;
}

/* The kickoff's Eastern weekday and hour name the broadcast window. These are
   the labels the day's angle selects on: a Thursday preview wants the TNF
   game, a Monday preview wants the MNF game, and "Sunday" on its own is three
   different slates that lock at three different times. */
function kickoffWindow(kickoffMs) {
  if (!Number.isFinite(Number(kickoffMs))) return 'unscheduled';
  const clock = easternParts(kickoffMs);
  if (clock.weekday === 4) return 'thursday-night';
  if (clock.weekday === 5) return 'friday';
  if (clock.weekday === 6) return 'saturday';
  if (clock.weekday === 1) return 'monday-night';
  if (clock.weekday === 2 || clock.weekday === 3) return 'midweek';
  if (clock.hour < 15) return 'sunday-early';
  if (clock.hour < 19) return 'sunday-late';
  return 'sunday-night';
}

const WINDOW_LABELS = {
  'thursday-night': 'Thursday night',
  friday: 'Friday',
  saturday: 'Saturday',
  'sunday-early': 'the Sunday early window',
  'sunday-late': 'the Sunday late window',
  'sunday-night': 'Sunday night',
  'monday-night': 'Monday night',
  midweek: 'midweek',
  unscheduled: 'an unscheduled window',
};

function slateGame(event, nowMs) {
  const competition = (Array.isArray(event.competitions) && event.competitions[0]) || null;
  const stamp = (competition && competition.date) || event.date;
  const kickoff = stamp ? new Date(stamp).getTime() : NaN;
  const kickoffMs = Number.isFinite(kickoff) ? kickoff : null;
  if (stamp && kickoffMs == null) {
    console.warn('[generate-editorial] the public NFL scoreboard carried an unparseable kickoff stamp "' +
      String(stamp) + '" on event ' + String(event && event.id) + '; that game is left out of the slate split ' +
      'rather than being guessed into a window.');
  }

  const status = (competition && competition.status) || event.status || {};
  const type = (status && status.type) || {};
  const state = cleanText(type.state).toLowerCase();

  const competitors = (competition && Array.isArray(competition.competitors)) ? competition.competitors : [];
  /* ESPN lists the home team first when it omits homeAway, which some archived
     documents do. Positional order is the documented fallback, not a guess. */
  const home = competitorSide(competitors.find((c) => c && c.homeAway === 'home') || competitors[0]);
  const away = competitorSide(competitors.find((c) => c && c.homeAway === 'away') || competitors[1]);
  if (!home.abbr || !away.abbr) return null;

  const completed = type.completed === true || state === 'post';
  /* Both signals have to agree before a game counts as unplayed. A cached or
     slow scoreboard document still reports `pre` for a game that kicked off
     ten minutes ago, and that is exactly the window in which a preview would
     name a player whose game is already running. */
  const started = completed || state === 'in' ||
    (kickoffMs != null && Number.isFinite(Number(nowMs)) && kickoffMs <= Number(nowMs));

  return {
    id: String((event && event.id) == null ? '' : event.id),
    kickoffMs,
    state: state || (completed ? 'post' : 'pre'),
    started,
    completed,
    home,
    away,
    window: kickoffWindow(kickoffMs),
    detail: cleanText(type.shortDetail || type.detail || type.description),
    leaders: gameLeaders(competition),
  };
}

/**
 * The week's games, split by whether they have been played.
 *
 * `started` is the split that matters and it is the union of three facts: the
 * scoreboard says the game is running, the scoreboard says it is complete, or
 * its kickoff is in the past. `upcoming` is the complement, and it is the only
 * collection any preview in this file is allowed to read.
 */
function normalizeSlate(payload, { nowMs = Date.now(), season = null, week = null } = {}) {
  const doc = (payload && typeof payload === 'object') ? payload : {};
  const events = Array.isArray(doc.events) ? doc.events : [];
  const games = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const game = slateGame(event, nowMs);
    if (game) games.push(game);
  }
  games.sort((a, b) => ((a.kickoffMs || 0) - (b.kickoffMs || 0)) || String(a.id).localeCompare(String(b.id)));

  const playedTeams = new Set();
  const upcomingTeams = new Set();
  for (const game of games) {
    const target = game.started ? playedTeams : upcomingTeams;
    for (const abbr of [game.home.abbr, game.away.abbr]) {
      for (const key of teamKeys(abbr)) target.add(key);
    }
  }

  return {
    season, week, nowMs, games,
    completed: games.filter((game) => game.completed),
    inProgress: games.filter((game) => game.started && !game.completed),
    upcoming: games.filter((game) => !game.started),
    playedTeams, upcomingTeams,
  };
}

async function nflSlate(state, options) {
  const url = scoreboardUrl(options.scoreboardBase || DEFAULT_SCOREBOARD_BASE, state);
  const payload = await fetchJson(url, { timeoutMs: 15000, label: 'ESPN public NFL scoreboard' });
  const slate = normalizeSlate(payload, {
    nowMs: options.now || Date.now(), season: state.season, week: state.week,
  });
  if (!slate.games.length) {
    throw new Error('[generate-editorial] the public NFL scoreboard returned no usable games for season ' +
      state.season + ' week ' + state.week + ', so there is no verified split between played and unplayed games.');
  }
  return slate;
}

const gamesIn = (games, windows) => games.filter((game) => windows.includes(game.window));

/* ---- The day's angle --------------------------------------------------- */

function upcomingGameLines(games) {
  return games.map((game) => '- **' + game.away.abbr + '** at **' + game.home.abbr + '**, ' +
    (kickoffLabel(game.kickoffMs) || 'kickoff time not published on the scoreboard') + '.');
}

function finalGameLines(games) {
  return games.map((game) => {
    const { home, away } = game;
    if (home.score == null || away.score == null) {
      return '- **' + away.abbr + '** at **' + home.abbr + '**: the scoreboard carries no final score for this game.';
    }
    if (home.score === away.score) {
      return '- **' + away.abbr + ' ' + away.score + '**, **' + home.abbr + ' ' + home.score + '**, a tie.';
    }
    const winner = home.score > away.score ? home : away;
    const loser = winner === home ? away : home;
    const margin = winner.score - loser.score;
    return '- **' + winner.abbr + ' ' + winner.score + '**, ' + loser.abbr + ' ' + loser.score + ', ' +
      (margin >= BLOWOUT_MARGIN ? 'a ' + margin + ' point blowout' : 'by ' + margin) + '.';
  });
}

function leaderLines(games, limit = 4) {
  const lines = [];
  for (const game of games) {
    for (const leader of game.leaders) {
      lines.push('- **' + leader.athlete + '**, ' + leader.label + ': ' + leader.value +
        ' (' + game.away.abbr + ' at ' + game.home.abbr + ').');
      if (lines.length >= limit) return lines;
    }
  }
  return lines;
}

/* Where a board row's NFL team stands on the week's schedule. Real scheduling
   fact, no projection: it is the sentence that tells a reader whether the name
   above it can still do anything for them. */
function rowSlateNote(row, slate) {
  if (!slate || !row.team) return '';
  const next = slate.upcoming.find((game) => teamIn(new Set(teamKeys(game.home.abbr).concat(teamKeys(game.away.abbr))), row.team));
  if (next) {
    const opponent = teamIn(new Set(teamKeys(next.home.abbr)), row.team) ? next.away.abbr : next.home.abbr;
    return row.team + ' still has ' + opponent + ' to play, ' + (kickoffLabel(next.kickoffMs) || 'later this week') + '.';
  }
  const done = slate.games.find((game) => game.started &&
    teamIn(new Set(teamKeys(game.home.abbr).concat(teamKeys(game.away.abbr))), row.team));
  if (done) return row.team + ' has already played this week.';
  return row.team + ' has no game on the week ' + slate.week + ' schedule.';
}

/* The add board, printed. Shared by every angle so the column reads the same
   on all five days; only the heading above it and the slate note under each
   row change with the day. */
function boardSection(featured, slate, { heading, lede }) {
  const parts = [heading, lede];
  featured.forEach((row, index) => {
    const where = row.team ? ', ' + row.team : '';
    parts.push('### ' + (index + 1) + '. **' + row.name + '**, ' + row.position + where);
    const note = rowSlateNote(row, slate);
    parts.push(note ? rowSentences(row, index) + ' ' + note : rowSentences(row, index));
  });
  return parts;
}

function designationLines(featured) {
  return featured
    .filter((row) => row.injuryStatus)
    .map((row) => '- **' + row.name + '**, ' + row.position + (row.team ? ' (' + row.team + ')' : '') +
      ': Sleeper carries a ' + row.injuryStatus.toLowerCase() + ' designation on this roster spot.');
}

const addCountLede = (state) =>
  'Sleeper publishes how many leagues across its entire platform added each player, and these are those ' +
  'counts as they stand for week ' + state.week + ' of the ' + state.season + ' season. Read them as demand, not ' +
  'as value: a name at the top of this list is being chased in every league at once, which is exactly when a ' +
  'claim costs more than the player is worth.';

const SOURCE_LINE = '*Sources: Sleeper public API for add counts over the last ' + TRENDING_LOOKBACK_HOURS +
  ' hours, and the public NFL scoreboard for kickoff times, game states and final scores.*';

const noLeagueViewLine =
  'This column has no view of your league. It reads two public sources and nothing else, so what it can tell ' +
  'you is which NFL games are still to be played and which players the rest of the platform is chasing. Which ' +
  'of your own starters that leaves on the board is the one part you have to look up yourself.';

function thursdayBody(ctx) {
  const { state, slate, featured } = ctx;
  const opener = gamesIn(slate.upcoming, ['thursday-night']);
  const parts = ['## Thursday night, before kickoff'];
  if (opener.length) {
    parts.push('Week ' + state.week + ' opens here, and nothing below has been played yet.');
    parts.push(...upcomingGameLines(opener));
  } else {
    parts.push('The week ' + state.week + ' schedule carries no Thursday night game still to come. Everything ' +
      'named below is drawn from the ' + slate.upcoming.length + ' games that have not kicked off.');
  }
  parts.push(...boardSection(featured, slate, {
    heading: '## The board going into the slate',
    lede: addCountLede(state) + ' Every name here plays a game that has not started, so this is a preview and ' +
      'not a recap of something you can already look up.',
  }));
  const designations = designationLines(featured);
  parts.push('## Designations to check before your lineup locks');
  if (designations.length) {
    parts.push('Sleeper carries an active designation on these roster spots. A designation is not a ruling, so ' +
      'the check is the point.');
    parts.push(...designations);
  } else {
    parts.push('Sleeper carries no injury designation on any player on the board above. That is a clean board, ' +
      'not a guarantee: designations move through the end of the week.');
  }
  parts.push('## Still to come this week');
  parts.push('The scoreboard has ' + slate.upcoming.length + ' week ' + state.week + ' game' +
    (slate.upcoming.length === 1 ? '' : 's') + ' still unplayed' +
    (slate.completed.length ? ' and ' + slate.completed.length + ' already final' : '') +
    '. Nothing in this preview is drawn from a game that has kicked off.');
  parts.push(SOURCE_LINE);
  return parts.join('\n\n');
}

function fridayBody(ctx) {
  const { state, slate, featured } = ctx;
  const thursdayFinals = gamesIn(slate.completed, ['thursday-night']);
  const parts = ['## Thursday night, final'];
  if (thursdayFinals.length) {
    parts.push(...finalGameLines(thursdayFinals));
    const leaders = leaderLines(thursdayFinals);
    if (leaders.length) {
      parts.push('Where the production was, as the scoreboard reported it:');
      parts.push(...leaders);
    }
  } else {
    parts.push('No week ' + state.week + ' Thursday night game is final on the scoreboard, so there is nothing ' +
      'to recap from it. The weekend preview below stands on its own.');
  }
  parts.push('## The weekend ahead');
  if (slate.upcoming.length) {
    parts.push('These games have not kicked off. They are the only ones this column previews.');
    parts.push(...upcomingGameLines(slate.upcoming));
  } else {
    parts.push('The scoreboard has no week ' + state.week + ' game left unplayed, so there is no weekend left ' +
      'to preview.');
  }
  parts.push(...boardSection(featured, slate, {
    heading: '## The board between the two',
    lede: addCountLede(state) + ' The twenty four hours these counts cover are the ones that contain Thursday ' +
      'night, which is why a Friday board rarely looks like a Wednesday one.',
  }));
  const designations = designationLines(featured);
  if (designations.length) {
    parts.push('## Designations carried into the weekend');
    parts.push(...designations);
  }
  parts.push(SOURCE_LINE);
  return parts.join('\n\n');
}

function sundayBody(ctx) {
  const { state, slate, featured } = ctx;
  const parts = ['## Sunday, before the next kickoff'];
  if (slate.upcoming.length) {
    parts.push('Final lineup decisions only apply to games that have not started. These are those games.');
    parts.push(...upcomingGameLines(slate.upcoming));
  } else {
    parts.push('Every week ' + state.week + ' game on the scoreboard has kicked off, so there is no lineup ' +
      'decision left to make.');
  }
  const designations = designationLines(featured);
  parts.push('## Late status to check');
  if (designations.length) {
    parts.push('These are the designations Sleeper carries on the board below, and Sunday is when they resolve.');
    parts.push(...designations);
  } else {
    parts.push('Sleeper carries no designation on any player on the board below. Check your own starters against ' +
      'the inactives list regardless: this column sees the platform, not your lineup.');
  }
  parts.push(...boardSection(featured, slate, {
    heading: '## The board with games still to come',
    lede: addCountLede(state) + ' Every name below plays a game that has not kicked off. Names whose games are ' +
      'already running were removed rather than previewed.',
  }));
  if (slate.completed.length || slate.inProgress.length) {
    parts.push('## Already underway, and not previewed here');
    parts.push('The scoreboard has ' + (slate.completed.length + slate.inProgress.length) + ' week ' + state.week +
      ' game' + (slate.completed.length + slate.inProgress.length === 1 ? '' : 's') + ' running or final. Those ' +
      'lineups are locked and nothing above is drawn from them.');
  }
  parts.push(SOURCE_LINE);
  return parts.join('\n\n');
}

function mondayBody(ctx) {
  const { state, slate, featured } = ctx;
  const sundayFinals = gamesIn(slate.completed, ['sunday-early', 'sunday-late', 'sunday-night']);
  const finals = sundayFinals.length ? sundayFinals : slate.completed;
  const tonight = gamesIn(slate.upcoming, ['monday-night']);
  const remaining = tonight.length ? tonight : slate.upcoming;

  const parts = ['## Sunday, final'];
  if (finals.length) {
    parts.push((sundayFinals.length ? 'Every Sunday game in the book' : 'Every week ' + state.week +
      ' game in the book') + ', with each margin named.');
    parts.push(...finalGameLines(finals));
    const blowouts = finals.filter((game) => game.home.score != null && game.away.score != null &&
      Math.abs(game.home.score - game.away.score) >= BLOWOUT_MARGIN);
    if (blowouts.length) {
      parts.push('That is ' + blowouts.length + ' game' + (blowouts.length === 1 ? '' : 's') + ' decided by ' +
        BLOWOUT_MARGIN + ' points or more. A blowout is where a bench emptied early, which is the part that shows ' +
        'up in a fantasy box score long after the result stopped being in doubt.');
    }
  } else {
    parts.push('The scoreboard carries no completed week ' + state.week + ' game yet, so there is nothing final ' +
      'to summarise.');
  }

  const leaders = leaderLines(finals, 6);
  if (leaders.length) {
    parts.push('## Where the scoring was');
    parts.push('The scoreboard\'s own statistical leaders out of those games, printed as it reported them.');
    parts.push(...leaders);
  }

  parts.push('## Monday night: what is still on the board');
  if (remaining.length) {
    parts.push('This is everything the week has left.');
    parts.push(...upcomingGameLines(remaining));
    const live = ctx.stillToPlay;
    if (live.length) {
      parts.push('Of the players the platform is chasing, these are the ones whose game has not been played, ' +
        'which makes them the only names on this board that can still move anything tonight:');
      parts.push(...live.map((row) => '- **' + row.name + '**, ' + row.position +
        (row.team ? ' (' + row.team + ')' : '') + '. ' + rowSlateNote(row, slate)));
    }
    parts.push(noLeagueViewLine);
  } else {
    parts.push('The scoreboard has no week ' + state.week + ' game left to play. Everything is final.');
  }

  parts.push(...boardSection(featured, slate, {
    heading: '## The board going into the claim window',
    lede: addCountLede(state) + ' A Monday board is read differently from a Thursday one: most of these adds are ' +
      'a reaction to a result that is already final, which is why the names near the top are the expensive ones.',
  }));
  parts.push(SOURCE_LINE);
  return parts.join('\n\n');
}

function tuesdayBody(ctx) {
  const { state, slate, featured } = ctx;
  const finals = slate.completed;
  const parts = ['## Week ' + state.week + ', final'];
  if (finals.length) {
    parts.push('All ' + finals.length + ' completed game' + (finals.length === 1 ? '' : 's') + ', with each margin named.');
    parts.push(...finalGameLines(finals));
  } else {
    parts.push('The scoreboard carries no completed week ' + state.week + ' game, so there is no final result ' +
      'to report.');
  }

  const scored = finals
    .filter((game) => game.home.score != null && game.away.score != null)
    .map((game) => ({
      game,
      total: game.home.score + game.away.score,
      margin: Math.abs(game.home.score - game.away.score),
    }));

  if (scored.length) {
    const byTotal = scored.slice().sort((a, b) => b.total - a.total || a.game.id.localeCompare(b.game.id));
    const byMargin = scored.slice().sort((a, b) => b.margin - a.margin || a.game.id.localeCompare(b.game.id));
    parts.push('## Winners, losers and the totals');
    parts.push('Highest combined score of the week:');
    parts.push(...byTotal.slice(0, 3).map((row) => '- **' + row.game.away.abbr + ' at ' + row.game.home.abbr +
      '**, ' + row.total + ' combined points.'));
    parts.push('Widest margin of the week:');
    parts.push(...byMargin.slice(0, 3).map((row) => '- **' + row.game.away.abbr + ' at ' + row.game.home.abbr +
      '**, decided by ' + row.margin + '.'));
  }

  const leaders = leaderLines(finals, 6);
  if (leaders.length) {
    parts.push('## Where the scoring was');
    parts.push('The scoreboard\'s own statistical leaders, printed as it reported them.');
    parts.push(...leaders);
  }

  parts.push(...boardSection(featured, slate, {
    heading: '## Early waiver targets',
    lede: addCountLede(state) + ' The week is over, so nothing on this board is a bet on a game still to be ' +
      'played: it is the platform reacting to results that are already public, ahead of the midweek claim deadline.',
  }));
  parts.push('The gap between the first name and the last one is the useful number here. Both ends of this list ' +
    'are trending, but the top of it is a bidding war and the bottom is a quiet add, and in a league where ' +
    'everyone reads the same public counts the quiet add is usually where the margin is.');
  parts.push(SOURCE_LINE);
  return parts.join('\n\n');
}

/**
 * The five day cadence, plus the midweek board the schedule actually runs on.
 *
 * `filtersPlayedTeams` is the requirement 2 switch: on a preview day the board
 * is cut down to players whose NFL game has not kicked off. Monday and Tuesday
 * leave it alone on purpose. Their board is a claim list for the week ahead,
 * not a start/sit call, and Monday's unplayed set is the two teams in one game,
 * which is a callout (`stillToPlay`) rather than a board.
 */
const ANGLES = {
  thursday: {
    angle: 'thursday',
    needsSlate: true,
    filtersPlayedTeams: true,
    category: 'Matchup Preview',
    title: (state) => 'Thursday Night Kickoff Preview: Week ' + state.week + ' Slate',
    excerpt: (state) => 'Week ' + state.week + ' opens Thursday night. The games that have not been played yet, ' +
      'the players the platform is claiming ahead of them, and the designations worth checking before your ' +
      'lineup locks.',
    summary: (state, slate) => 'Week ' + state.week + ' opens with ' + slate.upcoming.length + ' game' +
      (slate.upcoming.length === 1 ? '' : 's') + ' still unplayed.',
    body: thursdayBody,
  },
  friday: {
    angle: 'friday',
    needsSlate: true,
    filtersPlayedTeams: true,
    category: 'Analysis',
    title: (state) => 'Friday Morning Recap & Weekend Preview: Week ' + state.week,
    excerpt: () => 'Thursday night is final and the weekend is not. The Thursday result, the games still to ' +
      'come, and the add counts that moved in the twenty four hours between them.',
    summary: (state, slate) => slate.completed.length + ' week ' + state.week + ' game' +
      (slate.completed.length === 1 ? ' is' : 's are') + ' final and ' + slate.upcoming.length + ' remain' +
      (slate.upcoming.length === 1 ? 's' : '') + '.',
    body: fridayBody,
  },
  sunday: {
    angle: 'sunday',
    needsSlate: true,
    filtersPlayedTeams: true,
    category: 'Matchup Preview',
    title: (state) => 'Sunday Gameday Preview: Week ' + state.week + ' Final Lineup Decisions',
    excerpt: (state) => 'Final lineup decisions for week ' + state.week + ', taken only against the games that ' +
      'have not kicked off: who is still to play, which designations are open, and where the platform is ' +
      'putting its claims.',
    summary: (state, slate) => slate.upcoming.length + ' week ' + state.week + ' game' +
      (slate.upcoming.length === 1 ? '' : 's') + ' had not kicked off when this was filed.',
    body: sundayBody,
  },
  monday: {
    angle: 'monday',
    needsSlate: true,
    filtersPlayedTeams: false,
    category: 'Analysis',
    title: () => 'Monday Night Preview: What\'s at Stake & Sunday Recap',
    excerpt: (state) => 'Sunday is in the book and Monday night is not. The week ' + state.week + ' finals, the ' +
      'blowouts, the scoring leaders, and the players who are still on the board tonight.',
    summary: (state, slate) => slate.completed.length + ' week ' + state.week + ' game' +
      (slate.completed.length === 1 ? ' is' : 's are') + ' final, with ' + slate.upcoming.length +
      ' still to play.',
    body: mondayBody,
  },
  tuesday: {
    angle: 'tuesday',
    needsSlate: true,
    filtersPlayedTeams: false,
    category: 'Recap',
    title: (state) => 'Tuesday Morning Final Recap: Week ' + state.week + ' Winners & Losers',
    excerpt: (state) => 'Week ' + state.week + ' is final. Every result, the widest margins, the highest scoring ' +
      'games, and the first names worth a claim before the midweek deadline.',
    summary: (state, slate) => 'All ' + slate.completed.length + ' completed week ' + state.week +
      ' games, with the week\'s widest margins and highest totals.',
    body: tuesdayBody,
  },
  /* The evergreen board, and the fallback for every day whose angle cannot be
     supported. It reads no schedule and makes no claim about any individual
     game, which is what makes it safe on any day and at any hour. Its copy is
     `sleeperBody`, unchanged. */
  midweek: {
    angle: 'midweek',
    needsSlate: false,
    filtersPlayedTeams: false,
    category: 'Waiver Wire',
    title: (state) => 'Week ' + state.week + ' trending adds: where the waiver money is going',
    excerpt: null,
    summary: null,
    body: null,
  },
};

/* Wednesday and Saturday have no named angle: the NFL week is quiet on both,
   and inventing a sixth and seventh story for them would mean publishing a
   preview or a recap with nothing new behind it. They get the evergreen board.
   Wednesday is also the day the repository's own schedule is closest to. */
const CADENCE_BY_WEEKDAY = {
  0: ANGLES.sunday,
  1: ANGLES.monday,
  2: ANGLES.tuesday,
  3: ANGLES.midweek,
  4: ANGLES.thursday,
  5: ANGLES.friday,
  6: ANGLES.midweek,
};

const ANGLE_NAMES = Object.keys(ANGLES);

/**
 * Which story today is, and the Eastern clock it was decided from.
 *
 * `--angle` forces one, which is what makes a day's output reproducible in a
 * check rather than only on the one weekday it naturally occurs.
 */
function resolveCadence(options = {}) {
  const clock = easternParts(Number(options.now) || Date.now());
  const requested = cleanText(options.angle).toLowerCase();
  if (requested) {
    const forced = ANGLES[requested];
    if (!forced) {
      throw new Error('[generate-editorial] --angle must be one of ' + ANGLE_NAMES.join(', ') + '.');
    }
    return { ...forced, clock, forced: true };
  }
  return { ...(CADENCE_BY_WEEKDAY[clock.weekday] || ANGLES.midweek), clock, forced: false };
}

/**
 * The board a preview day is allowed to print.
 *
 * Three buckets, because "has not played" and "is not playing" are different
 * facts and only one of them disqualifies a name from a preview:
 *
 *   playable  the player's NFL game has not kicked off. Previewable.
 *   played    it has. Removed from a preview board entirely, because naming
 *             him is not advice, it is a result the reader can already see.
 *   idle      no game on the week's schedule at all, or no NFL team on the
 *             player record. A bye week stash is a legitimate claim, so these
 *             stay on the board and the copy says so under the row.
 */
function splitBoardBySlate(board, slate) {
  const playable = [];
  const played = [];
  const idle = [];
  for (const row of board) {
    if (!row.team) { idle.push(row); continue; }
    if (teamIn(slate.upcomingTeams, row.team)) playable.push(row);
    else if (teamIn(slate.playedTeams, row.team)) played.push(row);
    else idle.push(row);
  }
  return { playable, played, idle };
}

/**
 * One article, for the day it is actually being written on.
 *
 * The shape of the record is unchanged; what the day decides is the headline,
 * the category, the excerpt and which body builder runs. The midweek board is
 * byte for byte what this function produced before the cadence existed, and it
 * is also where every unsupported day lands, so the safe output is the old
 * output rather than a new untested one.
 */
function buildSleeperArticle(state, board, options) {
  const requested = options.cadence || resolveCadence(options);
  let cadence = requested;
  let slate = options.slate || null;
  let featured = board.slice(0, MAX_FEATURED_ROWS);
  let stillToPlay = [];

  if (cadence.needsSlate && !slate) {
    /* nflSlate() already said why; this is the consequence, said once, where a
       reader of the log can see which article they got instead. */
    console.warn('[generate-editorial] no verified game slate is available, so the ' + cadence.angle +
      ' angle cannot be honoured: it would have to claim which games have been played. Falling back to the ' +
      'midweek board, which makes no per game claim.');
    cadence = { ...ANGLES.midweek, clock: cadence.clock, forced: cadence.forced };
  }

  if (cadence.needsSlate && slate) {
    stillToPlay = board.filter((row) => row.team && teamIn(slate.upcomingTeams, row.team));
    if (cadence.filtersPlayedTeams) {
      const split = splitBoardBySlate(board, slate);
      const previewable = split.playable.concat(split.idle);
      if (split.played.length) {
        console.log('[generate-editorial] ' + split.played.length + ' trending player(s) were left off the ' +
          cadence.angle + ' preview board because their NFL game has already kicked off: ' +
          split.played.map((row) => row.name + ' (' + row.team + ')').join(', ') + '.');
      }
      if (previewable.length < MIN_BOARD_ROWS) {
        console.warn('[generate-editorial] the week ' + state.week + ' slate has moved far enough that only ' +
          previewable.length + ' of ' + board.length + ' trending players still have a game to come, below the ' +
          MIN_BOARD_ROWS + ' a preview board needs. A "' + cadence.angle + '" preview would have to name players ' +
          'whose games are already running, so this run falls back to the midweek board instead.');
        cadence = { ...ANGLES.midweek, clock: cadence.clock, forced: cadence.forced };
        slate = null;
      } else {
        featured = previewable.slice(0, MAX_FEATURED_ROWS);
      }
    }
  }

  /* The floor is checked against whatever the day actually prints. A board cut
     down by the slate filter and a board thin because Sleeper answered badly
     are the same defect from the reader's side: a two name column. */
  if (featured.length < MIN_BOARD_ROWS) {
    throw new Error('[generate-editorial] Sleeper trending data resolved to only ' + featured.length +
      ' usable player(s), below the ' + MIN_BOARD_ROWS + ' needed for a board. Refusing to publish a stub.');
  }

  /* The ET calendar date, not the UTC one. A run at 01:00 UTC on a Tuesday is
     a Monday night run, and stamping it with Tuesday's date files it a day
     ahead of the games it is about. */
  const publishDate = options.publishDate || cadence.clock.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishDate)) throw new Error('[generate-editorial] publish date must be YYYY-MM-DD.');

  const title = cadence.title(state);
  const ctx = { state, slate, board, featured, stillToPlay, cadence };

  let body;
  let excerpt;
  let impactSummary;
  if (cadence.angle === 'midweek') {
    body = sleeperBody(state, board, featured);
    const top = featured.slice(0, 3).map((row) => row.name);
    excerpt = ('Sleeper\'s platform-wide add counts for week ' + state.week + '. ' + top.slice(0, -1).join(', ') +
      (top.length > 1 ? ' and ' + top[top.length - 1] : top[0]) +
      ' are the most claimed players of the last ' + TRENDING_LOOKBACK_HOURS + ' hours, and the gap between the top of ' +
      'the board and the bottom is the part worth acting on.').slice(0, 420);
    impactSummary = '**' + featured[0].name + '** leads the platform with ' + countOf(featured[0].adds) +
      ' adds in the last ' + TRENDING_LOOKBACK_HOURS + ' hours.';
  } else {
    body = cadence.body(ctx);
    excerpt = cleanText(cadence.excerpt(state, slate)).slice(0, 420);
    impactSummary = cadence.summary(state, slate);
  }

  console.log('[generate-editorial] filing the ' + cadence.clock.weekdayName + ' angle (' + cadence.angle + ') for ' +
    publishDate + ', resolved from ' + EDITORIAL_TIME_ZONE + '.');

  return {
    title,
    slug: slugify(publishDate + '-' + title),
    publishDate,
    category: options.category || cadence.category,
    excerpt,
    author: 'FSN Desk',
    week: state.week,
    entities: featured.slice(0, MAX_ENTITIES).map((row) => ({
      name: row.name,
      position: row.position,
      sleeperPlayerId: row.playerId,
    })),
    body,
    impactSummary,
    scope: { season: state.season, week: state.week },
    angle: cadence.angle,
  };
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
  /* `|| Date.now()` and not a bare `options.now`: parseArgs stores an absent
     --now as 0, and 0 is a perfectly good timestamp as far as a default
     parameter is concerned. Passed through raw it would override
     sleeperPlayerIndex's own `now = Date.now()`, make every cache age negative,
     and re-download several megabytes on every single run against a source that
     asks to be read once a day. The cache clock is the real one even when the
     editorial clock is being moved for a rehearsal: which day's story to write
     has nothing to do with how old the player index on disk is. */
  const players = await sleeperPlayerIndex(base, {
    cacheFile: options.playersCache, refresh: options.refreshPlayers, now: options.now || Date.now(),
  });
  const board = trendingBoard(trending, players);

  /* The day is resolved before the slate is read so an angle that needs no
     schedule (Wednesday, Saturday, or a forced midweek run) costs no request. */
  const cadence = resolveCadence(options);
  console.log('[generate-editorial] it is ' + cadence.clock.weekdayName + ' ' + cadence.clock.date + ' in ' +
    EDITORIAL_TIME_ZONE + ', so this run files the "' + cadence.angle + '" angle' +
    (cadence.forced ? ' (forced with --angle)' : '') + '.');

  let slate = null;
  if (cadence.needsSlate) {
    try {
      slate = await nflSlate(state, options);
      console.log('[generate-editorial] the public NFL scoreboard reports ' + slate.games.length + ' week ' +
        state.week + ' game(s): ' + slate.completed.length + ' final, ' + slate.inProgress.length +
        ' in progress, ' + slate.upcoming.length + ' not yet kicked off.');
    } catch (err) {
      console.warn('[generate-editorial] the public NFL scoreboard was not usable for season ' + state.season +
        ' week ' + state.week + ', so played and unplayed games cannot be separated: ' + err.message, err);
      slate = null;
    }
  }

  return buildSleeperArticle(state, board, { ...options, cadence, slate });
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
    scoreboardBase: DEFAULT_SCOREBOARD_BASE, now: 0, angle: '',
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
    else if (arg === '--scoreboard-base') args.scoreboardBase = next();
    else if (arg === '--angle') {
      args.angle = cleanText(next()).toLowerCase();
      if (!ANGLE_NAMES.includes(args.angle)) {
        throw new Error('[generate-editorial] --angle must be one of ' + ANGLE_NAMES.join(', ') + '.');
      }
    }
    else if (arg === '--now') {
      const raw = next();
      const parsed = Date.parse(raw);
      if (!Number.isFinite(parsed)) {
        throw new Error('[generate-editorial] --now must be a parseable date, for example 2026-09-28T13:00:00Z.');
      }
      args.now = parsed;
    }
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
    { player_id: '7006', count: 3000 },
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
    7006: { full_name: 'Emari Demercado', position: 'RB', team: 'ARI', injury_status: '', years_exp: 3, depth_chart_order: 2 },
  };
}

/* --------------------------------------------------------------------------
   THE WEEK 4 FIXTURE SLATE

   Six games, with the real Eastern kickoff times of a week's five broadcast
   windows, and one document per day showing the same six games as they would
   look on that day. That is what makes the cadence testable: "is the Monday
   article a Sunday recap" is a question about a scoreboard state, and a single
   static fixture can only be one state at a time.

   The board's four usable teams are spread across the windows on purpose:
   JAX and TB play in the Sunday early window, BUF and MIA in the Monday night
   game and ARI in the second one, so a run part way through Sunday has some
   board rows already playing and some not. That is the only shape in which the
   "do not preview a player who has already played" filter can be observed
   doing something rather than merely not crashing.
-------------------------------------------------------------------------- */

const FIXTURE_KICKOFFS = {
  tnf: '2026-09-25T00:15Z',     /* Thursday 2026-09-24, 20:15 ET */
  sunEarlyA: '2026-09-27T17:00Z', /* Sunday 13:00 ET */
  sunEarlyB: '2026-09-27T17:00Z',
  sunLate: '2026-09-27T20:25Z',  /* Sunday 16:25 ET */
  snf: '2026-09-28T00:20Z',      /* Sunday 20:20 ET */
  mnfA: '2026-09-29T00:15Z',     /* Monday 2026-09-28, 20:15 ET */
  mnfB: '2026-09-29T01:15Z',     /* Monday 21:15 ET */
};

function fixtureEvent(id, kickoff, away, home, outcome) {
  const done = outcome && outcome.state === 'post';
  const competitors = [
    { homeAway: 'home', score: done ? String(outcome.home) : '0', team: { id: home, abbreviation: home, displayName: home + ' Home', shortDisplayName: home } },
    { homeAway: 'away', score: done ? String(outcome.away) : '0', team: { id: away, abbreviation: away, displayName: away + ' Away', shortDisplayName: away } },
  ];
  const competition = {
    id, date: kickoff, competitors,
    status: { type: { state: (outcome && outcome.state) || 'pre', completed: !!done, shortDetail: done ? 'Final' : 'Scheduled' } },
  };
  if (done && outcome.leader) {
    competition.leaders = [{
      name: 'passingYards', displayName: 'Passing Leader',
      leaders: [{ displayValue: outcome.leader.value, value: 1, athlete: { displayName: outcome.leader.name }, team: { id: home } }],
    }];
  }
  return { id, date: kickoff, shortName: away + ' @ ' + home, week: { number: 4 }, competitions: [competition] };
}

/* One row per game: which teams, which window, and the final it ends on. The
   per-day documents below differ only in how far down this list the `post`
   states have reached. */
const FIXTURE_SLATE_PLAN = [
  { id: '401', kickoff: FIXTURE_KICKOFFS.tnf, away: 'PHI', home: 'NYG', home_score: 17, away_score: 27, leader: { name: 'Jalen Hurts', value: '291 YDS, 2 TD' } },
  { id: '402', kickoff: FIXTURE_KICKOFFS.sunEarlyA, away: 'JAX', home: 'HOU', home_score: 13, away_score: 41, leader: { name: 'Trevor Lawrence', value: '318 YDS, 3 TD' } },
  { id: '403', kickoff: FIXTURE_KICKOFFS.sunEarlyB, away: 'TB', home: 'ATL', home_score: 24, away_score: 21 },
  { id: '404', kickoff: FIXTURE_KICKOFFS.sunLate, away: 'DAL', home: 'SF', home_score: 30, away_score: 28 },
  { id: '405', kickoff: FIXTURE_KICKOFFS.snf, away: 'GB', home: 'SEA', home_score: 20, away_score: 23 },
  { id: '406', kickoff: FIXTURE_KICKOFFS.mnfA, away: 'BUF', home: 'MIA', home_score: 14, away_score: 31 },
  { id: '407', kickoff: FIXTURE_KICKOFFS.mnfB, away: 'ARI', home: 'LV', home_score: 10, away_score: 24 },
];

/* `states` maps a game id to the state that day's document reports. Anything
   unlisted is `pre` with no score, which is what a scoreboard serves for a
   game that has not started. */
function fixtureScoreboard(states) {
  const events = FIXTURE_SLATE_PLAN.map((plan) => {
    const state = states[plan.id] || 'pre';
    const outcome = state === 'post'
      ? { state, home: plan.home_score, away: plan.away_score, leader: plan.leader }
      : { state };
    return fixtureEvent(plan.id, plan.kickoff, plan.away, plan.home, outcome);
  });
  return { season: { year: 2026, type: { type: 2 } }, week: { number: 4 }, events };
}

/* The seven days the self-test drives, each as {now, states}. `now` is the
   instant the generator is told it is, in UTC, and it is always consistent with
   the states beside it: that consistency is what the cadence asserts against. */
const FIXTURE_DAYS = {
  /* Wednesday 09:00 ET, before the week starts. */
  wed: { now: '2026-09-23T13:00:00Z', states: {} },
  /* Thursday 10:00 ET, ten hours before the opener. */
  thu: { now: '2026-09-24T14:00:00Z', states: {} },
  /* Friday 09:00 ET. The Thursday game is the only thing in the book. */
  fri: { now: '2026-09-25T13:00:00Z', states: { 401: 'post' } },
  /* Sunday 10:00 ET, before the early window. */
  sun: { now: '2026-09-27T14:00:00Z', states: { 401: 'post' } },
  /* Sunday 14:30 ET. The early window is running, so JAX and TB have played
     and MIA, BUF and ARI have not. Three previewable rows, which is the floor. */
  sunLive: { now: '2026-09-27T18:30:00Z', states: { 401: 'post', 402: 'in', 403: 'in' } },
  /* Monday 09:00 ET. Sunday is final, both Monday games are still to come. */
  mon: { now: '2026-09-28T13:00:00Z', states: { 401: 'post', 402: 'post', 403: 'post', 404: 'post', 405: 'post' } },
  /* Tuesday 09:00 ET. The week is closed. */
  tue: { now: '2026-09-29T13:00:00Z', states: { 401: 'post', 402: 'post', 403: 'post', 404: 'post', 405: 'post', 406: 'post', 407: 'post' } },
};

/* A final score line as finalGameLines prints it: "**JAX 41**, HOU 13". Used to
   assert that a preview carries no result. Matching on the word "final" instead
   catches the source attribution line, which every day carries. */
const SCORE_LINE = /\*\*[A-Z]{2,4} \d+\*\*,/;

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
    /* Everything a board needs except the player index, which 404s. A run
       against this base can only succeed off the on-disk cache. */
    if (url === '/v1/cacheonly/state/nfl') return json(fixtureState());
    if (url.startsWith('/v1/cacheonly/players/nfl/trending/add')) return json(fixtureTrending());
    if (url === '/v1/players/nfl' || url === '/v1/thin/players/nfl') return json(fixturePlayers());
    if (url === '/v1/thin/state/nfl') return json(fixtureState());
    const espn = /^\/espn\/([a-zA-Z]+)(?:\?|$)/.exec(url);
    if (espn) {
      const day = FIXTURE_DAYS[espn[1]];
      if (!day) { res.writeHead(404).end(); return; }
      return json(fixtureScoreboard(day.states));
    }
    if (url.startsWith('/espn/blocked')) { res.writeHead(503).end(); return; }
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
    scoreboardBase: origin + '/espn/wed', now: Date.parse(FIXTURE_DAYS.wed.now), angle: '',
    noSupabase: true, feeds: [origin + '/feed.xml'], item: 0, category: '', players: [],
    publishDate: '', week: 0, localState: '', out: tmp, env: {}, allowReservedHost: true, ...opts,
  });

  /* One Sleeper run on one fixture day, into its own directory so the days
     never overwrite each other's slug. Returns the Markdown that was written,
     or '' when the run declined to write anything. */
  const dayRun = async (day, opts = {}) => {
    const out = path.join(tmp, 'day-' + day + (opts.angle ? '-' + opts.angle : ''));
    const file = await generate(base({
      mode: 'sleeper', out,
      now: Date.parse(FIXTURE_DAYS[day].now),
      scoreboardBase: origin + '/espn/' + day,
      ...opts,
    }));
    return file ? fs.readFileSync(file, 'utf8') : '';
  };

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

    /* ---- The cadence: one article per day, and the right one ---- */

    /* Wednesday is the evergreen board, which is the pre-existing behaviour and
       the fallback every unsupported day lands on. Asserted first so a
       regression in it is not hidden behind a new day's failure. */
    const wed = await dayRun('wed');
    check(/^title: Week 4 trending adds/m.test(wed), 'Wednesday did not file the evergreen add board');
    check(/^category: Waiver Wire$/m.test(wed), 'the evergreen board changed category');

    const thu = await dayRun('thu');
    check(/^title: Thursday Night Kickoff Preview: Week 4 Slate$/m.test(thu), 'Thursday did not file the kickoff preview headline');
    check(/^publishDate: 2026-09-24$/m.test(thu), 'Thursday was not stamped with its own Eastern date');
    check(thu.includes('**PHI** at **NYG**'), 'the Thursday preview did not name the Thursday night game');
    check(/PHI\*\* at \*\*NYG\*\*, Thursday 8:15 PM ET/.test(thu), 'the Thursday night kickoff was not printed in Eastern time');
    check(!SCORE_LINE.test(thu) && !/blowout/i.test(thu), 'the Thursday preview reported a result before any game was played');
    check(thu.includes('Tank Bigsby') && thu.includes('Emari Demercado'), 'the Thursday board lost rows whose games are still to come');

    const fri = await dayRun('fri');
    check(/^title: Friday Morning Recap & Weekend Preview: Week 4$/m.test(fri), 'Friday did not file the recap and weekend preview headline');
    check(/^publishDate: 2026-09-25$/m.test(fri), 'Friday was not stamped with its own Eastern date');
    check(/Thursday night, final/.test(fri), 'the Friday article did not recap Thursday night');
    check(/\*\*PHI 27\*\*, NYG 17/.test(fri), 'the Friday recap did not print the Thursday final from the scoreboard');
    check(fri.includes('Jalen Hurts') && fri.includes('291 YDS, 2 TD'), 'the Friday recap dropped the scoreboard\'s own statistical leader');
    check(fri.includes('**JAX** at **HOU**') && fri.includes('**BUF** at **MIA**'), 'the Friday article did not preview the weekend still to come');
    check(!SCORE_LINE.test((fri.split('## The weekend ahead')[1] || '').split('\n## ')[0]),
      'the Friday weekend preview leaked a score for a game that had not been played');

    const sun = await dayRun('sun');
    check(/^title: Sunday Gameday Preview: Week 4 Final Lineup Decisions$/m.test(sun), 'Sunday did not file the gameday preview headline');
    check(/^publishDate: 2026-09-27$/m.test(sun), 'Sunday was not stamped with its own Eastern date');
    check(/Late status to check/.test(sun), 'the Sunday preview has no late status section');
    check(sun.includes('Jaylen Wright') && /questionable designation/.test(sun), 'the Sunday preview did not surface an open injury designation');
    check(sun.includes('**JAX** at **HOU**'), 'the Sunday preview did not name a game still to kick off');

    /* Requirement 2, observed rather than assumed. At 14:30 ET the Sunday early
       window is running, so the two board rows on those teams must be gone from
       a preview and the three whose games are still to come must remain. */
    const sunLive = await dayRun('sunLive');
    check(/^title: Sunday Gameday Preview: Week 4 Final Lineup Decisions$/m.test(sunLive), 'a part-way-through Sunday did not still file the Sunday preview');
    check(!sunLive.includes('Tank Bigsby'), 'a player whose NFL game had already kicked off was previewed anyway (JAX)');
    check(!sunLive.includes('Jalen McMillan'), 'a player whose NFL game had already kicked off was previewed anyway (TB)');
    check(sunLive.includes('Jaylen Wright') && sunLive.includes('Ray Davis') && sunLive.includes('Emari Demercado'),
      'the Sunday preview dropped players whose games had not kicked off');
    check(!/^ {4}- name: Tank Bigsby$/m.test(sunLive) && !/sleeperPlayerId: "7001"/.test(sunLive),
      'an already-playing player was still tagged as a tracked entity on a preview');
    check(/\*\*BUF\*\* at \*\*MIA\*\*, Monday 8:15 PM ET/.test(sunLive), 'the Sunday preview did not carry the unplayed games in Eastern time');
    check(!SCORE_LINE.test(sunLive), 'the Sunday preview printed a score for a game that was still in progress');

    const mon = await dayRun('mon');
    check(/^title: Monday Night Preview: What's at Stake & Sunday Recap$/m.test(mon), 'Monday did not file the Monday night preview headline');
    check(/^publishDate: 2026-09-28$/m.test(mon), 'Monday was not stamped with its own Eastern date');
    check(/## Sunday, final/.test(mon), 'the Monday article has no Sunday recap section');
    check(/\*\*JAX 41\*\*, HOU 13, a 28 point blowout/.test(mon), 'the Monday recap did not summarise the Sunday blowout from real scores');
    check(/\*\*SF 30\*\*, DAL 28, by 2/.test(mon), 'the Monday recap did not print a close Sunday final');
    check(!/\*\*PHI 27\*\*/.test(mon.split('## Sunday, final')[1].split('##')[0]), 'the Monday Sunday-recap folded the Thursday game in with the Sunday finals');
    check(/decided by 17 points or more/.test(mon), 'the Monday recap did not count the week\'s blowouts');
    check(mon.includes('Trevor Lawrence') && mon.includes('318 YDS, 3 TD'), 'the Monday recap dropped the scoreboard\'s standout stat line');
    check(/## Monday night: what is still on the board/.test(mon), 'the Monday article does not say what is still at stake');
    check(/\*\*BUF\*\* at \*\*MIA\*\*, Monday 8:15 PM ET/.test(mon) && /\*\*ARI\*\* at \*\*LV\*\*/.test(mon),
      'the Monday article did not name the games that can still move a week');
    check(/only names on this board that can still move anything tonight/.test(mon),
      'the Monday article did not identify the players still to play');
    check(/- \*\*Jaylen Wright\*\*, RB \(MIA\)\. MIA still has BUF to play, Monday 8:15 PM ET\./.test(mon),
      'the Monday still-to-play callout did not join a board row to its remaining game');
    check(!mon.includes('Tank Bigsby**, RB (JAX). JAX still has'), 'a player who had already played was listed as still to play');

    const tue = await dayRun('tue');
    check(/^title: Tuesday Morning Final Recap: Week 4 Winners & Losers$/m.test(tue), 'Tuesday did not file the final recap headline');
    check(/^publishDate: 2026-09-29$/m.test(tue), 'Tuesday was not stamped with its own Eastern date');
    check(/^category: Recap$/m.test(tue), 'the Tuesday final recap did not file under Recap');
    check(/All 7 completed games/.test(tue), 'the Tuesday recap did not cover every completed game');
    check(/\*\*MIA 14\*\*|\*\*BUF 31\*\*, MIA 14, a 17 point blowout/.test(tue), 'the Tuesday recap did not report the Monday night final');
    check(/Highest combined score of the week/.test(tue), 'the Tuesday recap has no total score leaders');
    check(/\*\*DAL at SF\*\*, 58 combined points/.test(tue), 'the Tuesday recap did not compute the highest combined score from real finals');
    check(/\*\*JAX at HOU\*\*, decided by 28/.test(tue), 'the Tuesday recap did not compute the widest margin from real finals');
    check(/## Early waiver targets/.test(tue), 'the Tuesday recap carries no early waiver targets');
    check(!/still has .* to play/.test(tue), 'the Tuesday recap previewed a game after the week had closed');

    /* Every day, the invariants that do not move with the angle. */
    for (const [day, content] of Object.entries({ wed, thu, fri, sun, sunLive, mon, tue })) {
      check(!BANNED_CHARS.test(content), 'the ' + day + ' article contains banned punctuation');
      check(!/league_id|blog_articles|supabase/i.test(content), 'the ' + day + ' article leaked a database reference into public copy');
      check(!content.includes('Puka Nacua'), 'the ' + day + ' article left a consensus-owned roster anchor on a claim board');
      check(!content.includes('Longsnapper') && !content.includes('404404'), 'the ' + day + ' article put an unusable row on the board');
      check(!/project(?:ed|ion)/i.test(content), 'the ' + day + ' article claims a projection, which no public source here publishes');
      check(/^week: 4$/m.test(content), 'the ' + day + ' article did not carry the live week from state/nfl');
    }

    /* A preview angle whose slate is entirely in the book cannot be honoured:
       every board row has already played. It falls back to the evergreen board
       rather than previewing finished games or writing nothing. */
    const stalePreview = await dayRun('tue', { angle: 'thursday' });
    check(/^title: Week 4 trending adds/m.test(stalePreview),
      'a preview angle with no unplayed games did not fall back to the evergreen board');
    check(!/Thursday Night Kickoff Preview/.test(stalePreview), 'a preview headline survived a slate with nothing left to preview');

    /* A scoreboard that will not answer is the same problem: no verified split
       between played and unplayed, so no day-specific claim can be made. */
    const noSlate = await dayRun('mon', { scoreboardBase: origin + '/espn/blocked' });
    check(/^title: Week 4 trending adds/m.test(noSlate), 'an unreadable scoreboard did not fall back to the evergreen board');
    check(noSlate.length > 0, 'an unreadable scoreboard suppressed the article entirely');

    /* ---- The clock itself ---- */

    /* The 21:00 ET Monday instant is already Tuesday in UTC. Reading the
       weekday off UTC would file the Tuesday final recap while the Monday night
       game was in the second quarter. */
    const mondayNight = easternParts(Date.parse('2026-09-29T01:00:00Z'));
    check(mondayNight.weekday === 1 && mondayNight.weekdayName === 'Monday',
      'a Monday night instant did not resolve to Monday in Eastern time');
    check(mondayNight.date === '2026-09-28', 'a Monday night instant was stamped with the UTC date rather than the Eastern one');
    check(easternParts(Date.parse('2026-09-29T13:00:00Z')).weekdayName === 'Tuesday',
      'a Tuesday morning instant did not resolve to Tuesday');
    check(resolveCadence({ now: Date.parse('2026-09-29T01:00:00Z') }).angle === 'monday',
      'the Monday night hour resolved to an angle other than monday');
    check(resolveCadence({ now: Date.parse('2026-09-26T13:00:00Z') }).angle === 'midweek',
      'Saturday did not resolve to the evergreen board');

    /* Broadcast windows, which are what the day's sections select on. */
    check(kickoffWindow(Date.parse('2026-09-25T00:15Z')) === 'thursday-night', 'the Thursday night window was misclassified');
    check(kickoffWindow(Date.parse('2026-09-27T17:00Z')) === 'sunday-early', 'the Sunday early window was misclassified');
    check(kickoffWindow(Date.parse('2026-09-27T20:25Z')) === 'sunday-late', 'the Sunday late window was misclassified');
    check(kickoffWindow(Date.parse('2026-09-28T00:20Z')) === 'sunday-night', 'the Sunday night window was misclassified');
    check(kickoffWindow(Date.parse('2026-09-29T00:15Z')) === 'monday-night', 'the Monday night window was misclassified');

    /* Washington is WAS on Sleeper and WSH on the scoreboard. One unmapped
       abbreviation silently files a player as having no game this week. */
    check(teamIn(new Set(['WSH']), 'WAS') && teamIn(new Set(['WAS']), 'WSH'),
      'the Washington abbreviation does not bridge Sleeper and the scoreboard');

    /* The split itself, on a document where one game is running. */
    const liveSlate = normalizeSlate(fixtureScoreboard(FIXTURE_DAYS.sunLive.states), {
      nowMs: Date.parse(FIXTURE_DAYS.sunLive.now), season: 2026, week: 4,
    });
    check(liveSlate.games.length === 7, 'the slate parser dropped games from the scoreboard document');
    check(liveSlate.completed.length === 1 && liveSlate.inProgress.length === 2 && liveSlate.upcoming.length === 4,
      'the slate was not split correctly into final, running and unplayed');
    check(teamIn(liveSlate.playedTeams, 'JAX') && !teamIn(liveSlate.upcomingTeams, 'JAX'),
      'a team whose game was running was not counted as having played');
    check(teamIn(liveSlate.upcomingTeams, 'MIA') && !teamIn(liveSlate.playedTeams, 'MIA'),
      'a team whose game had not kicked off was not counted as unplayed');

    /* A stale scoreboard still says `pre` for a game that started minutes ago.
       The kickoff timestamp is the second signal that catches it. */
    const stale = normalizeSlate(fixtureScoreboard({}), { nowMs: Date.parse('2026-09-27T18:00:00Z'), season: 2026, week: 4 });
    check(stale.upcoming.length === 4 && teamIn(stale.playedTeams, 'JAX'),
      'a game past its kickoff was treated as unplayed because the scoreboard still reported "pre"');

    let badAngleRefused = false;
    try { parseArgs(['--angle', 'saturday']); }
    catch (err) { badAngleRefused = /--angle must be one of/.test(err.message); }
    check(badAngleRefused, 'an unknown --angle was accepted');

    let badNowRefused = false;
    try { parseArgs(['--now', 'not-a-date']); }
    catch (err) { badNowRefused = /--now must be a parseable date/.test(err.message); }
    check(badNowRefused, 'an unparseable --now was accepted');

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

    /* An absent --now is stored as 0, and 0 must not reach the player index
       cache as a clock: every age would come out negative, every run would miss
       the cache, and Sleeper would be asked for several megabytes on every
       invocation. This base serves the week and the add counts but 404s on
       players/nfl, so the run can only succeed off the cache written above. */
    let cachedFile = null;
    let cacheFailure = '';
    try {
      cachedFile = await generate(base({
        mode: 'sleeper', angle: 'midweek', refreshPlayers: false, now: 0,
        sleeperBase: origin + '/v1/cacheonly', publishDate: '2026-09-24', out: path.join(tmp, 'cachehit'),
      }));
    } catch (err) {
      /* Caught rather than left to crash the run: this is the difference between
         a named failure an operator can act on and an opaque stack trace. */
      cacheFailure = err.message;
    }
    check(!!cachedFile && !cacheFailure,
      'a run with no --now ignored the Sleeper player index cache and asked the source for it again' +
      (cacheFailure ? ' (' + cacheFailure + ')' : ''));

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
  console.log('[generate-editorial] self-test passed: live Sleeper ingestion, the Eastern-time day-of-week ' +
    'cadence across all five angles plus the evergreen board, the played/unplayed slate split (no preview names ' +
    'a game or a player whose game has kicked off), the documented fallbacks for a dead scoreboard and a spent ' +
    'slate, waiver realism filtering, attributed Markdown, evidence-backed player entities, a global ' +
    '(league_id null) Supabase upsert, and no league or fabricated-stat dependency.');
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
