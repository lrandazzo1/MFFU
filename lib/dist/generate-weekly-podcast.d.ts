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
import { type PodcastCue } from './build-podcast-audio';
import { type WeeklyPodcastScript } from './podcast-script';
import { readNewsPayload, type NewsPayload } from './podcast-news-script';
import { type WeekCompletion } from './week-complete';
export { readNewsPayload };
export type PodcastRunStatus = 'created' | 'skipped' | 'failed';
export type PodcastFailureReason = 'ESPN_AUTH'
/** The article for this league-week has not published yet, so there is no
 *  `blog_articles` payload to narrate. The only reason that costs NOTHING:
 *  it is raised before ESPN, before ElevenLabs and before Storage, which is
 *  what makes it the only one safe to retry automatically. See
 *  RETRYABLE_PODCAST_FAILURES. */
 | 'ARTICLE_NOT_READY' | 'NO_MATCHUP_DATA' | 'EMPTY_SCRIPT' | 'TTS' | 'STORAGE' | 'TIMEOUT' | 'OTHER';
export declare const RETRYABLE_PODCAST_FAILURES: readonly PodcastFailureReason[];
export declare function podcastFailureIsRetryable(reason: PodcastFailureReason | null | undefined): boolean;
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
    /** True when this episode replaced one the league already held. */
    regenerated?: boolean;
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
    /** How many of `created` replaced a row the league already held. Only a
     *  forced run can be non-zero; a scheduled one skips those leagues. */
    regenerated: number;
    skipped: number;
    failed: number;
    /** Leagues the cap or the time budget kept this run from reaching. The next
     *  run finds no episode for them and picks them up. */
    not_attempted: number;
    /** Whether this run was allowed to write over episodes that already exist. */
    forced: boolean;
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
     * REGENERATE over episodes that already exist for this league-week.
     *
     * Off by default, and the scheduled Tuesday run can never turn it on — the
     * HTTP handler refuses `force` unless the caller also NAMED a week, and the
     * schedule names none. It exists for the case the idempotency skip cannot
     * tell apart from a finished episode: a `podcast_episodes` row that is
     * present but WRONG. That is not hypothetical. League 57155288 held a
     * `ready` 2026 week 3 row minted on the Sunday, mid-week, by the interactive
     * Studio path — an injury-wire preview, not a recap — so the Tuesday run
     * that should have recapped week 3 reported it `skipped` and the league got
     * no recap at all. Without this flag the only way back is deleting the row
     * by hand, which takes the episode off every member's feed first.
     *
     * What it does NOT do is weaken the mutex. A row already `generating`
     * belongs to a live invocation and is still refused; the claim is a
     * compare-and-swap on the row's current status, so two forced runs cannot
     * both reach ElevenLabs for one league-week.
     *
     * A regenerated episode is uploaded to a NEW, content-addressed Storage
     * path and only then written into the row: the episode the league is
     * reading stays exactly as it was until its replacement is in place, and a
     * forced run that fails puts the previous row back rather than leaving a
     * `failed` row where a playable episode used to be.
     */
    force?: boolean;
    /**
     * Override `PODCAST_CRON_MAX_LEAGUES` for this run only.
     *
     * The environment default is 5, which is a spend ceiling for a SCHEDULED
     * run and a cliff for a manual one: the deployment has 14 active leagues,
     * so the Tuesday sweep reaches at most five of them and reports the rest
     * `not_attempted`. The comment on that field says the next run picks them
     * up — true of a daily cron, false of a weekly one, where the next run is
     * seven days later and recapping a different week. A manual catch-up needs
     * to be able to raise the ceiling it is catching up on.
     */
    max_leagues?: number | null;
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
    fetchBoxScores?: (input: {
        league_id: string;
        season: number;
        week: number;
        req?: any;
    }) => Promise<any>;
    fetchKickoffs?: (input: {
        season: number;
        week: number;
    }) => Promise<any>;
    /** Swapped in tests so no ElevenLabs credit is spent. */
    synthesize?: (text: string, voiceId: string) => Promise<Buffer>;
    now?: () => number;
}
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
export declare const DEFAULT_TARGET_WEEK = "any";
export declare const DEFAULT_MAX_LEAGUES = 5;
/** A league whose week produced fewer than this many real segments is not
 *  worth synthesizing: an episode of four "nothing to report" rooms costs the
 *  same as a real one. */
