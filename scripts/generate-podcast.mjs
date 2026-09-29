#!/usr/bin/env node
/* ============================================================================
   FSN — WEEKLY PODCAST GENERATOR (CLI)

     PODCAST_TARGET_WEEK=2 npm run generate:podcast
     node scripts/generate-podcast.mjs --week=2
     node scripts/generate-podcast.mjs --week=2 --payload=<espn.json>   (offline)

   The same code path the Tuesday cron runs — `runWeeklyPodcastCron` from
   `lib/dist/generate-weekly-podcast.js` — driven from a terminal so the four
   segments, the week boundary, the Supabase writes and the ElevenLabs synthesis
   can be exercised without waiting for a schedule or standing up a request.

   ---- TWO MODES ----

   LIVE (default). Sweeps `public.leagues`, reads ESPN, synthesizes, uploads the
   MP3 to Supabase Storage and writes `podcast_episodes`. Needs real credentials
   and real network egress, and it SPENDS MONEY at ElevenLabs — one call per
   dialogue turn per league. `--preflight` reports whether it can run without
   running it.

   OFFLINE (`--payload=<file>`). Builds the four-segment script from a league
   payload on disk: the real index port, the real outcome math, the real preview
   matchups, the real script templates. Nothing is fetched, nothing is
   synthesized, nothing is written, nothing is billed. This is the mode that
   works on a machine with no keys, and it is the one that answers "does the
   pipeline produce a sane episode for week 2".

   ---- WHY A CLI AT ALL ----

   The route is a shared function slot behind a rewrite and an auth check, so
   reaching it by hand means minting a CRON_SECRET header against a deployed
   URL. This calls the module directly, which is what you want while testing:
   the failure you see is the pipeline's, not the transport's.
============================================================================ */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { flags: new Set(), values: {} };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) out.flags.add(body);
    else out.values[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const has = (name) => args.flags.has(name);
const value = (name) => (Object.prototype.hasOwnProperty.call(args.values, name) ? args.values[name] : null);

if (has('help') || has('h')) {
  console.log(`
FSN weekly podcast generator

  node scripts/generate-podcast.mjs [options]

  --week=<n>         The week to generate. Falls back to PODCAST_TARGET_WEEK,
                     which itself defaults to 2 (the testing boundary).
  --season=<year>    Defaults to the pipeline's CURRENT_SEASON.
  --league=<id>      Generate for this league only, skipping the sweep.
  --payload=<file>   OFFLINE: build the script from this ESPN league payload.
                     No network, no synthesis, no database, no spend.
  --out=<file>       Write the built episode to this JSON file.
  --format=<f>       'news' (default) reads the local blog_articles payload and
                     makes no external call; 'segments' is the four-segment long
                     form and still reads ESPN.
  --dry-run          LIVE: resolve leagues and idempotency, write nothing.
  --script-only      LIVE: store the four segments, synthesize no audio.
  --preflight        Report whether a live run can proceed, then stop.
  --max=<n>          Override PODCAST_CRON_MAX_LEAGUES for this run.
  --quiet            Suppress the spoken-script dump.

Examples
  PODCAST_TARGET_WEEK=2 npm run generate:podcast -- --preflight
  node scripts/generate-podcast.mjs --week=2 --payload=/tmp/league.json
  node scripts/generate-podcast.mjs --week=2 --dry-run
`.trim());
  process.exit(0);
}

/* ---- THE WEEK ----
   An explicit --week wins; otherwise PODCAST_TARGET_WEEK. Whatever is chosen is
   also exported into the environment, because runWeeklyPodcastCron reads
   PODCAST_TARGET_WEEK to enforce the pin and would refuse a week the flag asked
   for.

   Neither given is an error rather than a default. The scheduled run resolves
   the week that just ended from the NFL scoreboard, but this CLI also runs
   offline against a payload file, where a network resolve would be wrong and a
   guessed week would generate the wrong episode for every league in the
   sweep. */
const cron = require(join(root, 'lib/dist/generate-weekly-podcast.js'));
const scriptLib = require(join(root, 'lib/dist/podcast-script.js'));
const fsnIndex = require(join(root, 'lib/dist/fsn-index.js'));
const math = require(join(root, 'lib/dist/article-math.js'));
const generator = require(join(root, 'lib/dist/article-generator.js'));
const podcast = require(join(root, 'lib/dist/generate-podcast.js'));

const weekArg = value('week');
const weekRaw = weekArg != null ? weekArg : String(process.env.PODCAST_TARGET_WEEK || '').trim();
if (!weekRaw || /^(any|all|\*)$/i.test(weekRaw)) {
  console.error(
    '[generate-podcast] no week to generate. Pass --week=<n>, or set PODCAST_TARGET_WEEK to a week ' +
      'number. Unset (or "any") means "whatever week just ended", which only the scheduled HTTP run ' +
      'resolves — this CLI does not guess one.',
  );
  process.exit(2);
}
const week = Number.parseInt(weekRaw, 10);
if (!Number.isInteger(week) || week < 1 || week > 18) {
  console.error('[generate-podcast] --week must be a whole number between 1 and 18; got ' + String(weekRaw));
  process.exit(2);
}
process.env.PODCAST_TARGET_WEEK = String(week);

const season = Number.parseInt(value('season') || String(podcast.CURRENT_SEASON), 10);
if (value('max')) process.env.PODCAST_CRON_MAX_LEAGUES = String(value('max'));

console.log('[generate-podcast] week ' + week + ', season ' + season +
  ' (pinned PODCAST_TARGET_WEEK=' + process.env.PODCAST_TARGET_WEEK + ')');

/* ------------------------------------------------------------------ *
 * Preflight
 * ------------------------------------------------------------------ */

/** Every prerequisite for a live run, reported together.
 *
 *  All of them at once, on purpose: failing on the first missing variable sends
 *  you round the loop once per credential, and the useful answer to "why can I
 *  not run this" is the whole list. */
function preflight() {
  const checks = [
    { name: 'SUPABASE_URL', ok: !!process.env.SUPABASE_URL,
      why: 'the league sweep and the podcast_episodes write both go through it' },
    { name: 'SUPABASE_SERVICE_ROLE_KEY', ok: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      why: 'podcast_episodes and the storage bucket are service-role only' },
    { name: 'ELEVENLABS_API_KEY', ok: !!process.env.ELEVENLABS_API_KEY,
      why: 'one call per dialogue turn; --script-only runs without it' },
    { name: 'lib/dist build', ok: existsSync(join(root, 'lib/dist/generate-weekly-podcast.js')),
      why: 'run `npm run build:podcast`' },
  ];
  let ready = true;
  for (const check of checks) {
    console.log('  ' + (check.ok ? 'ok   ' : 'MISS ') + check.name + (check.ok ? '' : ' — ' + check.why));
    if (!check.ok) ready = false;
  }
  return ready;
}

/* ------------------------------------------------------------------ *
 * Offline: the four segments from a payload on disk
 * ------------------------------------------------------------------ */

function runOffline(payloadPath) {
  const file = resolve(payloadPath);
  if (!existsSync(file)) {
    console.error('[generate-podcast] no payload at ' + file);
    process.exit(2);
  }
  let payload;
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error('[generate-podcast] ' + file + ' is not readable JSON', err);
    process.exit(2);
  }

  console.log('[generate-podcast] OFFLINE — no network, no synthesis, no database, no spend');

  const tracked = math.calculatePlayerOutcomeFlags(payload, { week, kickoffs: null });
  if (!tracked.length) {
    console.error(
      '[generate-podcast] the payload yielded no tracked starters for week ' + week + '. Either it ' +
      'carries no matchupPeriodId ' + week + ', or its sides carry no starters/roster entries.',
    );
    process.exit(1);
  }

  const index = fsnIndex.computeFsnIndex(payload, week);
  const previousIndex = week > 1 ? fsnIndex.computeFsnIndex(payload, week - 1) : [];
  const matchups = generator.orderPreviewMatchups(generator.previewMatchups(tracked, null));

  const episode = scriptLib.buildWeeklyPodcastScript({
    season,
    week,
    index,
    previousIndex,
    tracked,
    matchups,
    leagueName: String((payload.settings && payload.settings.name) || '').trim(),
  });

  console.log('');
  console.log('  starters evaluated   ' + tracked.length);
  console.log('  index board          ' + index.length + ' teams (week ' + week + '), ' +
    previousIndex.length + ' teams (week ' + (week - 1) + ')');
  console.log('  matchups             ' + matchups.length);
  console.log('  segments populated   ' + episode.populatedSegments + ' of 4');
  console.log('  dialogue turns       ' + episode.lines.length +
    ' (endpoint accepts up to ' + podcast.MAX_EPISODE_LINES + ')');
  console.log('');

  for (const segment of episode.segments) {
    console.log('  ' + (segment.populated ? '●' : '○') + ' ' + segment.title +
      (segment.populated ? '' : '  (empty state)'));
    console.log('      ' + segment.headline);
  }

  if (!has('quiet')) {
    console.log('\n  ---- the episode, as Dan and Stu would read it ----\n');
    episode.lines.forEach((line, i) => {
      console.log('  [' + String(i + 1).padStart(2) + '] ' + line.host + ' (' + line.text.length + ' chars)');
      console.log('       ' + line.text + '\n');
    });
  }

  /* The endpoint's own validation, applied here so an episode that would be
     refused as a POST is refused at the point it was built. */
  const problems = [];
  if (episode.lines.length < 2) problems.push('fewer than 2 dialogue turns');
  if (episode.lines.length > podcast.MAX_EPISODE_LINES) {
    problems.push(episode.lines.length + ' turns exceeds MAX_EPISODE_LINES (' + podcast.MAX_EPISODE_LINES + ')');
  }
  episode.lines.forEach((line, i) => {
    if (!podcast.podcastHost(line.host)) problems.push('turn ' + (i + 1) + ' has an unknown host ' + line.host);
    if (line.text.length < 5) problems.push('turn ' + (i + 1) + ' is shorter than 5 characters');
    if (line.text.length > 450) problems.push('turn ' + (i + 1) + ' is ' + line.text.length + ' characters, over 450');
  });
  if (problems.length) {
    console.error('[generate-podcast] this episode would be REFUSED by /api/generate-podcast:');
    for (const problem of problems) console.error('    - ' + problem);
    process.exit(1);
  }
  console.log('  ✓ every turn passes the endpoint’s validation (host, length, count)');

  if (value('out')) writeEpisode(episode);
  return episode;
}

