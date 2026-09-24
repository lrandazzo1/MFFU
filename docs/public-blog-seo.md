# The public blog, and how it is crawled

`fantasysportsnetwork.app/blog` is the general-audience blog: real-world NFL
copy, the same for every reader. It is **not** the League Blog in the app, and
the two share no data.

| | Public blog | League Blog |
|---|---|---|
| Source | `landing/content/blog/**` (files in this repo) | `blog_articles` in Supabase |
| Built by | `scripts/build-blog.mjs` | `lib/article-generator.ts`, three mornings a week |
| Scope | Global | One league, `league_id` NOT NULL on every row |
| Served at | `fantasysportsnetwork.app/blog` | Inside the app, News Desk |

## Why private league recaps cannot leak onto it

Not a filter. There is no read path.

`blog_articles` holds one thing: per-league recaps. Every row carries a NOT
NULL `league_id`, so there is no such row as a "global" article to select, and
`/api/blog/articles` rejects any request that does not name a league, so the
table cannot be enumerated. The public blog is compiled from files and never
queries it.

The failure mode is somebody adding a convenience fetch to a blog page later
and quietly publishing a dozen leagues' private matchups. `npm run check:blog`
(first in `npm run verify`) scans `landing/blog/**` and
`landing/content/generated/blog/**` for the endpoint, the table name, a
Supabase client or a Supabase host, and fails the build on any of them.

It is scoped to the blog surface and to real read syntax on purpose:
`landing/invite.html` legitimately handles a league id and `landing/privacy.html`
legitimately names Supabase in prose. Neither is the blog and neither is a
read. `landing/vercel.json`'s proxy of `/api/blog/articles` is also allowed: it
exists so the app can serve that route from the root domain, it still demands a
league id, and no blog page calls it.

## Per-article metadata

There is no Next.js here, so no `generateMetadata()` and no `app/sitemap.ts`.
The static-site equivalent is better for crawling anyway: the HTML is already
on disk, so there is no server render and no hydration to wait for.

Every `/blog/<slug>` used to be a **verbatim copy of the reader shell**. Every
article on the site therefore shipped `<title>FSN Blog</title>`, the
description "An FSN Blog story.", and the same `og:title`. The shell rewrote
them from JSON after load, which a crawler that does not run the page's
JavaScript never sees, so Google had one title and one description for the
whole blog.

`stampArticlePage()` now bakes into each page at build time:

| Tag | Value |
|---|---|
| `<title>` | `<article title> \| Fantasy Sports Network` |
| `description` | the article excerpt |
| `og:title`, `og:description` | the same |
| `og:type` | `article` |
| `og:url`, `<link rel=canonical>` | `<SITE_ORIGIN>/blog/<slug>` |
| `article:published_time` | the publish date |
| `article:section`, `article:author` | category, author |
| `twitter:card` | `summary_large_image` (already on the shell) |

It also replaces the loading skeleton in `#article` with the **rendered
article body**, so a crawler reads the story itself rather than placeholder
bars. Client-side hydration is unchanged; it re-renders the same content it
finds, which costs nothing and keeps the reader working when a slug is reached
through the `/blog/:slug` rewrite rather than its own stamped page.

`replaceOnce()` **throws** rather than calling `fail()` if the shell no longer
contains a tag it matches on. The stamp runs in the write phase, after
collected errors are reported, so `fail()` would note the problem and then
write the page without its metadata. This regression is invisible in review
and surfaces weeks later as a ranking drop.

## SITE_ORIGIN

One constant for every absolute URL the build emits: the canonical link,
`og:url`, and every `<loc>` in the sitemap. Canonical, `og:url` and the
sitemap must agree on the host or a crawler treats `www` and the apex as two
sites and splits the ranking.

It is currently `https://www.fantasysportsnetwork.app`, matching the host
already baked into the deployed `og:image` and the previous sitemap. **If the
apex is the canonical host, change this one line** and rebuild; everything
follows it.

## The sitemap

`landing/sitemap.xml` was hand-maintained and had already drifted: it listed
three articles while `landing/blog/` held four, so the newest story was not
discoverable. It is now generated from the same `posts` the pages are stamped
from, which is the only way the two cannot disagree.

Articles get `<lastmod>` from their publish date and `changefreq weekly`. The
home page and `/blog` get the newest article's date. The legal pages get
`monthly` and no `lastmod`, because claiming they change weekly wastes crawl
budget.

`npm run check:blog` regenerates all of it in memory and fails if what is on
disk differs, so a hand edit to a slug page or the sitemap is caught rather
than silently overwritten on the next build.


## Three corpora, and which one is where

The commonest confusion about this product, so it is worth stating plainly.

| What | Where it lives | Where it shows | Scope |
|---|---|---|---|
| Global blog | `landing/content/blog/**` (files) | `fantasysportsnetwork.app/blog` **and** the app's Desk Wire | Everyone |
| League recaps | `blog_articles` (Supabase) | The app's News Desk, that league only | One league, private |
| Deterministic desk | `index.html` block 4 | The app's timeline | Generated per league per week |

A "Week 2 recap" generated by the article pipeline is the **middle** row. It is
one league's private content and it is correctly absent from `/blog` and the
sitemap. It appears in the app, on that league's week 2 News Desk.

## When the Desk Wire shows nothing

The wire only accepts global copy inside `MAX_AGE_DAYS` (currently 8) of today.
That window exists so a Wednesday with no waiver piece does not surface last
month's as a live recommendation.

The consequence: **a desk that has not published for longer than the window
shows nothing at all.** That is not a broken query, a stale cache, or a draft
flag. It is a publishing gap, and the fix is to add an article to
`landing/content/blog` and rebuild.

Two things now make that state visible instead of silent:

- `npm run check:blog` prints a `STALE:` warning naming the newest article, its
  age and the window. A warning and not a failure, because stale content is an
  editorial state and failing CI over it would block unrelated work every time
  a publishing week slipped. It reads `MAX_AGE_DAYS` out of `index.html` rather
  than copying it, so the two cannot drift; a rename there fails the check
  loudly rather than silently disabling the warning.
- The app logs why the wire is blank, once per distinct reason, so "no article
  is published for today's slot" and "the feed could not be reached" are
  distinguishable. They look identical on screen.

## What there is no such thing as

- **A draft or status flag.** `blog_articles` has `published_at` and nothing
  else of that kind; a row exists only because the pipeline published it. The
  file-based blog has no draft state either.
- **Next.js caching.** There is no Next.js: no `app/`, no `pages/`, no
  `next.config`. Nothing here can take `export const dynamic` or `revalidate`.
  Caching is explicit `Cache-Control` on the API routes and in
  `landing/vercel.json`, five minutes at the edge.
- **A query that needs reordering.** `/api/blog/articles` already orders
  `published_at DESC`; the global manifest is written newest-first and
  `selectForSlot()` sorts newest-first again before choosing.
