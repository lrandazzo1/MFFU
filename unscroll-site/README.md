# Phone-detox newsletter — single-file site

One file. `index.html` is the whole website.

## Deploy

**Vercel Drop** — go to https://vercel.com/new, drag `index.html` onto the drop
zone, deploy. Nothing to configure: no build command, no framework preset, no
output directory.

**Any other host** — upload `index.html`. It is a static file with no
dependencies beyond two CDNs (Tailwind, Google Fonts).

## How two pages fit in one file

Both pages live in the same document as `<div data-view="home">` and
`<div data-view="story">`. A ~25-line router at the bottom shows one at a time
and writes the route into the URL hash:

| URL | Page |
|---|---|
| `yoursite.com/` or `yoursite.com/#/` | Edition No. 01 — the article, the gate, the sign-up card |
| `yoursite.com/#/story` | Our Story — the reflex, the math, Shuttr, the pivot |

Deep links, the back button, and the browser title all work. An unrecognised
hash falls back to the landing page. With JavaScript disabled, both views
render as one continuous document — nothing is ever unreachable.

Links that scroll within a page (Subscribe, the sticky CTA) carry
`data-scroll` and move the viewport without touching the hash, so they can
never collide with a route.

## What to replace before launch

Search for `PLACEHOLDER`. The list:

- **Brand** — the wordmark "Unscroll" in the masthead and footer, plus
  `<title>`, the meta description, and the two titles in the `ROUTES` object.
- **Form action** — both `<form data-signup>` elements have `action="#"` and a
  JS stub that fakes success. Point them at ConvertKit / Beehiiv / Loops / your
  own API and replace the `// [PLACEHOLDER: POST …]` line.
- **Social proof** — the 12,400 readers figure, in both forms.
- **Author / signature** — `[Founder Name]` and the grey avatar circle.
- **Product name** — the hardware is called *Shuttr*.
- **Beta numbers** — 140 testers.
- **Privacy** — there is no privacy page; add one and link it in the footer.

## Design system

Defined inline in the `tailwind.config` block at the top of the file.

```
paper  #FBFAF8   page background
ink    #15140F   primary text
muted  #6B6A62   secondary text
rule   #E4E1D9   hairlines
accent #B4411F   marks, links, CTA hover
```

Type is **Newsreader** (serif, body and headlines) and **Inter** (sans, UI and
eyebrows). The reading column is capped at 38rem, about 70 characters.

## Going to production

The Tailwind CDN compiles in the browser — fine for launch, but it ships a JIT
compiler to every visitor. When traffic justifies it, run the Tailwind CLI over
this file and swap the `<script src="https://cdn.tailwindcss.com">` tag for the
built stylesheet:

```
npx tailwindcss -i in.css -o dist.css --minify
```

Move the inline `tailwind.config` object into `tailwind.config.js` unchanged,
with `content: ['./index.html']`.
