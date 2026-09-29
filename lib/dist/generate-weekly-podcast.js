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
 *   2. Works out which week just ended and refuses to go on until that week's
 *      box scores are closed, before spending anything. See "WHICH WEEK A
 *      SCHEDULED RUN RECAPS" on the HTTP handler below.
 *   3. Refuses any week other than `PODCAST_TARGET_WEEK` when that variable
 *      pins one. Unset — the normal case — pins nothing. See the boundary
 *      below.
 *   4. Sweeps `public.leagues` for the season's active leagues.
 *   5. Skips every league that already holds a `podcast_episodes` row for the
 *      week, so a retry or a double fire costs nothing and no member ever has
 *      an episode change under them.
 *   6. For each remaining league, up to the per-run cap: one ESPN read, the
 *      four-segment script, ElevenLabs synthesis, an MP3 into Supabase
 *      Storage, and a `podcast_episodes` row.
 *   7. Writes one `podcast_episode_runs` ledger row per league attempt,
 *      whether it succeeded or not.
 *
 * One league's failure never stops the others — the same contract
 * `lib/article-cron.ts` holds.
 *
 * ---- THE OPTIONAL WEEK PIN ----
 *
 * `PODCAST_TARGET_WEEK` is unset in the deployment and that means `'any'`: the
 * run recaps whatever week just ended. Set it to a number to pin every run to
 * that one week — a rehearsal lever — and the run then refuses anything else.
 * That check is the FIRST thing that happens after auth, before the league
 * sweep, before any ESPN read and long before ElevenLabs, so a misfire on the
 * wrong week cannot spend a cent.
 *
 * It defaulted to week 2 while the four-segment pipeline was being tested, and
 * because the variable is not set in the deployment that default WAS the
 * behaviour: every Tuesday run could only ever produce week 2. The guard that
 * replaced it is the completion gate, which needs no human to move it.
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
exports.MIN_POPULATED_SEGMENTS = exports.DEFAULT_MAX_LEAGUES = exports.DEFAULT_TARGET_WEEK = exports.readNewsPayload = void 0;
exports.targetWeekSetting = targetWeekSetting;
exports.resolveRecapWeek = resolveRecapWeek;
exports.assertWeekComplete = assertWeekComplete;
exports.maxLeaguesPerRun = maxLeaguesPerRun;
exports.podcastDatabase = podcastDatabase;
exports.leaguesAlreadyRecorded = leaguesAlreadyRecorded;
exports.classifyPodcastFailure = classifyPodcastFailure;
exports.buildLeagueEpisode = buildLeagueEpisode;
exports.runWeeklyPodcastCron = runWeeklyPodcastCron;
exports.default = handler;
const generate_podcast_1 = require("./generate-podcast");
const build_podcast_audio_1 = require("./build-podcast-audio");
const sanitize_podcast_script_1 = require("./sanitize-podcast-script");
const article_math_1 = require("./article-math");
const article_generator_1 = require("./article-generator");
const fsn_index_1 = require("./fsn-index");
const podcast_script_1 = require("./podcast-script");
const podcast_news_script_1 = require("./podcast-news-script");
Object.defineProperty(exports, "readNewsPayload", { enumerable: true, get: function () { return podcast_news_script_1.readNewsPayload; } });
const week_complete_1 = require("./week-complete");
const article_cron_1 = require("./article-cron");
/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */
/** What `PODCAST_TARGET_WEEK` means when it is not set: no pin at all. The run
 *  resolves the week that just ended and recaps that.
 *
 *  This used to default to week 2 — a testing boundary that refused every other
 *  week before spending anything. It is not the guard any more, and leaving it
 *  as the default meant a Tuesday run could only ever produce week 2: the
 *  variable is not set in the deployment, so the default WAS the behaviour.
 *  What protects the spend now is stricter and does not need a human to move it
 *  every week — the week has to be finished (`resolveRecapWeek()` /
 *  `assertWeekComplete()`), a league that already holds a row for the week is
 *  skipped, `PODCAST_CRON_MAX_LEAGUES` bounds the fan-out, and every attempt
 *  lands in `podcast_episode_runs`. Setting the variable to a number still pins
 *  the run to that week for a rehearsal. */
