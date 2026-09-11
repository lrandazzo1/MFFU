#!/usr/bin/env node
/* ============================================================================
   FSN — AUTOMATED EDITORIAL GENERATOR (Sleeper recap)
   ----------------------------------------------------------------------------
   Fetches one week's real matchup data from the public Sleeper API and turns
   it into a "who carried their squad" recap article, written straight into
   `landing/content/blog/` in the format `scripts/build-blog.mjs` already
   consumes (see `landing/content/blog/README.md` for the schema).

   This script is deliberately dumb about content: it never invents a score, a
   manager, or a stat line. Every number and every name in the output comes
   from the Sleeper response for the league and week you pass in. If the
   Sleeper API does not return enough to build a real article, the script
   fails loudly instead of padding the gap with generic copy.

   No `SLEEPER_LEAGUE_ID` is configured anywhere in this repo (the in-app
   league data comes from ESPN, not Sleeper), so this script requires a league
   id explicitly and never guesses one:

     --league <sleeperLeagueId>   or   SLEEPER_LEAGUE_ID=<id>
     --week <n>                   optional, defaults to Sleeper's current week
     --publish-date <YYYY-MM-DD>  optional, defaults to today
     --out <dir>                  optional, defaults to landing/content/blog
     --base <url>                 optional, override the Sleeper API base
                                   (used by --self-test to point at a fixture
                                   server instead of the real network)

   Usage:
     SLEEPER_LEAGUE_ID=123456789012345678 node scripts/generate-editorial.mjs
     node scripts/generate-editorial.mjs --league <id> --week 3
     node scripts/generate-editorial.mjs --self-test    # network-free check

   After a real run, compile it into the deploy payload as usual:
     npm run build:blog

   This script is additive: it only writes new files under
   `landing/content/blog/`. It never touches index.html, the News Desk
   generators, Supabase, or any historical data pipeline.
============================================================================ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'landing', 'content', 'blog');
const DEFAULT_BASE = 'https://api.sleeper.app/v1';

// U+2014 EM DASH and U+2015 HORIZONTAL BAR are banned everywhere in FSN blog
// copy (see landing/content/blog/README.md). Mirrored here so a generated
// article can never slip an em dash past the build-blog.mjs check.
const BANNED_CHARS = /[—―]/;

function normName(s) {
  return String(s == null ? '' : s)
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* ------------------------------------------------------------------ *
 * CLI args
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const args = {
    league: process.env.SLEEPER_LEAGUE_ID || null,
    week: null,
    publishDate: null,
    out: DEFAULT_OUT_DIR,
    base: process.env.SLEEPER_API_BASE || DEFAULT_BASE,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--league') args.league = argv[++i];
    else if (a === '--week') args.week = Number(argv[++i]);
    else if (a === '--publish-date') args.publishDate = argv[++i];
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--self-test') args.selfTest = true;
  }
  return args;
}

/* ------------------------------------------------------------------ *
 * Sleeper fetch layer. Every call surfaces a specific, actionable error
 * instead of returning a fallback value a caller might mistake for data.
 * ------------------------------------------------------------------ */
async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`[generate-editorial] request to ${url} failed: ${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`[generate-editorial] Sleeper returned ${res.status} ${res.statusText} for ${url}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`[generate-editorial] Sleeper response for ${url} was not valid JSON: ${err.message}`);
  }
}

async function currentWeek(base) {
  const state = await fetchJson(`${base}/state/nfl`);
  const week = Number(state && state.week);
  if (!Number.isFinite(week) || week < 1) {
    throw new Error('[generate-editorial] Sleeper /state/nfl did not return a usable current week.');
  }
  return week;
}

async function fetchLeagueWeek(base, leagueId, week) {
  const [league, rosters, users, matchups] = await Promise.all([
    fetchJson(`${base}/league/${leagueId}`),
    fetchJson(`${base}/league/${leagueId}/rosters`),
    fetchJson(`${base}/league/${leagueId}/users`),
    fetchJson(`${base}/league/${leagueId}/matchups/${week}`),
  ]);
  if (!league) {
    throw new Error(`[generate-editorial] Sleeper league "${leagueId}" was not found (the API returned null). Refusing to fabricate a league.`);
  }
  if (!Array.isArray(rosters) || rosters.length === 0) {
    throw new Error(`[generate-editorial] Sleeper league "${leagueId}" returned no rosters.`);
  }
  if (!Array.isArray(matchups) || matchups.length === 0) {
    throw new Error(`[generate-editorial] Sleeper league "${leagueId}" returned no matchups for week ${week}. That week may not have started yet.`);
  }
  return { league, rosters, users: Array.isArray(users) ? users : [], matchups };
}

