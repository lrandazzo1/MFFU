#!/usr/bin/env node
/* ============================================================================
   FSN INTERNET NEWS -> APP -> NOTIFICATION CONTRACT CHECK

   Exercises the same source article across the RSS fetcher, blog compiler,
   league-empty News Desk ingestion contract, and Tuesday/Thursday/Friday push
   routes. All network input and output directories are local fixtures.
============================================================================ */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const notifications = require('../lib/notifications/triggers.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDITIONS = [
  { date: '2026-09-15', weekday: 2, trigger: 'game_recap', slot: 'recap', category: 'Recap' },
  { date: '2026-09-17', weekday: 4, trigger: 'tnf_matchup_prep', slot: 'roster', category: 'Roster Watch' },
  { date: '2026-09-18', weekday: 5, trigger: 'weekend_deepdive', slot: 'roster', category: 'Roster Watch' },
];

let failures = 0;
const ok = (label) => console.log('  ok    ' + label);
const fail = (label) => { failures++; console.error('  FAIL  ' + label); };
const check = (condition, label) => condition ? ok(label) : fail(label);
const equal = (actual, wanted, label) => {
  if (actual === wanted) ok(label + ' = ' + JSON.stringify(actual));
  else fail(label + ' = ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(wanted));
};

function startFixtureServer() {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Pipeline News</title>
    <item><title>Star receiver cleared to practice</title><link>https://news.example/receiver</link><pubDate>Tue, 15 Sep 2026 17:00:00 GMT</pubDate><description>The receiver returned to full work after an early-week limitation.</description></item>
    <item><title>Backfield rotation changes after opener</title><link>https://news.example/backfield</link><pubDate>Tue, 15 Sep 2026 15:00:00 GMT</pubDate><description>Coaches confirmed a larger role for the younger back.</description></item>
    <item><title>Defense adjusts its pressure package</title><link>https://news.example/defense</link><pubDate>Tue, 15 Sep 2026 13:00:00 GMT</pubDate><description>The unit changed its third-down rotation.</description></item>
  </channel></rss>`;
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Pipeline Wire</title>
    <entry><title>Veteran lineman joins contender</title><link href="https://wire.example/lineman"/><updated>2026-09-15T12:00:00Z</updated><summary>The move adds depth before the weekend slate.</summary></entry>
    <entry><title>Star receiver cleared to practice</title><link href="https://wire.example/duplicate"/><updated>2026-09-15T11:00:00Z</updated><summary>This duplicate should be removed.</summary></entry>
  </feed>`;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/xml');
    if (req.url === '/rss.xml') res.end(rss);
    else if (req.url === '/atom.xml') res.end(atom);
    else { res.statusCode = 404; res.end('<error>not found</error>'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: Object.assign({}, process.env, env || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${process.execPath} ${args.join(' ')} exited ${code}\n${stdout}${stderr}`));
    });
  });
}

function slugFor(edition) {
  return `nfl-news-${edition.trigger.replace(/_/g, '-')}-${edition.date}`;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fsn-blog-pipeline-'));
const sourceDir = path.join(tmp, 'source');
const outputDir = path.join(tmp, 'generated');
const pagesDir = path.join(tmp, 'pages');
mkdirSync(sourceDir, { recursive: true });
mkdirSync(pagesDir, { recursive: true });

const server = await startFixtureServer();
const origin = `http://127.0.0.1:${server.address().port}`;
const feeds = [
  '--feed', `Pipeline News|${origin}/rss.xml`,
  '--feed', `Pipeline Wire|${origin}/atom.xml`,
];

try {
  console.log('\n-- 1. Public RSS/Atom -> source articles --');
  for (const edition of EDITIONS) {
    await runNode([
      'scripts/generate-editorial.mjs',
      '--publish-date', edition.date,
      '--out', sourceDir,
      '--limit', '4',
      '--max-age-hours', '96',
      ...feeds,
    ]);
    const sourceFile = path.join(sourceDir, slugFor(edition) + '.md');
    check(existsSync(sourceFile), `${edition.date} generator wrote a standalone news article`);
    const source = readFileSync(sourceFile, 'utf8');
    check(source.includes('Star receiver cleared to practice'), 'real RSS headline was compiled');
    check(source.includes('[Pipeline News](https://news.example/receiver)'), 'original source link was retained');
    check(source.includes('[Pipeline Wire](https://wire.example/lineman)'), 'Atom source was retained');
    equal((source.match(/Star receiver cleared to practice/g) || []).length, 1,
      'duplicate cross-feed headline count');
    check(source.includes(`notificationTrigger: ${edition.trigger}`),
      `${edition.date} article declares ${edition.trigger}`);
    check(!/SLEEPER_LEAGUE_ID|--league|league_id|roster_id|owner_id|sleeperPlayerId/.test(source),
      'source article has no league, roster, or user dependency');
  }

  console.log('-- 2. Source articles -> deploy payload --');
  await runNode(['scripts/build-blog.mjs'], {
    FSN_BLOG_SOURCE_DIR: sourceDir,
    FSN_BLOG_OUTPUT_DIR: outputDir,
    FSN_BLOG_PAGES_DIR: pagesDir,
    FSN_BLOG_READER_TEMPLATE: path.join(ROOT, 'landing', 'blog', 'reader.html'),
  });

  const manifest = JSON.parse(readFileSync(path.join(outputDir, 'index.json'), 'utf8'));
  equal(manifest.count, EDITIONS.length, 'compiled manifest article count');
  for (const edition of EDITIONS) {
    const slug = slugFor(edition);
    const row = manifest.posts.find((post) => post.slug === slug);
    check(!!row, `manifest includes ${slug}`);
    equal(row && row.category, edition.category, `${edition.date} category`);
    equal(row && row.notificationTrigger, edition.trigger, `${edition.date} dispatch hook`);
    check(!row.entities || (Array.isArray(row.entities) && row.entities.length === 0),
      `${edition.date} manifest row needs no roster entities`);

    const post = JSON.parse(readFileSync(path.join(outputDir, 'posts', slug + '.json'), 'utf8'));
    check(/<h3>Star receiver cleared to practice<\/h3>/.test(post.bodyHtml),
      `${edition.date} body renders the fetched headline`);
    check(/href="https:\/\/news\.example\/receiver"/.test(post.bodyHtml),
      `${edition.date} body renders the original report link`);
    check(!/<script|onerror=|onclick=/i.test(post.bodyHtml),
      `${edition.date} body contains no executable markup`);
    check(Array.isArray(post.entities) && post.entities.length === 0,
      `${edition.date} compiled post remains league-agnostic`);
    check(existsSync(path.join(pagesDir, slug + '.html')),
      `${edition.date} compiler stamped the reader route`);
  }

  console.log('-- 3. Deploy payload -> league-empty News Desk contract --');
  const app = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check(app.includes("const INDEX_PATH = '/content/generated/blog/index.json';"),
    'app polls the compiled manifest path');
  check(app.includes("const POSTS_PATH = '/content/generated/blog/posts/';"),
    'app loads the compiled post path');
  check(app.includes("const entities = (Array.isArray(src.entities) ? src.entities : [])"),
    'app treats a missing/empty entity list as optional');
  check(app.includes("if(!data || !Array.isArray(data.schedule) || !data.schedule.length) return empty;"),
    'ownership enrichment exits cleanly when no league is loaded');
  check(app.includes("FSNBridge.call('renderDeskWire')"),
    'successful polling repaints the News Desk through the guarded bridge');
  check(app.includes("console.warn('[FSNArticles] the article feed at "),
    'poll failures remain loud and use the cached/empty fallback path');

  console.log('-- 4. Tuesday/Thursday/Friday articles -> public notification hooks --');
  for (const edition of EDITIONS) {
    const runAt = Date.parse(edition.date + 'T16:00:00Z');
    const due = notifications.dueTriggers({
      deviceId: 'pipeline-device',
      timezone: 'UTC',
      prefs: { tuesday: true, wednesday: true, thursday: true, friday: true },
      seasonYear: 2026,
      week: 1,
    }, runAt, new Set());
    equal(due.length, 1, `${edition.date} produces one notification`);
    equal(due[0] && due[0].trigger.id, edition.trigger,
      `${edition.date} trigger matches generated article metadata`);
    equal(due[0] && due[0].trigger.articleSlot, edition.slot,
      `${edition.date} dispatch slot matches News Desk category`);

    const notification = notifications.buildNotification(edition.trigger, {
      seasonYear: 2026, week: 1,
    });
    check(!!notification, `${edition.date} notification payload built without a league id`);
    equal(notification && notification.data.articleSlot, edition.slot,
      `${edition.date} payload carries the article slot`);
    equal(notification && notification.data.url, '/?goto=news',
      `${edition.date} payload opens the News Desk`);
    equal(Object.hasOwn(notification.data, 'leagueId'), false,
      `${edition.date} payload omits user-specific league state`);
  }

  const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const dispatchCron = (vercel.crons || []).filter((cron) => cron.path === '/api/notifications-dispatch');
  equal(dispatchCron.length, 1, 'one notification dispatcher cron is configured');
  equal(dispatchCron[0] && dispatchCron[0].schedule, '0 16 * * *',
    'dispatcher keeps the audited once-daily 16:00 UTC schedule');

  const editorialWorkflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'editorial-news.yml'), 'utf8');
  check(editorialWorkflow.includes("cron: '0 13 * * 2,4,5'"),
    'news scraper runs three hours before Tuesday/Thursday/Friday dispatch');
  check(!/SLEEPER_LEAGUE_ID|--league/.test(editorialWorkflow),
    'scheduled scraper has no league-id configuration');
} catch (err) {
  fail('pipeline harness threw: ' + ((err && err.stack) || err));
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n[blog-pipeline-check] FAILED (${failures} assertion${failures === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log('\n[blog-pipeline-check] clean');