exports.DEFAULT_TARGET_WEEK = 'any';
exports.DEFAULT_MAX_LEAGUES = 5;
const BUCKET = 'podcast-episodes';
/** A league whose week produced fewer than this many real segments is not
 *  worth synthesizing: an episode of four "nothing to report" rooms costs the
 *  same as a real one. */
exports.MIN_POPULATED_SEGMENTS = 1;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
/**
 * The week this environment is pinned to, or `'any'` for no pin.
 *
 * Unset — which is how the deployment runs — means `'any'`: the run resolves the
 * week that just ended. A number pins it to that week, for a rehearsal or a
 * backfill. Returns the raw configured string alongside the number so the
 * summary can report what the setting actually was.
 */
function targetWeekSetting() {
    const raw = String(process.env.PODCAST_TARGET_WEEK || '').trim();
    if (!raw)
        return { value: 'any', week: null };
    if (/^(any|all|\*)$/i.test(raw))
        return { value: 'any', week: null };
    const week = Number.parseInt(raw, 10);
    if (!Number.isInteger(week) || week < 1 || week > 18) {
        console.error('[PodcastCron] PODCAST_TARGET_WEEK is set to "' + raw + '", which is not a week or "any". ' +
            'Ignoring it and recapping the week that just ended, which is what an unset variable means. ' +
            'A typo must not silently pin the schedule to a week nobody chose.', new Error('INVALID_PODCAST_TARGET_WEEK'));
        return { value: 'any', week: null };
    }
    return { value: String(week), week };
}
async function defaultFetchLiveWeek() {
    const scheduleFeed = require('../notifications/schedule-feed');
    const snapshot = await scheduleFeed.pull({});
    return {
        seasonYear: snapshot && snapshot.seasonYear == null ? null : Number(snapshot.seasonYear),
        week: snapshot && snapshot.week == null ? null : Number(snapshot.week),
    };
}
/**
 * THE JUST-COMPLETED WEEK.
 *
 * The Tuesday schedule fires in the morning, hours after the Monday night
 * final, and the week it must recap is the week that just ended — never the one
 * about to start. Two candidates, in this order:
 *
 *   1. The week the scoreboard currently calls live. On Tuesday morning ESPN is
 *      still reporting the week whose games just played (the same behaviour the
 *      Tuesday blog article relies on), so this is the normal answer.
 *   2. The week before it, for the run that lands after ESPN has already rolled
 *      over: the live week's games are all in the future, so it cannot be
 *      recapped and the week behind it is the finished one.
 *
 * Whichever is taken has to be COMPLETE — every game of it finished. A week that
 * is still being played is not a failure and not something to generate half of:
 * the caller turns it into a 409, which the schedule reports as a skip, and the
 * next run finds the same leagues with no episode and picks them up.
 */
async function resolveRecapWeek(input, deps = {}) {
    const fetchLiveWeek = deps.fetchLiveWeek || defaultFetchLiveWeek;
    const weekCompletion = deps.weekCompletion || ((i) => (0, week_complete_1.nflWeekCompletion)(i));
    let live;
    try {
        live = await fetchLiveWeek();
    }
    catch (err) {
        /* A guessed week would recap the wrong slate for every league in the sweep,
           so there is nothing to fall back to. */
        console.error('[PodcastCron] the NFL scoreboard could not be read, so the week to recap is unknown. ' +
            'No league was touched. Pass ?week= to run anyway.', err);
        throw fail('The current NFL week could not be resolved', 503);
    }
    const season = Number.isInteger(input.season)
        ? input.season
        : Number.isInteger(live.seasonYear)
            ? live.seasonYear
            : generate_podcast_1.CURRENT_SEASON;
    const liveWeek = Number.isInteger(live.week) ? live.week : null;
    if (liveWeek == null || liveWeek < 1) {
        console.error('[PodcastCron] the NFL scoreboard returned no usable week (season ' + String(live.seasonYear) +
            ', week ' + String(live.week) + '), so there is no slate to recap.', new Error('WEEK_UNRESOLVED'));
        throw fail('The current NFL week could not be resolved', 503);
    }
    const candidates = [
        { week: liveWeek, source: 'live_week' },
        { week: liveWeek - 1, source: 'previous_week' },
    ].filter((c) => c.week >= 1);
    let last = null;
    for (const candidate of candidates) {
        let completion;
        try {
            completion = await weekCompletion({ season, week: candidate.week });
        }
        catch (err) {
            console.error('[PodcastCron] could not tell whether ' + season + ' week ' + candidate.week +
                ' has finished, so nothing was generated for it.', err);
            throw fail('Week completion for ' + season + ' week ' + candidate.week + ' could not be read', 503);
        }
        last = completion;
        if (completion.complete) {
            return { season, week: candidate.week, live_week: liveWeek, source: candidate.source, completion };
        }
        console.warn('[PodcastCron] ' + season + ' week ' + candidate.week + ' is still open (' +
            completion.completed + ' of ' + completion.games + ' games final); it cannot be recapped yet.');
    }
    throw fail('No completed week to recap yet: ' + season + ' week ' + liveWeek + ' has ' +
        String(last ? last.completed : 0) + ' of ' + String(last ? last.games : 0) +
        ' games final. The weekly recap runs once the Sunday and Monday night box scores close.', 409);
}
/**
 * The gate for a week that was NAMED rather than resolved — an explicit
 * `?week=`, or the week `PODCAST_TARGET_WEEK` pins this environment to.
 *
 * Same rule, one read: a week whose games are still being played is refused with
 * a 409 before the league sweep, so a schedule that fires early skips instead of
 * narrating a half-played slate.
 */