async function fetchPlayerNames(base, playerIds) {
  if (playerIds.size === 0) return new Map();
  // /players/nfl is a multi-megabyte blob of every NFL player, so only pull it
  // when the week's matchups actually reference player ids to name.
  const all = await fetchJson(`${base}/players/nfl`);
  const names = new Map();
  for (const id of playerIds) {
    const p = all[id];
    if (!p) continue;
    const full = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
    if (full) names.set(id, { name: full, position: p.position || '' });
  }
  return names;
}

/* ------------------------------------------------------------------ *
 * Transform: raw Sleeper payloads -> matchup pairs with real owners and
 * real top performers. No randomness, no invented values.
 * ------------------------------------------------------------------ */
function rosterOwnerMap(rosters, users) {
  const userById = new Map(users.map((u) => [u.user_id, u]));
  const map = new Map();
  for (const r of rosters) {
    const u = userById.get(r.owner_id);
    const managerName = (u && (u.display_name || u.username)) || 'Unclaimed roster';
    const teamName = (u && u.metadata && u.metadata.team_name) || managerName;
    map.set(r.roster_id, { managerName, teamName });
  }
  return map;
}

function buildMatchupPairs(matchups) {
  const byId = new Map();
  for (const m of matchups) {
    const list = byId.get(m.matchup_id) || [];
    list.push(m);
    byId.set(m.matchup_id, list);
  }
  return [...byId.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, sides]) => ({ id, sides: sides.slice().sort((a, b) => a.roster_id - b.roster_id) }));
}

function topPerformer(side, playerNames) {
  const starters = Array.isArray(side.starters) ? side.starters : [];
  const pointsMap = side.players_points || {};
  let best = null;
  for (const id of starters) {
    const pts = Number(pointsMap[id]);
    if (!Number.isFinite(pts)) continue;
    if (!best || pts > best.points || (pts === best.points && String(id) < String(best.id))) {
      best = { id, points: pts };
    }
  }
  if (!best) return null;
  const info = playerNames.get(best.id);
  if (!info) return null;
  return { id: String(best.id), points: best.points, name: info.name, position: info.position };
}

const fmtPts = (n) => Number(n).toFixed(2);

function buildArticle({ week, pairs, ownerMap, playerNames, publishDate }) {
  const entitiesById = new Map();
  const sections = [];

  for (const pair of pairs) {
    if (pair.sides.length < 2) {
      console.warn(`[generate-editorial] matchup ${pair.id} has only one side (bye or odd roster count); skipping it rather than inventing an opponent.`);
      continue;
    }
    if (pair.sides.length > 2) {
      console.warn(`[generate-editorial] matchup ${pair.id} has ${pair.sides.length} sides; only the first two are used.`);
    }
    const [a, b] = pair.sides;
    const ownerA = ownerMap.get(a.roster_id) || { managerName: 'Unclaimed roster', teamName: 'Unclaimed roster' };
    const ownerB = ownerMap.get(b.roster_id) || { managerName: 'Unclaimed roster', teamName: 'Unclaimed roster' };
    const scoreA = Number(a.points) || 0;
    const scoreB = Number(b.points) || 0;

    const topA = topPerformer(a, playerNames);
    const topB = topPerformer(b, playerNames);
    if (topA) entitiesById.set(topA.id, topA);
    if (topB) entitiesById.set(topB.id, topB);

    const lines = [`### ${ownerA.teamName} vs ${ownerB.teamName}`];
    if (scoreA === scoreB) {
      lines.push(`${ownerA.teamName} and ${ownerB.teamName} tied at ${fmtPts(scoreA)} apiece.`);
    } else {
      const winner = scoreA > scoreB ? ownerA : ownerB;
      const loser = scoreA > scoreB ? ownerB : ownerA;
      const winScore = Math.max(scoreA, scoreB);
      const loseScore = Math.min(scoreA, scoreB);
      lines.push(`${winner.teamName} beat ${loser.teamName}, ${fmtPts(winScore)} to ${fmtPts(loseScore)}.`);
    }
    if (topA) lines.push(`${ownerA.teamName} leaned on **${topA.name}**, who scored ${fmtPts(topA.points)} points.`);
    if (topB) lines.push(`${ownerB.teamName} got the most from **${topB.name}**, who scored ${fmtPts(topB.points)} points.`);
    sections.push(lines.join('\n\n'));
  }

  if (sections.length === 0) {
    throw new Error('[generate-editorial] no complete matchup pairs were available for this week; refusing to publish an article with no real content.');
  }

  const entities = [...entitiesById.values()].map((t) => ({ name: t.name, position: t.position, sleeperPlayerId: t.id }));
  const title = `Week ${week} recap: who carried their squad`;
  const slug = `week-${week}-game-recap`;
  const excerpt = `Real scores from every matchup in week ${week}, and the player who did the most to win it.`;
  const body = [`The week ${week} slate is final. Here is exactly what happened, matchup by matchup.`, ...sections].join('\n\n');

  return { title, slug, publishDate, category: 'Recap', excerpt, author: 'FSN Desk', entities, body };
}

