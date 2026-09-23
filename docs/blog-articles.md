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

### Where kickoff times come from

**The ESPN fantasy league endpoint carries none.** It never has. So for the
first weeks this pipeline ran, every starter resolved to `kickoff: null`, every
matchup was `MISSING_KICKOFF_DATA`, no outcome flag was ever assigned, and every
published article read "No Swings To Report" with an empty impact summary. The
points were real; only the timing was missing.

They live on the public NFL scoreboard, which `lib/notifications/schedule-feed.js`
already reads for the push dispatcher, on a host already allowlisted:

| Piece | Role |
|---|---|
| `scoreboardUrl({season, week})` | The scoreboard for **one named week** (`?dates=&week=&seasontype=2`), which a backfill needs and the dispatcher's current-week `pull()` cannot answer. |
| `parseProTeamKickoffs(payload)` | Pure. Every NFL team in the document → its kickoff instant, keyed by **both** numeric ESPN team id and uppercase abbreviation, because the fantasy payload identifies a player's team by `proTeamId` and some shapes carry only an abbreviation. |
| `pullKickoffs({season, week})` | One request, one week. Throws rather than returning `{}`, because an empty index silently reproduces the exact bug it exists to remove. |
| `OutcomeOptions.kickoffs` | The index, handed to the math. `article-math.ts` stays pure and never fetches. |
| `GenerateDependencies.fetchKickoffs` | Injectable; defaults to `pullKickoffs`. |

A team on bye is **absent** from the index, not zero: it has no game, and a
starter on bye scores nothing and cannot move a margin.

An entry that states its own kickoff **outranks** the index. A payload naming a
kickoff for one specific player knows something the league-wide schedule does
not, such as a relocated game.

A scoreboard read that fails is logged and the run continues: the article then
carries the unresolved margins it would have had anyway. Losing a league's
article entirely is worse than losing its swing analysis, and `GenerateResult`
reports `kickoffs` (how many teams the index covered) so a cron summary shows
zero rather than leaving it to be inferred from the copy.

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

`impactSummary()` derives tier 2 from the flag and nothing else, with fixed
grammar per flag, so the callout can never say more than the math supports:
only `GAME_WINNER` gets "just enough", and a big score in a loss is "not
enough" rather than anything warmer.

When a week carries several flagged performances, the callout picks by a stated
order rather than inheriting `featuredTrackedPlayers`' news ranking, which put a
wasted 74 ahead of the player who actually swung a matchup:

    GAME_WINNER  >  DUD_COST_WIN  >  VALIANT_LOSS  >  GARBAGE_TIME_BLOWOUT

A matchup that was won outranks one thrown away, which outranks a big score
that changed nothing, which outranks padding in a game already decided. Within
a flag the math's own ranking breaks the tie, so the choice stays deterministic
for a given league, season and week. The summary is passed through
`assertOutcomeLanguage` with the rest of the copy — a callout is the most
prominent line on a card after the headline, and the last place an unbacked
hero claim should be able to slip through.

Adding the three tiers left `title`, `excerpt` and `content_markdown` byte for
byte what they were: a published article's copy does not change because a new
column was added beside it.

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
| `window.FSNLeagueArticles` (index.html, block 1) | The week on screen. Fetch, cache and state. |
| `window.FSNSupabaseArticles` (index.html, block 1) | The league's active stories, no week coordinate. Same five states. |
| `fsnNormalizeArticles()` (index.html, global, block 1) | The three-tier resolver both engines share. |
| `renderLeagueBlog()` (index.html, last block) | The paint: cards, markdown, player chips, the player sheet. |
| `scripts/league-blog-check.mjs` | `npm run check:leagueblog`, a real Chromium render against a stubbed endpoint. |
| `scripts/news-screen-shot.mjs` | `npm run shot:news`, a PNG of the card. A look, not a check. |

## The endpoint

```
GET /api/blog/articles?league_id=123456&season=2026&week=3&limit=10
```

Public, no auth. These rows are published by definition. `league_id` is
required and filters every query, so no parameter combination returns a mixed
set; `season` and `week` narrow further, and with neither the league's most
recent articles come back newest first.

