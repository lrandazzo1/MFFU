#!/usr/bin/env node

import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = {
  config: path.join(ROOT, 'app-store-marketing', 'slides.json'),
  input: path.join(ROOT, 'app-store-marketing', 'screenshots'),
  output: path.join(ROOT, 'app-store-assets'),
};

const PHONE = {
  x: 122,
  y: 625,
  width: 1040,
  height: 2145,
  inset: 32,
  radius: 104,
};

const HEADLINE = {
  x: 86,
  y: 340,
  fontSize: 92,
  lineHeight: 118,
  letterSpacing: 0.6,
  wordSpacing: 9,
};

const EYEBROW = {
  x: 151,
  y: 211,
  fontSize: 23,
  letterSpacing: 2.4,
  wordSpacing: 5,
};

const SUPPORTING = {
  x: 86,
  fontSize: 26,
  letterSpacing: 0.15,
  wordSpacing: 4,
  gapAfterHeadline: 105,
};

function usage() {
  return `Generate FSN App Store marketing screenshots.

Usage:
  npm run screenshots:appstore
  node scripts/generate-app-store-screenshots.mjs [options]

Options:
  --config <file>   Slide configuration JSON
  --input <dir>     Source screenshot directory
  --output <dir>    Generated JPEG directory
  --help            Show this message`;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (!['--config', '--input', '--output'].includes(arg)) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    options[arg.slice(2)] = path.resolve(process.cwd(), value);
    index += 1;
  }
  return options;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function assertHexColor(value, context) {
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${context} must be a six-digit hex color; received ${value}`);
  }
}

function validateConfig(config) {
  if (config?.canvas?.width !== 1284 || config?.canvas?.height !== 2778) {
    throw new Error('slides.json canvas must remain exactly 1284 × 2778 for the 6.5-inch App Store format.');
  }
  if (!Array.isArray(config.slides) || config.slides.length === 0) {
    throw new Error('slides.json must include at least one slide.');
  }

  const ids = new Set();
  for (const [index, slide] of config.slides.entries()) {
    const label = `Slide ${index + 1}`;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slide.id ?? '')) {
      throw new Error(`${label} id must be lowercase kebab-case.`);
    }
    if (ids.has(slide.id)) throw new Error(`Duplicate slide id: ${slide.id}`);
    ids.add(slide.id);
    if (!/^[^/\\]+\.png$/i.test(slide.source ?? '')) {
      throw new Error(`${label} source must be a PNG filename without directories.`);
    }
    if (!Array.isArray(slide.headline) || slide.headline.length < 1 || slide.headline.length > 3) {
      throw new Error(`${label} headline must contain one to three lines.`);
    }
    if (slide.headline.some(line => typeof line !== 'string' || line.trim().length === 0 || line.length > 22)) {
      throw new Error(`${label} headline lines must contain 1–22 characters.`);
    }
    if (typeof slide.eyebrow !== 'string' || slide.eyebrow.length > 52) {
      throw new Error(`${label} eyebrow must contain at most 52 characters.`);
    }
    if (typeof slide.supporting !== 'string' || slide.supporting.length > 88) {
      throw new Error(`${label} supporting copy must contain at most 88 characters.`);
    }
    assertHexColor(slide.accent, `${label} accent`);
  }
}

async function validateSource(sourcePath, slideNumber) {
  const metadata = await sharp(sourcePath).metadata();
  if (metadata.format !== 'png') {
    throw new Error(`Slide ${slideNumber} source must be PNG: ${sourcePath}`);
  }
  if (!metadata.width || !metadata.height || metadata.width < 230 || metadata.height < 500) {
    throw new Error(`Slide ${slideNumber} source is too small; minimum is 230 × 500: ${sourcePath}`);
  }
  const ratio = metadata.width / metadata.height;
  if (ratio < 0.44 || ratio > 0.49) {
    throw new Error(`Slide ${slideNumber} source must be a portrait phone capture (aspect ratio 0.44–0.49): ${sourcePath}`);
  }
}

async function validateHeadlineFit(slide, slideNumber) {
  for (const line of slide.headline) {
    const sample = Buffer.from(`
      <svg width="1600" height="180" xmlns="http://www.w3.org/2000/svg">
        <text x="0" y="125" font-family="Nimbus Sans Narrow, Arial Narrow, sans-serif" font-size="${HEADLINE.fontSize}" font-weight="700" letter-spacing="${HEADLINE.letterSpacing}" word-spacing="${HEADLINE.wordSpacing}">${escapeXml(line)}</text>
      </svg>
    `);
    const { info } = await sharp(sample).trim().png().toBuffer({ resolveWithObject: true });
    const availableWidth = 1284 - (HEADLINE.x * 2);
    if (info.width > availableWidth) {
      throw new Error(`Slide ${slideNumber} headline line is ${info.width}px wide but only ${availableWidth}px is available: ${line}`);
    }
  }
}

function backgroundSvg(slide, slideNumber, slideCount, width, height) {
  const headline = slide.headline.map((line, index) => (
    `<text x="${HEADLINE.x}" y="${HEADLINE.y + (index * HEADLINE.lineHeight)}" class="headline">${escapeXml(line)}</text>`
  )).join('');
  const lastHeadlineBaseline = HEADLINE.y + ((slide.headline.length - 1) * HEADLINE.lineHeight);
  const supportingY = lastHeadlineBaseline + SUPPORTING.gapAfterHeadline;

  return Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="glow" cx="50%" cy="22%" r="72%">
          <stop offset="0" stop-color="${slide.accent}" stop-opacity="0.17"/>
          <stop offset="0.42" stop-color="#07101a" stop-opacity="0.82"/>
          <stop offset="1" stop-color="#030509"/>
        </radialGradient>
        <linearGradient id="gridFade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffffff" stop-opacity="0.055"/>
          <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
        </linearGradient>
        <style>
          .narrow { font-family: 'Nimbus Sans Narrow', 'Arial Narrow', sans-serif; font-weight: 700; }
          .headline { font-family: 'Nimbus Sans Narrow', 'Arial Narrow', sans-serif; font-size: ${HEADLINE.fontSize}px; font-weight: 700; letter-spacing: ${HEADLINE.letterSpacing}px; word-spacing: ${HEADLINE.wordSpacing}px; fill: #f7f8fb; }
          .eyebrow { font-family: 'Nimbus Sans Narrow', 'Arial Narrow', sans-serif; font-size: ${EYEBROW.fontSize}px; font-weight: 700; letter-spacing: ${EYEBROW.letterSpacing}px; word-spacing: ${EYEBROW.wordSpacing}px; fill: ${slide.accent}; }
          .supporting { font-family: 'DejaVu Sans', sans-serif; font-size: ${SUPPORTING.fontSize}px; font-weight: 400; letter-spacing: ${SUPPORTING.letterSpacing}px; word-spacing: ${SUPPORTING.wordSpacing}px; fill: #a6afbd; }
        </style>
      </defs>
      <rect width="${width}" height="${height}" fill="#030509"/>
      <rect width="${width}" height="${height}" fill="url(#glow)"/>
      <g opacity="0.24">
        <path d="M0 162H1284 M0 226H1284 M0 290H1284 M0 354H1284 M0 418H1284 M0 482H1284 M0 546H1284 M0 610H1284" stroke="url(#gridFade)"/>
      </g>
      <rect x="86" y="76" width="54" height="54" rx="15" fill="${slide.accent}"/>
      <path d="M101 91h25v7h-17v7h15v7h-15v18h-8z" fill="#02050a"/>
      <text x="158" y="115" class="narrow" font-size="28" letter-spacing="2.2" word-spacing="5" fill="#f7f8fb">FANTASY SPORTS NETWORK</text>
      <text x="1198" y="114" text-anchor="end" class="narrow" font-size="24" letter-spacing="2.2" word-spacing="4" fill="#768091">${String(slideNumber).padStart(2, '0')} / ${String(slideCount).padStart(2, '0')}</text>
      <rect x="86" y="199" width="48" height="5" rx="2.5" fill="${slide.accent}"/>
      <text x="${EYEBROW.x}" y="${EYEBROW.y}" class="eyebrow">${escapeXml(slide.eyebrow)}</text>
      ${headline}
      <text x="${SUPPORTING.x}" y="${supportingY}" class="supporting">${escapeXml(slide.supporting)}</text>
    </svg>
  `);
}

