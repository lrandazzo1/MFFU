# FSN Blog content

Drop article source files into this directory (`landing/content/blog/`). The
ingestion pipeline (`scripts/build-blog.mjs`, run from the repo root) reads them
and compiles the deploy payload into `landing/content/generated/blog/`.

The blog is served on the root domain (`fantasysportsnetwork.app`) by the
`fsn-landing` Vercel project, whose deploy root is `landing/`. The public pages
at `/blog` and `/blog/<slug>` fetch that generated payload at runtime from
`/content/generated/blog/`.

## Two supported formats

Both formats carry the same schema. Pick whichever your automation emits.

### JSON (`<slug>.json`)

```json
{
  "title": "Waiver wire risers for week two",
  "slug": "waiver-wire-risers-week-2",
  "publishDate": "2026-09-11",
  "category": "Waiver Wire",
  "excerpt": "Three names to prioritize before Wednesday.",
  "author": "FSN Desk",
  "entities": [
    { "name": "Bijan Robinson", "position": "RB", "sleeperPlayerId": "8138" }
  ],
  "body": "Markdown string. Headings, lists, links, bold and italic all render."
}
```

### Markdown / MDX (`<slug>.md`, `<slug>.mdx`)

```markdown
---
title: Trade deadline watch
slug: trade-deadline-watch
publishDate: 2026-09-08
category: Analysis
excerpt: The contenders who should be buying, and the sellers to call.
author: FSN Desk
entities:
  - name: Justin Jefferson
    position: WR
    sleeperPlayerId: "6794"
---

The article body is plain Markdown below the frontmatter.
```

## Schema

**SEO metadata (all required):** `title`, `slug`, `publishDate` (YYYY-MM-DD),
`category`, `excerpt`. `author` is optional and defaults to `FSN Desk`.

**Entity extraction array (`entities`):** a clean array the web app and mobile
app parse to map stories onto active league rosters. Each entry:

- `name` (required): the player's full name.
- `position` (optional): `QB`, `RB`, `WR`, `TE`, `K`, `DEF`, and so on.
- `sleeperPlayerId` (optional): the Sleeper `player_id` string. The pipeline
  also accepts `player_id` as an alias and normalizes it to a string.

**Every entity must be named in the copy.** The "Players in this story" tray
only lists players whose exact display name actually appears in the `title` or
`body` (headings count). The build drops any orphaned or ghost entity that is
never mentioned in the prose and warns about it, so the tray can never surface
a player the reader never reads about. List a player as an entity only if you
also write their name into the article.

## Waiver Wire realism rules

Articles with `category: Waiver Wire` follow a stricter generation contract, so
the recommendations stay believable on a standard 12-team wire:

- Feature **true low-owned targets, direct injury replacements, or viable
  streaming options** only. These are players genuinely available on most
  standard wires.
- **Never recommend a consensus-owned roster anchor** (a universally drafted
  starter such as a locked-in RB1/WR1 or elite TE/QB). They are never on the
  wire, so recommending one as a claim is a build error. The blocked list of
  anchors lives in `scripts/build-blog.mjs` (`WAIVER_ANCHOR_BLOCKLIST`); extend
  it as the ownership consensus shifts week to week.
- Frame each add against roster ownership or a consensus baseline (why the
  player is available and what changed), not against season-long pedigree.

The build fails loudly if a Waiver Wire story features an anchor, so an
unrealistic waiver claim never ships.

## Punctuation contract

No em dashes. Anywhere. Not in titles, metadata, or body copy. Break clauses
with periods, commas, or colons. The build fails loudly if an em dash (or a
horizontal bar) is found, so bad copy never ships. En dashes and hyphens are
fine for ranges and joins.

## Build

```bash
npm run build:blog     # compile source -> landing/content/generated/blog/
npm run check:blog     # verify the payload is fresh and punctuation is clean
```

## Automated public-news pipeline

`scripts/generate-editorial.mjs` writes one global, league-agnostic source
article into this directory, from a public source. It has no league, roster,
provider-cookie, or fantasy-stat input, in either mode.