/* ------------------------------------------------------------------ *
 * Validate + serialize, mirroring the rules scripts/build-blog.mjs
 * enforces so nothing generated here can fail that build.
 * ------------------------------------------------------------------ */
function validateArticle(article) {
  const required = ['title', 'slug', 'publishDate', 'category', 'excerpt', 'author'];
  for (const key of required) {
    if (!article[key]) throw new Error(`[generate-editorial] generated article is missing required field "${key}"`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug)) {
    throw new Error(`[generate-editorial] generated slug "${article.slug}" is not lowercase kebab-case`);
  }
  if (Number.isNaN(Date.parse(article.publishDate))) {
    throw new Error(`[generate-editorial] generated publishDate "${article.publishDate}" is not a parseable date`);
  }
  if (article.entities.length === 0) {
    throw new Error('[generate-editorial] generated article has no entities; refusing to publish an unattributed recap');
  }

  const haystack = normName(article.title + ' ' + article.body);
  for (const e of article.entities) {
    if (!haystack.includes(normName(e.name))) {
      throw new Error(`[generate-editorial] entity "${e.name}" is not named verbatim in the article body; refusing to ship a ghost entity`);
    }
  }

  const scanFields = [article.title, article.slug, article.category, article.excerpt, article.author, article.body,
    ...article.entities.map((e) => e.name)];
  for (const field of scanFields) {
    if (BANNED_CHARS.test(String(field))) {
      throw new Error(`[generate-editorial] em dash found in generated content: "${field}"`);
    }
  }
}