export declare const MIN_POPULATED_SEGMENTS = 1;
/**
 * The week this environment is pinned to, or `'any'` for no pin.
 *
 * Unset — which is how the deployment runs — means `'any'`: the run resolves the
 * week that just ended. A number pins it to that week, for a rehearsal or a
 * backfill. Returns the raw configured string alongside the number so the
 * summary can report what the setting actually was.
 */
export declare function targetWeekSetting(): {
    value: string;
    week: number | null;
};
/** Why this week, and what the scoreboard said about it. */
export interface RecapWeekResolution {
    season: number;
    week: number;
    /** The week the NFL scoreboard currently reports as the live one. */
    live_week: number | null;
    /** `live_week` when that week's games are already in the books, otherwise the
     *  week before it — the one ESPN has just rolled off. */
    source: 'live_week' | 'previous_week';
    completion: WeekCompletion;
}
export interface RecapWeekDependencies {
    /** The season and week the scoreboard currently reports. Defaults to one
     *  schedule-feed pull, which is one outbound request per weekly run. */
    fetchLiveWeek?: () => Promise<{
        seasonYear: number | null;
        week: number | null;
    }>;
    /** Whether every game of a week has finished. Defaults to one scoreboard read
     *  per candidate week. */
    weekCompletion?: (input: {
        season: number;
        week: number;
    }) => Promise<WeekCompletion>;
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
export declare function resolveRecapWeek(input: {
    season?: number | null;
}, deps?: RecapWeekDependencies): Promise<RecapWeekResolution>;
/**
 * The gate for a week that was NAMED rather than resolved — an explicit
 * `?week=`, or the week `PODCAST_TARGET_WEEK` pins this environment to.
 *
 * Same rule, one read: a week whose games are still being played is refused with
 * a 409 before the league sweep, so a schedule that fires early skips instead of
 * narrating a half-played slate.
 */
export declare function assertWeekComplete(input: {
    season: number;
    week: number;
}, deps?: RecapWeekDependencies): Promise<WeekCompletion>;
/** The per-run league ceiling: an explicit override, else
 *  `PODCAST_CRON_MAX_LEAGUES`, else {@link DEFAULT_MAX_LEAGUES}. An override
 *  that is not a positive whole number is refused rather than ignored — a
 *  typo in a manual catch-up must not silently fall back to the ceiling the
 *  catch-up exists to raise. */
export declare function maxLeaguesPerRun(override?: number | null): number;
export declare function podcastDatabase(): any;
/**
 * The leagues that already hold an episode for this week.
 *
 * One query for the whole run. A row in ANY status counts: a `generating` claim
 * belongs to an invocation that may still be running and a `failed` one needs a
 * human, and starting a second synthesis over either is how a league gets
 * billed twice for one episode.
 */
export declare function leaguesAlreadyRecorded(db: any, season: number, week: number): Promise<Set<string>>;
/** The row as it stood before a forced run claimed it, so a failure can put it
 *  back exactly as the league's members were reading it. */
export interface PreviousEpisode {
    status: string;
    audio_url: string | null;
    episode: any;
}
export interface EpisodeClaim {
    /** 'new' inserted a row; 'regenerated' took over one that already existed. */
    mode: 'new' | 'regenerated';
    /** Only set for a regeneration. */
    previous: PreviousEpisode | null;
}
/**
 * Take the cross-instance lock on one league-week, or return null if another
 * invocation already holds it.
 *
 * ---- THE ORDINARY PATH ----
 *
 * An insert. The primary key IS the mutex, exactly as it is on the interactive
 * path: the loser of a race gets 23505 and never reaches ElevenLabs. Unchanged
 * from the day this route was written, and it is what every scheduled run does.
 *
 * ---- THE FORCED PATH ----
 *
 * A row already exists and the caller has said, explicitly and with a week
 * named, to replace it. The insert would only ever return 23505 here, so the
 * claim becomes a compare-and-swap instead: read the row, then flip it to
 * `generating` GUARDED ON THE STATUS IT WAS READ AT. Two forced runs racing
 * both read `ready`, both issue the same guarded update, and PostgREST applies
 * them one at a time — the first matches a row, the second matches none and
 * backs out. The mutex is therefore no weaker than the insert it replaces.
 *
 * A row already `generating` is refused outright rather than swapped: it
 * belongs to an invocation that may be mid-synthesis, and taking it would bill
 * a second ElevenLabs run for one episode.
 */
export declare function claimEpisodeSlot(db: any, input: {
    league_id: string;
    season: number;
    week: number;
    force?: boolean;
}): Promise<EpisodeClaim | null>;
/** Where a regenerated MP3 goes.
 *
 *  NOT `<week>.mp3`, which is what a first-time episode uses and what every
 *  client has already been served and cached under. Overwriting that object
 *  leaves members playing the old audio from a CDN edge for as long as it is
 *  cached, which on a regeneration is precisely the bug being fixed. The name
 *  carries a digest of the audio, so a new episode is a new URL and the swap is
 *  atomic from the reader's side. `scripts/rerun-podcast.mjs` settled on the
 *  same shape for the same reason. */
export declare function regeneratedAudioPath(leagueId: string, season: number, week: number, audio: Buffer): string;
/** Best-effort removal of the object a regeneration replaced.
 *
 *  Never throws: the new episode is already live and published at this point,
 *  and losing the delete only leaves an orphan MP3 in a bucket. Only paths
 *  inside this league-season are ever removed, so a malformed or foreign URL
 *  deletes nothing. */
export declare function removeSupersededAudio(db: any, leagueId: string, season: number, previousUrl: string | null, keepPath: string): Promise<void>;
export declare function classifyPodcastFailure(err: any): PodcastFailureReason;
export interface LeagueEpisodeOutcome {
    script: WeeklyPodcastScript;
    audio: Buffer | null;
    turns: number;
    markers: number[];
    turnMarkers: PodcastCue[];
    storyReelMarkers: PodcastCue[];
    leadInOffsetMs: number;
}
/**
 * Build one league's episode: the script, and the stitched audio when audio is
 * asked for.
 *
 * Throws on anything that should stop THIS league. The caller catches, logs the
 * reason and moves to the next one.
 */
export declare function buildLeagueEpisode(input: {
    league_id: string;
    season: number;
    week: number;
}, options: {
    script_only?: boolean;
} & PodcastRunDependencies): Promise<LeagueEpisodeOutcome>;
export declare function runWeeklyPodcastCron(input: PodcastRunInput, dependencies?: PodcastRunDependencies): Promise<PodcastRunSummary>;
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
 *
 * ---- MANUALLY RE-RUNNING A WEEK ----
 *
 *   `?week=N&force=1`     regenerate over episodes that already exist for the
 *                         week. REFUSED WITHOUT `?week=`, which is the whole
 *                         guarantee: the Tuesday schedule names no week, so no
 *                         schedule can ever reach this and quietly rewrite a
 *                         league's episode. Pair it with `?league=` to bound
 *                         the spend to one league.
 *   `?max_leagues=N`      raise (or lower) the per-run league ceiling for this
 *                         invocation only. The default of 5 is a spend ceiling
 *                         sized for a schedule; a catch-up over 14 leagues
 *                         needs to name its own.
 *
 * A word on `max_leagues` over HTTP: this route runs in a 60s function slot and
 * stops starting leagues at 50s, so a large ceiling here still reports the
 * remainder as `not_attempted` rather than running longer. The catch-up that
 * actually finishes is the CLI — `scripts/generate-podcast.mjs --force-week=N`
 * — which calls the same run function with no wall clock over it.
 */
export default function handler(req: any, res: any): Promise<void>;