```bash
npm run generate:editorial                      # Sleeper first, feeds as fallback
node scripts/generate-editorial.mjs --mode sleeper
node scripts/generate-editorial.mjs --angle monday                  # force a day's angle
node scripts/generate-editorial.mjs --now 2026-09-28T13:00:00Z      # rehearse a day
node scripts/generate-editorial.mjs --mode rss --feed <rss-url> --player "CeeDee Lamb|WR"
npm run build:blog
npm run check:editorial
```

### The day decides the story

An NFL fantasy week is not one story, it is five, and which one is true depends
on the hour the generator runs. The angle is resolved from the **Eastern**
weekday, not UTC, because the NFL's day boundaries are Eastern and the
interesting runs sit right on top of one: a Monday night kickoff is already
Tuesday in UTC, so a generator reading `getUTCDay()` would file the Tuesday
final recap while the Monday night game was in the second quarter, and stamp it
with tomorrow's date.

| Eastern day | Headline | What the body carries |
|---|---|---|
| Thursday | `Thursday Night Kickoff Preview: Week N Slate` | the Thursday night game, the board going into an unplayed slate, open designations |
| Friday | `Friday Morning Recap & Weekend Preview: Week N` | the Thursday final with its scoring leaders, then every game still to come |
| Sunday | `Sunday Gameday Preview: Week N Final Lineup Decisions` | the games that have not kicked off, late designations, and what is already locked |
| Monday | `Monday Night Preview: What's at Stake & Sunday Recap` | Sunday finals with margins and blowouts flagged, the scoring leaders, and the Monday games plus the board players still to play in them |
| Tuesday | `Tuesday Morning Final Recap: Week N Winners & Losers` | every final, the widest margins, the highest combined scores, and early waiver targets |
| Wed / Sat | `Week N trending adds: where the waiver money is going` | the evergreen platform-wide add board |

`--angle <name>` forces one of `thursday`, `friday`, `sunday`, `monday`,
`tuesday`, `midweek`; `--now <date>` moves the clock for both the weekday and
the played/unplayed split. Between them a day's output can be rehearsed and
asserted on any other day, which is how `npm run check:editorial` covers all
six angles.

### Played games are never previewed

The public NFL scoreboard carries a per-game state (`pre`, `in`, `post`), and
every preview in the generator is built from the `pre` games only. A player
whose NFL team has kicked off is **removed** from a preview board rather than
written about: "start him" is not advice once the game is running, it is a
result the reader can already look up. A game counts as started when the
scoreboard says it is running or complete, **or** when its kickoff is in the
past, because a cached scoreboard document still reports `pre` for a game that
kicked off ten minutes ago and that is exactly the window a stale preview lands
in.

A player with no game on the week's schedule at all (a bye, or no NFL team on
the player record) is a different fact and stays on the board: a bye-week stash
is a legitimate claim. The copy under the row says which case it is.

Two situations fall back to the evergreen board rather than failing the run:

* the scoreboard read failed or returned no games, so there is no verified split
  between played and unplayed; and
* a preview day whose slate has moved on far enough that fewer than three board
  rows still have a game to come.

The evergreen board is the right fallback for both because it makes no claim
about any individual game, so it stays true on a Sunday evening with the whole
slate in the book. Both fallbacks log loudly with the reason.

### `sleeper` mode (the default)

Sleeper's free, public, read-only API for the week and the add counts, plus
ESPN's public NFL scoreboard for the week's schedule and results. No account, no
key, no auth header on either. Four reads:

| Endpoint | What it supplies |
|---|---|
| `GET /v1/state/nfl` | the live season, week and season type |
| `GET /v1/players/nfl/trending/add?lookback_hours=24&limit=10` | platform-wide add counts, as `[{ player_id, count }]` |
| `GET /v1/players/nfl` | names, positions, teams, injury designations |
| `GET site.api.espn.com/.../nfl/scoreboard?dates=<season>&week=<week>` | each game's kickoff, state (`pre`/`in`/`post`), final score and statistical leaders |

The scoreboard is the same host and document `lib/notifications/schedule-feed.js`
already reads for the push dispatcher, so this adds no new upstream to the
project, and it is the only public source in reach that carries per-game state.
It is read only on a day whose angle needs it, so a Wednesday or Saturday run
costs three requests rather than four. `--scoreboard-base` overrides it.

