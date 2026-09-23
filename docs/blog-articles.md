# FSN league blog articles

The foundation for AI-written league stories on the public blog. Three pieces:
a Supabase table, a math layer that decides what a performance meant, and a
pipeline service that composes copy against that math and publishes it.

It is additive. It reads box scores and writes one new table. It does not touch
`index.html`, the News Desk generators (block 4), the historical pipelines, the
`leagues` table, or the existing file-based `landing/content/blog` ingestion.

## Pieces

| File | Role |
|---|---|
| `supabase/blog_articles.sql` | The `public.blog_articles` table, indexes, RLS, trigger. |
| `lib/article-math.ts` | `calculatePlayerOutcomeFlags()` — margins and strict outcome flags. |
| `lib/article-generator.ts` | `generateAndPublishBlogArticle()` — fetch, classify, compose, guard, write. |
| `lib/article-selftest.js` | `npm run test:articles`. Runs against the compiled output. |

The two modules are TypeScript, compiled to `lib/dist/` by
`npm run build:articles` (`tsconfig.articles.json`). The compiled output is
committed because `vercel.json` sets an empty `buildCommand`: the deploy serves
the repository as-is, so a `.js` route requiring `lib/dist/article-generator`
must find it already there. `npm run test:articles` rebuilds first, so a stale
`lib/dist` fails the test run rather than the deploy.

## The math

Margins are always stated from the perspective of the team that started the
player. Positive is a lead, negative is a deficit.

- `entering_margin` — the matchup margin **before this player's NFL game kicked
  off**, computed from the points of starters on both sides whose own games had
  already kicked off. Bench and IR are excluded: their points are never on the
  board.
- `final_margin` — the finished matchup margin.

If any starter in the matchup is missing a kickoff time, `entering_margin` is
returned as `null` with `unresolved_reason: 'MISSING_KICKOFF_DATA'` and no flag
is assigned. Points that cannot be placed in time would silently manufacture a
deficit that never existed, so partial data is refused rather than approximated.

### The flags

| Flag | Condition |
|---|---|
| `GAME_WINNER` | `entering_margin < 0` and `final_margin > 0` and `player_points >= abs(entering_margin)` |
| `GARBAGE_TIME_BLOWOUT` | `entering_margin > 20` and `final_margin > 20` |
| `VALIANT_LOSS` | `final_margin < 0` and `player_points > 20` |
| `DUD_COST_WIN` | `entering_margin > 0` and `final_margin < 0` and `player_points < projected_points - 5` |

Evaluated in that order. A row matching nothing gets `outcome_flag: null`,
which means "nothing decisive happened" and is a real answer, never upgraded
into a story.

## The guardrail

The framing rule is handed to the model as a system instruction
(`OUTCOME_FRAMING_RULE`, quoted verbatim in `buildSystemPrompt`) **and**
enforced afterwards by `assertOutcomeLanguage`, sentence by sentence. Hero and
game-saver language is allowed only in a sentence that names a player the math
flagged `GAME_WINNER`. Em dashes are rejected too, matching the copy contract in
`scripts/build-blog.mjs`.

A violation throws. Nothing is rewritten in place (that would publish copy
nobody reviewed) and nothing is written to the table.

`defaultComposer` is a deterministic, model-free writer used when no composer is
injected. It keeps the pipeline runnable without model credentials and is the
reference for what compliant framing reads like: a `VALIANT_LOSS` is "a monster
game, wasted", a `GARBAGE_TIME_BLOWOUT` is "unneeded stat-padding".

## Calling it

```js
const { generateAndPublishBlogArticle } = require('../lib/dist/article-generator');

await generateAndPublishBlogArticle(
  { league_id: '123456', season: 2026, week: 2, day: 'tue' },
  { req },            // forwarded to the ESPN read boundary in api/espn
);
```

`day` maps to `article_type`: `mon` → `monday_sweat`, `tue` →
`tuesday_verdict`, `fri` → `friday_tnf_preview`.

