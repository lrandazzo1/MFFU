#!/usr/bin/env node
/* ============================================================================
   FSN — ONE-OFF BLOG ARTICLE CLEANUP
   ----------------------------------------------------------------------------
   Deletes rows from `blog_articles`, so a generator that refuses to overwrite
   can write a fresh one.

   ---- WHY THIS EXISTS ----

   api/cron/generate-articles.js is idempotent by design: a league that already
   has this week's article of this type is SKIPPED, never rewritten, so no
   reader ever sees a story change under them. That is the right default and it
   is not being changed here. The consequence is that a row written by an older
   generator stays until somebody removes it, and this is the supported way to
   remove one.

   scripts/generate-editorial.mjs does not need this. Its Supabase write is an
   upsert on the slug with `resolution=merge-duplicates`, so a re-run replaces
   its own global row in place. Use this only for a row that something refuses
   to overwrite.

   ---- WHAT IT REFUSES TO DO ----

   A DELETE against a table of published articles is irreversible and there is
   no undo, so:

     * DRY RUN IS THE DEFAULT. Without `--apply` it only reads, prints exactly
       what would be deleted, and exits. `--apply` is the whole difference
       between a rehearsal and a deletion.
     * IT WILL NOT RUN UNSCOPED. A filter must pin the rows down: either an
       exact `--slug`, or `--season` AND `--week` together with at least one of
       `--type`, `--league` or `--global`. "Delete every article" is not
       expressible here, on purpose.
     * IT PRINTS THE ROWS FIRST, always, including under `--apply`, so the
       operator sees what is about to go and the run log records it.
     * IT STOPS ON A SURPRISE. If the delete reports a different number of rows
       than the read did, that is a concurrent write and it says so loudly
       rather than shrugging.

   PostgREST directly rather than @supabase/supabase-js, the same as
   scripts/generate-editorial.mjs: this is one GET and one DELETE from a script
   run by `node scripts/...` with no bundler in the path.

   Usage:
     node scripts/delete-stale-article.mjs --season 2026 --week 3 --type friday_tnf_preview
     node scripts/delete-stale-article.mjs --slug 2026-week-3-friday-tnf-preview-100 --apply
     node scripts/delete-stale-article.mjs --season 2026 --week 3 --global --apply
     node scripts/delete-stale-article.mjs --self-test

   Options:
     --slug <slug>        Exact slug. Sufficient scope on its own.
     --season <year>      Season. Needs --week and one of the three below.
     --week <1-18>        Week.
     --type <name>        article_type, e.g. friday_tnf_preview, global_editorial.
     --league <id>        Restrict to one league_id.
     --global             Restrict to global rows (league_id IS NULL).
     --apply              Actually delete. Without it, this is a dry run.
     --self-test          Network-free check of the scope guard and the wire shape.

   Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
============================================================================ */

import { createServer } from 'node:http';

const TABLE = 'blog_articles';
const ARTICLE_TYPES = ['monday_sweat', 'tuesday_verdict', 'friday_tnf_preview', 'league_dispatch', 'global_editorial'];
/* A scoped delete that matches more than this is not the one-off row cleanup
   this script is for, and is far more likely to be a mistyped filter. */
const MAX_ROWS = 25;

function parseArgs(argv) {
  const args = { slug: '', season: 0, week: 0, type: '', league: '', global: false, apply: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('[delete-stale-article] ' + arg + ' requires a value.');
      return value;
    };
    if (arg === '--slug') args.slug = next().trim();
    else if (arg === '--season') args.season = Number(next());
    else if (arg === '--week') args.week = Number(next());
    else if (arg === '--type') {
      args.type = next().trim();
      if (!ARTICLE_TYPES.includes(args.type)) {
        throw new Error('[delete-stale-article] --type must be one of ' + ARTICLE_TYPES.join(', ') + '.');
      }
    }
    else if (arg === '--league') args.league = next().trim();
    else if (arg === '--global') args.global = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--self-test') args.selfTest = true;
    else throw new Error('[delete-stale-article] unknown option "' + arg + '".');
  }
  if (args.league && args.global) {
    throw new Error('[delete-stale-article] --league and --global are mutually exclusive: a global row has no league.');
  }
  if (args.season && (!Number.isInteger(args.season) || args.season < 1990 || args.season > 2100)) {
    throw new Error('[delete-stale-article] --season must be a four digit year.');
  }
  if (args.week && (!Number.isInteger(args.week) || args.week < 1 || args.week > 18)) {
    throw new Error('[delete-stale-article] --week must be an integer from 1 through 18.');
  }
  return args;
}

