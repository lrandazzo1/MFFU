/* ============================================================================
   FSN NOTIFICATIONS — /api/notifications-selftest

   The in-app debug trigger. Fires one real push straight to the device that
   asked for it, so TestFlight builds and freshly-registered browsers can
   verify end-to-end delivery on-demand without waiting for the cadence to
   open a band.

   POST { deviceId }  ->  { ok, delivery, notification, device, apnsConfig }

   ---- WHY A SEPARATE ROUTE FROM /api/notifications-dispatch?selftest= ----

   The dispatcher's `?selftest=` mode does the same thing, but it is gated on
   CRON_SECRET so an unauthenticated push fan-out is impossible. That secret
   cannot ship to the client, which means the button in Setup could not
   reach it. This route serves that button and nothing else.

   ---- HOW IT AUTHORIZES ----

   The deviceId is the SHA-256 of the device's push address. Only the device
   that registered — and Supabase — hold it, so possessing it is proof of
   registration in the same way a bearer token is proof of ownership. Every
   request is verified against notification_devices before a send is made:

     * the deviceId must be 64 hex characters. Anything else is a typo or an
       attempt to widen the mode into a fan-out; both are refused rather than
       interpreted.
     * the row must exist. A missing row means the device never registered
       or its address was already retired and cleared.
     * a per-device cooldown of 30 seconds is enforced against the row's
       `last_test_at` column. A rate limit turns a leaked deviceId into a
       nuisance rather than a way to grind the transport.

   Nothing about this route consumes the reader's real weekly alert: no
   ledger row is written, no `last_sent_at` is stamped, no dead-token
   retirement happens. Those behaviours match the dispatcher's `?selftest=`
   mode exactly — a diagnostic that quietly consumed the alert it is used to
   diagnose would make the fault worse. `last_test_at` is a separate column
   from `last_sent_at` for the same reason.

   ---- WHAT IT SENDS ----

   A notification built by the same `engine.buildNotification()` the live
   dispatcher uses, byte-identical to the alert that trigger would produce
   for this league and week. Marking it as a test would answer a different
   question than the one being asked, which is whether a genuine alert
   renders on the device.
============================================================================ */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const engine = require('../lib/notifications/triggers');
const apns = require('../lib/notifications/apns');
const webpush = require('../lib/notifications/webpush');

const MAX_BODY_BYTES = 4 * 1024;
const COOLDOWN_MS = 30 * 1000;
const DEFAULT_TRIGGER = 'sunday_lineup';

/* Same origin set as the register route — the Capacitor binary serves the
   app from capacitor://localhost and sends either that or a null Origin, so
   the fallback stays permissive. The deviceId acts as the credential; the
   origin check is not the control that matters here. */
const ALLOWED_ORIGINS = [
  'https://fantasysportsnetwork.app',
  'https://www.fantasysportsnetwork.app',
  'https://app.fantasysportsnetwork.app',
];

let supabaseClient;

function applyHeaders(res, req) {
  const origin = String((req && req.headers && req.headers.origin) || '');
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}