The response carries only published columns — the three tiers (`headline`,
`match_impact_summary`, `content`) and the meta line (`category`, `author`),
plus `slug`, `article_type`, `tracked_players`, `season`, `week`,
`published_at` and the legacy `title` / `excerpt` / `content_markdown`. The
table's `id`, `league_id`, `created_at` and `updated_at` are never serialized,
and the select is an explicit allowlist rather than `select('*')` so a column
added later is never published by accident.

A present-but-unparseable filter (`week=banana`) is a 400, never a silently
dropped filter: returning the whole league would answer a question nobody
asked. Bad requests and failures are `no-store`; a successful read is cached
for five minutes at the edge with a day of stale-while-revalidate, matching the
static blog payload.

### The active read

```
GET /api/blog/articles?league_id=123456&active=1&limit=6
```

`active=1` asks for the league's currently live stories: everything already
published, newest first, with no week coordinate. The only thing it adds over
an unfiltered read is the `published_at <= now` floor, which excludes a row
dated into the future. The pipeline does not write those, but a backfill and
the publish route both accept an explicit `published_at`, so a story staged for
tomorrow morning is a real possibility and must not appear on a phone tonight.

It composes with the other filters rather than replacing them, so
`active=1&season=2026` is a legal narrowing and means what it reads like. The
response echoes `active` so a client can tell which read it got back. An
unrecognised value (`active=maybe`) is a 400, for the same reason `week=banana`
is.

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

## The three-tier article

A card reads in three tiers, and the schema, both endpoints and the renderer
all describe them in the same order:

| Tier | Column | What it is |
|---|---|---|
| 1 | `headline` | The prominent title at the top of the card. |
| 2 | `match_impact_summary` | One line: what a performance meant to a matchup. Painted in a highlighted callout directly under the headline. |
| 3 | `content` | The markdown narrative, below the callout. |
| meta | `category`, `author` | The editorial shelf ("Matchup Recap", "Waiver Wire") and the byline ("FFU News Desk"). |

### Backward compatibility, in both directions

`title` and `content_markdown` are the original columns and are **kept**. They
are NOT NULL on the table, they are what the static blog build reads, and
dropping them to tidy the payload would break a reader this pipeline cannot
see. So every row carries both namings, and every reader resolves:

```
headline = article.headline || article.title
content  = article.content  || article.content_markdown
```

That fallback is applied in four places on purpose, because each one sees a
case the others do not:

| Where | The case it covers |
|---|---|
| `mffu_sync_blog_article_tiers` (trigger) | A writer that knows only one generation of names. Runs before the NOT NULL checks, so an insert carrying only `headline`/`content` succeeds. |
| `api/blog/articles.js` | A row written before the columns existed. |
| `api/blog/articles-publish.js` | A caller written before the columns existed. |
| `FSNLeagueArticles.normalize()` | A payload cached under the previous shape and read back out of `localStorage` after an app update, or an older deployment's endpoint. |

A row with no `match_impact_summary` paints **no callout at all** rather than
an empty band, and a row with no `category` falls back to the shelf its
`article_type` belongs to. `CATEGORY_BY_TYPE` is spelled out identically in
`lib/article-generator.ts`, `api/blog/articles.js` and block 1 of
`index.html`; the three must agree.

### A database that has not been migrated yet

`vercel.json` sets an empty `buildCommand`, so a deploy can reach production
before `supabase/blog_articles.sql` has been run against its database. All
three touch points (the read route, the publish route and the pipeline's own
`store()`) detect PostgREST's `42703` "column does not exist", log a warning
naming the file to run, and retry against the legacy columns. An unmigrated
database therefore serves and stores the same stories in the legacy shape
instead of 502-ing over articles that are sitting right there.

`public.articles` is a `security_invoker` view over `blog_articles` that
resolves the fallbacks in SQL, for anything that would rather select `headline`
than `coalesce(headline, title)`. The table keeps its name: a rename would
break every route, index name and compiled module for cosmetics.

---

# Publishing

```
POST /api/blog/articles/publish
Authorization: Bearer $CRON_SECRET
Content-Type: application/json

{
  "league_id": "123456",
  "season": 2026,
  "week": 3,
  "headline": "Ridgeback FC Survive The Late Window",
  "match_impact_summary": "Monday Back scored 20 points, just enough for Ridgeback FC.",
  "content": "# The late window\n\n...",
  "category": "Matchup Recap",
  "author": "FFU News Desk"
}
```