Injectable dependencies: `db` (Supabase client), `fetchBoxScores`, `compose`
(a model-backed writer), `req`, `now`. Defaults are a service-role client from
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, the `api/espn` boundary, the local
composer, and the system clock.

The slug is deterministic — `<season>-week-<n>-<day-slug>-<league_id>` — and the
write is an upsert on it, so re-running a day overwrites its own row instead of
stacking duplicates.

## Failure behaviour

Every failure is logged with its subsystem tag (`[ArticleMath]`,
`[ArticleGenerator]`), the scope that failed, and the error object, then
rethrown. Nothing is swallowed: a resolved promise means there is a row in
`blog_articles`. A bad scope is rejected before any fetch or write happens.

---

# Scheduled generation

Three mornings a week a scheduler calls the cron route, which publishes one
article per active league that does not already have this week's story.

| Piece | Role |
|---|---|
| `api/cron/generate-articles.js` | The HTTP surface: auth, week resolution, response. |
| `lib/article-cron.ts` | The run itself: league sweep, idempotency, loop, audit. |
| `supabase/cron_article_logs.sql` | `public.cron_article_logs`, one row per league per run. |
| `.github/workflows/generate-articles.yml` | The three weekly triggers. |
| `lib/article-cron-selftest.js` | Covered by `npm run test:articles`. |

## The endpoint

```
POST /api/cron/generate-articles?day=mon|tue|fri
Authorization: Bearer $CRON_SECRET
```

`GET` is accepted too, so a Vercel cron (which can only issue GET) works
unchanged. Every response is `Cache-Control: no-store`.

| Parameter | Effect |
|---|---|
| `day` | Required. `mon` → `monday_sweat`, `tue` → `tuesday_verdict`, `fri` → `friday_tnf_preview`. |
| `season`, `week` | Optional override for a backfill. Both must be given together to skip the live lookup. |
| `dry_run=1` | Resolve the league list and the idempotency check, return what would be written, write nothing. |

### Authorization

`CRON_SECRET` must be set in the environment, presented as
`Authorization: Bearer $CRON_SECRET` (what Vercel attaches to its own scheduled
invocations) or `x-cron-secret` (what the workflow sends). The comparison is
constant time. **With no secret configured the route refuses every caller** —
it never defaults open, because an unauthenticated endpoint that writes an
article for every league is not something to leave to chance. The secret is
checked before the `day` parameter is even parsed, so the route cannot be
probed for valid inputs.

### Which week it writes about

Resolved from the shared NFL schedule feed, the same cached row
`lib/notifications/schedule-feed.js` keeps for the push dispatcher, so a normal
run costs no extra upstream request. The feed reports the week ESPN currently
considers live, which is what each morning wants:

- **Monday and Tuesday** — ESPN still reports the week whose games just played,
  so both recap that week.
- **Friday** — ESPN has rolled to the new week, whose Thursday night game was
  played the evening before.

A feed that cannot answer is a hard 503. A guessed week would publish this
week's story under last week's number and defeat the idempotency check for
both.

### Active leagues

Distinct `league_id` from `public.leagues` where `season_year` is the resolved
season. A row exists there only because a verified member of that league saved
it, so a row for the current season *is* the definition of active.

### Idempotency

One query per run, not one per league: every `league_id` already holding a row
in `blog_articles` for this `season`, `week` and `article_type` is skipped.
A retry, a double fire, or a manual run alongside the schedule therefore costs
nothing, and no reader ever sees a published story change under them.

If that query fails the run refuses to start. Republishing every league because
a read failed is worse than not running.

### Failure isolation

Each league is generated inside its own `try`. A failure is logged with
`[ArticleCron]`, the league, the week and the error object, recorded in
`cron_article_logs` with status `failed` and the message, and the loop moves to
the next league. A run where every league throws returns a summary, not an
exception.

The response is `200` with a per-league breakdown; `ok` is false when anything
failed or was left unattempted, which is what the workflow fails the job on.

### Time budget