function phoneUnderlaySvg(accent) {
  const { width, height, radius } = PHONE;
  return Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-30%" y="-20%" width="160%" height="150%">
          <feDropShadow dx="0" dy="32" stdDeviation="34" flood-color="#000000" flood-opacity="0.82"/>
          <feDropShadow dx="0" dy="0" stdDeviation="30" flood-color="${accent}" flood-opacity="0.24"/>
        </filter>
        <linearGradient id="frame" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#505967"/>
          <stop offset="0.2" stop-color="#111720"/>
          <stop offset="0.75" stop-color="#080b10"/>
          <stop offset="1" stop-color="#404957"/>
        </linearGradient>
      </defs>
      <rect x="10" y="10" width="${width - 20}" height="${height - 20}" rx="${radius}" fill="#05070b" stroke="url(#frame)" stroke-width="20" filter="url(#shadow)"/>
    </svg>
  `);
}

function phoneOverlaySvg(accent) {
  const { width, height, inset, radius } = PHONE;
  const screenRadius = radius - inset + 4;
  return Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${inset}" y="${inset}" width="${width - (inset * 2)}" height="${height - (inset * 2)}" rx="${screenRadius}" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="3"/>
      <rect x="${(width - 246) / 2}" y="47" width="246" height="66" rx="33" fill="#020308" stroke="#242a34" stroke-width="2"/>
      <circle cx="${(width / 2) + 88}" cy="80" r="8" fill="#121b26" stroke="${accent}" stroke-opacity="0.42" stroke-width="2"/>
      <path d="M-1 310h8v132h-8z M${width - 7} 354h8v190h-8z" fill="#242b35"/>
    </svg>
  `);
}

