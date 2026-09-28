/**
 * SCHEDULED WEEKLY PODCAST — the Tuesday run.
 *
 * Public path: `POST /api/cron/generate-weekly-podcast`
 *
 * ---- WHY THIS IS A lib/ MODULE AND NOT api/cron/generate-weekly-podcast.ts ----
 *
 * Vercel turns every file under `api/` into its own Serverless Function and the
 * plan this project deploys on allows twelve. There are already exactly twelve.
 * A thirteenth file does NOT fail the build — it fails the DEPLOY, at
 * patchBuild, with `exceeded_serverless_functions_per_deployment`, taking
 * production down rather than just the new route. That has happened to this repo
 * once already; see the header of `scripts/vercel-functions-check.mjs`.
 *
 * So the handler lives here and `vercel.json` rewrites the requested public
 * path into the existing cron function slot, exactly as
 * `/api/generate-podcast`, `/api/notifications-register`,
 * `/api/transaction-wire-dispatch`, `/api/auth/yahoo/callback` and
 * `/api/blog/articles/publish` already do. The URL the scheduler calls is the
 * one that was asked for.
 *
 * ---- WHAT ONE RUN DOES ----
 *
 *   1. Refuses any caller without `CRON_SECRET`.
 *   2. Refuses any week other than `PODCAST_TARGET_WEEK` (default 2) before
 *      spending anything. See the testing boundary below.
 *   3. Sweeps `public.leagues` for the season's active leagues.
 *   4. Skips every league that already holds a `podcast_episodes` row for the
 *      week, so a retry or a double fire costs nothing and no member ever has
 *      an episode change under them.
 *   5. For each remaining league, up to the per-run cap: one ESPN read, the
 *      four-segment script, ElevenLabs synthesis, an MP3 into Supabase
 *      Storage, and a `podcast_episodes` row.
 *   6. Writes one `podcast_episode_runs` ledger row per league attempt,
 *      whether it succeeded or not.
 *
 * One league's failure never stops the others — the same contract
 * `lib/article-cron.ts` holds.
 *
 * ---- THE TESTING BOUNDARY ----
 *
 * `PODCAST_TARGET_WEEK` defaults to 2 and the run refuses anything else. The
 * check is the FIRST thing that happens after auth, before the league sweep,
 * before any ESPN read and long before ElevenLabs, so a misfire on the wrong
 * week cannot spend a cent. Widen it by setting the variable in the Vercel
 * project; `PODCAST_TARGET_WEEK=any` lifts the lock entirely.
 *
 * ---- THE SPEND CEILING ----
 *
 * `docs/PODCAST_STUDIO.md` warns not to automate paid audio without a ledger,
 * and this is the route that automates it. Two guards, both deliberate:
 * `PODCAST_CRON_MAX_LEAGUES` bounds how many leagues one invocation can
 * synthesize for, and every attempt lands in `podcast_episode_runs` with its
 * turn count and byte size so the bill is attributable after the fact. Leagues
 * over the cap are not lost: the next run finds no episode for them.
 */

import {
  CURRENT_SEASON,
  generateHostAudio,
  podcastHost,
  podcastVoiceIds,
} from './generate-podcast';
import { buildPodcastAudio } from './build-podcast-audio';
import { calculatePlayerOutcomeFlags, type TrackedPlayer } from './article-math';
import { orderPreviewMatchups, previewMatchups } from './article-generator';
import { computeFsnIndex } from './fsn-index';
import { buildWeeklyPodcastScript, type WeeklyPodcastScript } from './podcast-script';
import { buildNewsPodcastScript, readNewsPayload, type NewsPayload } from './podcast-news-script';
/* Re-exported so the cron module stays the one import site for callers that
   already reach for it here. The read itself lives beside the generator that
   consumes it, because the interactive endpoint needs the same pair. */
export { readNewsPayload };
import { authorizedByCronSecret, cronSecretConfigured, activeLeagueIds } from './article-cron';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type PodcastRunStatus = 'created' | 'skipped' | 'failed';

