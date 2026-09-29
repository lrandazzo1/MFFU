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
| Trigger | A reader taps GENERATE in Studio, once the week has closed | Tuesday 10:25 UTC, every active league |
| Script | `lib/podcast-news-script.ts`, authored server-side | `lib/podcast-news-script.ts`, authored server-side |
| Auth | Per-league `x-league-token` | `CRON_SECRET` |
| Public path | `POST /api/generate-podcast` | `POST /api/cron/generate-weekly-podcast` |

Both land in the same `podcast_episodes` row for a league week, and the primary
key is the mutex, so whichever arrives first wins and the other observes it.

## Both triggers now produce the same script

The button used to author its own script: `studioDraft()` assembled four turns
of narration in the browser from whatever News Desk headlines were on screen and
POSTed them as `lines`. The Tuesday run built the ~60 second news recap from
`blog_articles`. Same table, same player, two different shows — and the manual
one was the shallower of the two.

`lines` is now **optional** on `POST /api/generate-podcast`:

- **Omitted** — the route reads the league week's `blog_articles` payload with
  `readNewsPayload()` and builds the script with `buildNewsPodcastScript()`.
  That is literally the generator the cron calls, so the two paths cannot drift:
  `scripts/podcast-segments-check.mjs` asserts the stored episode is turn-for-turn
  identical to what the generator produces for that payload.
- **Present** — honoured as before. App builds already in the wild post their
  own `lines`, and an episode they generate must not fail.

Two consequences worth knowing:

- **The script is built before the `generating` claim is inserted.** A league
  whose weekly article has not published has nothing to narrate and the route
  answers 422. If that answer came from inside the claim it would strand a
  `generating` row — the inner `catch` only fires on a throw — and the
  ten-minute staleness sweep would flip it to `failed`, locking the league week
  for good. Nothing is claimed until there is a script to record.
- **An empty News Desk no longer blocks generation.** `studioDraft()` is still
  consulted, but only for the Story Reel visuals (snapshots of rendered cards,
  which only a browser can produce) and the local archive id. A null draft
  degrades to an episode whose Story Reel falls back to headline cards, instead
  of refusing to generate.

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
     ?season=<year>         override; defaults to the current season
     &week=<n>              override; defaults to the just-completed week
     &dry_run=1             resolve leagues and idempotency, write nothing
     &script_only=1         store the four segments, synthesize no audio
     &allow_open_week=1     skip the "this week has finished" check
