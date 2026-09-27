"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_POPULATED_SEGMENTS = exports.DEFAULT_MAX_LEAGUES = exports.DEFAULT_TARGET_WEEK = void 0;
exports.targetWeekSetting = targetWeekSetting;
exports.maxLeaguesPerRun = maxLeaguesPerRun;
exports.podcastDatabase = podcastDatabase;
exports.leaguesAlreadyRecorded = leaguesAlreadyRecorded;
exports.classifyPodcastFailure = classifyPodcastFailure;
exports.buildLeagueEpisode = buildLeagueEpisode;
exports.runWeeklyPodcastCron = runWeeklyPodcastCron;
exports.default = handler;
const generate_podcast_1 = require("./generate-podcast");
const article_math_1 = require("./article-math");
const article_generator_1 = require("./article-generator");
const fsn_index_1 = require("./fsn-index");
const podcast_script_1 = require("./podcast-script");
const article_cron_1 = require("./article-cron");
/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */
exports.DEFAULT_TARGET_WEEK = 2;
exports.DEFAULT_MAX_LEAGUES = 5;
const BUCKET = 'podcast-episodes';
/** A league whose week produced fewer than this many real segments is not
 *  worth synthesizing: an episode of four "nothing to report" rooms costs the
 *  same as a real one. */
exports.MIN_POPULATED_SEGMENTS = 1;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
/**
 * The week this environment is allowed to generate, or `'any'`.
 *
 * Returns the raw configured string alongside the number so the summary can
 * report what the boundary actually was rather than what the default is.
 */
