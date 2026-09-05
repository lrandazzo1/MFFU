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
  'editorialScheduleEngine.js',
  // Push notification service. index.html loads this at global scope, so a
  // native build without it boots to a Setup screen that reports the service
  // as missing (see bindNotifySettings) rather than offering a dead switch.
  'notificationService.js'
];

// Web-only files. sw.js exists purely so a browser will accept a Web Push
// subscription; the iOS binary goes through APNs via the Capacitor plugin and
// never registers a service worker, so shipping it inside the app bundle would
// be dead weight.
const webOnly = ['sw.js'];

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

for (const rel of webOnly) {
  if (!existsSync(join(root, rel))) {
    console.warn(`[build:ios] web-only file absent, nothing to skip: ${rel}`);
    continue;
  }
  console.log(`[build:ios] skipped ${rel} (web-only)`);
}

console.log(`[build:ios] done -> ${out}`);
