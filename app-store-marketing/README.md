# FSN App Store marketing screenshots

This template turns the four selected FSN screen captures into polished,
device-framed 6.5-inch App Store assets. Every export is an opaque
`1284 × 2778` PNG.

## Generate the carousel

From the repository root:

```bash
npm ci
npm run screenshots:appstore
```

The finished files are written to `app-store-assets/`:

1. `01-power-index.png`
2. `02-news-desk.png`
3. `03-franchise-legacy.png`
4. `04-rivalries.png`

The generator validates every source and final image. It exits non-zero if a
source is missing, is not a PNG, is too small to render cleanly, or if an export
does not have the exact required dimensions and opaque RGB color space.

## Replace a screenshot or edit copy

- Put replacement PNGs in `app-store-marketing/screenshots/` using the source
  names referenced in `slides.json`.
- Edit each slide's eyebrow, headline lines, supporting sentence, or accent in
  `app-store-marketing/slides.json`.
- Run `npm run screenshots:appstore` again. Existing generated PNGs with the
  configured names are replaced; unrelated files are left alone.

Keep headlines split into one to three short lines. The template renders and
measures every line, then stops with a clear error if copy would exceed the App
Store safe area.

## Optional paths

The script accepts custom configuration, source, and output locations:

```bash
node scripts/generate-app-store-screenshots.mjs \
  --config ./app-store-marketing/slides.json \
  --input ./app-store-marketing/screenshots \
  --output ./app-store-assets
```

Use `--help` to print all options.