| Piece | Role |
|---|---|
| `lib/blog-publish.js` | The handler. |
| `api/blog/articles.js` | Dispatches to it on `?action=publish`, before any read header is applied. |
| `vercel.json` rewrite | Maps the public `/api/blog/articles/publish` onto that, the same way `/api/auth/yahoo/callback` is mapped. |
| `scripts/vercel-functions-check.mjs` | `npm run check:functions`, the budget that keeps this arrangement necessary. |
| `lib/blog-publish-selftest.js` | Covered by `npm run test:articles`. |

**Why the handler is in `lib/` and not its own file under `api/`.** Vercel makes
every file under `api/` a Serverless Function and the Hobby plan allows twelve;
this project has exactly twelve. A thirteenth does not fail the build — the
build succeeds, prints "Build Completed", and then the *deploy* fails at
patchBuild with `exceeded_serverless_functions_per_deployment`, taking the whole
production deployment down rather than just the new route. Adding
`api/blog/articles-publish.js` did exactly that, with every test green.

So a new endpoint shares an existing route behind an `?action=` rewrite, which
is why `/api/notifications-register`, `/api/notifications-selftest`,
`/api/transaction-wire-dispatch` and `/api/auth/yahoo/callback` are shaped that
way too. `npm run check:functions` enforces the budget and also verifies every
rewrite destination names a function that exists.

The dispatch happens **before** `applyHeaders()`: the read is public,
any-origin and edge-cached for five minutes, and the write is none of those.
Publish is selected only by an explicit `action=publish`, so a stray `POST` to
the read URL stays the 405 it always was rather than being taken for a publish
attempt.

The write boundary onto `blog_articles`, and the counterpart to the public
read. The table is RLS-protected with no browser policies, so the only two ways
in are the server-side pipeline (which holds the service-role key directly) and
this route.

**Auth** is `CRON_SECRET`, as `Authorization: Bearer $CRON_SECRET` or
`x-cron-secret`, compared in constant time by the same helper the scheduled
generator uses. With no secret configured the route refuses every caller rather
than defaulting open, and the check happens **before the body is parsed**, so
the route cannot be probed for valid inputs. There is deliberately no CORS
allowance: the read is public because published articles are public, and a
browser has no business holding a publishing secret.

