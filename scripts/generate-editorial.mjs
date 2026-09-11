#!/usr/bin/env node
/* ============================================================================
   FSN — AUTOMATED EDITORIAL GENERATOR
   scripts/generate-editorial.mjs

   Fetches real matchup, roster, and scoring data for one Sleeper league
   straight from the public Sleeper API (api.sleeper.app, the same read-only
   host the app's own /api/sleeper relay allowlists) and compiles a "Game
   Recaps" article for the landing blog pipeline (scripts/build-blog.mjs),
   grounded entirely in that fetched data.

   This is a source-generation step for landing/content/blog/, the marketing
   blog's ingestion folder documented in landing/content/blog/README.md. It is
   additive tooling: it never touches index.html, the News Desk generators,
   Supabase wiring, or any historical data pipeline (see CLAUDE.md rule 2).

   Guardrails enforced before anything is written:
     - Zero hallucination: every player, score, and manager name in the
       article comes from a fetched Sleeper response. There is no filler
       copy, no invented stat, no Math.random flavor text.
     - Strict entity validation: every entry in the `entities` array is
       required to appear verbatim (case-insensitively, whitespace and
       markdown-emphasis normalized) in the article title or body, mirroring
       the ghost-entity guard build-blog.mjs runs at ingestion. A mismatch
       throws instead of silently dropping the entity, because at generation
       time a mismatch means the template has a bug, not that the data was
       merely missing.
     - No em dashes: "—" and "―" are banned everywhere (title, slug,
       category, excerpt, author, body, entity names), matching the
       punctuation contract in landing/content/blog/README.md. Clauses are
       written with periods, commas, or colons.
     - A league id must be given explicitly (--league or SLEEPER_LEAGUE_ID).
       The script never guesses one, because a wrong league id would produce
       a fluent, well-formed article about the wrong league's players.

   Usage:
     node scripts/generate-editorial.mjs --league <sleeper_league_id> \
       [--week N] [--out-dir path] [--date YYYY-MM-DD] [--dry-run]

   After generating, run `npm run build:blog` to compile the new source file
   into landing/content/generated/blog/, which is what the landing deploy
   (no build step of its own) actually serves.
============================================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'landing', 'content', 'blog');
const CACHE_DIR = path.join(ROOT, 'scripts', '.cache');
const PLAYERS_CACHE_FILE = path.join(CACHE_DIR, 'sleeper-players-nfl.json');
const PLAYERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // matches api/sleeper.js's own edge cache for this endpoint

// Only Sleeper's public, read-only API host. Mirrors ALLOWED_SLEEPER_HOSTS in
// api/sleeper.js so this script can never be pointed at an arbitrary URL.
const ALLOWED_HOSTS = new Set(['api.sleeper.app']);

// U+2014 EM DASH and U+2015 HORIZONTAL BAR are banned everywhere, same as the
// blog ingestion pipeline's BANNED_CHARS in scripts/build-blog.mjs.
const BANNED_CHARS = /[—―]/;
const TOP_PERFORMER_COUNT = 4;

const USAGE = `Usage: node scripts/generate-editorial.mjs --league <sleeper_league_id> [--week N] [--out-dir path] [--date YYYY-MM-DD] [--dry-run]

Fetches real matchup, roster, and scoring data for the given Sleeper league
straight from the public Sleeper API (api.sleeper.app) and compiles a Game
Recaps article grounded entirely in that data. Every player named in the
article's entities array is guaranteed to appear verbatim in the article
text; no em dashes are ever emitted.

  --league    Sleeper league_id to fetch (required; or set SLEEPER_LEAGUE_ID)
  --week      NFL week to recap (defaults to the live week from /v1/state/nfl)
  --out-dir   Where to write the source article (default: landing/content/blog)
  --date      publishDate to stamp on the article (default: today, YYYY-MM-DD)
  --dry-run   Fetch and generate, print the article JSON, write nothing

After generating, run \`npm run build:blog\` to compile the new source file
into the deploy payload the landing site actually serves.`;

/* ------------------------------------------------------------------ *
 * Sleeper reads
 * ------------------------------------------------------------------ */
