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

## Editorial compiler

`scripts/generate-editorial.mjs` compiles structured editorial source files
(the same schema described above, `.md`, `.mdx`, or `.json`) from
`content/editorial/` into this directory. Editors drop new articles into the
source directory and the compiler writes normalized copies here that
`scripts/build-blog.mjs` then picks up like any hand-authored article. It
does not fetch anything from the outside world, does not require a league
id, and has no CLI flag requirements.

```bash
npm run generate:editorial                       # compile content/editorial/ -> here
npm run generate:editorial -- --source drafts/   # or read from a different dir
npm run build:blog                               # compile this dir into the deploy payload
npm run check:editorial                          # offline self-test of the compiler
```

The compiler enforces the same content guardrails as `build-blog.mjs` and
fails loudly before writing anything if a source file violates one, so a bad
source file never lands in this directory. Rules enforced:

- **No em dashes** anywhere in user-facing fields.
- **Every listed entity must appear verbatim in the title or body**
  (case-insensitive, markdown emphasis stripped). Ghost entities abort the
  compile rather than being silently dropped.
- **Slugs must be lowercase kebab-case** (letters, digits, hyphens).
- Required frontmatter fields (`title`, `slug`, `publishDate`, `category`,
  `excerpt`) must be present, and `publishDate` must be a parseable date.

`npm run check:editorial` runs the full compiler pipeline against in-memory
fixtures and verifies each guardrail, so it stays green with no network
access and no external service.

`landing/content/generated/blog/` is produced by the build. Do not hand edit it.
It is committed so the `fsn-landing` deploy (which runs no build step) serves it
as static files.