function serializeFrontmatter(article) {
  const lines = ['---'];
  lines.push(`title: ${article.title}`);
  lines.push(`slug: ${article.slug}`);
  lines.push(`publishDate: ${article.publishDate}`);
  lines.push(`category: ${article.category}`);
  lines.push(`excerpt: ${article.excerpt}`);
  lines.push(`author: ${article.author}`);
  lines.push('entities:');
  for (const e of article.entities) {
    lines.push(`  - name: ${e.name}`);
    if (e.position) lines.push(`    position: ${e.position}`);
    if (e.sleeperPlayerId) lines.push(`    sleeperPlayerId: "${e.sleeperPlayerId}"`);
  }
  lines.push('---');
  lines.push('');
  lines.push(article.body);
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */
async function generate({ league, week, publishDate, out, base }) {
  if (!league) {
    throw new Error('[generate-editorial] missing Sleeper league id. Pass --league <id> or set SLEEPER_LEAGUE_ID. Refusing to guess a league, since that would mean shipping fabricated data.');
  }
  const resolvedWeek = week || await currentWeek(base);
  const resolvedDate = publishDate || new Date().toISOString().slice(0, 10);

  console.log(`[generate-editorial] fetching league ${league}, week ${resolvedWeek} from ${base}`);
  const { rosters, users, matchups } = await fetchLeagueWeek(base, league, resolvedWeek);
  const ownerMap = rosterOwnerMap(rosters, users);
  const pairs = buildMatchupPairs(matchups);

  const neededIds = new Set();
  for (const pair of pairs) {
    for (const side of pair.sides) {
      for (const id of (side.starters || [])) neededIds.add(id);
    }
  }
  const playerNames = await fetchPlayerNames(base, neededIds);

  const article = buildArticle({ week: resolvedWeek, pairs, ownerMap, playerNames, publishDate: resolvedDate });
  validateArticle(article);

  fs.mkdirSync(out, { recursive: true });
  const outFile = path.join(out, `${article.slug}.md`);
  fs.writeFileSync(outFile, serializeFrontmatter(article), 'utf8');
  console.log(`[generate-editorial] wrote ${outFile}`);
  return outFile;
}

/* ------------------------------------------------------------------ *
 * Self-test: exercises the entire pipeline (fetch, pairing, entity
 * extraction, validation, serialization) against a local fixture server
 * shaped exactly like the real Sleeper API, so it runs without network
 * access and without a real league id.
 * ------------------------------------------------------------------ */
function buildFixtures() {
  return {
    '/v1/state/nfl': { week: 1, season: '2026', season_type: 'regular' },
    '/v1/league/test-league': { league_id: 'test-league', name: 'Fixture League', season: '2026' },
    '/v1/league/test-league/rosters': [
      { roster_id: 1, owner_id: 'u1' },
      { roster_id: 2, owner_id: 'u2' },
    ],
    '/v1/league/test-league/users': [
      { user_id: 'u1', display_name: 'Alice', metadata: { team_name: 'Alice All Stars' } },
      { user_id: 'u2', display_name: 'Bob', metadata: {} },
    ],
    '/v1/league/test-league/matchups/1': [
      { roster_id: 1, matchup_id: 1, points: 120.5, starters: ['1001', '1002'], players_points: { '1001': 30.2, '1002': 10.1 } },
      { roster_id: 2, matchup_id: 1, points: 110.0, starters: ['2001'], players_points: { '2001': 25.5 } },
    ],
    '/v1/players/nfl': {
      '1001': { full_name: 'Test Player One', position: 'WR' },
      '1002': { full_name: 'Test Player Two', position: 'RB' },
      '2001': { full_name: 'Test Player Three', position: 'QB' },
    },
  };
}

async function runSelfTest() {
  const fixtures = buildFixtures();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = fixtures[url.pathname];
    res.setHeader('Content-Type', 'application/json');
    if (body === undefined) {
      res.statusCode = 200;
      res.end('null'); // matches Sleeper's own behaviour for an unknown id
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/v1`;

  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'fsn-editorial-selftest-'));
  const failures = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); };

  try {
    // Run twice to confirm the pipeline is deterministic for identical input.
    let outFile;
    for (let run = 1; run <= 2; run++) {
      outFile = await generate({ league: 'test-league', week: 1, publishDate: '2026-09-16', out: tmpOut, base });
    }
    const content = fs.readFileSync(outFile, 'utf8');

    check(content.includes('title: Week 1 recap'), 'expected week-aware title');
    check(content.includes('Test Player One'), 'expected the higher-scoring starter (30.2 > 10.1) to be named as roster 1\'s top performer');
    check(!content.includes('Test Player Two'), 'expected the lower-scoring starter to be omitted as a top performer');
    check(content.includes('Test Player Three'), 'expected roster 2\'s only starter to be named as its top performer');
    check(content.includes('Alice All Stars'), 'expected users.metadata.team_name to be used when present');
    check(/\bBob\b/.test(content) && !content.includes('Bob\'s'), 'expected display_name fallback when team_name is absent');
    check(content.includes('Alice All Stars beat Bob, 120.50 to 110.00'), 'expected the real scores to decide and report the winner');
    check(!BANNED_CHARS.test(content), 'expected no em dash anywhere in generated content');
    check(/sleeperPlayerId: "1001"/.test(content), 'expected sleeperPlayerId to be serialized as a quoted string');

    // Missing league id must fail loudly, never fabricate a league.
    let threwForMissingLeague = false;
    try {
      await generate({ league: null, week: 1, out: tmpOut, base });
    } catch (err) {
      threwForMissingLeague = /missing Sleeper league id/.test(err.message);
    }
    check(threwForMissingLeague, 'expected a missing league id to throw a clear, specific error');

    // An unknown league id (Sleeper returns null, not a 404) must also fail loudly.
    let threwForUnknownLeague = false;
    try {
      await generate({ league: 'does-not-exist', week: 1, out: tmpOut, base });
    } catch (err) {
      threwForUnknownLeague = /was not found/.test(err.message);
    }
    check(threwForUnknownLeague, 'expected an unknown league id to throw a clear, specific error instead of writing a file');

    // Week auto-detection from /state/nfl.
    fs.rmSync(path.join(tmpOut, 'week-1-game-recap.md'), { force: true });
    await generate({ league: 'test-league', publishDate: '2026-09-16', out: tmpOut, base });
    check(fs.existsSync(path.join(tmpOut, 'week-1-game-recap.md')), 'expected week to be auto-detected from /state/nfl when --week is omitted');
  } finally {
    server.close();
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error('[generate-editorial] SELF-TEST FAILED:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[generate-editorial] self-test passed: Sleeper fetch, matchup pairing, entity extraction, determinism, and the punctuation/ghost-entity contract all verified against fixture data.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    await runSelfTest();
    return;
  }
  try {
    const outFile = await generate(args);
    console.log(`[generate-editorial] done. Run "npm run build:blog" to compile ${path.relative(ROOT, outFile)} into the deploy payload.`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
