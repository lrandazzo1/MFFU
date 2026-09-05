/* ============================================================================
   FSN NOTIFICATIONS — APNs TRANSPORT

   Token-based (.p8) authentication straight to Apple, over HTTP/2, using only
   Node builtins. No firebase-admin, no apn package, no Google Cloud project in
   the middle of a path that is already just "sign a JWT and POST to Apple".

   ---- WHY node:http2 AND NOT fetch ----

   APNs speaks HTTP/2 only and rejects an HTTP/1.1 connection outright. Node's
   global fetch (undici) does not negotiate HTTP/2, so it cannot reach Apple at
   all. `node:http2` can, and it lets one TCP session carry every notification
   in a dispatch batch instead of paying a TLS handshake per device.

   ---- ENVIRONMENT ----

     APNS_KEY_P8      contents of the AuthKey_XXXXXXXXXX.p8 file (the full
                      PEM block, newlines intact; \n escapes are also accepted
                      so it can be pasted into the Vercel dashboard)
     APNS_KEY_ID      the 10-character Key ID for that .p8
     APNS_TEAM_ID     the 10-character Apple Developer Team ID
     APNS_BUNDLE_ID   defaults to app.fantasysportsnetwork (capacitor.config.ts)
     APNS_ENV         'production' (default) or 'sandbox' for development
                      builds signed with a development provisioning profile
============================================================================ */

'use strict';

const http2 = require('node:http2');
const crypto = require('node:crypto');

const PROD_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';
const DEFAULT_BUNDLE_ID = 'app.fantasysportsnetwork';

/* Apple rejects a provider token older than one hour and throttles refreshes
   more frequent than every 20 minutes. 45 minutes sits safely between the two
   and survives a warm lambda handling several dispatch runs. */
const TOKEN_TTL_MS = 45 * 60 * 1000;

/* Per-request ceiling. A dispatch batch is serialised over one session, so a
   single unresponsive stream must not be allowed to hold the whole run. */
const REQUEST_TIMEOUT_MS = 10000;

let cachedToken = null;   // { jwt, mintedAt }

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* Vercel's dashboard stores multi-line values fine, but a key pasted through a
   shell or a CI variable often arrives with literal \n. Accept both. */
