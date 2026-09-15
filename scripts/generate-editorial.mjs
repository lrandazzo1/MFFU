#!/usr/bin/env node
/* ============================================================================
   FSN — PUBLIC EDITORIAL GENERATOR (box-score recap)
   ----------------------------------------------------------------------------
   Turns a structured, verified weekly box-score payload into a small Markdown
   recap for `landing/content/blog/`. There is no network access anywhere in
   this file: no RSS/Atom fetch, no external API call, no scraping. Every
   number and every name in the generated article is read straight out of the
   source payload and templated into prose; nothing is invented, summarized by
   guesswork, or drawn from a model call. That keeps this script safe to run
   in a network-restricted sandbox and keeps the output auditable: every claim
   traces back to one field in the JSON.

   Source schema (see scripts/data/weekly-editorial-source.json for a sample):
     {
       "verifiedBoxScoreSource": {
         "season": 2026,
         "week": 2,
         "publishDate": "2026-09-16",      // optional, defaults to today (UTC)
         "leagueName": "Optional League Name",
         "matchups": [
           {
             "homeTeam": "Team A",
             "awayTeam": "Team B",
             "homeScore": 132.42,
             "awayScore": 128.94,
             "homeRoster": [
               { "name": "Player One", "position": "QB", "points": 28.4, "starter": true },
               { "name": "Player Two", "position": "WR", "points": 4.2,  "starter": false }
             ],
             "awayRoster": [ ... same shape ... ]
           }
         ]
       }
     }

   Usage:
     node scripts/generate-editorial.mjs
     node scripts/generate-editorial.mjs --source path/to/payload.json
     node scripts/generate-editorial.mjs --out landing/content/blog
     node scripts/generate-editorial.mjs --self-test

   Options:
     --source <file>   Path to the verified box-score JSON. Defaults to
                        scripts/data/weekly-editorial-source.json.
     --out <dir>       Optional output directory (default: landing/content/blog).
     --self-test       Fully offline parser/template/validation check.

   After generation, compile the static public payload with `npm run build:blog`.
============================================================================ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'landing', 'content', 'blog');
const DEFAULT_SOURCE = path.join(ROOT, 'scripts', 'data', 'weekly-editorial-source.json');
const BANNED_CHARS = /[—―]/;
const TOP_PERFORMER_COUNT = 3;

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, out: DEFAULT_OUT_DIR, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('[generate-editorial] ' + arg + ' requires a value.');
      return value;
    };
    if (arg === '--source') args.source = path.resolve(next());
    else if (arg === '--out') args.out = path.resolve(next());
    else if (arg === '--self-test') args.selfTest = true;
    else throw new Error('[generate-editorial] unknown option "' + arg + '". This generator reads a local verified box-score payload only.');
  }
  return args;
}

/* ------------------------------------------------------------------ *
 * Strict payload validation. Every check throws with the exact field
 * that failed so a bad payload never gets padded with fallback text.
 * ------------------------------------------------------------------ */
function validatePlayer(raw, where) {
  if (!raw || typeof raw !== 'object') throw new Error('[generate-editorial] ' + where + ' has a roster entry that is not an object.');
  const name = cleanText(raw.name);
  const position = cleanText(raw.position).toUpperCase();
  const points = Number(raw.points);
  const starter = raw.starter === true || raw.starter === false ? raw.starter : null;
  if (!name) throw new Error('[generate-editorial] ' + where + ' has a roster entry missing "name".');
  if (!position) throw new Error('[generate-editorial] ' + where + ' entry "' + name + '" is missing "position".');
  if (!Number.isFinite(points)) throw new Error('[generate-editorial] ' + where + ' entry "' + name + '" has a non-numeric "points".');
  if (starter === null) throw new Error('[generate-editorial] ' + where + ' entry "' + name + '" is missing a boolean "starter" flag.');
  if (BANNED_CHARS.test(name) || BANNED_CHARS.test(position)) throw new Error('[generate-editorial] ' + where + ' entry "' + name + '" contains a banned em dash.');
  return { name, position, points, starter };
}

