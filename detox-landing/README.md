# Phone-detox newsletter — landing pages

Three standalone, single-file pages. No build step: each one is plain HTML +
Tailwind via CDN + ~30 lines of vanilla JS. Open them directly, or drop them
into any frontend project / landing-page builder.

| File | Purpose |
|---|---|
| `index.html` | **The landing page.** Part one is Edition No. 01 — the long-form article with a blur/gradient gate and sign-up card. Part two, at `#our-story`, is the founder's note. One scroll, two linked destinations. |
| `protocol.html` | Standalone lead-magnet page for *The 30-Day Digital Detox Protocol* |

`index.html` is a single page with two anchors. The sticky masthead links
`#top` ("Edition No. 01") and `#our-story`, and highlights whichever half you
are currently reading. A reader who doesn't convert at the gate is handed a
soft exit — *"Not yet? Read why we stopped selling hardware"* — into the story,
which ends at a second capture form (`#join`). Deep links work:
`/index.html#our-story` opens straight to part two.

## Shared design system

Defined inline in the `tailwind.config` block at the top of each file — change
it in one place per page.

```
paper  #FBFAF8   page background
ink    #15140F   primary text
muted  #6B6A62   secondary text
rule   #E4E1D9   hairlines
accent #B4411F   links, section marks, CTA hover
```

Type: **Newsreader** (serif, body + headlines) and **Inter** (sans, UI, labels,
eyebrows). Reading column is capped at `max-w-reading` (38rem ≈ 70 characters).

## What to replace

Every editable spot is marked with a `[PLACEHOLDER: …]` HTML comment. Search for
`PLACEHOLDER` in each file. The list:

- **Brand** — the wordmark "Unscroll" in the header and footer, plus `<title>`
  and `<meta name="description">`.
- **Form action** — each `<form data-signup>` has `action="#"` and a JS stub
  that fakes success. Point it at ConvertKit / Beehiiv / Loops / your own API,
  and replace the `// [PLACEHOLDER: POST …]` line in the script at the bottom.
- **Social proof** — subscriber counts, the avatar circles, the testimonial and
  the press-logo strip on `protocol.html`. Use real numbers or delete the block.
- **Author / signature** — `[Founder Name]` and the grey avatar circle at the
  end of the story.
- **Beta numbers** — the 140 testers in part two.
- **Nav links** — `/archive`, `/privacy` point nowhere yet.

## How the gate on `index.html` works

Everything after the free preview lives in `#gated`, which is still in the DOM
(so it indexes) but is clipped, `aria-hidden`, `pointer-events: none`, and faded
out with a CSS `mask-image` plus three stacked `backdrop-filter` layers of
increasing blur. The sign-up card sits on top with a negative margin. To change
how much is free, move content in or out of `#gated`; the mask adapts to any
height. To change where the fade starts, edit `max-height: 46vh` in the
`#gated` rule.

Server-side gating, if you want it, means not rendering the `#gated` markup for
logged-out visitors — the CSS mask is a presentation layer, not a security one.

## Behaviour notes

- Scroll reveals are gated behind a `.js` class on `<html>`, so with JS disabled
  every section is visible rather than stranded at `opacity: 0`.
- `prefers-reduced-motion` disables the reveal transitions and smooth scrolling.
- `index.html` has a reading-progress bar spanning the whole page and a sticky
  CTA that appears past 35% scroll and retires whenever either capture form
  (`#gate` or `#join`) is on screen.
- The 186 / 6 / 43 stat counters animate up on entry. The final values are the
  HTML text, so with JS off or reduced motion they simply sit there.

## Going to production

The Tailwind CDN (`cdn.tailwindcss.com`) compiles in the browser and is fine for
prototyping, but ships a JIT compiler to every visitor. For production, run the
Tailwind CLI over these files and swap the `<script src="https://cdn…">` tag for
the built stylesheet:

```
npx tailwindcss -i in.css -o dist.css --minify
```

Move the inline `tailwind.config` object into `tailwind.config.js` unchanged,
with `content: ['./*.html']`.