function readPrivateKey() {
  const raw = String(process.env.APNS_KEY_P8 || '').trim();
  if (!raw) return null;
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

function apnsConfig() {
  const keyId = String(process.env.APNS_KEY_ID || '').trim();
  const teamId = String(process.env.APNS_TEAM_ID || '').trim();
  const key = readPrivateKey();
  const bundleId = String(process.env.APNS_BUNDLE_ID || DEFAULT_BUNDLE_ID).trim();
  const host = String(process.env.APNS_ENV || 'production').toLowerCase() === 'sandbox'
    ? SANDBOX_HOST : PROD_HOST;
  return { keyId, teamId, key, bundleId, host };
}

/* True when every APNs secret is present. The dispatcher checks this so a
   project with only Web Push configured logs one clear line instead of a
   failure per iOS device. */
function isConfigured() {
  const c = apnsConfig();
  return !!(c.keyId && c.teamId && c.key);
}

/* --------------------------------------------------------------------------
   providerToken()

   ES256 JWT, per Apple's token-based provider authentication.

   The signature must be the raw 64-byte r||s pair, NOT the ASN.1/DER encoding
   Node emits by default for EC keys. `dsaEncoding: 'ieee-p1363'` is what makes
   it JOSE-compatible; without it Apple answers 403 InvalidProviderToken on
   every single push and the cause is invisible from the response alone.
-------------------------------------------------------------------------- */
function providerToken() {
  const now = Date.now();
  if (cachedToken && (now - cachedToken.mintedAt) < TOKEN_TTL_MS) return cachedToken.jwt;

  const { keyId, teamId, key } = apnsConfig();
  if (!keyId || !teamId || !key) throw new Error('APNS_NOT_CONFIGURED');

  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
  const signingInput = header + '.' + claims;

  const signature = crypto.sign(
    'sha256',
    Buffer.from(signingInput),
    { key, dsaEncoding: 'ieee-p1363' }
  );

  const jwt = signingInput + '.' + base64url(signature);
  cachedToken = { jwt, mintedAt: now };
  return jwt;
}

/* --------------------------------------------------------------------------
   openSession()

   One HTTP/2 session for a whole batch. The caller must close it.
-------------------------------------------------------------------------- */
function openSession() {
  const { host } = apnsConfig();
  const session = http2.connect(host);
  /* Without a handler an unsolicited session error is an unhandled 'error'
     event, which takes the entire function down rather than failing one send. */
  session.on('error', (err) => {
    console.error('[FSNPush] APNs session error for ' + host, err);
  });
  return session;
}

function closeSession(session) {
  if (!session) return;
  try {
    session.close();
  } catch (err) {
    console.warn('[FSNPush] APNs session close failed', err);
  }
}

/* --------------------------------------------------------------------------
   send(session, deviceToken, notification)

   Resolves { ok, status, reason, retryable, unregister }. It does NOT throw
   for a rejected push: a dead token is an ordinary, expected outcome that the
   dispatcher records and moves past. It rejects only when the request could
   not be made at all.

     unregister true -> the address is permanently dead; stop sending to it.
     retryable  true -> transient (429/500/503); leave the row alone.
-------------------------------------------------------------------------- */
function send(session, deviceToken, notification) {
  const { bundleId } = apnsConfig();
  const jwt = providerToken();

  const payload = JSON.stringify({
    aps: {
      alert: { title: notification.title, body: notification.body },
      sound: 'default',
      /* Collapses a cadence's alerts into one thread in Notification Center, so
         a reader who ignores Tuesday does not find two separate stacks. */
      'thread-id': 'fsn-' + String(notification.data && notification.data.group || 'general'),
    },
    fsn: notification.data || {},
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    let stream;
    try {
      stream = session.request({
        ':method': 'POST',
        ':path': '/3/device/' + deviceToken,
        authorization: 'bearer ' + jwt,
        'apns-topic': bundleId,
        'apns-push-type': 'alert',
        /* 10 = deliver immediately. These are time-boxed engagement windows;
           a lineup reminder held for a power-efficient moment is worthless. */
        'apns-priority': '10',
        /* Drop rather than store-and-forward past the window. Apple wants
           seconds since epoch. */
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 3 * 3600),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
    } catch (err) {
      finish(reject, err);
      return;
    }

    stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
      /* Destroy so the session is not left holding a half-open stream for the
         rest of the batch. */
      try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch (e) { /* stream already gone */ }
      finish(reject, new Error('APNS_TIMEOUT'));
    });

    let status = 0;
    let apnsId = '';
    stream.on('response', (headers) => {
      status = Number(headers[':status']) || 0;
      apnsId = String(headers['apns-id'] || '');
    });

    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));

    stream.on('error', (err) => finish(reject, err));

    stream.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      if (status === 200) {
        finish(resolve, { ok: true, status, apnsId, reason: '', retryable: false, unregister: false });
        return;
      }

      let reason = '';
      if (bodyText) {
        try {
          reason = String(JSON.parse(bodyText).reason || '');
        } catch (err) {
          /* A non-JSON error body is unexpected enough to be worth seeing in
             full — it usually means a proxy answered instead of Apple. */
          console.warn('[FSNPush] APNs returned status ' + status +
            ' with an unparseable body: ' + bodyText.slice(0, 200), err);
        }
      }

      /* 410 Unregistered is Apple's canonical "the app was deleted".
         BadDeviceToken means the token was never valid for this topic —
         usually a sandbox token sent to production. Both are terminal for the
         address, so both retire the row rather than retrying forever. */
      const unregister = status === 410 ||
        reason === 'Unregistered' ||
        reason === 'BadDeviceToken' ||
        reason === 'DeviceTokenNotForTopic';

      const retryable = status === 429 || status === 500 || status === 503;

      finish(resolve, { ok: false, status, apnsId, reason, retryable, unregister });
    });

    stream.end(payload);
  });
}

module.exports = { isConfigured, openSession, closeSession, send, apnsConfig };
