#!/usr/bin/env node
/* ============================================================================
   FSN API-BASE CHECK — scripts/api-base-check.mjs

   index.html writes every serverless call as a root-relative path
   ('/api/espn?url=…'). That is correct on the web and wrong in the packaged
   iOS binary, where WKWebView loads the page from the app bundle over
   `capacitor://localhost` and '/api/espn' names a file that does not exist.
   The webview answers 404 with an HTML body, the read dies at
   `response.json()`, and the app reports the relay as undeployed while the
   Vercel functions are live.

   window.FSNApi (first script block) rewrites those paths onto the deployed
   app project in a native shell and leaves them alone everywhere else. This
   check pins both halves of that, because the failing half only reproduces
   inside a native container that CI cannot run:

     - a page on an http(s) origin must keep every /api path relative, so a
       preview deploy keeps hitting its own functions instead of production;
     - a native shell — Capacitor's bridge, or any non-http protocol — must
       get absolute URLs on the deployment;
     - non-/api paths and already-absolute URLs are never touched;
     - FSNNet.fetch, which every call site goes through, issues the resolved
       URL rather than the one it was handed.

   Fully offline: a local static server serves the page and every external
   request is aborted at the route seam.
============================================================================ */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOYMENT = 'https://app.fantasysportsnetwork.app';

/* Mirrors resolveChromium() in render-check.mjs — the container's browsers
   live under a build-numbered directory playwright's own resolver misses. */
function resolveChromium() {
  const override = String(process.env.FSN_CHROMIUM_PATH || '').trim();
  if (override) return override;
  const dir = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers');
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((name) => name.startsWith('chromium'))
    .sort()
    .reverse()
    .flatMap((name) => [
      join(dir, name, 'chrome-linux', 'chrome'),
      join(dir, name, 'chrome-linux', 'headless_shell'),
    ])
    .find((file) => existsSync(file)) || null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function serve() {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    try {
      const body = readFileSync(join(root, file));
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      /* Only /api and /sw.js land here, and neither is under test — the point
         is the URL the page builds, not what answers it. */
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not served by api-base-check', file }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

let failures = 0;
function check(name, got, want) {
  if (got === want) { console.log('  ok    ' + name); return; }
  failures++;
  console.error('  FAIL  ' + name + '\n          got  ' + JSON.stringify(got) +
    '\n          want ' + JSON.stringify(want));
}

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[api-base-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') +
    '. Set FSN_CHROMIUM_PATH to run this check.');
  process.exit(1);
}
console.log('[api-base-check] chromium: ' + executablePath);

const { server, base } = await serve();
const browser = await chromium.launch({ executablePath });

/* Nothing in this check may touch the real network: the native shells resolve
   push registration onto the deployment on boot, and a red CI run must mean a
   broken resolver, not a broken link. */
async function newPage(init) {
  const page = await browser.newPage();
  if (init) await page.addInitScript(init);
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base) || url.startsWith('file://')) return route.continue();
    return route.abort();
  });
  return page;
}

const probe = () => ({
  native: window.FSNApi.isNativeShell(),
  espn: window.FSNApi.resolve('/api/espn?url=https%3A%2F%2Fx'),
  league: window.FSNApi.resolve('/api/league?league_id=1'),
  yahoo: window.FSNApi.resolve('/api/auth/yahoo?action=status'),
  sw: window.FSNApi.resolve('/sw.js'),
  absolute: window.FSNApi.resolve('https://lm-api-reads.fantasy.espn.com/x'),
  protocolRelative: window.FSNApi.resolve('//example.test/api/espn'),
});

/* ---- the web, which must be untouched ------------------------------------ */
{
  const page = await newPage();
  await page.goto(base + '/', { waitUntil: 'load' });
  const r = await page.evaluate(probe);
  console.log('\n[web] http origin');
  check('not treated as a native shell', r.native, false);
  check('/api/espn stays relative', r.espn, '/api/espn?url=https%3A%2F%2Fx');
  check('/api/league stays relative', r.league, '/api/league?league_id=1');
  check('/api/auth/yahoo stays relative', r.yahoo, '/api/auth/yahoo?action=status');
  check('/sw.js untouched', r.sw, '/sw.js');
  check('an absolute URL is untouched', r.absolute, 'https://lm-api-reads.fantasy.espn.com/x');
  check('a protocol-relative URL is untouched', r.protocolRelative, '//example.test/api/espn');
  await page.close();
}

