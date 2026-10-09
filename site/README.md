# Phone-detox newsletter site

Static two-page site. No build step, no dependencies to install.

```
index.html    Edition No. 01 — intro, gated "Four inventions" section, sign-up card
story.html    Our Story — 186 pickups, whack-a-mole, the Shuttr pivot, the mission
vercel.json   cleanUrls routing + security headers
```

## Live

Deployed to Vercel (team `jamoke`, project `unscroll-site`):

- https://unscroll-site-wheat.vercel.app
- https://unscroll-site-jamoke.vercel.app

`cleanUrls: true` means `/story.html` serves at `/story`; the in-page links are
written as `story.html` / `index.html` so they also work opened from disk, and
Vercel 308-redirects them to the clean path.

## Putting it on GitHub

The session that built this could not create a repository (the Claude GitHub
App is scoped to existing repos only). Two minutes by hand:

```bash
# 1. create an empty repo at https://github.com/new  (no README, no .gitignore)
# 2. from this directory:
git init
git add .
git commit -m "Phone-detox newsletter site"
git branch -M main
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

Then connect it in Vercel: Project → Settings → Git → Connect Git Repository,
pick the repo, keep Framework Preset = **Other**, Build Command and Output
Directory empty. Pushes to `main` deploy to production from then on.

## What to replace before launch

Search for `PLACEHOLDER`:

- **Brand** — "Unscroll" in the masthead and footer, plus `<title>` and the
  meta description on both pages.
- **Form action** — both `<form data-signup>` elements have `action="#"` and a
  JS stub that fakes success. Point them at your list provider and replace the
  `// [PLACEHOLDER: POST …]` line.
- **Social proof** — the 12,400 readers figure.
- **Author / signature** — `[Founder Name]` and the grey avatar circle.
- **Captions** — the two Shuttr figures on `story.html`.
- **Privacy** — no privacy page exists; the footer slot is commented out.

## Images

The Shuttr photography is hotlinked from the Shopify CDN
(`cdn.shopify.com/s/files/1/0655/4615/8155/...`), resized with `&width=`.
Those URLs are public and permanent. See `SHOPIFY.md` in `detox-landing/` for
how they were pulled and how to swap them.
