/* ============================================================================
   FSN NOTIFICATIONS — WEB PUSH TRANSPORT

   The browser half: VAPID-authenticated Web Push for the Vercel-served PWA,
   alongside the APNs path used by the Capacitor iOS binary.

   ---- WHY THE ONE DEPENDENCY ----

   Web Push is not "POST a JSON body to an endpoint". RFC 8291 requires the
   payload be encrypted to the subscriber's public key: an ECDH agreement on
   P-256, HKDF to derive a content-encryption key and nonce, then AES-128-GCM
   with an aes128gcm content-coding header. Hand-rolling that is a lot of
   cryptographic surface to own for no benefit, and getting it subtly wrong
   fails as a silent non-delivery rather than an error. `web-push` is the
   reference implementation of exactly this and nothing else.

   APNs, by contrast, is genuinely just a signed JWT and an HTTP/2 POST, which
   is why apns.js has no dependency at all.

   ---- ENVIRONMENT ----

     VAPID_PUBLIC_KEY    base64url P-256 public key
     VAPID_PRIVATE_KEY   base64url P-256 private key
     VAPID_SUBJECT       mailto: or https: contact, per RFC 8292

   Generate a keypair with:  npx web-push generate-vapid-keys
   The public key is served to browsers by /api/notifications-register; the
   private key never leaves the function.
============================================================================ */

'use strict';

/* Required lazily. A project that has only configured APNs should not fail to
   boot the dispatcher because an optional package is absent from the bundle. */
let webpush = null;
let loadError = null;

function library() {
  if (webpush || loadError) return webpush;
  try {
    webpush = require('web-push');
  } catch (err) {
    loadError = err;
    console.error('[FSNPush] the "web-push" package could not be loaded, so browser ' +
      'notifications are disabled for this deployment. Run `npm install` to restore it.', err);
  }
  return webpush;
}

function vapidConfig() {
  return {
    publicKey: String(process.env.VAPID_PUBLIC_KEY || '').trim(),
    privateKey: String(process.env.VAPID_PRIVATE_KEY || '').trim(),
    subject: String(process.env.VAPID_SUBJECT || 'https://fantasysportsnetwork.app').trim(),
  };
}

function isConfigured() {
  const c = vapidConfig();
  return !!(c.publicKey && c.privateKey && library());
}

/* The value browsers need for pushManager.subscribe(). Safe to serve publicly —
   it is the public half of the pair by design. */
function publicKey() {
  return vapidConfig().publicKey;
}

let vapidApplied = false;
function applyVapid() {
  if (vapidApplied) return true;
  const lib = library();
  if (!lib) return false;
  const c = vapidConfig();
  if (!c.publicKey || !c.privateKey) return false;
  try {
    lib.setVapidDetails(c.subject, c.publicKey, c.privateKey);
    vapidApplied = true;
    return true;
  } catch (err) {
    console.error('[FSNPush] VAPID details were rejected; check VAPID_SUBJECT is a ' +
      'mailto: or https: URL and that the keypair is a matching base64url P-256 pair.', err);
    return false;
  }
}

/* Shape check before the library sees it. A malformed row stored months ago
   should produce one clear log line, not a stack trace from inside a
   dependency. */
function validSubscription(subscription) {
  return !!(subscription &&
    typeof subscription.endpoint === 'string' &&
    /^https:\/\//.test(subscription.endpoint) &&
    subscription.keys &&
    typeof subscription.keys.p256dh === 'string' &&
    typeof subscription.keys.auth === 'string');
}

/* --------------------------------------------------------------------------
   send(subscription, notification)

   Same resolved contract as apns.send() so the dispatcher treats both
   transports identically:

     { ok, status, reason, retryable, unregister }
-------------------------------------------------------------------------- */
async function send(subscription, notification) {
  const lib = library();
  if (!lib) {
    return { ok: false, status: 0, reason: 'WEBPUSH_UNAVAILABLE', retryable: false, unregister: false };
  }
  if (!applyVapid()) {
    return { ok: false, status: 0, reason: 'VAPID_NOT_CONFIGURED', retryable: false, unregister: false };
  }
  if (!validSubscription(subscription)) {
    /* Unregister rather than retry: a row that cannot be addressed will never
       become addressable on its own. */
    console.error('[FSNPush] stored Web Push subscription is malformed and will be retired',
      new Error('WEBPUSH_BAD_SUBSCRIPTION'));
    return { ok: false, status: 0, reason: 'BadSubscription', retryable: false, unregister: true };
  }

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    category: notification.category,
    data: notification.data || {},
  });

  try {
    const result = await lib.sendNotification(subscription, payload, {
      TTL: 3 * 3600,        // match the APNs expiration: drop, do not store past the window
      urgency: 'high',
      /* Collapse repeats of the same cadence in the browser's push queue. */
      topic: undefined,
    });
    return {
      ok: true,
      status: (result && result.statusCode) || 201,
      reason: '',
      retryable: false,
      unregister: false,
    };
  } catch (err) {
    const status = Number(err && err.statusCode) || 0;
    /* 404 Not Found and 410 Gone are the push service saying the subscription
       is permanently dead — the browser was uninstalled, the site data cleared,
       or the user revoked permission. 403 means the subscription was minted
       against a different VAPID key, which is equally terminal for this row. */
    const unregister = status === 404 || status === 410 || status === 403;
    const retryable = status === 429 || status === 500 || status === 502 || status === 503;
    return {
      ok: false,
      status,
      reason: String((err && err.body) || (err && err.message) || 'WEBPUSH_ERROR').slice(0, 200),
      retryable,
      unregister,
    };
  }
}

module.exports = { isConfigured, publicKey, send, validSubscription };