function writeEpisode(episode) {
  const out = resolve(value('out'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(episode, null, 2));
  console.log('  wrote ' + out);
}

/* ------------------------------------------------------------------ *
 * Live
 * ------------------------------------------------------------------ */

async function runLive() {
  console.log('[generate-podcast] preflight:');
  const ready = preflight();
  const scriptOnly = has('script-only');
  const dryRun = has('dry-run');

  if (has('preflight')) process.exit(ready ? 0 : 1);

  /* --script-only needs no voice provider, so a missing ElevenLabs key is not
     fatal for it; everything else is. */
  const blocking = [
    !process.env.SUPABASE_URL && 'SUPABASE_URL',
    !process.env.SUPABASE_SERVICE_ROLE_KEY && 'SUPABASE_SERVICE_ROLE_KEY',
    !scriptOnly && !dryRun && !process.env.ELEVENLABS_API_KEY && 'ELEVENLABS_API_KEY',
  ].filter(Boolean);

  if (blocking.length) {
    console.error(
      '\n[generate-podcast] cannot run live: ' + blocking.join(', ') + ' not set.\n' +
      '  Options:\n' +
      '    --payload=<file>   build the four segments offline from a league payload\n' +
      '    --script-only      skip ElevenLabs (still needs Supabase)\n' +
      '    --dry-run          resolve leagues and idempotency only\n',
    );
    process.exit(1);
  }

  if (!dryRun && !scriptOnly) {
    console.log('[generate-podcast] LIVE — this will call ElevenLabs and write to Supabase.');
  }

  /* --league is a spend bound, not a convenience: the unfiltered sweep bills one
     ElevenLabs call per dialogue turn for every active league that has no row
     for this week. It travels as a run INPUT — the run validates it against the
     active leagues and reports it in the summary. It used to be passed as a
     `listLeagues` dependency the run did not read, so it was silently ignored
     and a live `--league` run swept everything. */
  const league = value('league');
  const summary = await cron.runWeeklyPodcastCron(
    {
      season,
      week,
      league: league || null,
      dry_run: dryRun,
      script_only: scriptOnly,
      format: value('format') === 'segments' ? 'segments' : 'news',
      run_id: `cli-${season}-w${week}-${new Date().toISOString().slice(0, 10)}`,
    },
    {},
  );

  console.log('\n[generate-podcast] ' + JSON.stringify(summary, null, 2));
  if (summary.failed > 0) {
    console.error('[generate-podcast] ' + summary.failed + ' league(s) failed. See podcast_episode_runs.');
    process.exit(1);
  }
  console.log('[generate-podcast] created ' + summary.created + ', skipped ' + summary.skipped +
    ', deferred ' + summary.not_attempted);
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

const payload = value('payload');
if (payload) {
  runOffline(payload);
  console.log('\n[generate-podcast] offline run complete for week ' + week);
} else {
  await runLive();
}