```

`GET` is accepted too, so a Vercel cron (which can only issue `GET`) works
unchanged. Auth is `Authorization: Bearer $CRON_SECRET` or `x-cron-secret`,
compared in constant time. With no secret configured the route refuses to run
rather than defaulting open.

### Tuesday morning, and only once the week has closed

The run is a Tuesday-morning artefact. `25 10 * * 2` (06:25 ET in season) puts it
well after the Monday night final and 145 minutes after the Tuesday **article**
run, which is not a coincidence: the default `news` format narrates the
`blog_articles` row that article writes, so a podcast run that starts before
`0 8 * * 2` has finished finds either no payload at all, or the **Monday** row —
a preview of a week that has not been played — and idempotency then locks that
wrong episode in for the whole week.

The gap is not what orders the two. GitHub queues scheduled workflows and starts
them late under load, per workflow and independently, so a nominal gap of any
size can be consumed by a busy morning; it used to be one hour, both jobs sat on
minute 0 (the most contended minute of the hour), and nothing checked the
outcome. What orders them is the `article-gate` job in
`.github/workflows/generate-weekly-podcast.yml`: it polls this repository's own
workflow-runs API for the Tuesday `generate-articles` run and holds the podcast
job until that run reaches `completed`, for up to an hour, before anything is
POSTed. A manual dispatch skips the gate — a rehearsal or a catch-up names its
own week. A *failed* article run does not stop the gate: that run exits non-zero
when any single league throws, and the leagues it did write still deserve their
episode.

A league the article run did not cover fails `ARTICLE_NOT_READY`, which is the
one failure reason that **releases its claim** instead of marking the row
`failed`. It is raised before ESPN, before ElevenLabs and before Storage, so
nothing was spent and there is no double-billing to prevent; leaving a `failed`
row behind would make `leaguesAlreadyRecorded()` skip that league for the rest of
the week, recoverable only by a forced catch-up that *does* re-bill. The run
still counts it in `failed` and still exits non-zero.

`scripts/podcast-segments-check.mjs` asserts all of it: the 90-minute minimum
margin, that neither Tuesday job sits on minute 0, that the gate and its `needs:`
wiring are intact, and that a missing payload leaves no row behind while a
provider failure still does.

The clock alone is not the guarantee, because a Monday night game can run long
and a stat pass can land late. Before the league sweep, before any ESPN read and
a long way before ElevenLabs, the route asks the NFL scoreboard whether the week
it is about to recap has actually finished:

- every game of the week reports `completed`, or the `post` state → generate;
- anything still open → `409`, which the workflow reports as a **skip**, not a
  failure. Nothing is claimed, nothing is spent, and the next run finds the same
  leagues with no episode for the week and picks them up.

A week the scoreboard reports **no games** for is not "probably finished" — it
is `complete: false`. "I cannot see this week" and "this week is over" are
different answers, and defaulting the unknown to complete is how a scheduled run
narrates a week nobody played. `lib/week-complete.ts` owns that read; its
`parseWeekCompletion()` is pure and counts both status shapes ESPN ships (on the
event, and on the event's first competition).

### Which week the run recaps

The schedule sends no `?week=`. Three sources answer, in precedence order, and
all of them end at a week whose box scores are closed:

| Source | When | Week |
|---|---|---|
| `?week=N` | a backfill or a scoped re-run | as asked, then checked for completion |
| `PODCAST_TARGET_WEEK=N` | the variable pins one week | that week, then checked for completion |
| unset, or `=any` | **the default** | `resolveRecapWeek()` |

`resolveRecapWeek()` takes the **just completed** week, never the one about to
start. It reads the week the NFL scoreboard currently calls live and tries two
candidates in order:

1. **the live week** — on Tuesday morning ESPN is still reporting the week whose
   games just played (the same behaviour the Tuesday blog article relies on), so
   this is the normal answer;
2. **the week behind it** — for a run that lands after ESPN has already rolled
   over: the live week's games are all in the future, so the finished week is the
   one before it.

The run's own response records what it did: `week_source` (`live_week`,
`previous_week`, `boundary` or `override`), `week_complete`, and
`week_games_final` as `finished/total`.

`allow_open_week=1` skips the completion check for a named week. It exists for a
deliberate mid-week rehearsal and for the case where the scoreboard read itself
is what is broken. Nothing on the schedule passes it.

**While `PODCAST_TARGET_WEEK` pins a week, the resolver never runs.** The pinned
week is used and checked, and every other week is refused with a 409. The
variable is **not set in the deployment**, which is what makes the resolver the
live path — see the section below for why that used to be the opposite.

### Studio's button follows the same rule

Generation is no longer a thing a reader can do in the middle of a week.
`studioGenerationLock()` in index.html returns a fourth reason, `'midweek'`,
whenever the week on screen has not closed, and the screen says so:

| State | Studio |
|---|---|
| The week is still being played | The button is **disabled** and reads `🎙️ Weekly Recap Unlocks Tuesday After MNF`, with a note explaining when it unlocks |
| The week has closed and no episode exists | The button is enabled: `GENERATE WEEKLY RECAP` |
| An episode exists | The player carries it and the button reads `EPISODE READY` |

Completion is read client-side by the global `weekBoxScoresComplete()` (block 1,
per rule 1 — the Studio renderer in the UI block calls it). It uses
`scheduleMatchupNarrativeFinal()`, not `scheduleGameFinal()`: ESPN routinely
leaves `winner` on UNDECIDED for hours after the Monday night whistle while stat
corrections settle, and a recap that waited for the official flag would still be
locked on Tuesday morning with every starter's game long over. A week with no
regular-season matchup loaded is **not** complete, for the same reason the server
refuses a week the scoreboard shows no games for.

**Reading is not gated on any of this.** A past week still polls for, loads and
plays the episode its league generated at the time, and an archive card still
opens its stored audio from Supabase Storage. Only minting a NEW episode is
locked. `scripts/studio-episode-check.mjs` asserts both halves: the disabled
mid-week button beside its note, and a completed week that still plays its
episode without a single POST to the generation endpoint.

### The optional week pin (was: the week 2 testing boundary)

`PODCAST_TARGET_WEEK` is **unset**, and unset means `any`: the run recaps
whatever week just ended. Set it to a week number to pin every run to that one
week and refuse the rest with a `409` — a rehearsal lever, not the spend guard.
The check is the first thing after auth — before the league sweep, before any
ESPN read, long before ElevenLabs — so a misfire on the wrong week costs
nothing. A malformed value is ignored with a loud `console.error` and the run
falls back to `any`, because a typo must not silently pin the schedule to a week
nobody chose.

It **defaulted to week 2** while the four-segment pipeline was being tested, and
since the variable is not set in the Vercel project that default *was* the
behaviour: every Tuesday run could only ever have produced week 2, and every
other week was a 409. The guard that replaced it does not need a human to move
it every week — the week has to be finished, a league that already holds a row
for it is skipped, `PODCAST_CRON_MAX_LEAGUES` bounds the fan-out, and every
attempt lands in `podcast_episode_runs`.

The Tuesday workflow treats a `409` as a skip, not a failure, so neither a pin
nor an unfinished week pages anyone.

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
- `PODCAST_TARGET_WEEK` — optional. Unset (the deployment's state) means the
  run recaps whatever week just ended; a week number pins every run to it.
- `PODCAST_CRON_MAX_LEAGUES` — optional, defaults to `5`.

## Why the schedule lives in GitHub Actions

`.github/workflows/generate-weekly-podcast.yml`, `25 10 * * 2`. Three reasons,
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
    { "path": "/api/cron/generate-weekly-podcast", "schedule": "25 10 * * 2" }
  ]
}
```