function targetWeekSetting() {
    const raw = String(process.env.PODCAST_TARGET_WEEK || '').trim();
    if (!raw)
        return { value: String(exports.DEFAULT_TARGET_WEEK), week: exports.DEFAULT_TARGET_WEEK };
    if (/^(any|all|\*)$/i.test(raw))
        return { value: 'any', week: null };
    const week = Number.parseInt(raw, 10);
    if (!Number.isInteger(week) || week < 1 || week > 18) {
        console.error('[PodcastCron] PODCAST_TARGET_WEEK is set to "' + raw + '", which is not a week or "any". ' +
            'Falling back to the week ' + exports.DEFAULT_TARGET_WEEK + ' testing boundary rather than generating for an ' +
            'unintended week.', new Error('INVALID_PODCAST_TARGET_WEEK'));
        return { value: String(exports.DEFAULT_TARGET_WEEK), week: exports.DEFAULT_TARGET_WEEK };
    }
    return { value: String(week), week };
}
function maxLeaguesPerRun() {
    const raw = String(process.env.PODCAST_CRON_MAX_LEAGUES || '').trim();
    if (!raw)
        return exports.DEFAULT_MAX_LEAGUES;
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value < 1) {
        console.warn('[PodcastCron] PODCAST_CRON_MAX_LEAGUES is set to "' + raw + '", which is not a positive ' +
            'whole number; using the default of ' + exports.DEFAULT_MAX_LEAGUES + '.');
        return exports.DEFAULT_MAX_LEAGUES;
    }
    return value;
}
/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */
function podcastDatabase() {
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
async function leaguesAlreadyRecorded(db, season, week) {
    const result = await db
        .from('podcast_episodes')
        .select('league_id')
        .eq('season', season)
        .eq('week', week);
    if (result.error)
        throw result.error;
    const seen = new Set();
    for (const row of result.data || []) {
        const id = row && row.league_id == null ? '' : String(row.league_id).trim();
        if (id)
            seen.add(id);
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
async function defaultFetchBoxScores(input) {
    /* Two levels up, not one: this is a runtime require, so Node resolves it
       relative to the EMITTED file in lib/dist, not to this source file. The
       same footgun is documented at length in lib/article-generator.ts. */
    const espn = require('../../api/espn');
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${input.season}` +
        `/segments/0/leagues/${input.league_id}?scoringPeriodId=${input.week}` +
        '&view=mMatchupScore&view=mBoxscore&view=mRoster&view=mTeam';
    let status = 200;
    let body;
    const response = {
        setHeader() { },
        status(value) { status = value; return this; },
        json(value) { body = value; return this; },
        send(value) { body = value; return this; },
        end() { return this; },
    };
    await espn({ method: 'GET', headers: (input.req && input.req.headers) || {}, query: { url }, url: '/api/espn' }, response);
    if (status < 200 || status >= 300 || !body || typeof body !== 'object') {
        throw fail('ESPN box score read failed (HTTP ' + status + ')', [400, 401, 403, 404, 429].includes(status) ? status : 502);
    }
    return body;
}
async function defaultFetchKickoffs(input) {
    const scheduleFeed = require('../notifications/schedule-feed');
    return scheduleFeed.pullKickoffs({ season: input.season, week: input.week });
}
async function defaultSynthesize(text, voiceId) {
    const stream = await (0, generate_podcast_1.generateHostAudio)(text, voiceId);
    const chunks = [];
    for await (const chunk of stream)
        chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}
/* ------------------------------------------------------------------ *
 * Failure classification
 * ------------------------------------------------------------------ */
function classifyPodcastFailure(err) {
    const status = Number(err && err.status);
    const message = String((err && err.message) || '');
    if (status === 401 || status === 403 || /cookie|unauthor|forbidden/i.test(message))
        return 'ESPN_AUTH';
    if (/no matchups|NO_MATCHUP|empty box score/i.test(message))
        return 'NO_MATCHUP_DATA';
    if (/abort|timeout|timed out/i.test(message))
        return 'TIMEOUT';
    if (/elevenlabs|voice|synthes|mp3/i.test(message))
        return 'TTS';
    if (/storage|upload|bucket/i.test(message))
        return 'STORAGE';
    return 'OTHER';
}
/**
 * Build one league's episode: the script, and the stitched audio when audio is
 * asked for.
 *
 * Throws on anything that should stop THIS league. The caller catches, logs the
 * reason and moves to the next one.
 */
async function buildLeagueEpisode(input, options) {
    const label = `${input.league_id}/${input.season}/w${input.week}`;
    const fetchBoxScores = options.fetchBoxScores || defaultFetchBoxScores;
    const payload = await fetchBoxScores({ ...input, req: options.req });
    /* The kickoff index is what lets the math place a starter's points in time.
       A failure degrades the episode to unresolved margins — the same trade the
       article pipeline makes — rather than losing the league its episode. */
    let kickoffs = {};
    try {
        kickoffs = (await (options.fetchKickoffs || defaultFetchKickoffs)({
            season: input.season,
            week: input.week,
        })) || {};
    }
    catch (err) {
        console.warn('[PodcastCron] kickoff times unavailable for ' + label +
            '; margins and the matchup segment fall back to unresolved.', err);
    }
    const tracked = (0, article_math_1.calculatePlayerOutcomeFlags)(payload, {
        week: input.week,
        kickoffs,
    });
    if (!tracked.length)
        throw fail('No matchup data for ' + label, 422);
    /* One payload, two boards: mMatchupScore carries the whole season schedule,
       so last week's index costs no extra request. */
    const index = (0, fsn_index_1.computeFsnIndex)(payload, input.week);
    const previousIndex = input.week > 1 ? (0, fsn_index_1.computeFsnIndex)(payload, input.week - 1) : [];
    const matchups = (0, article_generator_1.orderPreviewMatchups)((0, article_generator_1.previewMatchups)(tracked, null));
    const leagueName = String((payload && payload.settings && payload.settings.name) || '').trim();
    const script = (0, podcast_script_1.buildWeeklyPodcastScript)({
        season: input.season,
        week: input.week,
        index,
        previousIndex,
        tracked,
        matchups,
        leagueName,
    });
    if (script.populatedSegments < exports.MIN_POPULATED_SEGMENTS) {
        throw fail('Every segment for ' + label + ' came back empty; refusing to synthesize an empty episode', 422);
    }
    if (options.script_only) {
        return { script, audio: null, turns: 0, markers: [] };
    }
    if (!process.env.ELEVENLABS_API_KEY) {
        throw fail('ELEVENLABS_API_KEY is not configured', 503);
    }
    const synthesize = options.synthesize || defaultSynthesize;
    const voices = (0, generate_podcast_1.podcastVoiceIds)();
    const segments = [];
    const markers = [];
    for (const line of script.lines) {
        const host = (0, generate_podcast_1.podcastHost)(line.host);
        if (!host) {
            console.warn('[PodcastCron] skipping a line with an unknown host tag for ' + label, line.host);
            continue;
        }
        segments.push(await synthesize(line.text, voices[host]));
        /* 128 kbps output: each byte is 1/16000 of a second. Markers are turn
           boundaries so the Story Reel advances with the spoken dialogue. */
        markers.push((0, generate_podcast_1.stitchPodcastMp3)(segments).length / 16000);
    }
    if (!segments.length)
        throw fail('No dialogue turns were synthesized for ' + label, 502);
    return {
        script,
        audio: (0, generate_podcast_1.stitchPodcastMp3)(segments),
        turns: segments.length,
        markers,
    };
}
/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */
/** One ledger row per league attempt. A failure to write the ledger must never
 *  fail the league whose episode already succeeded, so this logs and returns. */
async function recordRun(db, runId, result) {
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
        if (write.error)
            throw write.error;
    }
    catch (err) {
        console.error('[PodcastCron] could not write the usage ledger row for ' + result.league_id +
            ' (run ' + runId + '). The episode itself is unaffected; run supabase/podcast_episode_runs.sql ' +
            'if this table does not exist yet.', err);
    }
}
async function runWeeklyPodcastCron(input, dependencies = {}) {
    const db = dependencies.db || podcastDatabase();
    const now = dependencies.now || (() => Date.now());
    const started = now();
    const season = Number.isInteger(input.season) ? input.season : generate_podcast_1.CURRENT_SEASON;
    const boundary = targetWeekSetting();
    const requestedWeek = Number.isInteger(input.week) ? input.week : boundary.week;
    if (!Number.isInteger(requestedWeek) || requestedWeek < 1) {
        throw fail('No week to generate for: pass ?week= or set PODCAST_TARGET_WEEK', 400);
    }
    const week = requestedWeek;
    /* ---- THE TESTING BOUNDARY ----
       Before the league sweep, before any ESPN read, and a long way before
       ElevenLabs. A wrong-week misfire costs nothing and says why. */
    if (boundary.week != null && week !== boundary.week) {
        console.warn('[PodcastCron] refusing week ' + week + ': this environment is locked to week ' +
            boundary.week + ' for testing (PODCAST_TARGET_WEEK). No provider or storage call was made.');
        throw fail('Podcast generation is locked to week ' + boundary.week +
            ' while testing. Set PODCAST_TARGET_WEEK to change the boundary, or "any" to lift it.', 409);
    }
    /* An archived season is refused by lib/generate-podcast.ts too, but a
       scheduled run must not reach ESPN or the storage claim to find that out. */
    if (season < generate_podcast_1.CURRENT_SEASON) {
        throw fail('Audio recaps are only available for the current season.', 400);
    }
    const runId = String(input.run_id || `${season}-w${week}-podcast`);
    const maxLeagues = maxLeaguesPerRun();
    const dryRun = !!input.dry_run;
    const scriptOnly = !!input.script_only;
    const leagueIds = await (0, article_cron_1.activeLeagueIds)(db, season);
    const already = await leaguesAlreadyRecorded(db, season, week);
    const pending = leagueIds.filter((id) => !already.has(id));
    const summary = {
        season,
        week,
        run_id: runId,
        target_week: boundary.value,
        leagues: leagueIds.length,
        created: 0,
        skipped: leagueIds.length - pending.length,
        failed: 0,
        not_attempted: 0,
        failed_by_reason: {},
        max_leagues: maxLeagues,
        dry_run: dryRun,
        audio: !scriptOnly,
        results: [],
    };
    for (const id of already) {
        if (!leagueIds.includes(id))
            continue;
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
        const result = {
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
                if (String(claim.error.code || '') !== '23505')
                    throw claim.error;
                console.warn('[PodcastCron] league ' + leagueId + ' week ' + week +
                    ' was claimed by another invocation between the sweep and the claim; skipping.');
                result.status = 'skipped';
                summary.skipped += 1;
                summary.results.push(result);
                continue;
            }
            const outcome = await buildLeagueEpisode({ league_id: leagueId, season, week }, { ...dependencies, script_only: scriptOnly });
            result.populated_segments = outcome.script.populatedSegments;
            result.turns = outcome.turns;
            let audioUrl = null;
            if (outcome.audio) {
                const path = `${leagueId}/${season}/${week}.mp3`;
                const uploaded = await db.storage
                    .from(BUCKET)
                    .upload(path, outcome.audio, { contentType: 'audio/mpeg', upsert: true });
                if (uploaded.error)
                    throw uploaded.error;
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
            if (saved.error)
                throw saved.error;
            result.status = 'created';
            summary.created += 1;
        }
        catch (err) {
            const reason = classifyPodcastFailure(err);
            result.status = 'failed';
            result.failure_reason = reason;
            result.error_message = String((err && err.message) || err).slice(0, 500);
            summary.failed += 1;
            summary.failed_by_reason[reason] = (summary.failed_by_reason[reason] || 0) + 1;
            console.error('[PodcastCron] league ' + leagueId + ' week ' + week + ' failed (' + reason + ')', err);
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
                if (marked.error)
                    throw marked.error;
            }
            catch (markErr) {
                console.error('[PodcastCron] could not mark league ' + leagueId + ' week ' + week + ' as failed; the row ' +
                    'may sit in "generating" until the interactive path\'s ten-minute staleness sweep clears it.', markErr);
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
function queryParam(req, name) {
    const value = req && req.query && req.query[name];
    if (Array.isArray(value))
        return String(value[0] == null ? '' : value[0]);
    return String(value == null ? '' : value);
}
function flag(req, name) {
    const value = queryParam(req, name).trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes';
}
function intParam(req, name) {
    const raw = queryParam(req, name).trim();
    if (!raw)
        return null;
    const value = Number(raw);
    return Number.isInteger(value) ? value : NaN;
}
/**
 * `POST /api/cron/generate-weekly-podcast` (GET accepted, so a Vercel cron —
 * which can only issue GET — works unchanged).
 */
async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
        return;
    }
    if (!(0, article_cron_1.authorizedByCronSecret)(req)) {
        if (!(0, article_cron_1.cronSecretConfigured)()) {
            console.error('[PodcastCron] refused: CRON_SECRET is not set in this environment, so the route cannot ' +
                'authenticate its caller and will not generate anything.', new Error('CRON_SECRET_MISSING'));
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
        const summary = await runWeeklyPodcastCron({
            season,
            week,
            dry_run: flag(req, 'dry_run'),
            script_only: flag(req, 'script_only'),
            /* The shared cron function slot is configured for 60s in vercel.json
               and is killed at it. Leave a margin so the summary survives. */
            budget_ms: 50000,
        }, { req });
        res.status(200).json({ ok: summary.failed === 0, ...summary });
    }
    catch (err) {
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
