#!/usr/bin/env node
/* ============================================================================
   FSN — UNIVERSAL LINK CONFIGURATION CHECK

   `node scripts/check-applinks.mjs`

   A universal link is configured in four places that cannot see each other:

     1. ios/App.entitlements          the hosts iOS is told to claim
     2. .well-known/…                 the app project's AASA (app. subdomain)
     3. landing/.well-known/…         the landing project's AASA (apex + www)
     4. index.html (FSNDeepLink)      the hosts the app will route a link from

   Every failure mode here is silent on both sides. A host claimed in the
   entitlement with no AASA behind it is a link that opens Safari. An AASA
   served from a host the entitlement does not claim is a file nobody reads. A
   host the app refuses to route is a link that opens the app on Home. Nothing
   about any of it shows up in a build, a deploy, or the simulator — only on a
   real device, after a real submission.

   So this pins the four to each other, and reports the one value that cannot
   be derived from the repo — the Apple Team ID in the AASA's appIDs — as a
   warning until somebody with access to the developer portal fills it in.
   A placeholder is a warning by default so that a red CI run always means the
   app itself broke; set FSN_REQUIRE_APPLINKS=1 to make it a hard failure,
   which is what a release run should do. A team ID that is present but does
   NOT match APPLE_TEAM_ID always fails — that is a mismatch, not an unfinished
   step, and it ships an app that claims links it cannot open.
============================================================================ */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = '[check-applinks]';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ENTITLEMENTS = join(root, 'ios', 'App.entitlements');
const APP_AASA = join(root, '.well-known', 'apple-app-site-association');
const LANDING_AASA = join(root, 'landing', '.well-known', 'apple-app-site-association');
const INDEX = join(root, 'index.html');
const CAPACITOR = join(root, 'capacitor.config.ts');
const PACKAGE = join(root, 'package.json');
const VERCEL = join(root, 'vercel.json');
const LANDING_VERCEL = join(root, 'landing', 'vercel.json');

// The placeholder shipped until somebody fills in the real Apple Team ID.
const TEAM_ID_PLACEHOLDER = 'TEAMID';

let failed = false;
const fail = (title, detail) => {
  failed = true;
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error title=${title}::${detail.replace(/\s+/g, ' ').trim()}`);
  }
  console.error(`  FAIL  ${title} — ${detail}`);
};
const warn = (title, detail) => {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::warning title=${title}::${detail.replace(/\s+/g, ' ').trim()}`);
  }
  console.warn(`  warn  ${title} — ${detail}`);
};
const pass = (message) => console.log(`  ok    ${message}`);

function read(path, label) {
  if (!existsSync(path)) {
    fail(`${label} is missing`, `Expected ${path}.`);
    return null;
  }
  return readFileSync(path, 'utf8');
}

console.log(`${TAG} pinning the entitlement, both AASA files and the app to each other\n`);

// ---------------------------------------------------------------------------
// 1. The entitlement — which hosts iOS is told to claim.

console.log('[1] ios/App.entitlements');
const entitlements = read(ENTITLEMENTS, 'The entitlements template');
let claimed = [];
if (entitlements) {
  claimed = [...entitlements.matchAll(/<string>applinks:([^<]+)<\/string>/g)].map((m) => m[1].trim());
  if (claimed.length === 0) {
    fail(
      'No applinks in the entitlement',
      'ios/App.entitlements declares no applinks: hosts, so the binary claims no links at all and ' +
        'every shared link opens Safari.'
    );
  } else {
    pass(`claims ${claimed.length} host(s): ${claimed.join(', ')}`);
  }
  if (!/com\.apple\.developer\.associated-domains/.test(entitlements)) {
    fail(
      'No associated-domains key',
      'ios/App.entitlements has no com.apple.developer.associated-domains key, so Xcode signs the ' +
        'binary without the capability.'
    );
  }
}

// ---------------------------------------------------------------------------
// 2. The two AASA files.

console.log('\n[2] The apple-app-site-association files');
const appAasaRaw = read(APP_AASA, 'The app project AASA');
const landingAasaRaw = read(LANDING_AASA, 'The landing project AASA');

