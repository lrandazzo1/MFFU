# FSN Podcast Studio

The Studio tab builds a short weekly script from the league's existing News Desk
headlines. Dan and Stu are synthesized with ElevenLabs Flash v2.5. Audio,
script, and story cards are stored in IndexedDB on the current device; the
shared league archive and deterministic News Desk generators are unchanged.
New episodes snapshot the existing Story Reel panels, including power ranks,
team crests, matchup scores, and margin bars. Older device archives still
display their headline-only News Desk cards.

Set these server-side variables in the Vercel project before enabling audio:

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_DAN_VOICE_ID` (optional; defaults to `T9EcMlwa9Tz1Qri0md9E`, Dee Rawls)
- `ELEVENLABS_STU_VOICE_ID` (optional; defaults to `gzpdkRXvSsVFesfPP5i7`, Jim Tolliver)
- Existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for league token verification

Voice resolution checks the new variable first, then the legacy
`ELEVENLABS_MARK_VOICE_ID` or `ELEVENLABS_SULLY_VOICE_ID`, then the supplied
default voice ID. The API key remains required. Older clients sending MARK and
SULLY tags are accepted and routed to Dan and Stu's resolved voices.

The public endpoint is `POST /api/generate-podcast`. The route rewrites into
the existing admin function slot and dispatches to `lib/generate-podcast.ts`.
This keeps the deployment at the project's twelve-function limit. The browser
sends an `x-league-token` for a saved or invited ESPN league. Requests without a
matching token cannot consume ElevenLabs credits. Generation is limited to six
short dialogue lines and has a five-minute in-memory cooldown per league token.
The cooldown is a best-effort guard within a warm function instance, not a
durable quota across instances. Add a persistent usage ledger before broadly
distributing paid audio generation to large leagues.

The function removes per-turn MP3 metadata before joining host audio so the
HTML audio element can report the full episode duration instead of the first
speaker turn. The player updates its timestamps when metadata or duration
changes arrive.

Saved audio is deleted by Setup's **Erase Stored Data & Disconnect** action.
The Studio currently uses scripted narration of existing league headlines: Dan
leads with the reported board, and Stu adds color without inventing a result.
There is no LLM system prompt in this pipeline. Episodes are device-local and do not
sync across league members.

---

# The scheduled weekly recap (four segments, Tuesdays)

Two pipelines now write episodes, and they do not overlap:

| | Interactive | Scheduled |
|---|---|---|
| Trigger | A reader taps GENERATE in Studio | Tuesday 10:00 UTC, every active league |
| Script | `studioDraft()` in index.html, from News Desk headlines | `lib/podcast-script.ts`, four segments |
| Auth | Per-league `x-league-token` | `CRON_SECRET` |
| Public path | `POST /api/generate-podcast` | `POST /api/cron/generate-weekly-podcast` |

Both land in the same `podcast_episodes` row for a league week, and the primary
key is the mutex, so whichever arrives first wins and the other observes it. The
interactive path is unchanged.

## The four segments

`lib/podcast-script.ts` builds one episode from two branches of data the app
already computes. There is still **no LLM in this pipeline**: every sentence is a
template filled from numbers the math modules stand behind, which is what lets an
episode be regenerated and come out identical.

| Segment | Source | What it says |
|---|---|---|
| 1 · FSN Index Movers | `lib/fsn-index.ts`, this week's board vs last week's | Biggest rank jumps and drops, with the index-point move |
| 2 · Big Performers | `lib/article-math.ts` tracked starters | Top scorers, and the performance the math flagged as deciding a matchup |
| 3 · Matchup of the Week | `lib/article-generator.ts` preview matchups | The closest board with points on it, deepest-dived |
| 4 · Waiver Lookout | Starter shortfalls against projection | Which teams have a hole, and how big |

Eight dialogue turns, Dan and Stu strictly alternating. The show open and the
sign-off ride on the first and last turns rather than taking turns of their own:
two consecutive turns by one host stitch into a single continuous block of that
voice, and it removes two ElevenLabs calls from every episode. The per-request
ceiling is `MAX_EPISODE_LINES` (16) in `lib/generate-podcast.ts`, raised from 6,
which had silently rejected every four-segment script.

### What segment 4 deliberately does not do

It does not name a player to add. A recommendation like that needs a free-agent
availability feed, and the ESPN read on this path returns the league's own box
scores, not who is unowned. So the segment reports the holes the week exposed —
the starters furthest under their own projection — and leaves the replacement to
the manager. Naming an available player the pipeline cannot see would be an
invention, which is the one thing this whole pipeline is built not to do.

### The FSN Index is a second copy, on purpose

`fsnPowerIndex()` lives inside index.html block 3 and reads `LeagueData`, so a
serverless run cannot call it. `lib/fsn-index.ts` is a faithful port —
`0.50·all-play + 0.20·PF + 0.15·consistency + 0.15·context` — because a reader
can open Analytics and check what the podcast just told them.
`scripts/podcast-segments-check.mjs` reads the weights and the shrinkage
threshold out of index.html and fails if the two disagree, so changing one forces
changing the other.

One deliberate divergence: the client's context pillar prefers managerial
efficiency and falls back to schedule hardship when ESPN omits the bench detail
(which its own comment notes is frequent). The port always takes the documented
fallback and reports `mode: 'sos'`.

## Running it

```
POST /api/cron/generate-weekly-podcast
     ?season=<year>       override; defaults to the current season
     &week=<n>            override; defaults to PODCAST_TARGET_WEEK
     &dry_run=1           resolve leagues and idempotency, write nothing
     &script_only=1       store the four segments, synthesize no audio
