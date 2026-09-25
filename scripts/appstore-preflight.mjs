#!/usr/bin/env node
// App Store Connect credential preflight for the iOS CI workflow.
//
// The distribution half of the iOS build (xcodebuild archive, export and the
// TestFlight upload) can only work if the four App Store Connect secrets are
// present AND Apple actually accepts them. When they don't, xcodebuild reports
// it as a wall of downstream noise -- "No profiles for '<bundle id>' were
// found", "No signing certificate \"iOS Distribution\" found" -- which reads
// like a project misconfiguration and has repeatedly sent people editing the
// Xcode project instead of the key. The real line is buried:
//
//   IDEDistribution: App Store Connect request for store configuration failed
//   ... Code=-19000 "Failure to authenticate."
//   A non-HTTP 200 response was received (401) for URL .../listTeams.action
//
// So: normalize and validate the .p8, mint the ES256 JWT ourselves, and ask
// App Store Connect directly. That turns an ambiguous 40-line xcodebuild dump
// into one sentence naming which of the four secrets is wrong and why.
//
// This script NEVER throws on a bad credential -- it reports. The workflow
// decides whether a missing credential skips distribution (push builds, so a
// code regression is still the only thing that turns main red) or fails the
// run (an explicit credential check via workflow_dispatch).
//
// Secret material is never logged: only pass/fail and Apple's status code.
import { createPrivateKey, randomUUID, sign as cryptoSign } from 'node:crypto';
import { writeFileSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const API_BASE = 'https://api.appstoreconnect.apple.com/v1';
const TAG = '[preflight]';
// The TestFlight upload action takes the private key as a *value*, not a path,
// so the normalized PEM is handed to that step through the environment under
// this name. Keep in sync with .github/workflows/ios-build.yml.
const UPLOAD_KEY_ENV = 'APPSTORE_CONNECT_PRIVATE_KEY_PEM';

const env = (name) => (process.env[name] || '').trim();

const keyId = env('APPSTORE_CONNECT_KEY_ID');
const issuerId = env('APPSTORE_CONNECT_ISSUER_ID');
const teamId = env('APPLE_TEAM_ID');
const rawKey = process.env.APPSTORE_CONNECT_PRIVATE_KEY || '';
const keyPath = env('APPSTORE_KEY_PATH');
const bundleId = env('APP_BUNDLE_ID');

// ---------------------------------------------------------------------------
// 6. The version train
//
// A marketing version is CLOSED for new build submissions once a build has been
// approved against it. Every upload after that is rejected by email, minutes
// after a perfectly green run, with:
//
//   ITMS-90186 Invalid Pre-Release Train - the train version 'X' is closed
//   ITMS-90062 CFBundleShortVersionString [X] must contain a higher version
//              than that of the previously approved version [X]
//
// APP_MARKETING_VERSION in the workflow is a hand-maintained constant, and a
// hand-maintained constant drifts: this repo has now shipped a rejected build
// twice for exactly that reason, once on a stale build-number floor and once on
// a stale marketing version. So rather than trusting the constant, ask Apple
// what is already closed and refuse to archive against it.
//
// Fails CLOSED only on a definite answer. Any API or parsing failure is a note
// and the run continues: an Apple outage must not become a release outage, and
// the upload step still has the final say.

/* Semantic-ish compare over dotted numeric versions. Returns -1, 0 or 1.
   Missing components count as zero, so 1.0 and 1.0.0 compare equal, and a
   non-numeric component sorts as zero rather than NaN-poisoning the compare. */
function compareVersions(a, b) {
  const parts = (value) => String(value == null ? '' : value).trim().split('.')
    .map((piece) => {
      const n = Number.parseInt(piece, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const left = parts(a);
  const right = parts(b);
  const width = Math.max(left.length, right.length);
  for (let i = 0; i < width; i++) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/* App Store Connect states in which a version will no longer take a new build.
   Everything else (PREPARE_FOR_SUBMISSION, the rejected states, in-review) is
   still open, and a build uploaded against it is accepted.

   Listed explicitly rather than inferred: Apple adds states, and an unknown
   state must read as OPEN so a new one never silently blocks every release.
   The cost of being wrong in that direction is the rejection email this guard
   is trying to prevent; the cost in the other direction is a repo that cannot
   ship at all until someone edits this list. */
const CLOSED_STATES = new Set([
  'ACCEPTED',
  'DEVELOPER_REMOVED_FROM_SALE',
  'PENDING_APPLE_RELEASE',
  'PENDING_DEVELOPER_RELEASE',
  'PREORDER_READY_FOR_SALE',
  'PROCESSING_FOR_APP_STORE',
  'READY_FOR_SALE',
  'REMOVED_FROM_SALE',
  'REPLACED_BY_NEW_VERSION',
]);

/* The highest version string that is already closed, or '' if none is. */
function highestClosedVersion(versions) {
  let highest = '';
  for (const entry of Array.isArray(versions) ? versions : []) {
    const attrs = (entry && entry.attributes) || {};
    const version = String(attrs.versionString || '').trim();
    const state = String(attrs.appStoreState || '').trim().toUpperCase();
    if (!version || !CLOSED_STATES.has(state)) continue;
    if (!highest || compareVersions(version, highest) > 0) highest = version;
  }
  return highest;
}

/* The next patch above a version: 1.0.2 -> 1.0.3. Only the last component
   moves, because that is the bump this situation calls for and guessing at a
   minor or major bump is a product decision, not a build one. */
function nextPatch(version) {
  const parts = String(version || '').trim().split('.');
  if (!parts.length || !parts[0]) return '';
  const last = Number.parseInt(parts[parts.length - 1], 10);
  parts[parts.length - 1] = String((Number.isFinite(last) ? last : 0) + 1);
  return parts.join('.');
}

/* The highest CFBundleVersion already delivered for one marketing version.
   Builds are scoped to a train, so a build number is only "taken" within the
   version it was uploaded against. */
function highestBuildFor(builds, marketing) {
  let highest = 0;
  for (const entry of Array.isArray(builds) ? builds : []) {
    const attrs = (entry && entry.attributes) || {};
    const train = String(
      (entry.preReleaseVersionString != null ? entry.preReleaseVersionString : attrs.preReleaseVersionString) || ''
    ).trim();
    if (marketing && train && train !== marketing) continue;
    const number = Number.parseInt(String(attrs.version || '').trim(), 10);
    if (Number.isFinite(number) && number > highest) highest = number;
  }
  return highest;
}

/**
 * The whole decision, as a pure function, so it can be tested without Apple.
 *
 * Returns { ok, code, headline, remedy, note }. `ok: true` with a `note` is the
 * "could not tell, carry on" case; `ok: false` is a definite refusal.
 */
function judgeVersionTrain({ marketing, build, versions, builds }) {
  if (!marketing) {
    return { ok: true, note: 'No APP_MARKETING_VERSION passed to the preflight; version train not checked.' };
  }
  const closed = highestClosedVersion(versions);
  if (closed && compareVersions(marketing, closed) <= 0) {
    const suggested = nextPatch(closed);
    return {
      ok: false,
      code: 'version-train-closed',
      headline:
        `App Store Connect has already closed version ${closed} for new build submissions, and this run ` +
        `intends to upload as ${marketing}. Apple would reject the upload with ITMS-90186 and ITMS-90062 ` +
        `after the archive completes.`,
      remedy:
        `Set \`APP_MARKETING_VERSION\` in .github/workflows/ios-build.yml to \`${suggested}\` (and keep ` +
        '`version` in package.json matching it), then re-run. CFBundleShortVersionString has to be strictly ' +
        `greater than the highest approved version, which is currently ${closed}.`,
    };
  }

  const taken = highestBuildFor(builds, marketing);
  const wanted = Number.parseInt(String(build || '').trim(), 10);
  if (taken && Number.isFinite(wanted) && wanted <= taken) {
    return {
      ok: false,
      code: 'build-number-taken',
      headline:
        `Build ${wanted} is not above the highest build already delivered for ${marketing}, which is ${taken}. ` +
        'App Store Connect requires CFBundleVersion to increase strictly within a marketing version.',
      remedy:
        `Raise \`APP_BUILD_NUMBER_FLOOR\` in .github/workflows/ios-build.yml to at least \`${taken}\`, then ` +
        're-run. The workflow resolves CFBundleVersion as max(github.run_number, that floor).',
    };
  }

  const parts = [`Version train ${marketing} is open`];
  if (closed) parts.push(`highest closed version is ${closed}`);
  if (taken) parts.push(`highest build already delivered for this train is ${taken}`);
  return { ok: true, note: parts.join('; ') + '.' };
}

// ---------------------------------------------------------------------------
// Self-test. Runs before anything touches a secret or the network, because the
// decision above is the part worth testing and it must be testable without an
// Apple account. `npm run check:appstore` is this and nothing else.

function runSelfTest() {
  const failures = [];
  const check = (value, message) => { if (!value) failures.push(message); };

  check(compareVersions('1.0.2', '1.0.3') === -1, 'compareVersions did not order a lower patch first');
  check(compareVersions('1.0.10', '1.0.9') === 1, 'compareVersions compared components as strings');
  check(compareVersions('1.0', '1.0.0') === 0, 'compareVersions did not treat a missing component as zero');
  check(compareVersions('2.0.0', '1.9.9') === 1, 'compareVersions did not order a major bump above a minor one');
  check(compareVersions('1.0.x', '1.0.0') === 0, 'a non-numeric component did not fall back to zero');
  check(nextPatch('1.0.2') === '1.0.3', 'nextPatch did not bump the last component');
  check(nextPatch('1.0.9') === '1.0.10', 'nextPatch rolled over instead of incrementing');
  check(nextPatch('') === '', 'nextPatch invented a version out of nothing');

  const closedVersions = [
    { attributes: { versionString: '1.0.1', appStoreState: 'REPLACED_BY_NEW_VERSION' } },
    { attributes: { versionString: '1.0.2', appStoreState: 'READY_FOR_SALE' } },
    { attributes: { versionString: '1.1.0', appStoreState: 'PREPARE_FOR_SUBMISSION' } },
  ];
  check(highestClosedVersion(closedVersions) === '1.0.2', 'the highest closed version was not 1.0.2');
  check(highestClosedVersion([]) === '', 'an app with no versions reported one as closed');
  check(highestClosedVersion([{ attributes: { versionString: '9.9.9', appStoreState: 'SOME_NEW_STATE' } }]) === '',
    'an unrecognised state was treated as closed, which would block every release until this list was edited');

  /* The exact rejection that prompted this guard: build 186 delivered as 1.0.2
     while 1.0.2 was already approved. */
  const rejected = judgeVersionTrain({ marketing: '1.0.2', build: '186', versions: closedVersions, builds: [] });
  check(rejected.ok === false && rejected.code === 'version-train-closed',
    'a closed train was not refused, which is the exact case that shipped a rejected build');
  check(/1\.0\.3/.test(rejected.remedy), 'the refusal did not name the version to bump to');

  const bumped = judgeVersionTrain({ marketing: '1.0.3', build: '187', versions: closedVersions, builds: [] });
  check(bumped.ok === true, 'a version above the highest closed one was refused');

  /* Equal is closed too: Apple wants strictly greater. */
  check(judgeVersionTrain({ marketing: '1.0.1', build: '1', versions: closedVersions, builds: [] }).ok === false,
    'a version below the highest closed one was allowed');

  const builds = [
    { attributes: { version: '184' }, preReleaseVersionString: '1.0.3' },
    { attributes: { version: '187' }, preReleaseVersionString: '1.0.3' },
    { attributes: { version: '999' }, preReleaseVersionString: '1.0.2' },
  ];
  check(highestBuildFor(builds, '1.0.3') === 187, 'the highest build for a train counted another train\'s builds');
  check(highestBuildFor([{ attributes: { version: '42' } }], '1.0.3') === 42,
    'a build with no train string was skipped, but a server-side filtered response carries none');

  const taken = judgeVersionTrain({ marketing: '1.0.3', build: '187', versions: closedVersions, builds });
  check(taken.ok === false && taken.code === 'build-number-taken', 'a build number already delivered was accepted');
  check(/187/.test(taken.remedy), 'the build refusal did not name the floor to raise');
  check(judgeVersionTrain({ marketing: '1.0.3', build: '188', versions: closedVersions, builds }).ok === true,
    'a build number above everything delivered was refused');

  /* Could-not-tell cases carry on rather than blocking a release. */
  check(judgeVersionTrain({ marketing: '', build: '1', versions: closedVersions, builds }).ok === true,
    'a missing marketing version blocked the run instead of noting it');
  check(judgeVersionTrain({ marketing: '1.0.3', build: '188', versions: null, builds: null }).ok === true,
    'an unreadable API response blocked the run instead of noting it');

  /* The workflow constant and package.json are the two hand-maintained copies
     of this number, and they drifting apart is how the wrong one ships. */
  try {
    const workflow = readFileSync(new URL('../.github/workflows/ios-build.yml', import.meta.url), 'utf8');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const match = workflow.match(/^\s*APP_MARKETING_VERSION:\s*'([^']+)'/m);
    check(!!match, 'APP_MARKETING_VERSION was not found in .github/workflows/ios-build.yml');
    if (match) {
      check(match[1] === pkg.version,
        'APP_MARKETING_VERSION (' + match[1] + ') and package.json version (' + pkg.version + ') disagree. ' +
        'They are the two hand-maintained copies of the shipped version and must move together.');
    }
    const floor = workflow.match(/^\s*APP_BUILD_NUMBER_FLOOR:\s*'(\d+)'/m);
    check(!!floor, 'APP_BUILD_NUMBER_FLOOR was not found in .github/workflows/ios-build.yml');
  } catch (err) {
    failures.push('could not read the workflow or package.json to compare versions: ' + err.message);
  }

  if (failures.length) {
    console.error(`${TAG} SELF-TEST FAILED:`);
    failures.forEach((failure) => console.error(`  - ${failure}`));
    process.exit(1);
  }
  console.log(`${TAG} self-test passed: version ordering, the closed-state list (unknown states read as open), ` +
    `the ITMS-90186 refusal and the version it names, per-train build numbers, the carry-on cases, and ` +
    `APP_MARKETING_VERSION matching package.json.`);
  process.exit(0);
}

if (process.argv.includes('--self-test')) runSelfTest();

// ---------------------------------------------------------------------------
// Reporting

const notes = [];

function emit(available, code, headline, remedy) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    // GITHUB_OUTPUT is line-oriented: a newline inside a value silently
    // truncates it and lets the remainder be parsed as further outputs.
    // Apple's error detail is arbitrary text, so flatten it.
    const oneLine = String(headline).replace(/\s+/g, ' ').trim();
    appendFileSync(out, `available=${available}\n`);
    appendFileSync(out, `code=${code}\n`);
    appendFileSync(out, `headline=${oneLine}\n`);
  }

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const lines = [
      `### App Store Connect credentials — ${available ? '✅ accepted' : '⚠️ not usable'}`,
      '',
      headline,
      ''
    ];
    if (remedy) lines.push(remedy, '');
    if (notes.length) lines.push(...notes.map((n) => `- ${n}`), '');
    appendFileSync(summary, lines.join('\n'));
  }

  if (available) {
    console.log(`${TAG} ${headline}`);
  } else {
    // ::warning is deliberate: on a push build a bad key skips distribution
    // rather than failing, and a plain console line would scroll away unseen.
    console.log(`::warning title=App Store Connect credentials (${code})::${headline}`);
    console.error(`${TAG} ${code}: ${headline}`);
    if (remedy) console.error(`${TAG} remedy: ${remedy.replace(/\n+/g, ' ')}`);
  }

  for (const note of notes) console.log(`${TAG} note: ${note}`);

  if (!available && env('REQUIRE_SIGNING') === 'true') {
    console.error(`${TAG} REQUIRE_SIGNING is set — failing the job.`);
    process.exit(1);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Presence

const missing = [
  ['APPSTORE_CONNECT_KEY_ID', keyId],
  ['APPSTORE_CONNECT_ISSUER_ID', issuerId],
  ['APPLE_TEAM_ID', teamId],
  ['APPSTORE_CONNECT_PRIVATE_KEY', rawKey.trim()]
].filter(([, value]) => !value).map(([name]) => name);

if (missing.length) {
  emit(
    false,
    'missing-secrets',
    `Repository secret(s) not set or empty: ${missing.join(', ')}.`,
    'Add them under Settings → Secrets and variables → Actions. ' +
      '`APPSTORE_CONNECT_PRIVATE_KEY` is the full contents of the `AuthKey_<KEY_ID>.p8` ' +
      'file downloaded from App Store Connect → Users and Access → Integrations → App Store Connect API.'
  );
}

// ---------------------------------------------------------------------------
// 2. Normalize + parse the .p8
//
// Secrets get pasted in three shapes: a real multi-line PEM, a single line
// with literal backslash-n, or the bare base64 body with the armor stripped.
// All three are recoverable, so accept all three rather than failing 40
// minutes later inside xcodebuild with an unrelated-looking error.

function normalizePem(input) {
  let text = input.replace(/\r/g, '').trim();

  if (!text.includes('\n') && text.includes('\\n')) {
    text = text.replace(/\\n/g, '\n').trim();
    notes.push('Private key was stored with escaped newlines; expanded to a real PEM.');
  }

  if (!text.includes('-----BEGIN')) {
    const body = text.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(body)) return null;
    const wrapped = body.match(/.{1,64}/g).join('\n');
    text = `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`;
    notes.push('Private key was stored without PEM armor; re-wrapped as PKCS#8.');
  }

  return `${text}\n`;
}

const pem = normalizePem(rawKey);
let privateKey;

if (pem) {
  try {
    privateKey = createPrivateKey({ key: pem, format: 'pem' });
  } catch (err) {
    console.error(`${TAG} key parse failed:`, err.message);
  }
}

if (!privateKey) {
  emit(
    false,
    'malformed-key',
    'APPSTORE_CONNECT_PRIVATE_KEY is set but is not a readable PKCS#8 private key.',
    'Re-copy the `.p8` file verbatim — `pbcopy < AuthKey_<KEY_ID>.p8` — including the ' +
      '`-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines, and paste it ' +
      'as the secret value with no surrounding quotes.'
  );
}

if (privateKey.asymmetricKeyType !== 'ec') {
  emit(
    false,
    'wrong-key-type',
    `APPSTORE_CONNECT_PRIVATE_KEY parsed as a ${privateKey.asymmetricKeyType} key; ` +
      'App Store Connect keys are EC (P-256).',
    'The secret is holding the wrong key — App Store Connect issues a `.p8` EC key, ' +
      'not an RSA key. Download the correct one from Users and Access → Integrations.'
  );
}

// Hand the *normalized* key to the TestFlight upload step.
//
// This exists because normalizePem() above may have repaired the secret --
// expanded escaped newlines, or re-added stripped PEM armor. xcodebuild reads
// the repaired key from the file written below, but the upload action takes
// the key as a value, so it previously received the raw secret instead and
// would fail on exactly the two shapes this script exists to recover.
//
// Masking is not optional here. GitHub redacts the verbatim secret, but a
// repaired key is text it has never seen and would print in full, so every
// body line is registered with ::add-mask:: before the value is written.
function stageKeyForUpload(keyPem) {
  const envFile = process.env.GITHUB_ENV;
  if (!envFile) return;

  for (const line of keyPem.split('\n')) {
    const body = line.trim();
    // The BEGIN/END armor is not secret, and masking it would redact those
    // markers everywhere they legitimately appear in the log.
    if (body && !body.startsWith('-----')) console.log(`::add-mask::${body}`);
  }

  // GITHUB_ENV is line-oriented, so a multi-line value needs heredoc syntax.
  // The delimiter is random so key content can never collide with it and let
  // the remainder of the PEM be parsed as further environment assignments.
  const delimiter = `PEM_${randomUUID()}`;
  const body = keyPem.endsWith('\n') ? keyPem : `${keyPem}\n`;
  appendFileSync(envFile, `${UPLOAD_KEY_ENV}<<${delimiter}\n${body}${delimiter}\n`);
  console.log(`${TAG} staged the normalized key for the TestFlight upload step.`);
}

// Only written once the key is known-good, so a half-valid file never reaches
// xcodebuild.
if (keyPath) {
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, pem, { mode: 0o600 });
  console.log(`${TAG} wrote validated key to ${keyPath}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `key_path=${keyPath}\n`);
  stageKeyForUpload(pem);
}

// ---------------------------------------------------------------------------
// 3. Ask Apple

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function mintJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })
  );
  const signingInput = `${header}.${payload}`;
  // App Store Connect wants a raw R||S signature, not the DER form Node emits
  // by default. Without ieee-p1363 every request comes back 401 with a
  // perfectly valid key — the exact symptom this preflight exists to name.
  const signature = cryptoSign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  });
  return `${signingInput}.${b64url(signature)}`;
}

async function callApi(path, token) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000)
  });
}

let token;
try {
  token = mintJwt();
} catch (err) {
  console.error(`${TAG} JWT signing failed:`, err);
  emit(
    false,
    'jwt-signing-failed',
    `Could not sign a token with the supplied key: ${err.message}`,
    'The key parsed but could not be used to sign. Re-download the `.p8` from App Store Connect.'
  );
}

let response;
try {
  response = await callApi('/apps?limit=1', token);
} catch (err) {
  console.error(`${TAG} App Store Connect request failed:`, err);
  emit(
    false,
    'network-error',
    `Could not reach App Store Connect: ${err.message}`,
    'This is usually transient. Re-run the workflow; if it persists, check ' +
      'https://developer.apple.com/system-status/.'
  );
}

// Any non-2xx gets its body read once. App Store Connect always answers with
// a JSON `errors` array; anything else on the wire (a corporate proxy, a
// captive portal) is reported as such rather than mislabelled as an Apple
// permission problem.
if (!response.ok) {
  const contentType = response.headers.get('content-type') || '';
  let appleCode = '';
  let detail = '';
  let looksLikeApple = false;

  try {
    const text = await response.text();
    if (contentType.includes('json')) {
      const body = JSON.parse(text);
      const first = Array.isArray(body?.errors) ? body.errors[0] : null;
      if (first) {
        looksLikeApple = true;
        appleCode = first.code || '';
        detail = first.detail || first.title || '';
      }
    } else {
      detail = text.trim().slice(0, 200);
    }
  } catch (err) {
    console.error(`${TAG} could not read the error body from App Store Connect:`, err.message);
  }

  if (!looksLikeApple) {
    emit(
      false,
      `unexpected-http-${response.status}`,
      `HTTP ${response.status} from ${API_BASE}, and the body is not an App Store Connect ` +
        `error document${detail ? `: ${detail}` : '.'}`,
      'Something between the runner and Apple answered instead of App Store Connect. ' +
        'Re-run the workflow; if it repeats, check https://developer.apple.com/system-status/.'
    );
  }

  if (response.status === 401) {
    emit(
      false,
      'apple-rejected-401',
      'App Store Connect rejected the API key (HTTP 401' +
        `${appleCode ? `, ${appleCode}` : ''}). The key material, APPSTORE_CONNECT_KEY_ID and ` +
        'APPSTORE_CONNECT_ISSUER_ID do not form a valid, active key.',
      'Check, in this order:\n' +
        '1. The key has not been **revoked** in App Store Connect → Users and Access → Integrations.\n' +
        '2. `APPSTORE_CONNECT_KEY_ID` matches the *Key ID* column for that key — it is also the ' +
        '`<KEY_ID>` in the `AuthKey_<KEY_ID>.p8` filename.\n' +
        '3. `APPSTORE_CONNECT_ISSUER_ID` is the **Issuer ID** shown above the key list (a UUID), ' +
        'not the Key ID and not the Team ID.\n' +
        '4. `APPSTORE_CONNECT_PRIVATE_KEY` is the `.p8` belonging to *that* Key ID. A `.p8` can only ' +
        'be downloaded once, so a re-created key needs the secret updated too.'
    );
  }

  if (response.status === 403) {
    emit(
      false,
      'apple-rejected-403',
      'App Store Connect authenticated the key but refused the request (HTTP 403' +
        `${appleCode ? `, ${appleCode}` : ''})${detail ? `: ${detail}` : '.'}`,
      'This is a permissions problem, not a bad key. Automatic cloud signing requires an ' +
        '**Admin** App Store Connect API key (Users and Access → Integrations → the key\'s ' +
        'Access column). App Manager can upload builds but cannot authorize Xcode to use ' +
        'cloud-managed distribution certificates.'
    );
  }

  emit(
    false,
    `apple-http-${response.status}`,
    `App Store Connect returned HTTP ${response.status}${appleCode ? ` (${appleCode})` : ''}` +
      `${detail ? `: ${detail}` : '.'}`,
    'Re-run the workflow. If it repeats, check https://developer.apple.com/system-status/.'
  );
}

// ---------------------------------------------------------------------------
// 4. Authenticated. Confirm the App ID exists, since a missing app record
//    produces the same "No profiles for '<bundle id>' were found" export error
//    as a bad key and is otherwise indistinguishable in the log.

let appId = '';

if (bundleId) {
  try {
    const appsRes = await callApi(
      `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`,
      token
    );
    if (appsRes.ok) {
      const body = await appsRes.json();
      if (Array.isArray(body.data) && body.data.length > 0) {
        appId = String(body.data[0].id || '').trim();
        notes.push(`App record found for \`${bundleId}\`.`);
      } else {
        notes.push(
          `No App Store Connect app record matches \`${bundleId}\`. Export can still mint a ` +
            'profile if the App ID exists in the Developer portal, but if export fails with ' +
            '"No profiles were found", create the app record first.'
        );
      }
    } else {
      notes.push(`Bundle-ID lookup returned HTTP ${appsRes.status}; skipped that check.`);
    }
  } catch (err) {
    console.error(`${TAG} bundle id lookup failed (non-fatal):`, err.message);
    notes.push('Bundle-ID lookup failed; skipped that check.');
  }
}