async function assertWeekComplete(input, deps = {}) {
    const weekCompletion = deps.weekCompletion || ((i) => (0, week_complete_1.nflWeekCompletion)(i));
    let completion;
    try {
        completion = await weekCompletion({ season: input.season, week: input.week });
    }
    catch (err) {
        console.error('[PodcastCron] could not tell whether ' + input.season + ' week ' + input.week +
            ' has finished, so nothing was generated for it. Pass ?allow_open_week=1 to skip this check.', err);
        throw fail('Week completion for ' + input.season + ' week ' + input.week + ' could not be read', 503);
    }
    if (!completion.complete) {
        throw fail(input.season + ' week ' + input.week + ' is still being played (' + completion.completed + ' of ' +
            completion.games + ' games final). The weekly recap runs Tuesday, after the Monday night final.', 409);
    }
    return completion;
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
    const format = options.format === 'segments' ? 'segments' : 'news';
    /* ---- 'news': the local payload, and NOT ONE EXTERNAL CALL ----
       Returns before the ESPN read below. The stat lines come from the
       blog_articles row the article cron already wrote for this league-week, so
       the podcast cannot disagree with the article the league is reading, and a
       Tuesday run costs no box-score request at all. */
    if (format === 'news') {
        const news = options.readNewsPayload
            ? await options.readNewsPayload(input.league_id, input.season, input.week)
            : await (0, podcast_news_script_1.readNewsPayload)(options.db, input.league_id, input.season, input.week);
        if (!news) {
            throw fail('No news payload in blog_articles for ' + label +
                '; the article for this league-week has not published yet', 422);
        }
        const built = (0, podcast_news_script_1.buildNewsPodcastScript)(news);
        const script = {
            title: built.title,
            week: built.week,
            season: built.season,
            lines: built.lines,
            stories: built.stories,
            /* The news format has movements, not the four named segments. It reports
               one populated segment per narrated performance so the run summary's
               populated_segments stays meaningful across both formats. */
            segments: built.movements.map((m) => ({
                key: m.key,
                title: m.key,
                headline: m.key + ': ' + m.words + ' words',
                populated: m.words > 0,
            })),
            populatedSegments: Math.min(4, built.performances),
        };
        console.info('[PodcastCron] ' + label + ' news script: ' + built.words + ' words, ' +
            built.characters + ' chars, ~' + built.estimatedSeconds + 's, ' +
            built.performances + ' performance(s), ' + built.lines.length + ' turns.');
        if (script.populatedSegments < exports.MIN_POPULATED_SEGMENTS) {
            throw fail('The news payload for ' + label + ' narrated nothing; refusing to synthesize', 422);
        }
        return finishEpisode(script, label, options);
    }
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
    return finishEpisode(script, label, options);
}
/**
 * Synthesis and stitching, shared by both script formats.
 *
 * Extracted when the news format arrived: the two formats differ only in how
 * the script is built, and a second copy of the turn loop would be a second
 * place for the marker arithmetic to drift.
 */