/**
 * The PostgREST filter, or a refusal.
 *
 * The refusal is the point of the function. An unscoped DELETE against
 * blog_articles would take the whole corpus, and PostgREST will happily accept
 * one, so the guard has to live here rather than in the reviewer's attention.
 */
function buildFilter(args) {
  const params = new URLSearchParams();
  if (args.slug) {
    params.set('slug', 'eq.' + args.slug);
    return params;
  }
  const narrowing = [args.type && 'type', args.league && 'league', args.global && 'global'].filter(Boolean);
  if (!args.season || !args.week || !narrowing.length) {
    throw new Error('[delete-stale-article] refusing an unscoped delete. Pass --slug, or pass --season and --week ' +
      'together with at least one of --type, --league or --global. This script will not express "delete everything".');
  }
  params.set('season', 'eq.' + args.season);
  params.set('week', 'eq.' + args.week);
  if (args.type) params.set('article_type', 'eq.' + args.type);
  if (args.league) params.set('league_id', 'eq.' + args.league);
  if (args.global) params.set('league_id', 'is.null');
  return params;
}

function supabaseConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  return { url, key };
}

const headers = (config, extra = {}) => ({
  apikey: config.key,
  Authorization: 'Bearer ' + config.key,
  'Content-Type': 'application/json',
  ...extra,
});

async function request(url, options, label) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new Error('[delete-stale-article] the ' + label + ' request failed: ' + err.message);
  }
  const body = await res.text();
  if (!res.ok) {
    throw new Error('[delete-stale-article] Supabase refused the ' + label + ' (HTTP ' + res.status + '): ' + body.slice(0, 400));
  }
  try {
    return JSON.parse(body || '[]');
  } catch (err) {
    throw new Error('[delete-stale-article] the ' + label + ' returned a body that is not JSON: ' + err.message);
  }
}

const describe = (row) => '  ' + row.slug + '  [' + row.article_type + ', league ' +
  (row.league_id == null ? 'NULL (global)' : row.league_id) + ', season ' + row.season + ' week ' + row.week + ']' +
  (row.title ? '\n      "' + String(row.title).slice(0, 90) + '"' : '');

async function run(args, env = process.env) {
  const config = supabaseConfig(env);
  if (!config) {
    throw new Error('[delete-stale-article] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set. ' +
      'This script cannot reach the database without them, and it will not pretend it did.');
  }
  const filter = buildFilter(args);

  const readParams = new URLSearchParams(filter);
  readParams.set('select', 'slug,article_type,league_id,season,week,title,published_at');
  const found = await request(config.url + '/rest/v1/' + TABLE + '?' + readParams.toString(),
    { method: 'GET', headers: headers(config) }, 'read');

  if (!found.length) {
    console.log('[delete-stale-article] no rows match that filter. Nothing to delete.');
    return { matched: [], deleted: [] };
  }
  console.log('[delete-stale-article] ' + found.length + ' row(s) match:');
  for (const row of found) console.log(describe(row));

  if (found.length > MAX_ROWS) {
    throw new Error('[delete-stale-article] that filter matches ' + found.length + ' rows, above the ' + MAX_ROWS +
      ' this script will delete in one go. Narrow it. A filter this wide is far more likely to be a typo than an intent.');
  }

  if (!args.apply) {
    console.log('[delete-stale-article] DRY RUN: nothing was deleted. Re-run with --apply to delete the rows above.');
    return { matched: found, deleted: [] };
  }

  const deleted = await request(config.url + '/rest/v1/' + TABLE + '?' + filter.toString(),
    { method: 'DELETE', headers: headers(config, { Prefer: 'return=representation' }) }, 'delete');

  if (deleted.length !== found.length) {
    /* Not fatal to the rows already gone, but the operator must know the set
       moved under them: something else wrote to this table mid-run. */
    console.error('[delete-stale-article] the read matched ' + found.length + ' row(s) but the delete removed ' +
      deleted.length + '. Something wrote to ' + TABLE + ' between the two requests. Re-run the read to see the ' +
      'current state before assuming this cleanup is complete.');
  }
  console.log('[delete-stale-article] deleted ' + deleted.length + ' row(s). The generator that owns them can now ' +
    'write a fresh article for that scope.');
  return { matched: found, deleted };
}