// ---------------------------------------------------------------------------
// 5. Confirm this key can read signing resources. Authenticating against /apps
// is not enough: App Manager keys can upload builds but Xcode cloud signing
// requires Admin access to certificates and provisioning profiles.

try {
  const signingRes = await callApi('/certificates?limit=1', token);
  if (signingRes.status === 403) {
    emit(
      false,
      'cloud-signing-forbidden',
      'App Store Connect accepted the key, but it cannot access signing certificates (HTTP 403).',
      'Give this API key the **Admin** role under App Store Connect → Users and Access → ' +
        'Integrations. Xcode cloud signing cannot use an App Manager key.'
    );
  }
  if (!signingRes.ok) {
    emit(
      false,
      `cloud-signing-http-${signingRes.status}`,
      `Signing-resource preflight returned HTTP ${signingRes.status}.`,
      'Re-run the workflow. If it repeats, check Apple system status and the API key role.'
    );
  }
  notes.push('API key can access signing certificates for Xcode-managed signing.');
} catch (err) {
  console.error(`${TAG} signing-resource lookup failed:`, err);
  emit(
    false,
    'cloud-signing-network-error',
    `Could not verify signing-resource access: ${err.message}`,
    'Re-run the workflow. If it repeats, check https://developer.apple.com/system-status/.'
  );
}

