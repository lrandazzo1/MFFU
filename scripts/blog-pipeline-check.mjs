#!/usr/bin/env node
/* ============================================================================
   FSN BLOG GENERATION -> INGESTION -> NOTIFICATION CONTRACT CHECK

   This is the missing cross-boundary check. Existing suites deeply verify the
   News Desk renderer and the push dispatcher in isolation. This harness proves
   that one article built from real provider-shaped scores keeps the same
   identity, week, category and trigger as it moves through the compiler, the
   app feed contract and the Tuesday notification cadence.

   It writes only below the operating system temp directory. Production source,
   compiled blog payloads, deterministic News Desk generators and Supabase are
   never touched.
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
const FIXED_DATE = '2026-09-15'; // Tuesday, the recap dispatch day.

let failures = 0;
const ok = (label) => console.log('  ok    ' + label);
const fail = (label) => { failures++; console.error('  FAIL  ' + label); };
const check = (condition, label) => condition ? ok(label) : fail(label);
const equal = (actual, wanted, label) => {
  if (actual === wanted) ok(label + ' = ' + JSON.stringify(actual));
  else fail(label + ' = ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(wanted));
};

function fixtures() {
  return {
    '/v1/state/nfl': { week: 1, season: '2026', season_type: 'regular' },
    '/v1/league/pipeline-league': { league_id: 'pipeline-league', name: 'Pipeline League', season: '2026' },
    '/v1/league/pipeline-league/rosters': [
      { roster_id: 1, owner_id: 'u1' },
      { roster_id: 2, owner_id: 'u2' },
    ],
    '/v1/league/pipeline-league/users': [
      { user_id: 'u1', display_name: 'Alice', metadata: { team_name: 'Alice All Stars' } },
      { user_id: 'u2', display_name: 'Bob', metadata: { team_name: 'Bob Blitz' } },
    ],
    '/v1/league/pipeline-league/matchups/1': [
      {
        roster_id: 1, matchup_id: 1, points: 120.5,
        starters: ['1001', '1002'], players_points: { '1001': 30.2, '1002': 10.1 },
      },
      {
        roster_id: 2, matchup_id: 1, points: 110,
        starters: ['2001'], players_points: { '2001': 25.5 },
      },
    ],
    '/v1/players/nfl': {
      '1001': { full_name: 'Test Player One', position: 'WR' },
      '1002': { full_name: 'Test Player Two', position: 'RB' },
      '2001': { full_name: 'Test Player Three', position: 'QB' },
    },
  };
}

function startFixtureServer() {
  const rows = fixtures();
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      res.setHeader('Content-Type', 'application/json');
      if (!(pathname in rows)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'fixture not found', pathname }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify(rows[pathname]));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
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
      else reject(new Error(
        `${process.execPath} ${args.join(' ')} exited ${code}\n${stdout}${stderr}`
      ));
    });
  });
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fsn-blog-pipeline-'));
const sourceDir = path.join(tmp, 'source');
const outputDir = path.join(tmp, 'generated');
const pagesDir = path.join(tmp, 'pages');
mkdirSync(sourceDir, { recursive: true });
mkdirSync(pagesDir, { recursive: true });

const server = await startFixtureServer();
const apiBase = `http://127.0.0.1:${server.address().port}/v1`;

try {
  console.log('\n-- 1. Provider metrics -> source article --');
  await runNode([
    'scripts/generate-editorial.mjs',
    '--league', 'pipeline-league',
    '--week', '1',
    '--publish-date', FIXED_DATE,
    '--out', sourceDir,
    '--base', apiBase,
  ]);

  const sourceFile = path.join(sourceDir, 'week-1-game-recap.md');
  check(existsSync(sourceFile), 'generator wrote the Week 1 source article');
  const source = readFileSync(sourceFile, 'utf8');
  check(source.includes('Alice All Stars beat Bob Blitz, 120.50 to 110.00.'),
    'winner and final scores came from the provider payload');
  check(source.includes('Test Player One') && source.includes('30.20 points'),
    'winning roster top performer and points were compiled');
  check(source.includes('Test Player Three') && source.includes('25.50 points'),
    'opposing roster top performer and points were compiled');
  check(!source.includes('Test Player Two'),
    'lower-scoring starter was not mislabeled as the top performer');
  check(source.includes('notificationTrigger: game_recap'),
    'generated recap declares its notification trigger');

  console.log('-- 2. Source article -> deploy payload --');
  await runNode(['scripts/build-blog.mjs'], {
    FSN_BLOG_SOURCE_DIR: sourceDir,
    FSN_BLOG_OUTPUT_DIR: outputDir,
    FSN_BLOG_PAGES_DIR: pagesDir,
    FSN_BLOG_READER_TEMPLATE: path.join(ROOT, 'landing', 'blog', 'reader.html'),
  });

  const manifest = JSON.parse(readFileSync(path.join(outputDir, 'index.json'), 'utf8'));
  equal(manifest.count, 1, 'compiled manifest article count');
  const row = manifest.posts[0];
  equal(row.slug, 'week-1-game-recap', 'manifest preserves the generated slug');
  equal(row.publishDate, FIXED_DATE, 'manifest preserves the dispatch date');
  equal(row.category, 'Recap', 'manifest preserves the News Desk category');
  equal(row.notificationTrigger, 'game_recap', 'manifest preserves the dispatch hook');

  const post = JSON.parse(readFileSync(
    path.join(outputDir, 'posts', 'week-1-game-recap.json'), 'utf8'
  ));
  check(/<h3>Alice All Stars vs Bob Blitz<\/h3>/.test(post.bodyHtml),
    'compiler rendered matchup markup for the app');
  check(/Alice All Stars beat Bob Blitz, 120\.50 to 110\.00\./.test(post.bodyHtml),
    'rendered body preserves the verified winner and score');
  check(!/<script|onerror=|onclick=/i.test(post.bodyHtml),
    'compiled body contains no executable markup');
  equal(post.notificationTrigger, row.notificationTrigger,
    'post body and manifest carry the same trigger identity');
  check(existsSync(path.join(pagesDir, 'week-1-game-recap.html')),
    'compiler stamped the clean reader route');

  console.log('-- 3. Deploy payload -> News Desk ingestion contract --');
  const app = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check(app.includes("const INDEX_PATH = '/content/generated/blog/index.json';"),
    'app polls the compiled manifest path');
  check(app.includes("const POSTS_PATH = '/content/generated/blog/posts/';"),
    'app loads the compiled post path');
  check(app.includes("slug: String(src.slug || row.slug || '').trim()") &&
      app.includes("category: String(src.category || row.category || '').trim()") &&
      app.includes("bodyHtml: typeof src.bodyHtml === 'string' ? src.bodyHtml : ''"),
    'compiled payload exposes every field the app ingestion contract requires');
  check(/recap:\s*\{[\s\S]*?terms:\s*\[[\s\S]*?'recap'/.test(app),
    'Recap category is routable to the app recap slot');
  check(app.includes('FSNBridge.call(\'renderDeskWire\')'),
    'successful polling repaints the News Desk through the guarded bridge');
  check(app.includes("console.warn('[FSNArticles] the article feed at "),
    'poll failures remain loud and use the cached/empty fallback path');

  console.log('-- 4. Generated article -> Tuesday dispatch hook --');
  const tuesdayRun = Date.UTC(2026, 8, 15, 16, 0, 0);
  const due = notifications.dueTriggers({
    deviceId: 'pipeline-device',
    timezone: 'America/Chicago',
    prefs: { tuesday: true, wednesday: true, thursday: true, friday: true },
    seasonYear: 2026,
    week: 1,
  }, tuesdayRun, new Set());
  equal(due.length, 1, 'Tuesday produces exactly one notification');
  const dueTrigger = due[0] && due[0].trigger;
  equal(dueTrigger && dueTrigger.id, row.notificationTrigger,
    'Tuesday trigger matches the generated article metadata');
  equal(dueTrigger && dueTrigger.articleSlot, 'recap',
    'dispatch trigger targets the same recap slot the app renders');

  const notification = notifications.buildNotification(row.notificationTrigger, {
    leagueId: 'pipeline-league', seasonYear: 2026, week: 1,
  });
  check(!!notification, 'notification payload built for the generated article');
  equal(notification && notification.data.articleSlot, dueTrigger && dueTrigger.articleSlot,
    'payload carries the generated-content slot');
  equal(notification && notification.data.url, '/?goto=news',
    'notification click opens the News Desk');

  const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const dispatchCron = (vercel.crons || []).filter((c) => c.path === '/api/notifications-dispatch');
  equal(dispatchCron.length, 1, 'one notification dispatcher cron is configured');
  equal(dispatchCron[0] && dispatchCron[0].schedule, '0 16 * * *',
    'dispatcher keeps the audited once-daily 16:00 UTC schedule');
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