function validateMatchup(raw, index) {
  const where = 'matchup #' + (index + 1);
  if (!raw || typeof raw !== 'object') throw new Error('[generate-editorial] ' + where + ' is not an object.');
  const homeTeam = cleanText(raw.homeTeam);
  const awayTeam = cleanText(raw.awayTeam);
  const homeScore = Number(raw.homeScore);
  const awayScore = Number(raw.awayScore);
  if (!homeTeam) throw new Error('[generate-editorial] ' + where + ' is missing "homeTeam".');
  if (!awayTeam) throw new Error('[generate-editorial] ' + where + ' is missing "awayTeam".');
  if (homeTeam === awayTeam) throw new Error('[generate-editorial] ' + where + ' has "homeTeam" and "awayTeam" set to the same name.');
  if (!Number.isFinite(homeScore) || homeScore < 0) throw new Error('[generate-editorial] ' + where + ' ("' + homeTeam + '") has a non-numeric or negative "homeScore".');
  if (!Number.isFinite(awayScore) || awayScore < 0) throw new Error('[generate-editorial] ' + where + ' ("' + awayTeam + '") has a non-numeric or negative "awayScore".');
  if (!Array.isArray(raw.homeRoster) || !raw.homeRoster.length) throw new Error('[generate-editorial] ' + where + ' ("' + homeTeam + '") is missing a non-empty "homeRoster".');
  if (!Array.isArray(raw.awayRoster) || !raw.awayRoster.length) throw new Error('[generate-editorial] ' + where + ' ("' + awayTeam + '") is missing a non-empty "awayRoster".');
  if (BANNED_CHARS.test(homeTeam) || BANNED_CHARS.test(awayTeam)) throw new Error('[generate-editorial] ' + where + ' has a team name containing a banned em dash.');
  const homeRoster = raw.homeRoster.map((p) => validatePlayer(p, where + ' homeRoster'));
  const awayRoster = raw.awayRoster.map((p) => validatePlayer(p, where + ' awayRoster'));
  return { homeTeam, awayTeam, homeScore, awayScore, homeRoster, awayRoster };
}

function loadSource(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error('[generate-editorial] source ' + file + ' could not be read: ' + err.message);
  }
  const source = parsed && parsed.verifiedBoxScoreSource;
  if (!source || typeof source !== 'object') {
    throw new Error('[generate-editorial] ' + file + ' has no "verifiedBoxScoreSource" object; no output will be created.');
  }
  const season = Number(source.season);
  const week = Number(source.week);
  if (!Number.isInteger(season) || season < 2000) throw new Error('[generate-editorial] verifiedBoxScoreSource.season must be a valid year.');
  if (!Number.isInteger(week) || week < 1 || week > 18) throw new Error('[generate-editorial] verifiedBoxScoreSource.week must be an integer from 1 through 18.');
  if (!Array.isArray(source.matchups) || !source.matchups.length) throw new Error('[generate-editorial] verifiedBoxScoreSource.matchups must be a non-empty array.');
  const publishDate = cleanText(source.publishDate) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishDate)) throw new Error('[generate-editorial] verifiedBoxScoreSource.publishDate must be YYYY-MM-DD.');
  const leagueName = cleanText(source.leagueName);
  if (leagueName && BANNED_CHARS.test(leagueName)) throw new Error('[generate-editorial] verifiedBoxScoreSource.leagueName contains a banned em dash.');
  const matchups = source.matchups.map(validateMatchup);
  return { season, week, publishDate, leagueName, matchups };
}

/* ------------------------------------------------------------------ *
 * Pure math over the validated payload. No text is produced here, only
 * facts derived from the numbers already present in the source.
 * ------------------------------------------------------------------ */