/* ---- Capacitor's bridge on an https origin (the Android scheme shape) ----- */
{
  const page = await newPage(() => { window.Capacitor = { isNativePlatform: () => true }; });
  await page.goto(base + '/', { waitUntil: 'load' });
  const r = await page.evaluate(probe);
  console.log('\n[native] Capacitor.isNativePlatform() reports true');
  check('detected as a native shell', r.native, true);
  check('/api/espn resolves onto the deployment', r.espn, DEPLOYMENT + '/api/espn?url=https%3A%2F%2Fx');
  check('/api/league resolves onto the deployment', r.league, DEPLOYMENT + '/api/league?league_id=1');
  check('/api/auth/yahoo resolves onto the deployment', r.yahoo, DEPLOYMENT + '/api/auth/yahoo?action=status');
  check('/sw.js is still untouched', r.sw, '/sw.js');
  check('an absolute URL is still untouched', r.absolute, 'https://lm-api-reads.fantasy.espn.com/x');
  await page.close();
}

/* ---- a non-http protocol with no bridge (the capacitor:// / file:// shape) - */
{
  const page = await newPage();
  await page.goto('file://' + join(root, 'index.html'), { waitUntil: 'load' });
  const r = await page.evaluate(probe);
  console.log('\n[native] non-http protocol, no Capacitor bridge');
  check('detected as a native shell', r.native, true);
  check('/api/espn resolves onto the deployment', r.espn, DEPLOYMENT + '/api/espn?url=https%3A%2F%2Fx');
  await page.close();
}

/* ---- the staging seam ----------------------------------------------------- */
{
  const page = await newPage(() => {
    window.Capacitor = { isNativePlatform: () => true };
    window.FSN_API_ORIGIN = 'https://mffu-preview.vercel.app/';
  });
  await page.goto(base + '/', { waitUntil: 'load' });
  const got = await page.evaluate(() => window.FSNApi.resolve('/api/league?league_id=1'));
  console.log('\n[native] window.FSN_API_ORIGIN override');
  check('the override wins and its trailing slash is trimmed', got,
    'https://mffu-preview.vercel.app/api/league?league_id=1');
  await page.close();
}

/* ---- a malformed override must fall back, and say so ---------------------- */
{
  const errors = [];
  const page = await newPage(() => {
    window.Capacitor = { isNativePlatform: () => true };
    window.FSN_API_ORIGIN = 'http://not-an-origin.example/with/a/path';
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().includes('[FSNApi]')) errors.push(msg.text());
  });
  await page.goto(base + '/', { waitUntil: 'load' });
  const got = await page.evaluate(() => window.FSNApi.resolve('/api/league?league_id=1'));
  console.log('\n[native] malformed window.FSN_API_ORIGIN');
  check('falls back to the deployment', got, DEPLOYMENT + '/api/league?league_id=1');
  check('and reports the rejection instead of failing silently', errors.length > 0, true);
  await page.close();
}

/* ---- the seam every call site actually goes through ----------------------- */
{
  const page = await newPage(() => { window.Capacitor = { isNativePlatform: () => true }; });
  await page.goto(base + '/', { waitUntil: 'load' });
  const requested = await page.evaluate(async () => {
    const real = window.fetch;
    let seen = '';
    window.fetch = function (url) {
      seen = String(url);
      /* Answer locally: this asserts the URL FSNNet builds, not the route. */
      return Promise.resolve(new Response('{}', {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    };
    try {
      await window.FSNNet.fetch('/api/espn?url=probe', {}, { timeoutMs: 3000, label: 'api-base-check probe' });
    } finally {
      window.fetch = real;
    }
    return seen;
  });
  console.log('\n[native] FSNNet.fetch');
  check('issues the resolved URL, not the relative one', requested,
    DEPLOYMENT + '/api/espn?url=probe');
  await page.close();
}

await browser.close();
server.close();

if (failures) {
  console.error('\n[api-base-check] ' + failures + ' failed — mobile /api reads would 404 inside the app bundle.');
  process.exit(1);
}
console.log('\n[api-base-check] clean');