async function finishEpisode(script, label, options) {
    if (options.script_only) {
        return { script, audio: null, turns: 0, markers: [],
            turnMarkers: [], storyReelMarkers: [], leadInOffsetMs: 0 };
    }
    if (!process.env.ELEVENLABS_API_KEY) {
        throw fail('ELEVENLABS_API_KEY is not configured', 503);
    }
    const synthesize = options.synthesize || defaultSynthesize;
    const voices = (0, generate_podcast_1.podcastVoiceIds)();
    const pronunciations = (0, sanitize_podcast_script_1.podcastPronunciations)();
    const spokenLines = script.lines.map(line => (0, sanitize_podcast_script_1.sanitizePodcastScript)(line.text, pronunciations));
    if (spokenLines.some(text => text.length < 5))
        throw fail('The podcast script contains an empty spoken turn', 422);
    const stingers = await (0, build_podcast_audio_1.configuredPodcastStingers)();
    const segments = [];
    for (const [index, line] of script.lines.entries()) {
        const host = (0, generate_podcast_1.podcastHost)(line.host);
        if (!host) {
            console.warn('[PodcastCron] skipping a line with an unknown host tag for ' + label, line.host);
            continue;
        }
        segments.push(await synthesize(spokenLines[index], voices[host]));
    }
    if (!segments.length)
        throw fail('No dialogue turns were synthesized for ' + label, 502);
    const { audio, markers, turnMarkers, leadInOffsetMs } = await (0, build_podcast_audio_1.buildPodcastAudio)(segments, stingers);
    const storyMarkers = (0, build_podcast_audio_1.storyReelMarkers)(turnMarkers, script.stories.length, script.segments.map(segment => segment.lines?.length ?? 0));
    return {
        script,
        audio,
        turns: segments.length,
        markers,
        turnMarkers,
        storyReelMarkers: storyMarkers,
        leadInOffsetMs,
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
        /* Only reachable in-process: the HTTP handler resolves the just-completed
           week before it gets here, so this is a caller that named neither. */
        throw fail('No week to generate for: pass a week, or set PODCAST_TARGET_WEEK to pin one', 400);
    }
    const week = requestedWeek;
    /* ---- THE TESTING BOUNDARY ----
       Before the league sweep, before any ESPN read, and a long way before
       ElevenLabs. A wrong-week misfire costs nothing and says why. */
    if (boundary.week != null && week !== boundary.week) {
        console.warn('[PodcastCron] refusing week ' + week + ': this environment is pinned to week ' +
            boundary.week + ' by PODCAST_TARGET_WEEK. No provider or storage call was made.');
        throw fail('Podcast generation is pinned to week ' + boundary.week +
            '. Change PODCAST_TARGET_WEEK, or unset it to recap whatever week just ended.', 409);
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
    const format = input.format === 'segments' ? 'segments' : 'news';
    const requestedLeague = String(input.league == null ? '' : input.league).trim();
    if (requestedLeague && !/^\d{1,20}$/.test(requestedLeague)) {
        throw fail('league must be a numeric ESPN league id', 400);
    }
    const allLeagueIds = await (dependencies.listLeagues
        ? dependencies.listLeagues(db, season)
        : (0, article_cron_1.activeLeagueIds)(db, season));
    if (requestedLeague && !allLeagueIds.includes(requestedLeague)) {
        throw fail('League ' + requestedLeague + ' is not an active league for ' + season +
            ', so there is nothing to generate for it.', 404);
    }
    /* The filter is applied to the league list itself, so every count in the
       summary — leagues, skipped, not_attempted — describes the scoped run and
       not the league table. */
    const leagueIds = requestedLeague ? [requestedLeague] : allLeagueIds;
    const already = await leaguesAlreadyRecorded(db, season, week);
    const pending = leagueIds.filter((id) => !already.has(id));
    const summary = {
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
            /* `db` explicitly, NOT just `...dependencies`. The run resolves its own
               client when the caller supplies none — which is exactly what the HTTP
               handler does, passing only `{ req }` — so `dependencies.db` is
               undefined in production while the local `db` holds the real client.
               Spreading dependencies alone handed buildLeagueEpisode an undefined db,
               and the news path's payload read died on `db.from` with "Cannot read
               properties of undefined". Every test passed a db, so nothing caught it
               until a live run. */
            const outcome = await buildLeagueEpisode({ league_id: leagueId, season, week }, { ...dependencies, db, script_only: scriptOnly, format });
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
                turn_markers: outcome.turnMarkers,
                story_reel_markers: outcome.storyReelMarkers,
                leadInOffsetMs: outcome.leadInOffsetMs,
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
 *
 * ---- WHICH WEEK A SCHEDULED RUN RECAPS ----
 *
 * The schedule carries no `?week=`, and the answer is the week that just ended.
 * Three sources, in precedence order, all of which end at a week whose games
 * are finished:
 *
 *   `?week=N`                  an explicit backfill. Taken as asked, then
 *                              checked for completion like any other week.
 *   PODCAST_TARGET_WEEK=N      the variable pins this environment to one week;
 *                              that week is used and checked.
 *   unset, or =any             the default. resolveRecapWeek() asks the NFL
 *                              scoreboard: the live week if its games are in
 *                              the books, otherwise the week behind it.
 *
 * `?allow_open_week=1` skips the completion check for a named week. It exists
 * for a deliberate mid-week rehearsal and for the case where the scoreboard read
 * itself is what is broken; nothing on the schedule passes it.
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
    /* ---- THE WEEK, AND WHETHER IT IS FINISHED ----
       Resolved here rather than inside runWeeklyPodcastCron() so the in-process
       callers that name their own week (scripts/generate-podcast.mjs, the checks)
       keep working exactly as they do, while the scheduled HTTP path gets the
       just-completed week and the "box scores are closed" guarantee. Both live
       ahead of the league sweep, the ESPN read and every ElevenLabs call. */
    const allowOpenWeek = flag(req, 'allow_open_week');
    const boundary = targetWeekSetting();
    let scopeSeason = season;
    let scopeWeek = week;
    let weekSource = 'override';
    let completion = null;
    try {
        if (week == null && boundary.week == null) {
            const resolved = await resolveRecapWeek({ season });
            scopeSeason = resolved.season;
            scopeWeek = resolved.week;
            weekSource = resolved.source;
            completion = resolved.completion;
            console.info('[PodcastCron] recapping ' + resolved.season + ' week ' + resolved.week + ' (' + resolved.source +
                '; the scoreboard reports week ' + String(resolved.live_week) + ' live, ' +
                resolved.completion.completed + ' of ' + resolved.completion.games + ' games final).');
        }
        else {
            if (week == null) {
                scopeWeek = boundary.week;
                weekSource = 'boundary';
            }
            if (!allowOpenWeek) {
                completion = await assertWeekComplete({
                    season: scopeSeason == null ? generate_podcast_1.CURRENT_SEASON : scopeSeason,
                    week: scopeWeek,
                });
            }
        }
    }
    catch (err) {
        const status = Number(err && err.status) || 500;
        if (status === 409) {
            console.warn('[PodcastCron] run skipped: ' + String(err.message));
            res.status(409).json({ error: 'WEEK_NOT_COMPLETE', message: String(err.message) });
            return;
        }
        console.error('[PodcastCron] the week to recap could not be resolved', err);
        res.status(status).json({ error: 'WEEK_UNRESOLVED', message: String((err && err.message) || err) });
        return;
    }
    try {
        const summary = await runWeeklyPodcastCron({
            season: scopeSeason,
            week: scopeWeek,
            dry_run: flag(req, 'dry_run'),
            script_only: flag(req, 'script_only'),
            /* Optional. Omitted, the run sweeps every active league exactly as the
               Tuesday schedule does; named, it touches that league and no other. */
            league: queryParam(req, 'league').trim() || null,
            /* The shared cron function slot is configured for 60s in vercel.json
               and is killed at it. Leave a margin so the summary survives. */
            budget_ms: 50000,
        }, { req });
        res.status(200).json({
            ok: summary.failed === 0,
            /* How the week was chosen and what the scoreboard said about it, so a
               Tuesday run is auditable from its own response. */
            week_source: weekSource,
            week_complete: completion ? completion.complete : null,
            week_games_final: completion ? completion.completed + '/' + completion.games : null,
            ...summary,
        });
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