The week comes from `state/nfl` and from nowhere else: it is never inferred
from the calendar, and a week outside 1 through 18 or a season type that is not
`regular`/`post` refuses the run rather than filing an article into a bucket
no reader opens. `players/nfl` is several megabytes and Sleeper asks that it be
read at most once a day, so it is slimmed to the fields the article prints and
cached under `scripts/data/.cache/` for 24 hours (gitignored; `--refresh-players`
ignores it).

Every number in the generated article is a field Sleeper or the scoreboard
returned. There is no model call, no projection and no derived statistic on any
day: neither public source publishes a fantasy projection, so no angle carries
one, and the recap days print the scoreboard's own `displayValue` for a stat
line rather than reformatting it. A trending id with no entry in the player
index is dropped rather than printed as an unnamed row, and a board that
resolves to fewer than three usable players refuses to publish rather than
shipping a stub.

The generator also has no view of any league, on any day. It can say which NFL
games are still to be played and which players the platform is claiming; it
cannot say what a reader's own matchup needs, and the Monday copy says so in
those words rather than implying a scoreboard it does not have.

The board is filtered through `scripts/data/waiver-anchors.json` on **every**
day, not only under the `Waiver Wire` category, because it is framed as a claim
list under all six angles. That is the same consensus-owned starter list
`scripts/build-blog.mjs` fails the build over. Sleeper counts adds across
every league on the platform, so a locked-in starter surfaces on ordinary
drop/add churn; those names are left off the board here, before the build ever
sees the file.

### `rss` mode

One item from a public RSS or Atom feed, rewritten as a short attributed brief
that links back to the original report. This was the original behaviour and is
unchanged.

### Order, and the safe outcome

A default run tries Sleeper, then the feeds, then a verified local snapshot, and
writes **nothing** if none of them verifies. A network-restricted environment
therefore degrades to "no article" rather than to a fabricated one. The local
snapshot is also refused when its URL points at an RFC 2606 / RFC 6761 reserved
host (`.test`, `.invalid`, `example.com`): a placeholder somebody forgot to
replace is not a report.

### The Supabase half

After writing the file, the generator upserts the same article into the
`blog_articles` table with `league_id` NULL and
`article_type = 'global_editorial'`, which is the database's definition of a
global article. It needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; with
either missing it says so and still writes the file. `--no-supabase` skips it.

That row is a durable record of the global corpus, not the thing that puts an
article on `/blog`. **`/blog` is file backed**: it serves the payload
`npm run build:blog` compiles out of this directory. Committing the source file
is what publishes.

### Where the live path actually runs

The development container denies `api.sleeper.app` at its egress proxy, so a run
there reports "no verified source" and writes nothing. The live read happens on
a GitHub runner, in the **Public editorial generator** workflow
(`.github/workflows/generate-editorial.yml`).

It runs itself five times a week, once inside each window the cadence above is
about: Thursday 20:47, Friday 13:47, Sunday 14:47 and Monday 14:47 UTC, plus the
original Tuesday 13:00 UTC between the Monday night final and the midweek claim
deadline. The four added runs sit on minute 47 rather than minute 0 because
GitHub queues scheduled workflows and the top of the hour is the most contended
minute of the hour. A `workflow_dispatch` can force any angle with the `angle`
input. A successful run commits the source file and the compiled payload
together and pushes to the default branch, so the article is live without anyone
touching it. It also prints the generated Markdown into the run summary and
uploads it as an artifact.

Dispatch it by hand to publish off schedule. `commit` and `publish_supabase`
both default on; turning `commit` off makes the run a preview of exactly what a
committing run would publish, with the Markdown still in the summary.

Nothing publishes when nothing verifies. An unreachable Sleeper, an offseason
week or a board too thin to stand up all write no file, the commit step finds an
empty index and says so, and the run is green with no article.

`--player` is optional and repeatable. A supplied player must appear in the
selected public item or generation fails, preventing ghost entities. When no
entity is supplied, the app's News Desk still safely recognizes rostered player
names mentioned in the published article and adds reader-specific context.
`npm run check:editorial` verifies the public-feed parser, attribution, clean
Markdown, evidence-backed entity tags, and zero league/stat dependency using a
local fixture, so it runs without network access.

`landing/content/generated/blog/` is produced by the build. Do not hand edit it.
It is committed so the `fsn-landing` deploy (which runs no build step) serves it
as static files.