let appAasa = null;
for (const [label, raw, path] of [
  ['app project', appAasaRaw, APP_AASA],
  ['landing project', landingAasaRaw, LANDING_AASA],
]) {
  if (!raw) continue;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(
      `The ${label} AASA is not valid JSON`,
      `${path} does not parse (${err.message}). iOS treats an unparseable AASA as no association at all.`
    );
    continue;
  }
  const details = parsed && parsed.applinks && parsed.applinks.details;
  if (!Array.isArray(details) || details.length === 0) {
    fail(`The ${label} AASA declares no applinks details`, `${path} has no applinks.details array.`);
    continue;
  }
  const appIDs = details.flatMap((d) => (Array.isArray(d.appIDs) ? d.appIDs : []));
  if (appIDs.length === 0) {
    fail(`The ${label} AASA names no appIDs`, `${path} declares details with no appIDs, so no app can match it.`);
    continue;
  }
  pass(`${label} AASA parses and names ${appIDs.join(', ')}`);
  if (label === 'app project') appAasa = { parsed, appIDs };
}

if (appAasaRaw && landingAasaRaw && appAasaRaw !== landingAasaRaw) {
  fail(
    'The two AASA files differ',
    'The app project and the landing project must serve the SAME association — iOS fetches each host ' +
      'independently, so a link on one host would behave differently from the same link on another. ' +
      'Copy .well-known/apple-app-site-association over landing/.well-known/apple-app-site-association.'
  );
} else if (appAasaRaw && landingAasaRaw) {
  pass('both projects serve byte-identical association files');
}

// ---------------------------------------------------------------------------
// 3. The bundle identifier, and the Apple Team ID that cannot live in the repo
//    until somebody reads it off the developer portal.

console.log('\n[3] App identity');
const capacitor = read(CAPACITOR, 'capacitor.config.ts');
let bundleId = '';
if (capacitor) {
  const match = capacitor.match(/appId:\s*'([^']+)'/) || capacitor.match(/appId:\s*"([^"]+)"/);
  bundleId = match ? match[1] : '';
  if (!bundleId) {
    fail('No appId in capacitor.config.ts', 'Could not read the bundle identifier to check the AASA against.');
  } else {
    pass(`capacitor.config.ts declares the bundle id ${bundleId}`);
  }
}