function analyze(source) {
  const results = source.matchups.map((m) => {
    const margin = Math.abs(m.homeScore - m.awayScore);
    const tie = m.homeScore === m.awayScore;
    const winner = tie ? null : (m.homeScore > m.awayScore ? m.homeTeam : m.awayTeam);
    const loser = tie ? null : (m.homeScore > m.awayScore ? m.awayTeam : m.homeTeam);
    const winnerScore = tie ? null : Math.max(m.homeScore, m.awayScore);
    const loserScore = tie ? null : Math.min(m.homeScore, m.awayScore);
    return { ...m, margin, tie, winner, loser, winnerScore, loserScore };
  });

  const nailBiter = results.reduce((closest, m) => (closest == null || m.margin < closest.margin ? m : closest), null);

  const allStarters = [];
  for (const m of source.matchups) {
    for (const p of m.homeRoster) if (p.starter) allStarters.push({ ...p, team: m.homeTeam });
    for (const p of m.awayRoster) if (p.starter) allStarters.push({ ...p, team: m.awayTeam });
  }
  const topPerformers = [...allStarters].sort((a, b) => b.points - a.points).slice(0, TOP_PERFORMER_COUNT);

  const benchRegrets = [];
  for (const m of source.matchups) {
    for (const [team, roster] of [[m.homeTeam, m.homeRoster], [m.awayTeam, m.awayRoster]]) {
      const starters = roster.filter((p) => p.starter);
      const bench = roster.filter((p) => !p.starter);
      if (!starters.length || !bench.length) continue;
      const weakestStarter = starters.reduce((min, p) => (p.points < min.points ? p : min));
      const bestBench = bench.reduce((max, p) => (p.points > max.points ? p : max));
      if (bestBench.points > weakestStarter.points) {
        benchRegrets.push({ team, bestBench, weakestStarter, gap: bestBench.points - weakestStarter.points });
      }
    }
  }
  benchRegrets.sort((a, b) => b.gap - a.gap);

  return { results, nailBiter, topPerformers, benchRegrets };
}