The function is configured for `maxDuration: 60` in `vercel.json` and is killed
at it with no chance to respond. The run stops starting new leagues at 50s and
reports them as `not_attempted`. They are not lost: the next scheduled run
finds no article for them and publishes. This is the second reason idempotency
matters.

## The schedule

`.github/workflows/generate-articles.yml` fires three weekly triggers, all at
08:00 UTC (04:00 ET during the season):

| Cron | Day | Article |
|---|---|---|
| `0 8 * * 1` | Monday | `monday_sweat` — recaps the Sunday slate, previews MNF. |
| `0 8 * * 2` | Tuesday | `tuesday_verdict` — recaps the Monday night final. |
| `0 8 * * 5` | Friday | `friday_tnf_preview` — recaps TNF, previews the weekend slate. |

The three entries are deliberately not collapsed into the equivalent
`0 8 * * 1,2,5`. The job maps the schedule string that fired to the article it
writes, and GitHub queues scheduled runs under load: a run that starts well
after its slot still carries its own cron string, whereas reading the weekday
off the clock would publish Monday's article as Tuesday's after a long enough
delay.

It also takes a `workflow_dispatch` with `day`, `dry_run`, `season` and `week`,
for a manual run or a backfill, and a `concurrency` group so a manual run never
races the scheduled one into the same league week.

Setup: add a `CRON_SECRET` **repository secret** matching the one in the Vercel
project. Optionally set an `ARTICLE_CRON_BASE_URL` repository variable; it
defaults to `https://app.fantasysportsnetwork.app`.

### Running it on Vercel instead

GitHub Actions is used because Vercel cron jobs are always issued as `GET`,
day-of-week schedules and more than a couple of cron jobs need a paid plan, and
the project already spends two cron slots on the transaction wire and the
notification dispatch. If you would rather run it on Vercel, add to the `crons`
array in `vercel.json` and delete the workflow (running both would just make
the second one a no-op, but the duplicate alert noise is not worth it):

```json
{ "path": "/api/cron/generate-articles?day=mon", "schedule": "0 8 * * 1" },
{ "path": "/api/cron/generate-articles?day=tue", "schedule": "0 8 * * 2" },
{ "path": "/api/cron/generate-articles?day=fri", "schedule": "0 8 * * 5" }
```

Vercel injects the `Authorization: Bearer $CRON_SECRET` header itself, so no
other change is needed.

## Reading the audit trail

```sql
-- What happened this morning.
select league_id, article_type, status, error_message, executed_at
from public.cron_article_logs
order by executed_at desc limit 50;

-- Why one league has gone quiet.
select status, error_message, season, week, executed_at
from public.cron_article_logs
where league_id = '123456'
order by executed_at desc limit 20;

-- Every failure from one run.
select league_id, error_message
from public.cron_article_logs
where run_id = '2026-w3-mon-2026-09-21' and status = 'failed';
```

---

# In the app

The News Desk reads the league's own published articles and paints them above
the deterministic timeline.

| Piece | Role |
|---|---|
| `api/blog/articles.js` | Public `GET /api/blog/articles`, the one read boundary onto `blog_articles`. |
| `window.FSNLeagueArticles` (index.html, block 1) | Fetch, cache and state. The data half. |
| `renderLeagueBlog()` (index.html, last block) | The paint: cards, markdown, player chips, the player sheet. |
| `scripts/league-blog-check.mjs` | `npm run check:leagueblog`, a real Chromium render against a stubbed endpoint. |

## The endpoint

```
GET /api/blog/articles?league_id=123456&season=2026&week=3&limit=10
```

Public, no auth. These rows are published by definition. `league_id` is
required and filters every query, so no parameter combination returns a mixed
set; `season` and `week` narrow further, and with neither the league's most
recent articles come back newest first.

The response carries only published columns — `slug`, `title`, `excerpt`,
`content_markdown`, `article_type`, `tracked_players`, `season`, `week`,
`published_at`. The table's `id`, `league_id`, `created_at` and `updated_at`
are never serialized, and the select is an explicit allowlist rather than
`select('*')` so a column added later is never published by accident.