if (appAasa && bundleId) {
  const wrong = appAasa.appIDs.filter((id) => !id.endsWith('.' + bundleId));
  if (wrong.length) {
    fail(
      'AASA appIDs do not match the bundle id',
      `The association names ${wrong.join(', ')}, which does not end in .${bundleId}. iOS matches the ` +
        'app by <TeamID>.<BundleID>, so this app would never claim the link.'
    );
  } else {
    pass(`every appID ends in .${bundleId}`);
  }

  const teamIds = appAasa.appIDs.map((id) => id.split('.')[0]);
  const placeholders = teamIds.filter((id) => id === TEAM_ID_PLACEHOLDER);
  const expectedTeam = String(process.env.APPLE_TEAM_ID || '').trim();

  if (placeholders.length) {
    const detail =
      `The AASA still says "${TEAM_ID_PLACEHOLDER}.${bundleId}". Replace ${TEAM_ID_PLACEHOLDER} with ` +
      (expectedTeam ? `the Apple Team ID this build signs with (${expectedTeam})` :
        'the Apple Team ID (Apple Developer -> Membership -> Team ID)') +
      ' in BOTH .well-known/apple-app-site-association and ' +
      'landing/.well-known/apple-app-site-association before the first App Store submission, or iOS ' +
      'will never verify the association and every shared link will open Safari instead of the app.';
    /* A warning, not a failure, unless a release run asks for the gate: the
       value is not in the repo to be got right, and a red run on main has to
       keep meaning that the app broke. */
    if (process.env.FSN_REQUIRE_APPLINKS === '1') fail('The Apple Team ID is still a placeholder', detail);
    else warn('The Apple Team ID is still a placeholder', detail);
  } else if (expectedTeam && !teamIds.includes(expectedTeam)) {
    fail(
      'The AASA names the wrong Apple Team ID',
      `APPLE_TEAM_ID is ${expectedTeam} but the association names ${teamIds.join(', ')}. Update both ` +
        'apple-app-site-association files.'
    );
  } else {
    pass(`the association names the Apple Team ID ${teamIds.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// 4. The app's own view of which hosts it will route.

console.log('\n[4] index.html — FSNDeepLink');
const index = read(INDEX, 'index.html');
if (index) {
  if (!/window\.FSNDeepLink\s*=/.test(index)) {
    fail(
      'FSNDeepLink is missing',
      'index.html defines no window.FSNDeepLink, so nothing parses a link the app is handed and every ' +
        'universal link opens the app on Home.'
    );
  } else {
    pass('window.FSNDeepLink is defined at global scope');
  }

  const hostsBlock = index.match(/const HOSTS = \[([\s\S]*?)\];/);
  const routed = hostsBlock
    ? [...hostsBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    : [];
  if (routed.length === 0) {
    fail('FSNDeepLink lists no hosts', 'Could not read the HOSTS array out of index.html.');
  } else {
    pass(`the app routes links from ${routed.join(', ')}`);
  }

  if (claimed.length && routed.length) {
    const missingFromApp = claimed.filter((h) => !routed.includes(h));
    const missingFromEntitlement = routed.filter((h) => !claimed.includes(h));
    if (missingFromApp.length) {
      fail(
        'A claimed host the app will not route',
        `${missingFromApp.join(', ')} is in ios/App.entitlements but not in FSNDeepLink.HOSTS. iOS would ` +
          'open the app for those links and the app would ignore them.'
      );
    }
    if (missingFromEntitlement.length) {
      fail(
        'A routed host iOS does not claim',
        `${missingFromEntitlement.join(', ')} is in FSNDeepLink.HOSTS but not in ios/App.entitlements, so ` +
          'those links open Safari and never reach the app.'
      );
    }
    if (!missingFromApp.length && !missingFromEntitlement.length) {
      pass('the entitlement and the app agree on every host');
    }
  }

  if (!/@capacitor\/app/.test(readFileSync(PACKAGE, 'utf8'))) {
    fail(
      '@capacitor/app is not a dependency',
      'The native half of the feature reads the launch URL and the appUrlOpen event from that plugin. ' +
        'Without it a universal link brings the app to the front on whatever screen it was left on.'
    );
  } else {
    pass('@capacitor/app is a dependency, so the binary can receive a link');
  }
}

// ---------------------------------------------------------------------------
// 5. Vercel has to answer the AASA as application/json.

console.log('\n[5] Vercel — the AASA content type');
for (const [label, path] of [['app project', VERCEL], ['landing project', LANDING_VERCEL]]) {
  const raw = read(path, `${label} vercel.json`);
  if (!raw) continue;
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    fail(`${label} vercel.json is not valid JSON`, `${path} does not parse (${err.message}).`);
    continue;
  }
  const headers = Array.isArray(config.headers) ? config.headers : [];
  const rule = headers.find((h) => String(h.source || '').includes('apple-app-site-association'));
  const value = rule && (rule.headers || []).find((h) => String(h.key || '').toLowerCase() === 'content-type');
  if (!value || !/application\/json/.test(String(value.value || ''))) {
    fail(
      `${label} does not serve the AASA as JSON`,
      `${path} has no headers rule setting Content-Type: application/json on ` +
        '/.well-known/apple-app-site-association. The file has no extension, so Vercel serves it as ' +
        'application/octet-stream and iOS rejects the association without a word.'
    );
  } else {
    pass(`${label} serves the AASA as ${value.value}`);
  }
  if (config.routes) {
    fail(
      `${label} vercel.json declares a legacy routes block`,
      'A "routes" key disables filesystem handling and the zero-config api/ functions with it. Use ' +
        '"headers" / "rewrites" instead (see DEPLOYMENT.md).'
    );
  }
}

console.log('');
if (failed) {
  console.error(`${TAG} FAILED`);
  process.exit(1);
}
console.log(`${TAG} clean`);
