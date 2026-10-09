# Pulling Shuttr images out of Shopify

The store is **Shuttr** (`shuttrcase.com`, Basic plan). The images used on the
story page come from its **Files library** (Content → Files), not from the
theme, which matters for how you pull them.

## 1. The CLI — what it does and does not cover

```bash
npm install -g @shopify/cli@latest
shopify version

# first run opens a browser to authenticate
shopify theme list --store shuttrcase.com

# pull a theme into ./shuttr-theme (assets/, sections/, snippets/, templates/)
shopify theme pull --store shuttrcase.com --path ./shuttr-theme
shopify theme pull --store shuttrcase.com --theme 123456789 --path ./shuttr-theme
```

`shopify theme pull` gives you **theme assets** — the files in `assets/`, which
a Liquid template references as:

```liquid
{{ 'shuttr-hero.png' | asset_url }}
{{ 'shuttr-hero.png' | asset_url | image_url: width: 1280 }}
```

There is **no `shopify files pull` command**. The Shuttr product shots and
prototype photos live in the Files library, which the theme CLI does not touch.
For those, use the Admin API below — that is how the three URLs now in
`story.html` were obtained.

## 2. Pulling the Files library (what we actually used)

Create a token once: Settings → Apps and sales channels → Develop apps → Create
an app → Configure Admin API scopes → tick `read_files` and `read_products` →
Install app → copy the Admin API access token.

```bash
export SHOPIFY_STORE=shuttrcase.com
export SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxxxxx   # never commit this

# every image in the Files library, newest first
curl -sS -X POST "https://$SHOPIFY_STORE/admin/api/2026-07/graphql.json" \
  -H "X-Shopify-Access-Token: $SHOPIFY_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ files(first: 50, query: \"media_type:IMAGE\", sortKey: CREATED_AT, reverse: true) { edges { node { createdAt alt ... on MediaImage { id image { url width height } } } } pageInfo { hasNextPage endCursor } } }"}' \
  | jq -r '.data.files.edges[].node | [.image.width, .image.height, .image.url] | @tsv'

# every image attached to a product
curl -sS -X POST "https://$SHOPIFY_STORE/admin/api/2026-07/graphql.json" \
  -H "X-Shopify-Access-Token: $SHOPIFY_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ products(first: 10) { edges { node { title handle media(first: 25) { edges { node { ... on MediaImage { image { url width height } } } } } } } } }"}' \
  | jq -r '.data.products.edges[].node | .title as $t | .media.edges[].node.image.url | "\($t)\t\(.)"'
```

Bump `2026-07` to the current stable API version as Shopify rolls quarterly.

To download them locally instead of hotlinking:

```bash
curl -sS -X POST ... | jq -r '.data.files.edges[].node.image.url' > urls.txt
mkdir -p img && (cd img && xargs -n1 curl -sSO < ../urls.txt)
```

## 3. Serving them from the landing page

The CDN URLs are public, permanent and globally cached, so hotlinking them from
Vercel is fine — no CORS setup, no egress cost to you, no auth. The `?v=`
parameter is a content hash: it changes when you replace the file, which is what
makes the URLs safe to cache forever.

Shopify's CDN resizes on the fly. Append to any file URL:

| Param | Effect |
|---|---|
| `&width=1280` | resize to 1280px wide (what the `srcset` entries use) |
| `&height=800&crop=center` | hard crop to a box |
| `&format=webp` or `&format=jpg` | re-encode |

**One gotcha:** several files in the library are `.heic` (the `IMG_4743_3`,
`IMG_4744_3`, `IMG_4746_3` originals, straight off an iPhone). Chrome and
Firefox cannot display HEIC. Either append `&format=jpg` or re-upload them as
JPEGs.

## 4. What is on the page now

Three files, wired into `story.html` (and the story view of
`unscroll-site/index.html`):

| Slot | File | Size |
|---|---|---|
| Wide plate after the math block | `shuttr_render_ultra_sharp_4608x3072_1.png` | 4439 × 2959 |
| Two-up, left — "What we built first" | `IMG_4759.jpg` | 1206 × 2112 |
| Two-up, right — "What we built first" | `ChatGPTImageJun22_2026_06_50_55PM_2.png` | 893 × 1254 (featured image of the live **Shuttr** product) |

Each `<img>` carries a 4-step `srcset` (`&width=` 400/600/800/1200 or
640/960/1280/1600), `sizes`, explicit `width`/`height` so nothing shifts while
loading, `loading="lazy"`, `decoding="async"`, and alt text. The frames are
fixed-ratio (`aspect-[3/2]` and `aspect-[4/5]`) with `object-cover`, so swapping
in a differently-shaped image never breaks the layout.

To swap one: replace the `src` and the four `srcset` URLs in that `<figure>`
with another file URL from the list in step 2, and rewrite the caption.
