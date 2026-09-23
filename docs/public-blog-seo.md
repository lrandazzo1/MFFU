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