async function fetchJson(url, { label }) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new Error(`[generate-editorial] refusing to fetch non-allowlisted host "${u.hostname}" for ${label}.`);
  }
  let res;
  try {
    res = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`[generate-editorial] network request failed for ${label} (${url}): ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`[generate-editorial] ${label} request failed: HTTP ${res.status} ${res.statusText} (${url})`);
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`[generate-editorial] ${label} returned invalid JSON (${url}): ${err.message}`);
  }
  if (body == null) {
    throw new Error(`[generate-editorial] ${label} returned null. Check that the league id and week are correct (${url}).`);
  }
  return body;
}

// The player index (/v1/players/nfl) is a multi-megabyte, effectively
// immutable-per-day blob. Cached locally for PLAYERS_CACHE_TTL_MS so repeated
// runs (and a weekly cron) do not re-download it every time, the same
// reasoning api/sleeper.js uses for its own edge cache of this endpoint.
async function fetchPlayersIndex() {
  try {
    if (fs.existsSync(PLAYERS_CACHE_FILE)) {
      const stat = fs.statSync(PLAYERS_CACHE_FILE);
      if (Date.now() - stat.mtimeMs < PLAYERS_CACHE_TTL_MS) {
        return JSON.parse(fs.readFileSync(PLAYERS_CACHE_FILE, 'utf8'));
      }
    }
  } catch (err) {
    console.warn('[generate-editorial] player cache read failed, refetching from Sleeper.', err);
  }
  const data = await fetchJson('https://api.sleeper.app/v1/players/nfl', { label: 'player index' });
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(PLAYERS_CACHE_FILE, JSON.stringify(data));
  } catch (err) {
    console.warn('[generate-editorial] player cache write failed (continuing without a cached copy).', err);
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * Pure data shaping — no network, no Date.now, no Math.random. Every
 * value below traces back to a fetched Sleeper response.
 * ------------------------------------------------------------------ */
function buildTeamIndex(rosters, users) {
  const usersById = new Map((users || []).map((u) => [String(u.user_id), u]));
  const index = new Map();
  for (const roster of rosters) {
    const rid = String(roster.roster_id);
    const user = roster.owner_id != null ? usersById.get(String(roster.owner_id)) : null;
    if (!user) {
      console.warn(`[generate-editorial] no Sleeper user found for roster ${rid} (owner_id ${roster.owner_id}); using a fallback label.`);
    }
    const managerName = (user && user.display_name) || `Manager ${rid}`;
    const teamName = (user && user.metadata && user.metadata.team_name) || managerName;
    index.set(rid, { managerName, teamName });
  }
  return index;
}

function playerDisplayName(p) {
  if (!p) return '';
  if (p.full_name) return p.full_name;
  return [p.first_name, p.last_name].filter(Boolean).join(' ');
}

function buildPerformances(matchupEntries, playersIndex, teamIndex) {
  const out = [];
  for (const entry of matchupEntries) {
    const rid = String(entry.roster_id);
    const team = teamIndex.get(rid) || { managerName: `Manager ${rid}`, teamName: `Manager ${rid}` };
    const starters = Array.isArray(entry.starters) ? entry.starters : [];
    const starterPoints = Array.isArray(entry.starters_points) ? entry.starters_points : [];
    starters.forEach((playerId, i) => {
      if (!playerId || playerId === '0') return; // empty lineup slot
      const pts = Number(starterPoints[i]);
      if (!Number.isFinite(pts)) return;
      const p = playersIndex[playerId];
      if (!p) {
        console.warn(`[generate-editorial] unknown Sleeper player_id "${playerId}" (roster ${rid}); skipping from the performance list rather than guessing a name.`);
        return;
      }
      const name = playerDisplayName(p);
      if (!name) return;
      out.push({ playerId: String(playerId), name, position: p.position || '', points: pts, rosterId: rid, managerName: team.managerName, teamName: team.teamName });
    });
  }
  out.sort((a, b) => b.points - a.points);
  return out;
}

function buildMatchupResults(matchupEntries, teamIndex) {
  const groups = new Map();
  for (const entry of matchupEntries) {
    if (entry.matchup_id == null) continue; // no opponent this week (bye)
    const key = entry.matchup_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const results = [];
  for (const [matchupId, entries] of groups) {
    if (entries.length !== 2) continue; // skip byes and malformed groups rather than fabricate an opponent
    const [a, b] = entries;
    const teamA = teamIndex.get(String(a.roster_id)) || { managerName: `Manager ${a.roster_id}`, teamName: `Manager ${a.roster_id}` };
    const teamB = teamIndex.get(String(b.roster_id)) || { managerName: `Manager ${b.roster_id}`, teamName: `Manager ${b.roster_id}` };
    const scoreA = Number(a.points) || 0;
    const scoreB = Number(b.points) || 0;
    const aWon = scoreA >= scoreB;
    const winner = aWon ? teamA : teamB;
    const loser = aWon ? teamB : teamA;
    const winnerScore = aWon ? scoreA : scoreB;
    const loserScore = aWon ? scoreB : scoreA;
    results.push({ matchupId, winner, loser, winnerScore, loserScore, margin: Number((winnerScore - loserScore).toFixed(2)) });
  }
  results.sort((x, y) => x.margin - y.margin);
  return results;
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function fmtPts(n) {
  return Number(n).toFixed(1);
}

function composeArticle({ league, week, performances, results, date }) {
  const leagueName = (league && league.name) || `League ${league && league.league_id}`;
  const top = performances.slice(0, TOP_PERFORMER_COUNT);
  if (top.length === 0) {
    throw new Error('[generate-editorial] no starter performances were found for this week; refusing to generate an article with no real data.');
  }
  if (results.length === 0) {
    throw new Error('[generate-editorial] no completed head to head matchups were found for this week; refusing to generate an article with no real data.');
  }

  const closest = results[0];
  const blowout = results[results.length - 1];
  const leader = top[0];

  const title = `Week ${week} recap: ${leader.name} leads ${leagueName}`;
  const slug = `week-${week}-recap-${slugify(leagueName)}`;
  const category = 'Game Recaps';
  const excerpt = `${leader.name} put up ${fmtPts(leader.points)} points for ${leader.managerName} in Week ${week}, the top individual score in a week where ${blowout.winner.managerName} beat ${blowout.loser.managerName} by ${fmtPts(blowout.margin)}.`;
  const author = 'FSN Desk';

  const bodyLines = [];
  bodyLines.push(`Week ${week} is final across ${leagueName}, and the box scores set the storylines. Here is who actually produced, mapped to the rosters that own them.`);
  bodyLines.push('');
  bodyLines.push('## Top performances');
  bodyLines.push('');
  for (const p of top) {
    bodyLines.push(`- **${p.name}** (${p.position || 'N/A'}) scored ${fmtPts(p.points)} points for ${p.managerName}.`);
  }
  bodyLines.push('');
  bodyLines.push('## Matchup margins');
  bodyLines.push('');
  bodyLines.push(`**Closest game:** ${closest.winner.managerName} edged ${closest.loser.managerName} ${fmtPts(closest.winnerScore)} to ${fmtPts(closest.loserScore)}, a ${fmtPts(closest.margin)} point margin.`);
  bodyLines.push('');
  bodyLines.push(`**Biggest margin:** ${blowout.winner.managerName} beat ${blowout.loser.managerName} ${fmtPts(blowout.winnerScore)} to ${fmtPts(blowout.loserScore)}, a ${fmtPts(blowout.margin)} point margin.`);
  bodyLines.push('');
  bodyLines.push(`${leader.managerName} owns the headline number of the week: **${leader.name}** posted ${fmtPts(leader.points)} points, the most of any starter in the league.`);
  const body = bodyLines.join('\n');

  const entityMap = new Map();
  for (const p of top) entityMap.set(p.playerId, p);
  const entities = Array.from(entityMap.values()).map((p) => ({
    name: p.name,
    position: p.position || '',
    sleeperPlayerId: p.playerId,
  }));

  return { title, slug, publishDate: date, category, excerpt, author, entities, body };
}

/* ------------------------------------------------------------------ *
 * Validation — mirrors the ghost-entity guard and punctuation contract
 * scripts/build-blog.mjs enforces at ingestion, so a payload that passes
 * here is guaranteed to pass the ingestion pipeline too.
 * ------------------------------------------------------------------ */
function normName(s) {
  return String(s == null ? '' : s)
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function validateArticle(article) {
  const errors = [];
  const required = ['title', 'slug', 'publishDate', 'category', 'excerpt', 'body'];
  for (const key of required) {
    if (!article[key]) errors.push(`missing required field "${key}"`);
  }
  if (article.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug)) {
    errors.push(`slug "${article.slug}" must be lowercase kebab-case`);
  }
  if (article.publishDate && Number.isNaN(Date.parse(article.publishDate))) {
    errors.push(`publishDate "${article.publishDate}" is not a parseable date (use YYYY-MM-DD)`);
  }

  const punctuationFields = {
    title: article.title,
    slug: article.slug,
    category: article.category,
    excerpt: article.excerpt,
    author: article.author,
    body: article.body,
  };
  for (const [key, val] of Object.entries(punctuationFields)) {
    if (val && BANNED_CHARS.test(String(val))) {
      errors.push(`em dash (or horizontal bar) found in "${key}"`);
    }
  }

  if (!article.entities || article.entities.length === 0) {
    errors.push('article has zero entities; a data grounded recap must name at least one real player');
  }
  const haystack = normName(`${article.title} ${article.body}`);
  for (const ent of article.entities || []) {
    if (BANNED_CHARS.test(ent.name || '')) errors.push(`em dash found in entity name "${ent.name}"`);
    const nm = normName(ent.name);
    if (!nm || !haystack.includes(nm)) {
      errors.push(`entity "${ent.name}" does not appear verbatim in the article title or body (ghost entity)`);
    }
  }

  if (errors.length) {
    throw new Error('[generate-editorial] article failed validation:\n' + errors.map((e) => '  - ' + e).join('\n'));
  }
}

function writeArticle(article, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, `${article.slug}.json`);
  if (fs.existsSync(filePath)) {
    console.warn(`[generate-editorial] ${filePath} already exists and will be overwritten.`);
  }
  const payload = {
    title: article.title,
    slug: article.slug,
    publishDate: article.publishDate,
    category: article.category,
    excerpt: article.excerpt,
    author: article.author,
    entities: article.entities,
    body: article.body,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n');
  return filePath;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const out = { league: null, week: null, outDir: null, date: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--league') out.league = argv[++i];
    else if (a === '--week') out.week = Number(argv[++i]);
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--date') out.date = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const leagueId = args.league || process.env.SLEEPER_LEAGUE_ID;
  if (!leagueId) {
    console.error('[generate-editorial] missing --league (or SLEEPER_LEAGUE_ID). Refusing to guess a league id.\n');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const league = await fetchJson(`https://api.sleeper.app/v1/league/${encodeURIComponent(leagueId)}`, { label: 'league' });

  let week = args.week;
  if (!week) {
    const state = await fetchJson('https://api.sleeper.app/v1/state/nfl', { label: 'NFL state' });
    week = Number(state.week);
    if (!Number.isFinite(week) || week <= 0) {
      throw new Error('[generate-editorial] could not resolve the current NFL week from /v1/state/nfl; pass --week explicitly.');
    }
  }

  const [rosters, users, matchupEntries, playersIndex] = await Promise.all([
    fetchJson(`https://api.sleeper.app/v1/league/${encodeURIComponent(leagueId)}/rosters`, { label: 'rosters' }),
    fetchJson(`https://api.sleeper.app/v1/league/${encodeURIComponent(leagueId)}/users`, { label: 'users' }),
    fetchJson(`https://api.sleeper.app/v1/league/${encodeURIComponent(leagueId)}/matchups/${week}`, { label: `week ${week} matchups` }),
    fetchPlayersIndex(),
  ]);

  if (!Array.isArray(rosters) || rosters.length === 0) {
    throw new Error('[generate-editorial] league has no rosters; refusing to generate.');
  }
  if (!Array.isArray(matchupEntries) || matchupEntries.length === 0) {
    throw new Error(`[generate-editorial] no matchups were returned for week ${week}; that week may not have started yet.`);
  }

  const teamIndex = buildTeamIndex(rosters, Array.isArray(users) ? users : []);
  const performances = buildPerformances(matchupEntries, playersIndex, teamIndex);
  const results = buildMatchupResults(matchupEntries, teamIndex);
  const date = args.date || new Date().toISOString().slice(0, 10);

  const article = composeArticle({ league, week, performances, results, date });
  validateArticle(article);

  if (args.dryRun) {
    console.log(JSON.stringify(article, null, 2));
    console.log('\n[generate-editorial] dry run: article validated, nothing written.');
    return;
  }

  const outDir = args.outDir ? path.resolve(args.outDir) : DEFAULT_OUT_DIR;
  const filePath = writeArticle(article, outDir);
  console.log(`[generate-editorial] wrote ${path.relative(ROOT, filePath)}`);
  console.log('[generate-editorial] next: npm run build:blog');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

export {
  fetchJson,
  fetchPlayersIndex,
  buildTeamIndex,
  buildPerformances,
  buildMatchupResults,
  composeArticle,
  validateArticle,
  writeArticle,
  slugify,
};