```

`GET` is accepted too, so a Vercel cron (which can only issue `GET`) works
unchanged. Auth is `Authorization: Bearer $CRON_SECRET` or `x-cron-secret`,
compared in constant time. With no secret configured the route refuses to run
rather than defaulting open.

### Week 2 testing boundary

`PODCAST_TARGET_WEEK` defaults to **2** and the run refuses any other week with
a `409`. The check is the first thing after auth — before the league sweep,
before any ESPN read, long before ElevenLabs — so a misfire on the wrong week
costs nothing. Set it to another week to move the boundary, or to `any` to lift
it. A malformed value falls back to week 2 rather than opening up.

The Tuesday workflow treats a `409` as a skip, not a failure, so the schedule
does not page anyone while the boundary is in force.

### Spend ceiling and the ledger

Every dialogue turn is one ElevenLabs call and the run fans out over every
active league, so:

- `PODCAST_CRON_MAX_LEAGUES` (default **5**) bounds how many leagues one
  invocation synthesizes for. Leagues over the cap are not lost — the next run
  finds no episode for them.
- Every attempt writes a `podcast_episode_runs` row with its turn count, byte
  size, segment count and failure reason, so a Tuesday's cost is attributable
  without reading the invoice. Apply `supabase/podcast_episode_runs.sql` before
  enabling the schedule.
- A league whose week produced no real segments is refused rather than
  synthesized: an episode of four empty rooms costs the same as a real one.
- `script_only=1` stores the segments and spends nothing. Such a row stays
  `generating`, because the table's own constraint requires an `audio_url`
  before a row may be `ready`, and calling a silent episode ready would lie to
  every client polling for one.

### Environment

Beyond the interactive path's variables:

- `CRON_SECRET` — required; must match the scheduler's.
- `PODCAST_TARGET_WEEK` — optional, defaults to `2`.
- `PODCAST_CRON_MAX_LEAGUES` — optional, defaults to `5`.

## Why the schedule lives in GitHub Actions

`.github/workflows/generate-weekly-podcast.yml`, `0 10 * * 2`. Three reasons,
the same ones that put the league blog articles there:

- Vercel cron jobs are always issued as `GET`; this schedule `POST`s.
- Day-of-week schedules and more than a couple of cron jobs need a paid plan.
- Both Hobby cron slots in `vercel.json` are already spent on the transaction
  wire and the notification dispatch. A third entry does not fail the build — it
  fails the deploy. `scripts/vercel-functions-check.mjs` now guards that ceiling
  alongside the twelve-function one.

On a paid plan, this is the equivalent `vercel.json` block:

```json
{
  "crons": [
    { "path": "/api/cron/generate-weekly-podcast", "schedule": "0 10 * * 2" }
  ]
}
```

The route itself needs no change for that: it accepts `GET`, and Vercel attaches
`Authorization: Bearer $CRON_SECRET` to its own scheduled invocations.

## Why the handler is in `lib/` and not `api/cron/generate-weekly-podcast.ts`

`api/` holds exactly twelve function files and the plan allows twelve. A
thirteenth fails the deploy with
`exceeded_serverless_functions_per_deployment`, taking production down rather
than just the new route — which has happened to this repo once already. So
`vercel.json` rewrites the public path into the existing cron slot:

```
/api/cron/generate-weekly-podcast  ->  /api/cron/generate-articles?action=podcast-cron
```

The handler is compiled into `lib/dist` (`npm run build:podcast`, output
committed) rather than left as TypeScript for Vercel to bundle, because it
reaches the ESPN boundary with `require('../../api/espn')` — a path Node
resolves at runtime relative to the *emitted* file. `lib/dist/` is the depth
that string is written for, and the article pipeline emits there for the same
reason.

## Verifying

```
npm run check:podcast-segments   # builds lib/dist, then the full pipeline check
npm run check:functions          # twelve functions, two cron slots, rewrites resolve
npm run check:podcast-lock       # the interactive endpoint's claim and season lock
```

`scripts/podcast-segments-check.mjs` runs the compiled modules against an
in-memory Supabase double and a stubbed voice provider: the index port against
index.html, all four segments and their honest empty states, determinism, the
week boundary refusing before any provider call, the league cap, idempotency
across two runs, and one ledger row per attempt. No credit is spent and nothing
is written anywhere real.
