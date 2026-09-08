#!/usr/bin/env node
// Stage the static web app into `www/` for Capacitor to package.
// This is the iOS-only build step. Vercel (web) still serves index.html
// straight from the repo root and does not run this script.
import { mkdirSync, rmSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
// be dead weight. The apple-app-site-association is the same shape of thing in
// the other direction: it is what the DEPLOYMENT serves so iOS can verify the
// app owns fantasysportsnetwork.app links, and it is meaningless inside the
// bundle — the app's own half of that handshake is the entitlement written by
// scripts/ios-associated-domains.mjs.
const webOnly = ['sw.js', '.well-known/apple-app-site-association'];

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
  if(rel === 'index.html'){
    let html = readFileSync(src, 'utf8');
    if(!html.includes('data-fsn-release="web"')) throw new Error('Missing FSN release marker');
    const starts = html.match(/<!-- FSN_WEB_ONLY_START -->/g) || [];
    const ends = html.match(/<!-- FSN_WEB_ONLY_END -->/g) || [];
    if(starts.length !== 2 || starts.length !== ends.length) throw new Error('Unbalanced web-only UI markers');
    html = html.replace('data-fsn-release="web"', 'data-fsn-release="ios"')
      .replace(/<!-- FSN_WEB_ONLY_START -->[\s\S]*?<!-- FSN_WEB_ONLY_END -->/g, '');
    if(/id="(?:providerYahoo|yahooAuthPanel)"/.test(html)) throw new Error('Web-only provider UI leaked into iOS');
    writeFileSync(dst, html);
  } else {
    copyFileSync(src, dst);
  }
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
