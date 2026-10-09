# Phone-detox newsletter — landing pages

Three standalone, single-file pages. No build step: each one is plain HTML +
Tailwind via CDN + ~30 lines of vanilla JS. Open them directly, or drop them
into any frontend project / landing-page builder.

| File | Purpose |
|---|---|
| `index.html` | The newsletter landing page: Edition No. 01, the free intro, the gated "Four inventions" section, and the sign-up card |
| `story.html` | Our Story — the reflex, the math, digital whack-a-mole, the Shuttr pivot, and the agnostic mission |
| `protocol.html` | Standalone lead-magnet page for *The 30-Day Digital Detox Protocol* |

Three independent files, cross-linked with relative hrefs (`index.html`,
`story.html`, `protocol.html`) so they work opened from disk and from any
directory you deploy them to. Each page's masthead carries both destinations
and marks the current one with `aria-current="page"`.

The reader's path: `index.html` gives away Skinner and Section I, starts
Section II, blurs it out, and asks for the email. Anyone who doesn't convert
gets a soft exit under the card — *"Not yet? Read why we stopped selling
hardware"* — into `story.html`, which ends at its own capture form (`#join`).

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
  end of `story.html`.
- **Product name** — the hardware is called *Shuttr* in `story.html`.
- **Beta numbers** — the 140 testers.
- **Nav links** — `/archive`, `/privacy` point nowhere yet.

## How the gate on `index.html` works

Everything from Section II ("Four inventions") down lives in `#gated`, which is still in the DOM
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
- Both pages carry a reading-progress bar. `index.html` adds a sticky CTA that
  appears past 35% scroll and retires once the sign-up card is on screen.
- On `story.html`, the 186 / 6 / 43 stat counters animate up on entry. The
  final values are the HTML text, so with JS off or reduced motion they simply
  sit there.

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
