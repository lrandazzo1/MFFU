/**
 * Stage the production web assets into `www/` for Capacitor.
 *
 * This is an iOS-only packaging step. It never modifies the files it reads —
 * the Vercel deployments keep serving `index.html` / `league-media-studio.html`
 * straight from the repository root exactly as they do today.
 *
 * Two things happen here:
 *   1. The production HTML entry points are copied into `www/` (Capacitor's
 *      `webDir`), which is the directory `npx cap sync` bundles into the app.
 *   2. A small shim is injected into the *copies* so that the root-relative
 *      `/api/*` calls in the app resolve against the live Vercel deployment.
 *      Inside the native shell the page is served from `capacitor://localhost`,
 *      where `/api/*` would otherwise 404.
 *
 * Usage: node scripts/build-ios-web.mjs   (npm run build:ios)
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'www');

// The deployed app project (see DEPLOYMENT.md). Override in CI if the API ever
// moves: FSN_API_ORIGIN=https://staging.example.app node scripts/build-ios-web.mjs
const API_ORIGIN = (process.env.FSN_API_ORIGIN || 'https://app.fantasysportsnetwork.app').replace(/\/+$/, '');

// Entry points copied verbatim out of the repository root.
const ENTRY_POINTS = ['index.html', 'league-media-studio.html'];

const apiShim = `<script>
/* Injected by scripts/build-ios-web.mjs for the native iOS shell only.
   Rewrites root-relative /api/* requests onto the deployed serverless
   functions, because the WebView serves this bundle from capacitor://localhost.
   On any http(s) origin (Vercel, local preview) it is a no-op. */
(function () {
  var API_ORIGIN = ${JSON.stringify(API_ORIGIN)};
  if (location.protocol === 'http:' || location.protocol === 'https:') return;

  function absolutize(url) {
    return typeof url === 'string' && url.indexOf('/api/') === 0 ? API_ORIGIN + url : url;
  }

  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      if (typeof input === 'string') {
        input = absolutize(input);
      } else if (input && typeof input.url === 'string' && input.url.indexOf('/api/') === 0) {
        input = new Request(absolutize(input.url), input);
      }
      return nativeFetch.call(this, input, init);
    };
  }

  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = absolutize(url);
    return nativeOpen.apply(this, args);
  };
})();
</script>
`;

async function stage(name) {
  const source = await readFile(join(ROOT, name), 'utf8');

  // Inject as early as possible, but *after* `<meta charset>` — that tag has to
  // stay inside the first 1024 bytes for the browser's encoding sniffer. The
  // shim only has to beat the application code, and all of it lives further
  // down the document. If there is no <head> at all we fail loudly rather than
  // shipping a bundle whose API calls silently 404.
  const headMatch = source.match(/<head[^>]*>/i);
  if (!headMatch) {
    throw new Error(`${name}: no <head> tag found; cannot inject the iOS API shim.`);
  }
  const headEnd = headMatch.index + headMatch[0].length;
  const charsetMatch = source.slice(headEnd).match(/<meta[^>]*charset[^>]*>/i);
  const insertAt = charsetMatch ? headEnd + charsetMatch.index + charsetMatch[0].length : headEnd;
  const staged = source.slice(0, insertAt) + '\n' + apiShim + source.slice(insertAt);

  await writeFile(join(OUT_DIR, name), staged);
  console.log(`  staged ${name} (${(staged.length / 1024).toFixed(0)} KB)`);
}

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

console.log(`Staging web assets into www/ (API origin: ${API_ORIGIN})`);
for (const entry of ENTRY_POINTS) {
  await stage(entry);
}
console.log('Done. Run "npx cap sync ios" to copy this into the Xcode project.');