export type PodcastFailureReason =
  | 'ESPN_AUTH'
  | 'NO_MATCHUP_DATA'
  | 'EMPTY_SCRIPT'
  | 'TTS'
  | 'STORAGE'
  | 'TIMEOUT'
  | 'OTHER';

export interface PodcastLeagueResult {
  league_id: string;
  status: PodcastRunStatus;
  week: number;
  season: number;
  /** Segments that carried real material, 0–4. Null when nothing was built. */
  populated_segments: number | null;
  /** Synthesized dialogue turns. Null when no audio was made. */
  turns: number | null;
  audio_bytes: number | null;
  error_message: string | null;
  failure_reason?: PodcastFailureReason | null;
}

export interface PodcastRunSummary {
  season: number;
  week: number;
  run_id: string;
  target_week: string;
  leagues: number;
  /** The single league this run was narrowed to, or null for the full sweep. */
  league: string | null;
  created: number;
  skipped: number;
  failed: number;
  /** Leagues the cap or the time budget kept this run from reaching. The next
   *  run finds no episode for them and picks them up. */
  not_attempted: number;
  failed_by_reason: Partial<Record<PodcastFailureReason, number>>;
  max_leagues: number;
  dry_run: boolean;
  audio: boolean;
  format: PodcastScriptFormat;
  results: PodcastLeagueResult[];
}

/** Which script the run builds.
 *
 *   'news'     the ~60s recap from the local blog_articles payload. Makes NO
 *              external call: the box score was read once by the article cron
 *              hours earlier and its evaluated stat lines are already stored.
 *   'segments' the four-segment long form. Still reads ESPN, because the FSN
 *              Index board and the preview matchups need the raw payload.
 *
 * 'news' is the default. It is shorter (four provider calls, not eight), it
 * reads a performance in context rather than reciting a total, and its
 * scaffolding varies week to week — the three things the long form did not. */
export type PodcastScriptFormat = 'news' | 'segments';

export interface PodcastRunInput {
  season?: number | null;
  week?: number | null;
  format?: PodcastScriptFormat;
  /** Resolve the leagues and the idempotency check, then stop. Nothing is
   *  fetched, synthesized, uploaded or written. */
  dry_run?: boolean;
  /** Build and store the script with no audio. Costs nothing at ElevenLabs and
   *  still gives every member the four segments to read. */
  script_only?: boolean;
  run_id?: string;
  budget_ms?: number;
  /**
   * Narrow the run to ONE league id, instead of every active league.
   *
   * Absent — the default, and what the Tuesday schedule uses — every active
   * league is swept exactly as before. This changes nothing for that run.
   *
   * Present, it is a spend bound rather than a convenience. Re-generating one
   * league's episode through the unfiltered sweep also generates one for every
   * other active league that happens to have no row for that week yet, at one
   * ElevenLabs call per dialogue turn each, and publishes episodes to leagues
   * whose members never asked for one. A regeneration is a single-league
   * operation, so it gets a single-league switch.
   *
   * A league that is not active for the season is reported as such; it is not
   * silently an empty run, because "nothing happened" and "you named a league
   * this season does not have" need different answers.
   */
  league?: string | null;
}

