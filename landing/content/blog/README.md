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

`scripts/generate-editorial.mjs` reads one item from a public RSS or Atom
feed and writes a small, attributed source article in this directory. It has no
league, roster, provider-cookie, or fantasy-stat input. The brief preserves the
source headline and links readers to the original report instead of generating
new claims around it.

```bash
npm run generate:editorial
node scripts/generate-editorial.mjs --feed <rss-url> --player "CeeDee Lamb|WR"
npm run build:blog
npm run check:editorial
```

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