A present-but-unparseable filter (`week=banana`) is a 400, never a silently
dropped filter: returning the whole league would answer a question nobody
asked. Bad requests and failures are `no-store`; a successful read is cached
for five minutes at the edge with a day of stale-while-revalidate, matching the
static blog payload.

It is also reachable at `https://fantasysportsnetwork.app/api/blog/articles`.
The `fsn-landing` project has no `api/` of its own and no Supabase credentials,
so `landing/vercel.json` proxies that path to the app project rather than
duplicating the service-role key into a second deployment.

## FSNLeagueArticles

The data layer, at global scope in the first script block per the rule at the
top of `index.html`: the state is owned there and the paint lives in the last
block, which is a closed scope.

```js
FSNLeagueArticles.read(leagueId, week, season)   // what is known now, no network
FSNLeagueArticles.load(leagueId, week, season)   // fetch, using cache when fresh
FSNLeagueArticles.refresh()                      // pull to refresh: force a read
FSNLeagueArticles.subscribe(fn)                  // repaint on state changes
FSNLeagueArticles.clear()                        // drop every cached scope
```

Every read resolves to one of five states, so the renderer never has to infer
"nothing published yet" from an empty array plus a null error:

| State | Meaning |
|---|---|
| `idle` | Nothing asked for yet, or the scope is incomplete. |
| `loading` | In flight, with no cached copy to stand in. |
| `ready` | Articles in hand, possibly from cache. |
| `empty` | This league has nothing published for this scope. Not an error. |
| `error` | The read failed and there is no cached copy to fall back on. |

A cached payload paints immediately and refreshes behind the reader, so a
repeat visit is instant; `stale` says what is on screen came from cache while a
refresh runs, which is what drives the quiet updating hint instead of a
blocking spinner. A read that fails while a cached copy exists keeps the cached
copy: the reader would rather see this morning's story than a failure they
cannot act on.

An HTTP 404 is treated as `empty`, not `error`, and logged as a warning. It
means the endpoint is not on this deployment at all — a static preview, a local
harness, or a build predating this feature — and the app shipped for years
without a league blog. Any other status, a network fault or a timeout is a real
fault and is logged as one.

The cache key is `league:season:week` and a payload cached under a different
scope is refused rather than painted, so one week's stories can never appear
under another's header.

## The News Desk section

`renderLeagueBlog()` paints `#leagueBlogWrap`, which is hidden outright until
the league has something published for the viewed week. Everything below it —
the lead story, the timeline, the topic bar — is the existing deterministic
News Desk and is untouched. The call sits behind its own `try` inside
`renderNews()`, so a failure in the remote feed can never stop the desk from
rendering.

Unlike the desk wire, this section needs **no season/week gate**. The desk wire
reads the root-domain blog, which publishes real-world NFL copy dated to today
and would misrepresent itself in a historical view. Every article here is
stored against an explicit league, season and week and is requested by those
three coordinates, so a Week 3 article is correct on the Week 3 view and
nowhere else by construction.

### Markdown

A deliberately small subset: headings, bold, italic, inline code, links,
unordered lists and paragraphs. That is everything the generator emits. Text is
escaped **first** and markup applied to the escaped string, so no article body
can inject markup whatever the pipeline wrote into it; links are rewritten to
`http(s)` only. `scripts/league-blog-check.mjs` puts an `<img onerror>` and a
`<script>` in a fixture body and asserts neither becomes an element.

### Tracked player chips

`tracked_players` renders as "N PLAYERS TRACKED" and one chip per row, dot
coloured by outcome flag. A tap opens the shared player sheet with that row's
own numbers: points, projection, the margin before his game, and the final
margin.

Chips are keyed by position in the array, not by player id: two rows can
legitimately name the same player (one per side of a matchup), and the sheet
must open the row that was tapped.

The sheet's verdict line restates the outcome flag and nothing more. A player
who is not flagged `GAME_WINNER` is never described as having won anything,
exactly as in the generator that wrote the article, and the check asserts that
in both directions for all four flags plus the unflagged case.