export interface PodcastRunDependencies {
  db?: any;
  req?: any;
  /** Which script to build. Defaults to 'news'. */
  format?: PodcastScriptFormat;
  /** The season's active leagues. Defaults to `activeLeagueIds(db, season)`.
   *  Swapped in tests, and honoured rather than ignored so a caller that hands
   *  over a league list gets that list — scripts/generate-podcast.mjs passed one
   *  and it was silently dropped, which meant `--league` on a live CLI run swept
   *  every league and billed for all of them. */
  listLeagues?: (db: any, season: number) => Promise<string[]>;
  /** Swapped in tests so the local payload can be supplied without a database. */
  readNewsPayload?: (leagueId: string, season: number, week: number) => Promise<NewsPayload | null>;
  /** Swapped in tests. Production reads ESPN through `api/espn`. */
  fetchBoxScores?: (input: { league_id: string; season: number; week: number; req?: any }) => Promise<any>;
  fetchKickoffs?: (input: { season: number; week: number }) => Promise<any>;
  /** Swapped in tests so no ElevenLabs credit is spent. */
  synthesize?: (text: string, voiceId: string) => Promise<Buffer>;
  now?: () => number;
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export const DEFAULT_TARGET_WEEK = 2;
export const DEFAULT_MAX_LEAGUES = 5;
const BUCKET = 'podcast-episodes';
/** A league whose week produced fewer than this many real segments is not
 *  worth synthesizing: an episode of four "nothing to report" rooms costs the
 *  same as a real one. */
export const MIN_POPULATED_SEGMENTS = 1;

const fail = (message: string, status = 400): Error => Object.assign(new Error(message), { status });

/**
 * The week this environment is allowed to generate, or `'any'`.
 *
 * Returns the raw configured string alongside the number so the summary can
 * report what the boundary actually was rather than what the default is.
 */
export function targetWeekSetting(): { value: string; week: number | null } {
  const raw = String(process.env.PODCAST_TARGET_WEEK || '').trim();
  if (!raw) return { value: String(DEFAULT_TARGET_WEEK), week: DEFAULT_TARGET_WEEK };
  if (/^(any|all|\*)$/i.test(raw)) return { value: 'any', week: null };
  const week = Number.parseInt(raw, 10);
  if (!Number.isInteger(week) || week < 1 || week > 18) {
    console.error(
      '[PodcastCron] PODCAST_TARGET_WEEK is set to "' + raw + '", which is not a week or "any". ' +
        'Falling back to the week ' + DEFAULT_TARGET_WEEK + ' testing boundary rather than generating for an ' +
        'unintended week.',
      new Error('INVALID_PODCAST_TARGET_WEEK'),
    );
    return { value: String(DEFAULT_TARGET_WEEK), week: DEFAULT_TARGET_WEEK };
  }
  return { value: String(week), week };
}

export function maxLeaguesPerRun(): number {
  const raw = String(process.env.PODCAST_CRON_MAX_LEAGUES || '').trim();
  if (!raw) return DEFAULT_MAX_LEAGUES;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    console.warn(
      '[PodcastCron] PODCAST_CRON_MAX_LEAGUES is set to "' + raw + '", which is not a positive ' +
        'whole number; using the default of ' + DEFAULT_MAX_LEAGUES + '.',
    );
    return DEFAULT_MAX_LEAGUES;
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export function podcastDatabase(): any {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw fail('Podcast storage is not configured', 503);
  }
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * The leagues that already hold an episode for this week.
 *
 * One query for the whole run. A row in ANY status counts: a `generating` claim
 * belongs to an invocation that may still be running and a `failed` one needs a
 * human, and starting a second synthesis over either is how a league gets
 * billed twice for one episode.
 */
export async function leaguesAlreadyRecorded(
  db: any,
  season: number,
  week: number,
): Promise<Set<string>> {
  const result = await db
    .from('podcast_episodes')
    .select('league_id')
    .eq('season', season)
    .eq('week', week);
  if (result.error) throw result.error;
  const seen = new Set<string>();
  for (const row of result.data || []) {
    const id = row && row.league_id == null ? '' : String(row.league_id).trim();
    if (id) seen.add(id);
  }
  return seen;
}

/** The ESPN read, through the same boundary the article pipeline uses: a direct
 *  call into `api/espn`, no HTTP round trip, so the league's stored cookies and
 *  share token are applied exactly as they are for a browser read.
 *
 *  `view=mMatchupScore` returns the WHOLE season schedule, not just the
 *  requested period, which is what lets one read serve both the week's box
 *  score and the FSN Index boards for this week and last. */
async function defaultFetchBoxScores(input: {
  league_id: string;
  season: number;
  week: number;
  req?: any;
}): Promise<any> {
  /* Two levels up, not one: this is a runtime require, so Node resolves it
     relative to the EMITTED file in lib/dist, not to this source file. The
     same footgun is documented at length in lib/article-generator.ts. */
  const espn = require('../../api/espn');
  const url =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${input.season}` +
    `/segments/0/leagues/${input.league_id}?scoringPeriodId=${input.week}` +
    '&view=mMatchupScore&view=mBoxscore&view=mRoster&view=mTeam';

  let status = 200;
  let body: any;
  const response = {
    setHeader() {},
    status(value: number) { status = value; return this; },
    json(value: any) { body = value; return this; },
    send(value: any) { body = value; return this; },
    end() { return this; },
  };
  await espn(
    { method: 'GET', headers: (input.req && input.req.headers) || {}, query: { url }, url: '/api/espn' },
    response,
  );
  if (status < 200 || status >= 300 || !body || typeof body !== 'object') {
    throw fail(
      'ESPN box score read failed (HTTP ' + status + ')',
      [400, 401, 403, 404, 429].includes(status) ? status : 502,
    );
  }
  return body;
}

async function defaultFetchKickoffs(input: { season: number; week: number }): Promise<any> {
  const scheduleFeed = require('../notifications/schedule-feed');
  return scheduleFeed.pullKickoffs({ season: input.season, week: input.week });
}

async function defaultSynthesize(text: string, voiceId: string): Promise<Buffer> {
  const stream = await generateHostAudio(text, voiceId);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as any) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ *
 * Failure classification
 * ------------------------------------------------------------------ */

export function classifyPodcastFailure(err: any): PodcastFailureReason {
  const status = Number(err && err.status);
  const message = String((err && err.message) || '');
  if (status === 401 || status === 403 || /cookie|unauthor|forbidden/i.test(message)) return 'ESPN_AUTH';
  if (/no matchups|NO_MATCHUP|empty box score/i.test(message)) return 'NO_MATCHUP_DATA';
  if (/abort|timeout|timed out/i.test(message)) return 'TIMEOUT';
  if (/elevenlabs|voice|synthes|mp3/i.test(message)) return 'TTS';
  if (/storage|upload|bucket/i.test(message)) return 'STORAGE';
  return 'OTHER';
}

/* ------------------------------------------------------------------ *
 * One league
 * ------------------------------------------------------------------ */

export interface LeagueEpisodeOutcome {
  script: WeeklyPodcastScript;
  audio: Buffer | null;
  turns: number;
  markers: number[];
}

/**
 * Build one league's episode: the script, and the stitched audio when audio is
 * asked for.
 *
 * Throws on anything that should stop THIS league. The caller catches, logs the
 * reason and moves to the next one.
 */
export async function buildLeagueEpisode(
  input: { league_id: string; season: number; week: number },
  options: { script_only?: boolean } & PodcastRunDependencies,
): Promise<LeagueEpisodeOutcome> {
  const label = `${input.league_id}/${input.season}/w${input.week}`;
  const format: PodcastScriptFormat = options.format === 'segments' ? 'segments' : 'news';

  /* ---- 'news': the local payload, and NOT ONE EXTERNAL CALL ----
     Returns before the ESPN read below. The stat lines come from the
     blog_articles row the article cron already wrote for this league-week, so
     the podcast cannot disagree with the article the league is reading, and a
     Tuesday run costs no box-score request at all. */
  if (format === 'news') {
    const news = options.readNewsPayload
      ? await options.readNewsPayload(input.league_id, input.season, input.week)
      : await readNewsPayload(options.db, input.league_id, input.season, input.week);
    if (!news) {
      throw fail('No news payload in blog_articles for ' + label +
        '; the article for this league-week has not published yet', 422);
    }
    const built = buildNewsPodcastScript(news);
    const script: WeeklyPodcastScript = {
      title: built.title,
      week: built.week,
      season: built.season,
      lines: built.lines,
      stories: built.stories,
      /* The news format has movements, not the four named segments. It reports
         one populated segment per narrated performance so the run summary's
         populated_segments stays meaningful across both formats. */
      segments: built.movements.map((m) => ({
        key: m.key as any,
        title: m.key,
        headline: m.key + ': ' + m.words + ' words',
        populated: m.words > 0,
      })),
      populatedSegments: Math.min(4, built.performances),
    } as WeeklyPodcastScript;
    console.info('[PodcastCron] ' + label + ' news script: ' + built.words + ' words, ' +
      built.characters + ' chars, ~' + built.estimatedSeconds + 's, ' +
      built.performances + ' performance(s), ' + built.lines.length + ' turns.');
    if (script.populatedSegments < MIN_POPULATED_SEGMENTS) {
      throw fail('The news payload for ' + label + ' narrated nothing; refusing to synthesize', 422);
    }
    return finishEpisode(script, label, options);
  }

  const fetchBoxScores = options.fetchBoxScores || defaultFetchBoxScores;
  const payload = await fetchBoxScores({ ...input, req: options.req });

  /* The kickoff index is what lets the math place a starter's points in time.
     A failure degrades the episode to unresolved margins — the same trade the
     article pipeline makes — rather than losing the league its episode. */
  let kickoffs: any = {};
  try {
    kickoffs = (await (options.fetchKickoffs || defaultFetchKickoffs)({
      season: input.season,
      week: input.week,
    })) || {};
  } catch (err) {
    console.warn(
      '[PodcastCron] kickoff times unavailable for ' + label +
        '; margins and the matchup segment fall back to unresolved.',
      err,
    );
  }

  const tracked: TrackedPlayer[] = calculatePlayerOutcomeFlags(payload, {
    week: input.week,
    kickoffs,
  });
  if (!tracked.length) throw fail('No matchup data for ' + label, 422);

  /* One payload, two boards: mMatchupScore carries the whole season schedule,
     so last week's index costs no extra request. */
  const index = computeFsnIndex(payload, input.week);
  const previousIndex = input.week > 1 ? computeFsnIndex(payload, input.week - 1) : [];

  const matchups = orderPreviewMatchups(previewMatchups(tracked, null));

  const leagueName = String(
    (payload && payload.settings && payload.settings.name) || '',
  ).trim();

  const script = buildWeeklyPodcastScript({
    season: input.season,
    week: input.week,
    index,
    previousIndex,
    tracked,
    matchups,
    leagueName,
  });

  if (script.populatedSegments < MIN_POPULATED_SEGMENTS) {
    throw fail(
      'Every segment for ' + label + ' came back empty; refusing to synthesize an empty episode',
      422,
    );
  }

  return finishEpisode(script, label, options);
}

/**
 * Synthesis and stitching, shared by both script formats.
 *
 * Extracted when the news format arrived: the two formats differ only in how
 * the script is built, and a second copy of the turn loop would be a second
 * place for the marker arithmetic to drift.
 */
async function finishEpisode(
  script: WeeklyPodcastScript,
  label: string,
  options: { script_only?: boolean } & PodcastRunDependencies,
): Promise<LeagueEpisodeOutcome> {
  if (options.script_only) {
    return { script, audio: null, turns: 0, markers: [] };
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    throw fail('ELEVENLABS_API_KEY is not configured', 503);
  }

  const synthesize = options.synthesize || defaultSynthesize;
  const voices = podcastVoiceIds();
  const segments: Buffer[] = [];
  for (const line of script.lines) {
    const host = podcastHost(line.host);
    if (!host) {
      console.warn('[PodcastCron] skipping a line with an unknown host tag for ' + label, line.host);
      continue;
    }
    segments.push(await synthesize(line.text, voices[host]));
  }
  if (!segments.length) throw fail('No dialogue turns were synthesized for ' + label, 502);

  const { audio, markers } = buildPodcastAudio(segments);

  return {
    script,
    audio,
    turns: segments.length,
    markers,
  };
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

/** One ledger row per league attempt. A failure to write the ledger must never
 *  fail the league whose episode already succeeded, so this logs and returns. */
async function recordRun(db: any, runId: string, result: PodcastLeagueResult): Promise<void> {
  try {
    const write = await db.from('podcast_episode_runs').insert({
      run_id: runId,
      league_id: result.league_id,
      season: result.season,
      week: result.week,
      status: result.status,
      turns: result.turns,
      audio_bytes: result.audio_bytes,
      populated_segments: result.populated_segments,
      failure_reason: result.failure_reason || null,
      error_message: result.error_message,
    });
    if (write.error) throw write.error;
  } catch (err) {
    console.error(
      '[PodcastCron] could not write the usage ledger row for ' + result.league_id +
        ' (run ' + runId + '). The episode itself is unaffected; run supabase/podcast_episode_runs.sql ' +
        'if this table does not exist yet.',
      err,
    );
  }
}

export async function runWeeklyPodcastCron(
  input: PodcastRunInput,
  dependencies: PodcastRunDependencies = {},
): Promise<PodcastRunSummary> {
  const db = dependencies.db || podcastDatabase();
  const now = dependencies.now || (() => Date.now());
  const started = now();

  const season = Number.isInteger(input.season as number) ? (input.season as number) : CURRENT_SEASON;
  const boundary = targetWeekSetting();
  const requestedWeek = Number.isInteger(input.week as number) ? (input.week as number) : boundary.week;

  if (!Number.isInteger(requestedWeek as number) || (requestedWeek as number) < 1) {
    throw fail('No week to generate for: pass ?week= or set PODCAST_TARGET_WEEK', 400);
  }
  const week = requestedWeek as number;

  /* ---- THE TESTING BOUNDARY ----
     Before the league sweep, before any ESPN read, and a long way before
     ElevenLabs. A wrong-week misfire costs nothing and says why. */
  if (boundary.week != null && week !== boundary.week) {
    console.warn(
      '[PodcastCron] refusing week ' + week + ': this environment is locked to week ' +
        boundary.week + ' for testing (PODCAST_TARGET_WEEK). No provider or storage call was made.',
    );
    throw fail(
      'Podcast generation is locked to week ' + boundary.week +
        ' while testing. Set PODCAST_TARGET_WEEK to change the boundary, or "any" to lift it.',
      409,
    );
  }

  /* An archived season is refused by lib/generate-podcast.ts too, but a
     scheduled run must not reach ESPN or the storage claim to find that out. */
  if (season < CURRENT_SEASON) {
    throw fail('Audio recaps are only available for the current season.', 400);
  }

  const runId = String(input.run_id || `${season}-w${week}-podcast`);
  const maxLeagues = maxLeaguesPerRun();
  const dryRun = !!input.dry_run;
  const scriptOnly = !!input.script_only;
  const format: PodcastScriptFormat = input.format === 'segments' ? 'segments' : 'news';

  const requestedLeague = String(input.league == null ? '' : input.league).trim();
  if (requestedLeague && !/^\d{1,20}$/.test(requestedLeague)) {
    throw fail('league must be a numeric ESPN league id', 400);
  }

  const allLeagueIds = await (dependencies.listLeagues
    ? dependencies.listLeagues(db, season)
    : activeLeagueIds(db, season));
  if (requestedLeague && !allLeagueIds.includes(requestedLeague)) {
    throw fail(
      'League ' + requestedLeague + ' is not an active league for ' + season +
        ', so there is nothing to generate for it.',
      404,
    );
  }
  /* The filter is applied to the league list itself, so every count in the
     summary — leagues, skipped, not_attempted — describes the scoped run and
     not the league table. */
  const leagueIds = requestedLeague ? [requestedLeague] : allLeagueIds;
  const already = await leaguesAlreadyRecorded(db, season, week);
  const pending = leagueIds.filter((id) => !already.has(id));

  const summary: PodcastRunSummary = {
    season,
    week,
    run_id: runId,
    target_week: boundary.value,
    leagues: leagueIds.length,
    league: requestedLeague || null,
    created: 0,
    skipped: leagueIds.length - pending.length,
    failed: 0,
    not_attempted: 0,
    failed_by_reason: {},
    max_leagues: maxLeagues,
    dry_run: dryRun,
    audio: !scriptOnly,
    format,
    results: [],
  };

  for (const id of already) {
    if (!leagueIds.includes(id)) continue;
    summary.results.push({
      league_id: id,
      status: 'skipped',
      week,
      season,
      populated_segments: null,
      turns: null,
      audio_bytes: null,
      error_message: null,
    });
  }

  if (dryRun) {
    summary.not_attempted = Math.max(0, pending.length - maxLeagues);
    return summary;
  }

  const attempt = pending.slice(0, maxLeagues);
  summary.not_attempted = pending.length - attempt.length;

  for (const leagueId of attempt) {
    /* A serverless invocation is killed at its maxDuration with no chance to
       respond. Stop starting leagues before that so the summary and the ledger
       rows for the leagues that DID run survive. */
    if (input.budget_ms && now() - started > input.budget_ms) {
      summary.not_attempted += 1;
      continue;
    }

    const result: PodcastLeagueResult = {
      league_id: leagueId,
      status: 'failed',
      week,
      season,
      populated_segments: null,
      turns: null,
      audio_bytes: null,
      error_message: null,
    };

    try {
      /* The primary key is the cross-instance mutex, exactly as it is on the
         interactive path: an insert loser never reaches ElevenLabs. */
      const claim = await db.from('podcast_episodes').insert({
        league_id: leagueId,
        season,
        week,
        status: 'generating',
      });
      if (claim.error) {
        if (String(claim.error.code || '') !== '23505') throw claim.error;
        console.warn(
          '[PodcastCron] league ' + leagueId + ' week ' + week +
            ' was claimed by another invocation between the sweep and the claim; skipping.',
        );
        result.status = 'skipped';
        summary.skipped += 1;
        summary.results.push(result);
        continue;
      }

      /* `db` explicitly, NOT just `...dependencies`. The run resolves its own
         client when the caller supplies none — which is exactly what the HTTP
         handler does, passing only `{ req }` — so `dependencies.db` is
         undefined in production while the local `db` holds the real client.
         Spreading dependencies alone handed buildLeagueEpisode an undefined db,
         and the news path's payload read died on `db.from` with "Cannot read
         properties of undefined". Every test passed a db, so nothing caught it
         until a live run. */
      const outcome = await buildLeagueEpisode(
        { league_id: leagueId, season, week },
        { ...dependencies, db, script_only: scriptOnly, format },
      );
      result.populated_segments = outcome.script.populatedSegments;
      result.turns = outcome.turns;

      let audioUrl: string | null = null;
      if (outcome.audio) {
        const path = `${leagueId}/${season}/${week}.mp3`;
        const uploaded = await db.storage
          .from(BUCKET)
          .upload(path, outcome.audio, { contentType: 'audio/mpeg', upsert: true });
        if (uploaded.error) throw uploaded.error;
        audioUrl = db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
        result.audio_bytes = outcome.audio.length;
      }

      const episode = {
        title: outcome.script.title,
        lines: outcome.script.lines,
        stories: outcome.script.stories,
        visuals: [],
        segments: outcome.script.segments.map((s) => ({
          key: s.key,
          title: s.title,
          headline: s.headline,
          populated: s.populated,
        })),
        markers: outcome.markers,
        week,
        year: season,
        leagueId: leagueId,
        createdAt: started,
      };

      /* A script-only run leaves the row `generating`: the schema's own check
         constraint requires an audio_url before a row may be `ready`, and
         calling a silent episode ready would be a lie to every client polling
         for one. The interactive Studio path can still finish it. */
      const ready = !!audioUrl;
      const saved = await db
        .from('podcast_episodes')
        .update({
          status: ready ? 'ready' : 'generating',
          episode,
          audio_url: audioUrl,
          updated_at: new Date(started).toISOString(),
        })
        .eq('league_id', leagueId)
        .eq('season', season)
        .eq('week', week)
        .eq('status', 'generating');
      if (saved.error) throw saved.error;

      result.status = 'created';
      summary.created += 1;
    } catch (err) {
      const reason = classifyPodcastFailure(err);
      result.status = 'failed';
      result.failure_reason = reason;
      result.error_message = String((err && (err as Error).message) || err).slice(0, 500);
      summary.failed += 1;
      summary.failed_by_reason[reason] = (summary.failed_by_reason[reason] || 0) + 1;
      console.error(
        '[PodcastCron] league ' + leagueId + ' week ' + week + ' failed (' + reason + ')',
        err,
      );

      /* Leave the claim as `failed` rather than deleting it. An ambiguous
         provider or storage failure may already have been billed, and an
         automatic retry next Tuesday would bill again. */
      try {
        const marked = await db
          .from('podcast_episodes')
          .update({ status: 'failed', updated_at: new Date(now()).toISOString() })
          .eq('league_id', leagueId)
          .eq('season', season)
          .eq('week', week)
          .eq('status', 'generating');
        if (marked.error) throw marked.error;
      } catch (markErr) {
        console.error(
          '[PodcastCron] could not mark league ' + leagueId + ' week ' + week + ' as failed; the row ' +
            'may sit in "generating" until the interactive path\'s ten-minute staleness sweep clears it.',
          markErr,
        );
      }
    }

    summary.results.push(result);
    await recordRun(db, runId, result);
  }

  return summary;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function queryParam(req: any, name: string): string {
  const value = req && req.query && req.query[name];
  if (Array.isArray(value)) return String(value[0] == null ? '' : value[0]);
  return String(value == null ? '' : value);
}

function flag(req: any, name: string): boolean {
  const value = queryParam(req, name).trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function intParam(req: any, name: string): number | null {
  const raw = queryParam(req, name).trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : NaN;
}

/**
 * `POST /api/cron/generate-weekly-podcast` (GET accepted, so a Vercel cron —
 * which can only issue GET — works unchanged).
 */
export default async function handler(req: any, res: any): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  if (!authorizedByCronSecret(req)) {
    if (!cronSecretConfigured()) {
      console.error(
        '[PodcastCron] refused: CRON_SECRET is not set in this environment, so the route cannot ' +
          'authenticate its caller and will not generate anything.',
        new Error('CRON_SECRET_MISSING'),
      );
    }
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const season = intParam(req, 'season');
  const week = intParam(req, 'week');
  if (Number.isNaN(season) || Number.isNaN(week)) {
    res.status(400).json({ error: 'BAD_SCOPE', message: 'season and week must be whole numbers' });
    return;
  }

  try {
    const summary = await runWeeklyPodcastCron(
      {
        season,
        week,
        dry_run: flag(req, 'dry_run'),
        script_only: flag(req, 'script_only'),
        /* Optional. Omitted, the run sweeps every active league exactly as the
           Tuesday schedule does; named, it touches that league and no other. */
        league: queryParam(req, 'league').trim() || null,
        /* The shared cron function slot is configured for 60s in vercel.json
           and is killed at it. Leave a margin so the summary survives. */
        budget_ms: 50000,
      },
      { req },
    );
    res.status(200).json({ ok: summary.failed === 0, ...summary });
  } catch (err: any) {
    const status = Number(err && err.status) || 500;
    /* A refused week is the configured boundary doing its job, not a fault. */
    if (status === 409) {
      console.warn('[PodcastCron] run refused by the week boundary: ' + String(err.message));
      res.status(409).json({ error: 'WEEK_LOCKED', message: String(err.message) });
      return;
    }
    console.error('[PodcastCron] the weekly podcast run could not start', err);
    res.status(status).json({ error: 'RUN_FAILED', message: String((err && err.message) || err) });
  }
}
