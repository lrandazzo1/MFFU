#!/usr/bin/env node
// App Store Connect credential preflight for the iOS CI workflow.
//
// The distribution half of the iOS build (xcodebuild -exportArchive and the
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
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const API_BASE = 'https://api.appstoreconnect.apple.com/v1';
const TAG = '[preflight]';

const env = (name) => (process.env[name] || '').trim();

const keyId = env('APPSTORE_CONNECT_KEY_ID');
const issuerId = env('APPSTORE_CONNECT_ISSUER_ID');
const teamId = env('APPLE_TEAM_ID');
const rawKey = process.env.APPSTORE_CONNECT_PRIVATE_KEY || '';
const keyPath = env('APPSTORE_KEY_PATH');
const bundleId = env('APP_BUNDLE_ID');

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

// Only written once the key is known-good, so a half-valid file never reaches
// xcodebuild.
if (keyPath) {
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, pem, { mode: 0o600 });
  console.log(`${TAG} wrote validated key to ${keyPath}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `key_path=${keyPath}\n`);
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
      'This is a permissions problem, not a bad key. Give the key the **App Manager** role ' +
        "(Users and Access → Integrations → the key's Access column). A Developer- or " +
        'Marketing-role key cannot manage signing certificates or upload builds.'
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

if (bundleId) {
  try {
    const appsRes = await callApi(
      `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`,
      token
    );
    if (appsRes.ok) {
      const body = await appsRes.json();
      if (Array.isArray(body.data) && body.data.length > 0) {
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

emit(true, 'ok', 'App Store Connect accepted the API key. Proceeding with export and upload.', '');
