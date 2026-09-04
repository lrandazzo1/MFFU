#!/usr/bin/env node
// Stage the static web app into `www/` for Capacitor to package.
// This is the iOS-only build step. Vercel (web) still serves index.html
// straight from the repo root and does not run this script.
import { mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'www');

const files = [
  'index.html',
  'editorialScheduleEngine.js'
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const rel of files) {
  const src = join(root, rel);
  if (!existsSync(src)) {
    console.error(`[build:ios] missing source file: ${rel}`);
    process.exit(1);
  }
  const dst = join(out, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`[build:ios] staged ${rel}`);
}

console.log(`[build:ios] done -> ${out}`);
