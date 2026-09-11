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

`landing/content/generated/blog/` is produced by the build. Do not hand edit it.
It is committed so the `fsn-landing` deploy (which runs no build step) serves it
as static files.