**Fields.** `league_id`, `season`, `week` and a headline and body are required;
the headline and body may arrive under either generation of names. Everything
else is optional. `author` defaults to `FFU News Desk`, `category` to empty
(the reader then falls back to the article type's shelf), `article_type` to
`league_dispatch` — the type for a story published outside the
Monday/Tuesday/Friday schedule, and the one value the check constraint in
`supabase/blog_articles.sql` was widened to allow. Every field is bounded, and
a present-but-unusable one is a 400 that never reaches the table.

The markdown body is stored **verbatim**, not trimmed: a trailing newline is
part of what the generator wrote, and a story read back out of the table should
be byte for byte the story that was published.

**Idempotency** is an upsert on `slug`, exactly as the pipeline's is. With no
slug supplied the deterministic
`<season>-week-<n>-<category-slug>-<league_id>` is used, so re-publishing the
same story overwrites its own row instead of stacking duplicates and a retry
after a timeout costs nothing.

---

## FSNSupabaseArticles

The active feed, also at global scope in the first block.

```js
FSNSupabaseArticles.fetch(leagueId)                // cache when fresh
FSNSupabaseArticles.fetch(leagueId, {force:true})  // always go to the network
FSNSupabaseArticles.read(leagueId)                 // what is known now, no network
FSNSupabaseArticles.refresh()                      // re-read the last league
FSNSupabaseArticles.subscribe(fn)                  // repaint on state changes
FSNSupabaseArticles.clear()                        // drop every cached league
```

Same five states, same cache-outranks-an-error posture, same 404-is-`empty`
rule as `FSNLeagueArticles`. Its scope is a league id and nothing else, its
cache key and storage prefix are its own, and it refuses a payload whose
`league_id` does not match what it asked for.

**Why it exists alongside `FSNLeagueArticles`.** That engine reads one week,
which is correct: an article is stored against an explicit league, season and
week, so asking by those three coordinates puts a Week 3 story on the Week 3
view and nowhere else. What it cannot answer is "what has this league published
lately", and three publishing mornings a week means most visits land on a week
with no story of its own. Hiding the section outright on those visits is what
made the feed look disconnected.

**Why it is not a browser Supabase client.** `blog_articles` has RLS enabled
and no anon or authenticated policies: the browser holds no key that can read
it and is never given one, because a service-role key in a static file is a
service-role key in every reader's devtools. `/api/blog/articles` is the read
boundary, exactly as `/api/league` is for league storage, so "fetch from
Supabase" means fetch through that route. Same posture as the transaction wire
and the cloud archive.

**The shared resolver.** `fsnNormalizeArticles()` and `fsnArticleTiers()` are
at global scope rather than inside either IIFE, per the rule at the top of
`index.html`: both engines resolve rows with them, and a copy inside one would
be invisible to the other and let the two feeds drift on what an article is.

## The News Desk section

`renderLeagueBlog()` paints `#leagueBlogWrap` from **both** feeds, and only
ever one of them at a time, so no article can be painted twice:

1. **The week on screen leads.** When `FSNLeagueArticles` has stories for it,
   those are the section, under a `WEEK n` label. This is exactly what the
   section did before the active feed existed.
2. **The active feed stands in** when the week has nothing, under a `LATEST`
   label: the league's most recent coverage, whatever week it belongs to.
3. Both still loading with nothing to stand in → one loading line. Both done
   with nothing, and either read failed → one honest sentence saying the
   coverage could not be reached. Both done and genuinely empty → the section
   is hidden outright, as before.

The header label always says which of the two is on screen, and each card names
the week its own story belongs to.

Everything below the section — the lead story, the timeline, the topic bar — is
the existing deterministic News Desk and is untouched. The call sits behind its
own `try` inside `renderNews()`, so a failure in either remote feed can never
stop the desk from rendering.

**The gate.** The week-scoped feed needs none: every article it returns was
requested by the exact season and week on screen. The active feed is held back
outside the live season (`lbOnLiveSeason()`), because it is not season-scoped
and would otherwise offer 2026 stories on a 2019 retro view, which a reader
only reaches by choosing it.

Within the live season it is deliberately **not** gated on the week. Each card
names its story's week and the header says `LATEST`, so nothing is presented as
the viewed week's own coverage, and the app's default landing week can
legitimately sit behind the week the league has rolled forward to
(`effectiveWeek()` 2 while `currentLeagueWeek()` reads 3 is an ordinary
Tuesday). A week comparison would suppress the feed on exactly the view where a
reader who has navigated nowhere most wants it.

A gate that throws returns false: holding the fallback back costs the reader a
section they were not promised, while guessing wrong puts one season's copy
under another's name.

**The refresh control** drives both feeds through `Promise.allSettled`, because
refreshing one and not the other would leave the reader looking at a stale
fallback after asking for fresh copy, and one feed failing must not cancel the
other's repaint or leave the button disabled.

**On a league switch**, `clearLeagueStateForSwitch()` clears both stores.

### The echoed heading

The generator opens every body with `# <title>`, which was right when the card
painted the body and nothing else. The headline is now its own tier directly
above it, so that first heading would print the same words twice.

`lbStripEchoedHeading()` drops it **at paint time, not at write time**: the
stored article is what was published and is not rewritten. A body whose opening
heading says something *different* from the headline keeps it, because then it
is a real heading rather than a restatement. The comparison is on letters and
digits only, so punctuation or casing drift between the two does not defeat it.

### Seeing the card

```
npm run shot:news                            # writes news-screen.png
npm run shot:news -- --out /tmp/a.png
npm run shot:news -- --payload article.json  # a real published article
```

Boots the real `index.html` in Chromium at phone width against a stubbed
endpoint, opens the News tab and writes a PNG of `#leagueBlogWrap` with a
three-tier article on it, then prints what landed in each tier. It hides the
fixed tab bar for the capture, which would otherwise composite over the bottom
of the section and clip the tracked-player chips.

It is a **look, not a check**: `npm run check:leagueblog` is what asserts. This
exists so a change to the card can be reviewed on a phone-width viewport
without a device. Its article is a fixture, read from no one's league and
written nowhere, and `--payload` serves a real one instead (a single article
object in the shape the endpoint returns) for looking at a story the pipeline
actually published. `news-screen.png` is gitignored.

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