Note what that block gives up: a Vercel cron fires on the clock and cannot wait,
so moving the schedule there drops the `article-gate` job and puts the ordering
back on the nominal gap alone. The `ARTICLE_NOT_READY` claim release keeps the
week recoverable either way, but the gate is what keeps the wrong episode from
being minted in the first place.

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
week boundary refusing before any provider call, the week resolver and its
completion gate (both fed stubbed scoreboards — nothing is fetched), the league
cap, idempotency across two runs, and one ledger row per attempt. No credit is spent and nothing
is written anywhere real.


---

# The ~60 second news-payload recap (default format)

A second script format, and the one the cron builds by default. It exists
because the four-segment long form had three problems: it made a live ESPN call
during script generation, it recited totals instead of reading them in context,
and its scaffolding was one fixed template per slot, so every week read the
same.

| | Four-segment long form | News recap (default) |
|---|---|---|
| Format value | `segments` | `news` |
| Input | live ESPN box score | `blog_articles` row, already local |
| External calls | ESPN + kickoff feed | **none** |
| Turns | 8 | 4-6 |
| Length | ~1,900 chars | ~800-950 chars, 140-160 words, ~60s |
| Shape | 4 named segments | intro 10s, body 35s, outro 15s |

## No external call

`readNewsPayload()` reads one `blog_articles` row for the league, season and
week: `tracked_players` (the eight evaluated stat lines the Tuesday article cron
already computed), plus that row's `headline` and `match_impact_summary`. One
Supabase select replaces one external API call, and the podcast cannot disagree
with the article the league is also reading, because it *is* the article's data.

A league whose article has not published yet has no payload, which is an
ordinary skip rather than a failure. `scripts/podcast-segments-check.mjs` proves
the absence of fetching directly: it runs the format with a `fetchBoxScores`
that throws, and the episode still builds.

## Where the depth comes from

Not new copy — `lib/article-generator.ts` already owns an archetype matrix that
reads a performance in context. `archetypeFor()` weighs the outcome flag against
the deficit the player's team was carrying when he kicked off, the finishing
margin, and whether it happened under the lights, across nine archetypes. So a
47.5-point week is not "beat his projection by 28":