function fmtPts(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/* ------------------------------------------------------------------ *
 * Deterministic templating. Every sentence below only ever substitutes
 * values that came directly out of the validated payload.
 * ------------------------------------------------------------------ */
function buildArticle(source, analysis) {
  const { results, nailBiter, topPerformers, benchRegrets } = analysis;

  const scoreLines = results.map((m) => {
    if (m.tie) return '- ' + m.homeTeam + ' and ' + m.awayTeam + ' tied at ' + fmtPts(m.homeScore) + '.';
    return '- ' + m.winner + ' defeated ' + m.loser + ', ' + fmtPts(m.winnerScore) + ' to ' + fmtPts(m.loserScore) + '.';
  });

  const nailBiterLine = nailBiter.tie
    ? 'The closest matchup of the week was a flat tie: ' + nailBiter.homeTeam + ' and ' + nailBiter.awayTeam + ' both finished at ' + fmtPts(nailBiter.homeScore) + '.'
    : 'The nail-biter of the week: ' + nailBiter.winner + ' held off ' + nailBiter.loser + ' by just ' + fmtPts(nailBiter.margin) + ' points, ' + fmtPts(nailBiter.winnerScore) + ' to ' + fmtPts(nailBiter.loserScore) + '.';

  const topPerformerLines = topPerformers.map((p, idx) =>
    (idx + 1) + '. ' + p.name + ' (' + p.position + ', ' + p.team + '): ' + fmtPts(p.points) + ' points.');

  const benchLines = benchRegrets.slice(0, TOP_PERFORMER_COUNT).map((b) =>
    '- ' + b.team + ' left ' + fmtPts(b.gap) + ' points on the bench: ' + b.bestBench.name + ' (' + b.bestBench.position + ') scored ' + fmtPts(b.bestBench.points) + ' while starter ' + b.weakestStarter.name + ' (' + b.weakestStarter.position + ') posted ' + fmtPts(b.weakestStarter.points) + '.');

  const leaguePrefix = source.leagueName ? source.leagueName + ', ' : '';
  const title = 'Week ' + source.week + ' Recap: Box Scores, Top Performers, and Bench Regrets';

  const bodyParts = [
    '## Week ' + source.week + ' box scores',
    scoreLines.join('\n'),
    '## ' + nailBiterLine,
  ];
  if (topPerformerLines.length) {
    bodyParts.push('## Top performers', topPerformerLines.join('\n'));
  }
  if (benchLines.length) {
    bodyParts.push('## Bench decisions that cost points', benchLines.join('\n'));
  } else {
    bodyParts.push('## Bench decisions', 'Every starting lineup this week outscored its bench alternatives: no bench regrets to report.');
  }
  const body = bodyParts.join('\n\n');

  const excerpt = leaguePrefix + 'Week ' + source.week + ' results: ' +
    (nailBiter.tie ? nailBiter.homeTeam + ' and ' + nailBiter.awayTeam + ' tied' : nailBiter.winner + ' edged ' + nailBiter.loser + ' by ' + fmtPts(nailBiter.margin)) +
    ', plus the week\'s top scorers and biggest bench decisions.';

  const entities = [];
  const seen = new Set();
  const addEntity = (name, position) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entities.push({ name, position });
  };
  for (const p of topPerformers) addEntity(p.name, p.position);
  for (const b of benchRegrets.slice(0, TOP_PERFORMER_COUNT)) {
    addEntity(b.bestBench.name, b.bestBench.position);
    addEntity(b.weakestStarter.name, b.weakestStarter.position);
  }

  const slug = 'week-' + source.week + '-' + source.season + '-recap';

  return {
    title, slug, publishDate: source.publishDate, category: 'Recap',
    excerpt, author: 'FSN Desk', week: source.week, entities, body,
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
    if (!haystack.includes(entity.name.toLowerCase())) throw new Error('[generate-editorial] entity "' + entity.name + '" is not named in the generated recap; refusing to publish an unlinked entity.');
  }
  const fields = [article.title, article.slug, article.category, article.excerpt, article.author, article.body, ...article.entities.map((e) => e.name)];
  if (fields.some((field) => BANNED_CHARS.test(String(field)))) throw new Error('[generate-editorial] em dash found in generated content.');
  if (!Number.isInteger(article.week) || article.week < 1 || article.week > 18) {
    throw new Error('[generate-editorial] generated week must be an integer from 1 through 18.');
  }
}

function serializeFrontmatter(article) {
  const lines = ['---'];
  for (const key of ['title', 'slug', 'publishDate', 'category', 'excerpt', 'author']) lines.push(key + ': ' + article[key]);
  lines.push('week: ' + article.week);
  if (article.entities.length) {
    lines.push('entities:');
    for (const entity of article.entities) {
      lines.push('  - name: ' + entity.name);
      if (entity.position) lines.push('    position: ' + entity.position);
    }
  }
  lines.push('---', '', article.body);
  return lines.join('\n') + '\n';
}

function generate(options) {
  if (!fs.existsSync(options.source)) {
    console.warn('[generate-editorial] no verified box-score source found at ' + path.relative(ROOT, options.source) + '; no blog, News Desk, or database write was attempted.');
    return null;
  }
  const source = loadSource(options.source);
  const analysis = analyze(source);
  const article = buildArticle(source, analysis);
  validateArticle(article);
  fs.mkdirSync(options.out, { recursive: true });
  const outFile = path.join(options.out, article.slug + '.md');
  fs.writeFileSync(outFile, serializeFrontmatter(article), 'utf8');
  console.log('[generate-editorial] wrote ' + outFile);
  return outFile;
}