function getSupabase() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  if (!supabaseClient) {
    supabaseClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'X-Client-Info': 'mffu-vercel-notifications-selftest' } },
    });
  }
  return supabaseClient;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') {
    if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    return req.body;
  }
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body, 'utf8') > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    return req.body ? JSON.parse(req.body) : {};
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function handler(req, res) {
  applyHeaders(res, req);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    console.error('[FSNPush] /api/notifications-selftest cannot reach Supabase: ' +
      'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing from the environment.',
      new Error('SUPABASE_NOT_CONFIGURED'));
    res.status(503).json({ error: 'STORAGE_NOT_CONFIGURED' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    console.warn('[FSNPush] selftest received an unreadable body', err);
    res.status(400).json({ error: err.message === 'PAYLOAD_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_JSON' });
    return;
  }

  const deviceId = String((body && body.deviceId) || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(deviceId)) {
    res.status(400).json({
      error: 'BAD_DEVICE_ID',
      detail: 'deviceId must be the 64-character hex receipt /api/notifications-register returned.',
    });
    return;
  }

  const triggerId = String((body && body.trigger) || DEFAULT_TRIGGER).trim() || DEFAULT_TRIGGER;
  const trigger = engine.TRIGGERS_BY_ID[triggerId];
  if (!trigger) {
    res.status(400).json({
      error: 'UNKNOWN_TRIGGER',
      detail: 'trigger must be one of: ' + engine.TRIGGERS.map((t) => t.id).join(', '),
    });
    return;
  }

  const { data: rows, error: readError } = await supabase
    .from('notification_devices')
    .select('device_id, platform, apns_token, subscription, league_id, team_id, timezone, prefs, season_year, week, first_kickoff_ms, disabled_at, disabled_reason, last_test_at')
    .eq('device_id', deviceId)
    .limit(1);

  if (readError) {
    console.error('[FSNPush] selftest could not read device ' + deviceId, readError);
    res.status(500).json({ error: 'DEVICE_READ_FAILED', detail: readError.message });
    return;
  }

  const row = (Array.isArray(rows) && rows[0]) || null;
  if (!row) {
    /* Not authorised, not "not found": from the caller's perspective these
       are indistinguishable, and returning 404 for a device the requester
       does not own would leak the fact of registration. */
    res.status(403).json({
      error: 'UNKNOWN_DEVICE',
      detail: 'That deviceId is not registered on this deployment. Turn alerts on in Setup to register, then retry.',
    });
    return;
  }

  /* Rate limit on the DB row, not process memory: serverless invocations
     cold-start, so an in-process counter would fail open under load. */
  const now = Date.now();
  const lastTestAt = row.last_test_at ? Date.parse(row.last_test_at) : 0;
  if (Number.isFinite(lastTestAt) && lastTestAt > 0 && (now - lastTestAt) < COOLDOWN_MS) {
    const retryInMs = COOLDOWN_MS - (now - lastTestAt);
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryInMs / 1000))));
    res.status(429).json({
      error: 'COOLDOWN',
      detail: 'A test alert was just sent for this device. Wait a few seconds and retry.',
      retryInMs,
    });
    return;
  }

  const apnsReady = apns.isConfigured();
  const webReady = webpush.isConfigured();
  const transportReady = row.platform === 'ios' ? apnsReady : webReady;
  if (!transportReady) {
    console.error('[FSNPush] selftest cannot reach device ' + deviceId + ': the "' +
      row.platform + '" transport is not configured on this deployment.',
      new Error('TRANSPORT_NOT_CONFIGURED'));
    res.status(503).json({
      error: 'TRANSPORT_NOT_CONFIGURED',
      platform: row.platform,
      transports: { apns: apnsReady, web: webReady },
      apnsConfig: apns.describe(),
      detail: row.platform === 'ios'
        ? 'The APNS_* variables are missing from this deployment.'
        : 'The VAPID_* variables are missing from this deployment.',
    });
    return;
  }

  /* Stamp the cooldown BEFORE the send so a slow provider cannot be spammed
     while the previous request is still in flight. The write is best-effort:
     a stamp failure logs loudly and continues rather than blocking a test. */
  const stampAt = new Date(now).toISOString();
  const { error: stampError } = await supabase
    .from('notification_devices')
    .update({ last_test_at: stampAt })
    .eq('device_id', deviceId);
  if (stampError) {
    console.warn('[FSNPush] selftest could not stamp last_test_at for ' + deviceId +
      '; the cooldown will not apply this run.', stampError);
  }

  const notification = engine.buildNotification(trigger.id, {
    leagueId: row.league_id,
    seasonYear: row.season_year,
    week: row.week,
  });
  if (!notification) {
    console.error('[FSNPush] selftest could not build notification for trigger ' + trigger.id);
    res.status(500).json({ error: 'NOTIFICATION_BUILD_FAILED', trigger: trigger.id });
    return;
  }

  let session = null;
  let result;
  const startedAt = Date.now();
  try {
    if (row.platform === 'ios') {
      session = apns.openSession();
      result = await apns.send(session, row.apns_token, notification);
    } else {
      result = await webpush.send(row.subscription, notification);
    }
  } catch (err) {
    console.error('[FSNPush] selftest transport threw sending ' + trigger.id +
      ' to device ' + deviceId + ' (' + row.platform + ')', err);
    result = { ok: false, status: 0, reason: String((err && err.message) || 'THREW'), retryable: true, unregister: false };
  } finally {
    if (session) {
      try { apns.closeSession(session); }
      catch (err) { console.warn('[FSNPush] selftest could not close APNs session cleanly', err); }
    }
  }

  if (!result.ok) {
    console.error('[FSNPush] selftest push to device ' + deviceId + ' (' + row.platform +
      ') was rejected: status ' + result.status + ' ' + (result.reason || ''),
      new Error('SELFTEST_PUSH_REJECTED'));
  }

  res.status(200).json({
    ok: !!result.ok,
    selftest: true,
    sentAt: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,

    device: {
      deviceId: row.device_id,
      platform: row.platform,
      timezone: row.timezone,
      leagueId: row.league_id,
      seasonYear: row.season_year,
      week: row.week,
      /* A retired row still receives the test push. If this is non-null,
         the row WAS disabled by an earlier rejection and the daily cron is
         skipping it even when the test succeeds — re-register from the app
         to clear it. */
      disabledAt: row.disabled_at || null,
      disabledReason: row.disabled_reason || null,
    },

    notification: {
      trigger: trigger.id,
      group: trigger.group,
      title: notification.title,
      body: notification.body,
    },

    delivery: {
      status: result.status,
      apnsId: result.apnsId || null,
      reason: result.reason || null,
      retryable: !!result.retryable,
      unregister: !!result.unregister,
    },

    apnsConfig: apns.describe(),
    ledgerWritten: false,
  });
}

module.exports = handler;