> Jaxon Smith-Njigba erased a 42.5 deficit with 47.5 points to secure a 20 point
> win for Nicholas Sheffington.

The flag contract behind it still refuses to call a player decisive in a matchup
his team lost.

## Why it stops reading the same every week

Each archetype carries two phrasings and `newsVariants()` seeds the first
appearance of each from a league-week hash, then alternates strictly, so two
performances of the same archetype never read alike. Eighteen body shapes. The
intro and sign-off draw from their own four-entry pools on the same seed.

Two things were wrong before and are worth recording, because both were
*measured* rather than reasoned about:

1. `rotateVariants()` seeds from `(playerId + week) % 2`, so the week only moves
   the answer by its **parity** — weeks 2 and 4 produced byte-identical bodies.
2. Replacing it with a string hash did not help, because every consumer takes
   the seed modulo a small number and a polynomial hash makes the low bits a
   near-linear function of the last characters: `…:2026:2` and `…:2026:4` differ
   by 2, so bit 0 was still identical. `weekSeed()` is now FNV-1a plus a
   murmur3 finalizer so bit 0 depends on the whole string.

With real weekly data the check measures **10 distinct bodies across 10 weeks**.
Holding the payload artificially constant it collapses to about three, which is
the honest ceiling of two phrasings per archetype: more variety means writing
more phrasings, which is a deliberate authoring task.

## Speech shaping

`sentenceFor()` is written for markdown and a reader. `speakable()` adapts it:
bold markers stripped, `pts` said as `points`, figures cut to one decimal
(`47.50` reads as "forty seven point five zero"), and `a 18.1` corrected to
`an 18.1`, since the indefinite article has to agree with how the number is
*spoken*.

One artifact is inherited on purpose: some blog templates read
`<team> were 25.9 down`, which is natural for a team name and odd for a manager's
own name. Fixing it means editing published blog copy, so it is left alone.

## Length

140-160 words, chosen by measuring rather than guessing: candidate performance
counts are tried in preference order and the first landing in the window wins.
The count is an integer, so some payloads have no count that fits a 20-word
window; the closest is used and the shortfall reported in `words` rather than
padded with filler. `WORD_GRACE` keeps a miss of a couple of words from logging.

## Regenerating one league's episode

The route is idempotent: a league that already holds a row for the week — in any
status, `failed` included — is skipped. So a regeneration is two steps, and the
first one is destructive.

```sql
-- 1. look at what you are about to replace
select league_id, week, status, audio_url,
       jsonb_array_length(episode->'lines') as turns,
       (episode->'markers'->-1)::text as runtime_seconds
from podcast_episodes where league_id = '<id>' and season = 2026 and week = <n>;

-- 2. clear the row (keep a copy first; this cannot be undone)
delete from podcast_episodes where league_id = '<id>' and season = 2026 and week = <n>;
```

Then run the generation **scoped to that league**:

```
gh workflow run "Weekly podcast" -f mode=live -f week=<n> -f league=<id>
node scripts/generate-podcast.mjs --week=<n> --league=<id>     # needs real keys
POST /api/cron/generate-weekly-podcast?week=<n>&league=<id>
```

`league` is optional and absent means the full sweep, which is what the Tuesday
schedule wants. **Do not omit it for a re-run.** The sweep also generates,
publishes and bills for every other active league that happens to have no row
for that week — at one ElevenLabs call per dialogue turn each — and those
leagues' members did not ask for an episode. A league id that is not active for
the season is refused with 404 rather than quietly running an empty sweep, and
the workflow fails the run if the endpoint reports a different league than the
one asked for.

The storage upload on this path uses `upsert: true`, so the MP3 at
`<league>/<season>/<week>.mp3` is replaced in place and every client polling the
row picks up the new audio at the same URL.

## Selecting a format

```
POST /api/cron/generate-weekly-podcast          # news, the default
node scripts/generate-podcast.mjs --format=segments --week=2 --dry-run
```

The run summary reports which format it built in its `format` field.
