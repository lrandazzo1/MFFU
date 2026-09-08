#!/usr/bin/env node
/* ============================================================================
   FSN — LEGAL LINK CHECK

   `node scripts/legal-links-check.mjs`

   The Privacy Policy and Terms of Service links in Setup are an App Store
   Guideline 5.1.1 requirement, and "working" means two separate things that
   fail independently:

     1. The tap reaches a real external opener. index.html ships to the web
        AND into a Capacitor binary, where a bare target="_blank" anchor
        either does nothing or replaces the running app with the policy page.
        FSNLinks.openExternal() picks the right opener per shell.
     2. The URL it opens actually resolves. Both links point at the landing
        deployment, whose Root Directory is landing/ — so the destination has
        to be a file in there, served without its extension by cleanUrls.

   This check covers both halves, across all four shells the app runs in.
   Like the other checks in `npm run verify`, it asserts against the real
   index.html rather than a fixture: there is no build step to catch anything.
============================================================================ */

import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/* Serves the repo root for the app, and mirrors the landing project's
   `cleanUrls: true` under /legal/* so /legal/privacy resolves the same way
   www.fantasysportsnetwork.app/privacy does in production. */
function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/api/notifications-register') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configured: false, apns: false, web: false, groups: [] }));
        return;
      }

      let rel = url.pathname === '/' ? '/index.html' : url.pathname;
      if (rel.startsWith('/legal/')) {
        const name = rel.slice('/legal/'.length);
        rel = '/landing/' + (extname(name) ? name : name + '.html');
      }

      const file = join(root, rel.replace(/^\/+/, ''));
      if (!file.startsWith(root) || !existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

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

let failed = false;
const fail = (message) => { failed = true; console.error('  FAIL  ' + message); };
const pass = (message) => console.log('  ok    ' + message);

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[legal-links-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  server.close();
  process.exit(1);
}

const browser = await chromium.launch({ executablePath });

/* Records what each opener was handed, and whether the anchor's own navigation
   was left to stand. `Browser` is the plugin shape a native binary exposes on
   window.Capacitor.Plugins once @capacitor/browser is linked by `cap sync`.

   Passed to addInitScript as a plain function plus a config argument — a bound
   function serialises as "[native code]" and would silently install nothing. */
function instrument(config) {
  window.__legal = { windowOpen: [], browserOpen: [], notPrevented: [], warned: [], errored: [] };

  try { window.localStorage.setItem('hasCompletedOnboarding', 'true'); } catch (err) { /* private mode */ }

  window.open = function (url, target) {
    window.__legal.windowOpen.push({ url: String(url), target: String(target) });
    return config.popupBlocked ? null : { closed: false, focus() {} };
  };

  if (config.native) {
    const plugins = {};
    if (config.browserPlugin) {
      plugins.Browser = {
        open(o) {
          window.__legal.browserOpen.push(String(o && o.url));
          return Promise.resolve();
        },
      };
    }
    window.Capacitor = { isNativePlatform: () => true, isNative: true, Plugins: plugins };
  }

  const warn = console.warn.bind(console);
  const error = console.error.bind(console);
  console.warn = function (...args) { window.__legal.warned.push(args.map(String).join(' ')); warn(...args); };
  console.error = function (...args) { window.__legal.errored.push(args.map(String).join(' ')); error(...args); };

  /* Bubble phase, so the app's own anchor handler has already run and
     defaultPrevented reads true when it took the tap over. The harness then
     always prevents, because the destination is a real external host. */
  document.addEventListener('click', function (ev) {
    const link = ev.target && ev.target.closest && ev.target.closest('.privacy-link');
    if (!link) return;
    if (!ev.defaultPrevented) window.__legal.notPrevented.push(link.getAttribute('href'));
    ev.preventDefault();
  });
}

async function openApp(config) {
  const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
  await page.addInitScript(instrument, config || {});
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  return { page, pageErrors };
}

try {
  /* ---- 1. The links exist, and point where they claim to ----------------- */
  const { page, pageErrors } = await openApp({});

  const links = await page.$$eval('.privacy-link', (els) => els.map((e) => ({
    href: e.getAttribute('href'),
    label: (e.textContent || '').replace(/\s+/g, ' ').trim(),
    target: e.getAttribute('target'),
    rel: e.getAttribute('rel'),
  })));

  if (links.length !== 2) fail('expected 2 .privacy-link anchors in Setup, found ' + links.length);
  else pass('found both policy links: ' + links.map((l) => l.label).join(' | '));

  const expected = [
    'https://www.fantasysportsnetwork.app/privacy',
    'https://www.fantasysportsnetwork.app/terms',
  ];
  for (const href of expected) {
    if (links.some((l) => l.href === href)) pass('link present: ' + href);
    else fail('no policy link points at ' + href);
  }

  /* The anchor must keep its own href and target: that is what keeps the web
     build, keyboard navigation and "copy link address" working when the
     handler stands down. */
  for (const l of links) {
    if (l.target === '_blank' && /noopener/.test(l.rel || '')) pass('anchor keeps target=_blank + rel=noopener: ' + l.label);
    else fail('anchor lost its target/rel hardening: ' + l.label);
  }

  /* ---- 2. Every hosted URL resolves to a real page ----------------------- */
  for (const href of expected) {
    const path = new URL(href).pathname;
    const file = join(root, 'landing', path.replace(/^\/+/, '') + '.html');
    if (existsSync(file)) pass('destination file exists for ' + path + ' → landing' + path + '.html');
    else fail('DEAD LINK: ' + href + ' has no page — expected landing' + path + '.html');

    const doc = await browser.newPage();
    const docErrors = [];
    doc.on('pageerror', (err) => docErrors.push(String((err && err.stack) || err)));
    const resp = await doc.goto(base + '/legal' + path, { waitUntil: 'load' });
    const status = resp ? resp.status() : 0;
    if (status === 200) pass('GET ' + path + ' → 200 (cleanUrls, no .html extension)');
    else fail('GET ' + path + ' → ' + status);

    const title = await doc.title();
    if (/Fantasy Sports Network/.test(title) && /Privacy Policy|Terms of Service/.test(title)) {
      pass(path + ' titled: ' + title);
    } else {
      fail(path + ' has an unexpected title: ' + title);
    }

    const headings = await doc.$$eval('h2', (els) => els.length);
    if (headings >= 5) pass(path + ' renders ' + headings + ' sections');
    else fail(path + ' rendered only ' + headings + ' sections');

    const crossLink = await doc.$$eval('a[href="/terms"], a[href="/privacy"]', (els) => els.length);
    if (crossLink >= 1) pass(path + ' cross-links the other policy');
    else fail(path + ' does not link to its sibling policy');

    if (docErrors.length) fail(path + ' raised page errors: ' + docErrors.join(' | '));
    else pass(path + ': zero uncaught page errors');
    await doc.close();
  }

  /* ---- 3. Web shell: the tap opens a new tab ----------------------------- */
  await page.click('.privacy-link');
  await page.waitForTimeout(200);
  const web = await page.evaluate(() => window.__legal);
  if (web.windowOpen.length === 1 && web.windowOpen[0].url === expected[0] && web.windowOpen[0].target === '_blank') {
    pass('web: tap called window.open(' + web.windowOpen[0].url + ', _blank)');
  } else {
    fail('web: expected one window.open for the privacy URL, got ' + JSON.stringify(web.windowOpen));
  }
  if (!web.notPrevented.length) pass('web: the handler took the tap over (default prevented)');
  else fail('web: the anchor navigated instead of being handled: ' + web.notPrevented.join(', '));
  if (pageErrors.length) fail('web: page errors during the tap: ' + pageErrors.join(' | '));
  else pass('web: zero uncaught page errors');
  await page.close();

  /* ---- 4. Web shell, popup blocked: fall back to the anchor -------------- */
  const blocked = await openApp({ popupBlocked: true });
  await blocked.page.click('.privacy-link');
  await blocked.page.waitForTimeout(200);
  const bl = await blocked.page.evaluate(() => window.__legal);
  if (bl.notPrevented.length === 1) pass('popup blocked: the anchor is left to navigate rather than dead-ending');
  else fail('popup blocked: expected the handler to stand down, got ' + JSON.stringify(bl.notPrevented));
  if (bl.warned.some((w) => /\[FSNLinks\].*popup blocked/.test(w))) pass('popup blocked: reported, not swallowed');
  else fail('popup blocked: nothing logged — the failure would be invisible');
  await blocked.page.close();

  /* ---- 5. Native binary with the Browser plugin -------------------------- */
  const native = await openApp({ native: true, browserPlugin: true });
  await native.page.click('.privacy-link');
  await native.page.waitForTimeout(200);
  const nat = await native.page.evaluate(() => window.__legal);
  if (nat.browserOpen.length === 1 && nat.browserOpen[0] === expected[0]) {
    pass('native: tap opened the in-app browser at ' + nat.browserOpen[0]);
  } else {
    fail('native: expected Capacitor Browser.open for the privacy URL, got ' + JSON.stringify(nat.browserOpen));
  }
  if (!nat.windowOpen.length) pass('native: window.open was not used (it would replace the running app)');
  else fail('native: fell through to window.open ' + JSON.stringify(nat.windowOpen));
  if (!nat.notPrevented.length) pass('native: the handler took the tap over (default prevented)');
  else fail('native: the anchor navigated in place: ' + nat.notPrevented.join(', '));
  await native.page.close();

  /* ---- 6. Native binary WITHOUT the plugin: stand down, loudly ----------- */
  const legacy = await openApp({ native: true, browserPlugin: false });
  await legacy.page.click('.privacy-link');
  await legacy.page.waitForTimeout(200);
  const leg = await legacy.page.evaluate(() => window.__legal);
  if (!leg.windowOpen.length && !leg.browserOpen.length) {
    pass('legacy native build: no opener was forced (the app is not navigated away)');
  } else {
    fail('legacy native build: something opened anyway: ' +
      JSON.stringify({ windowOpen: leg.windowOpen, browserOpen: leg.browserOpen }));
  }
  if (leg.warned.some((w) => /\[FSNLinks\].*Capacitor Browser plugin/.test(w))) {
    pass('legacy native build: says exactly what is missing and how to fix it');
  } else {
    fail('legacy native build: the missing plugin was not reported');
  }
  await legacy.page.close();

  /* ---- 7. Only http(s) is ever handed to an opener ----------------------- */
  const guard = await openApp({});
  const guarded = await guard.page.evaluate(() => ({
    js: window.FSNLinks.openExternal('javascript:alert(1)'),
    data: window.FSNLinks.openExternal('data:text/html,<b>x</b>'),
    empty: window.FSNLinks.openExternal(''),
    https: window.FSNLinks.externalUrl('https://www.fantasysportsnetwork.app/terms'),
    opened: window.__legal.windowOpen.length,
    errors: window.__legal.errored.length,
  }));
  if (guarded.js === false && guarded.data === false && guarded.empty === false) {
    pass('scheme guard: javascript:, data: and empty URLs are all refused');
  } else {
    fail('scheme guard: a non-http(s) URL was accepted: ' + JSON.stringify(guarded));
  }
  if (guarded.opened === 0) pass('scheme guard: nothing reached an opener');
  else fail('scheme guard: ' + guarded.opened + ' refused URL(s) still reached window.open');
  if (guarded.errors >= 2) pass('scheme guard: each refusal is logged');
  else fail('scheme guard: refusals were swallowed');
  if (guarded.https === 'https://www.fantasysportsnetwork.app/terms') pass('scheme guard: a real https URL passes through unchanged');
  else fail('scheme guard: mangled a valid https URL into ' + guarded.https);
  await guard.page.close();
} catch (err) {
  fail('threw: ' + ((err && err.stack) || err));
} finally {
  await browser.close();
  server.close();
}

if (failed) {
  console.error('\n[legal-links-check] FAILED');
  process.exit(1);
}
console.log('\n[legal-links-check] clean');