// ---------------------------------------------------------------------------
// 6. The version train, against Apple rather than against a constant.

const marketing = env('APP_MARKETING_VERSION');
const buildNumber = env('APP_BUILD_NUMBER');

if (appId && marketing) {
  let versions = null;
  let builds = null;
  try {
    const versionsRes = await callApi(
      `/apps/${encodeURIComponent(appId)}/appStoreVersions` +
        '?limit=200&fields[appStoreVersions]=versionString,appStoreState',
      token
    );
    if (versionsRes.ok) {
      versions = (await versionsRes.json()).data;
    } else {
      notes.push(`Version lookup returned HTTP ${versionsRes.status}; the version train was not checked.`);
    }
  } catch (err) {
    console.error(`${TAG} appStoreVersions lookup failed (non-fatal):`, err.message);
    notes.push('Version lookup failed; the version train was not checked.');
  }

  /* Filtered to this train server side, so every row returned is already
     scoped and the client-side train filter is a no-op on it. */
  try {
    const buildsRes = await callApi(
      `/builds?filter[app]=${encodeURIComponent(appId)}` +
        `&filter[preReleaseVersion.version]=${encodeURIComponent(marketing)}` +
        '&fields[builds]=version&limit=200',
      token
    );
    if (buildsRes.ok) {
      builds = (await buildsRes.json()).data;
    } else {
      notes.push(`Build lookup returned HTTP ${buildsRes.status}; the build number was not checked.`);
    }
  } catch (err) {
    console.error(`${TAG} builds lookup failed (non-fatal):`, err.message);
    notes.push('Build lookup failed; the build number was not checked.');
  }

  const verdict = judgeVersionTrain({ marketing, build: buildNumber, versions, builds });
  if (!verdict.ok) {
    emit(false, verdict.code, verdict.headline, verdict.remedy);
  }
  if (verdict.note) notes.push(verdict.note);
} else if (marketing) {
  notes.push('No app record id resolved, so the version train was not checked.');
}

emit(true, 'ok', 'App Store Connect accepted the API key and authorized cloud signing. Proceeding with signed archive, export and upload.', '');