/* --------------------------------------------------------------------------
   SELF-TEST — network free. The scope guard is the part that matters, so it is
   checked directly, and the two requests are served from a local fixture so the
   wire shape (filter, method, Prefer header) is asserted rather than assumed.
-------------------------------------------------------------------------- */
async function runSelfTest() {
  const failures = [];
  const check = (value, message) => { if (!value) failures.push(message); };

  for (const argv of [[], ['--season', '2026'], ['--season', '2026', '--week', '3'], ['--week', '3', '--type', 'monday_sweat']]) {
    let refused = false;
    try { buildFilter(parseArgs(argv)); }
    catch (err) { refused = /refusing an unscoped delete/.test(err.message); }
    check(refused, 'an unscoped delete was accepted for argv ' + JSON.stringify(argv));
  }

  check(buildFilter(parseArgs(['--slug', 'abc'])).get('slug') === 'eq.abc', 'a slug scope did not build an equality filter');
  const scoped = buildFilter(parseArgs(['--season', '2026', '--week', '3', '--type', 'friday_tnf_preview']));
  check(scoped.get('season') === 'eq.2026' && scoped.get('week') === 'eq.3' &&
    scoped.get('article_type') === 'eq.friday_tnf_preview', 'a season/week/type scope did not build the right filter');
  check(buildFilter(parseArgs(['--season', '2026', '--week', '3', '--global'])).get('league_id') === 'is.null',
    '--global did not filter on a null league_id');

  let exclusive = false;
  try { parseArgs(['--league', '1', '--global']); }
  catch (err) { exclusive = /mutually exclusive/.test(err.message); }
  check(exclusive, '--league and --global were accepted together');

  let badType = false;
  try { parseArgs(['--type', 'not_a_type']); }
  catch (err) { badType = /--type must be one of/.test(err.message); }
  check(badType, 'an unknown article type was accepted');

  const rows = [{ slug: 's1', article_type: 'friday_tnf_preview', league_id: '100', season: 2026, week: 3, title: 'T' }];
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, prefer: req.headers.prefer || '' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = { SUPABASE_URL: 'http://127.0.0.1:' + server.address().port, SUPABASE_SERVICE_ROLE_KEY: 'selftest' };

  try {
    const dry = await run(parseArgs(['--season', '2026', '--week', '3', '--type', 'friday_tnf_preview']), env);
    check(dry.matched.length === 1 && dry.deleted.length === 0, 'a dry run reported a deletion');
    check(seen.length === 1 && seen[0].method === 'GET', 'a dry run issued something other than a single read');

    seen.length = 0;
    const applied = await run(parseArgs(['--season', '2026', '--week', '3', '--type', 'friday_tnf_preview', '--apply']), env);
    check(applied.deleted.length === 1, '--apply did not delete the matched row');
    check(seen.length === 2 && seen[0].method === 'GET' && seen[1].method === 'DELETE',
      '--apply did not read before it deleted');
    check(seen[1].url.includes('article_type=eq.friday_tnf_preview') && seen[1].url.includes('week=eq.3'),
      'the delete was sent without the scoping filter, which would have taken the whole table');
    check(!seen[1].url.includes('select='), 'the delete carried the read-only select parameter');
    check(seen[1].prefer.includes('return=representation'), 'the delete did not ask for the rows it removed');

    let noCreds = false;
    try { await run(parseArgs(['--slug', 'x']), {}); }
    catch (err) { noCreds = /must both be set/.test(err.message); }
    check(noCreds, 'the script tried to run without credentials');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  if (failures.length) {
    console.error('[delete-stale-article] SELF-TEST FAILED:');
    failures.forEach((failure) => console.error('  - ' + failure));
    process.exit(1);
  }
  console.log('[delete-stale-article] self-test passed: the unscoped-delete refusal, slug and season/week scoping, ' +
    'the global null-league filter, dry run by default, and a scoped DELETE that reads first.');
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(err.message); process.exit(1); }
  if (args.selfTest) { await runSelfTest(); return; }
  try { await run(args); }
  catch (err) { console.error(err.message); process.exit(1); }
}

main();