async function roundedScreenshot(sourcePath) {
  const width = PHONE.width - (PHONE.inset * 2);
  const height = PHONE.height - (PHONE.inset * 2);
  const radius = PHONE.radius - PHONE.inset + 4;
  const mask = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" rx="${radius}" fill="#fff"/>
    </svg>
  `);

  return sharp(sourcePath)
    .resize({ width, height, fit: 'contain', background: '#05070b' })
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function renderSlide(slide, index, config, options) {
  const slideNumber = index + 1;
  const sourcePath = path.join(options.input, slide.source);
  await validateSource(sourcePath, slideNumber);
  await validateHeadlineFit(slide, slideNumber);

  const screenshot = await roundedScreenshot(sourcePath);
  const outputStem = `${String(slideNumber).padStart(2, '0')}-${slide.id}`;
  const outputPath = path.join(options.output, `${outputStem}.jpg`);
  const { width, height } = config.canvas;

  await Promise.all([
    rm(path.join(options.output, `${outputStem}.png`), { force: true }),
    rm(outputPath, { force: true }),
  ]);

  await sharp(backgroundSvg(slide, slideNumber, config.slides.length, width, height))
    .composite([
      { input: phoneUnderlaySvg(slide.accent), left: PHONE.x, top: PHONE.y },
      { input: screenshot, left: PHONE.x + PHONE.inset, top: PHONE.y + PHONE.inset },
      { input: phoneOverlaySvg(slide.accent), left: PHONE.x, top: PHONE.y },
    ])
    .flatten({ background: '#030509' })
    .removeAlpha()
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(outputPath);

  const output = await sharp(outputPath).metadata();
  if (output.format !== 'jpeg' || output.width !== width || output.height !== height || output.hasAlpha || output.space !== 'srgb') {
    throw new Error(`Generated asset failed validation: ${outputPath} (${output.format}, ${output.width} × ${output.height}, alpha=${output.hasAlpha}, color=${output.space})`);
  }
  await sharp(outputPath).stats();
  console.log(`[app-store] ${path.basename(outputPath)} — ${output.width} × ${output.height}, opaque sRGB JPEG`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(options.config, 'utf8'));
  validateConfig(config);
  await mkdir(options.output, { recursive: true });

  for (const [index, slide] of config.slides.entries()) {
    await renderSlide(slide, index, config, options);
  }

  console.log(`[app-store] Generated ${config.slides.length} validated screenshots in ${options.output}`);
}

main().catch(error => {
  console.error('[app-store] Screenshot generation failed.', error);
  process.exitCode = 1;
});