function fixtureSource() {
  return {
    verifiedBoxScoreSource: {
      season: 2026,
      week: 2,
      publishDate: '2026-09-16',
      leagueName: 'Fixture League',
      matchups: [
        {
          homeTeam: 'Gridiron Gurus', awayTeam: 'End Zone Elites',
          homeScore: 132.42, awayScore: 128.94,
          homeRoster: [
            { name: 'Fixture QB One', position: 'QB', points: 28.4, starter: true },
            { name: 'Fixture Bench WR', position: 'WR', points: 22.1, starter: false },
            { name: 'Fixture Weak RB', position: 'RB', points: 5.3, starter: true },
          ],
          awayRoster: [
            { name: 'Fixture RB Star', position: 'RB', points: 31.7, starter: true },
            { name: 'Fixture Other', position: 'TE', points: 9.0, starter: true },
          ],
        },
        {
          homeTeam: 'Blitz Brigade', awayTeam: 'Red Zone Raiders',
          homeScore: 101.0, awayScore: 100.5,
          homeRoster: [{ name: 'Fixture Kicker', position: 'K', points: 10.0, starter: true }],
          awayRoster: [{ name: 'Fixture WR Two', position: 'WR', points: 18.0, starter: true }],
        },
      ],
    },
  };
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsn-editorial-selftest-'));
  const sourceFile = path.join(tmp, 'source.json');
  const failures = [];
  const check = (value, message) => { if (!value) failures.push(message); };
  try {
    fs.writeFileSync(sourceFile, JSON.stringify(fixtureSource()), 'utf8');
    const file = generate({ source: sourceFile, out: tmp });
    const content = fs.readFileSync(file, 'utf8');
    check(content.includes('End Zone Elites defeated Gridiron Gurus') === false, 'winner/loser direction should follow the higher score');
    check(content.includes('Gridiron Gurus defeated End Zone Elites, 132.42 to 128.94'), 'expected score line missing or wrong');
    check(content.includes('Blitz Brigade held off Red Zone Raiders by just 0.50 points'), 'nail-biter line missing or wrong margin');
    check(content.includes('Fixture RB Star (RB, End Zone Elites): 31.70 points'), 'top performer line missing or wrong');
    check(content.includes('Gridiron Gurus left 16.80 points on the bench: Fixture Bench WR (WR) scored 22.10 while starter Fixture Weak RB (RB) posted 5.30'), 'bench regret line missing or wrong');
    check(!BANNED_CHARS.test(content), 'output contains banned punctuation');
    check(/^week: 2$/m.test(content), 'week frontmatter missing');

    const missingFile = path.join(tmp, 'missing.json');
    const noOutput = generate({ source: missingFile, out: tmp });
    check(noOutput === null, 'a missing source file should skip safely instead of crashing');

    const badFile = path.join(tmp, 'bad.json');
    fs.writeFileSync(badFile, JSON.stringify({ verifiedBoxScoreSource: { season: 2026, week: 2, matchups: [{ homeTeam: 'A', awayTeam: 'B', homeScore: 10, awayScore: 5, homeRoster: [{ name: 'Ghost Player', position: 'QB', points: 10 }], awayRoster: [{ name: 'X', position: 'WR', points: 5, starter: true }] }] } }), 'utf8');
    let rejected = false;
    try { generate({ source: badFile, out: tmp }); }
    catch (err) { rejected = /missing a boolean "starter" flag/.test(err.message); }
    check(rejected, 'a roster entry missing the starter flag should be rejected, not defaulted');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error('[generate-editorial] SELF-TEST FAILED:');
    failures.forEach((failure) => console.error('  - ' + failure));
    process.exit(1);
  }
  console.log('[generate-editorial] self-test passed: strict box-score validation, deterministic recap templating, no network calls.');
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(err.message); process.exit(1); }
  if (args.selfTest) { runSelfTest(); return; }
  try {
    const file = generate(args);
    if (file) console.log('[generate-editorial] done. Run "npm run build:blog" to compile ' + path.relative(ROOT, file) + '.');
    else console.log('[generate-editorial] skipped safely: no verified source, no output written.');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
