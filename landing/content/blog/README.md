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
node scripts/generate-editorial.mjs --mode rss --feed <rss-url> --player "CeeDee Lamb|WR"
npm run build:blog
npm run check:editorial
```

### `sleeper` mode (the default)

Sleeper's free, public, read-only API. No account, no key, no auth header.
Three reads:

| Endpoint | What it supplies |
|---|---|
| `GET /v1/state/nfl` | the live season, week and season type |
| `GET /v1/players/nfl/trending/add?lookback_hours=24&limit=10` | platform-wide add counts, as `[{ player_id, count }]` |
| `GET /v1/players/nfl` | names, positions, teams, injury designations |

The week comes from `state/nfl` and from nowhere else: it is never inferred
from the calendar, and a week outside 1 through 18 or a season type that is not
`regular`/`post` refuses the run rather than filing an article into a bucket
no reader opens. `players/nfl` is several megabytes and Sleeper asks that it be
read at most once a day, so it is slimmed to the fields the article prints and
cached under `scripts/data/.cache/` for 24 hours (gitignored; `--refresh-players`
ignores it).

Every number in the generated article is a field Sleeper returned. There is no
model call, no projection and no derived statistic. A trending id with no entry
in the player index is dropped rather than printed as an unnamed row, and a
board that resolves to fewer than three usable players refuses to publish
rather than shipping a stub.

The generated board carries the `Waiver Wire` category, so it is filtered
through `scripts/data/waiver-anchors.json`, the same consensus-owned starter
list `scripts/build-blog.mjs` fails the build over. Sleeper counts adds across
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

### Verifying the live path

The development container denies `api.sleeper.app` at its egress proxy, so a run
there reports "no verified source" and writes nothing. The
**Public editorial generator** workflow (`.github/workflows/generate-editorial.yml`,
run it by hand) exercises the live read on a GitHub runner, prints the generated
Markdown into the run summary, and uploads it as an artifact. It does not commit.

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
