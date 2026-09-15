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

## Automated box-score recap pipeline

`scripts/generate-editorial.mjs` reads a strict, structured box-score payload
(no network access anywhere in the script) and writes a weekly recap source
article into this directory. Every score, team name, and player name in the
generated Markdown is read directly out of the payload and templated into
prose; nothing is summarized, embellished, or invented, so the article can
only ever say what the numbers say.

```bash
npm run generate:editorial                          # reads scripts/data/weekly-editorial-source.json
node scripts/generate-editorial.mjs --source path/to/payload.json
npm run build:blog
npm run check:editorial
```

The payload schema (`verifiedBoxScoreSource`) is documented at the top of
`scripts/generate-editorial.mjs`, with a sample/fallback fixture at
`scripts/data/weekly-editorial-source.json`. Every roster entry requires a
`name`, `position`, numeric `points`, and a boolean `starter` flag; a malformed
or incomplete payload is rejected rather than padded with fallback text.
Generation fails loudly (and writes nothing) if a required field is missing,
a score or point total isn't numeric, or an entity ends up unmentioned in the
generated recap.

`npm run check:editorial` runs a fully offline self-test: it exercises the
validation, the win/loss/margin math, the top-performer and bench-decision
templating, and the em-dash ban against an in-memory fixture, so it needs no
network access and never touches `landing/content/blog/`.

The sample fixture ships with clearly-labeled placeholder teams and players
("Sample Team A", "Sample Player One", and so on). Replace it with the real
completed week's box scores before generating an article meant for
publication; do not commit a generated article built from the placeholder
data.

`landing/content/generated/blog/` is produced by the build. Do not hand edit it.
It is committed so the `fsn-landing` deploy (which runs no build step) serves it
as static files.
