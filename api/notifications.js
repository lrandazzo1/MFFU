/* ============================================================================
   FSN NOTIFICATIONS — /api/notifications

   Single serverless entry point for the two client-facing notification
   endpoints, dispatched by ?action= so this file counts as one Vercel
   function instead of two:

     ?action=register  (default)     the device-token registration boundary
                                     — same contract as the retired
                                     /api/notifications-register endpoint
                                     (GET / POST / DELETE).
     ?action=selftest                the in-app debug trigger — same contract
                                     as the retired /api/notifications-selftest
                                     endpoint (POST-only).

   Behaviour of both actions is byte-identical to the pre-consolidation files
   they replace. See vercel.json for the /api/notifications-register and
   /api/notifications-selftest rewrites that keep older clients on their
   original URLs.

   The cron target — /api/notifications-dispatch — stays its own file. Its
   auth model (Bearer CRON_SECRET) and payload are unrelated to these two,
   and Vercel's crons block references it by path.
============================================================================ */

'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const engine = require('../lib/notifications/triggers');
const { PREF_GROUPS, normalizeTimeZone } = engine;
const apns = require('../lib/notifications/apns');
const webpush = require('../lib/notifications/webpush');

const REGISTER_MAX_BODY_BYTES = 32 * 1024;
const SELFTEST_MAX_BODY_BYTES = 4 * 1024;
const SELFTEST_COOLDOWN_MS = 30 * 1000;
const SELFTEST_DEFAULT_TRIGGER = 'sunday_lineup';

/* Same origin set both retired routes used. The Capacitor binary serves the
   app from capacitor://localhost and sends either that or a null Origin, so
   the fallback stays permissive — these routes either store a push address
   the caller already owns (register) or require possession of the deviceId
   receipt (selftest), so the origin check is not the control that matters. */
const ALLOWED_ORIGINS = [
  'https://fantasysportsnetwork.app',
  'https://www.fantasysportsnetwork.app',
  'https://app.fantasysportsnetwork.app',
];

let supabaseClient;

function applyHeaders(res, req, methods) {
  const origin = String((req && req.headers && req.headers.origin) || '');
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}

function getSupabase(clientInfo) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  if (!supabaseClient) {
    supabaseClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'X-Client-Info': clientInfo || 'mffu-vercel-notifications' } },
    });
  }
  return supabaseClient;
}

async function readBody(req, maxBytes) {
  if (req.body && typeof req.body === 'object') {
    if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
    return req.body;
  }
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body, 'utf8') > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
    return req.body ? JSON.parse(req.body) : {};
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

/* ============================================================================
   REGISTER (default) — the device-token boundary
============================================================================ */

/* The stored primary key. Hashing the push address means the id can appear in
   the send ledger, in logs, and in a response body without any of those
   becoming a place a push address leaks from. */
function deviceIdFor(addressString) {
  return crypto.createHash('sha256').update(String(addressString), 'utf8').digest('hex');
}

function cleanLeagueId(value) {
  const id = String(value == null ? '' : value).trim();
  if (!id) return null;
  return /^[A-Za-z0-9_.-]{1,64}$/.test(id) ? id : null;
}

function cleanTeamId(value) {
  const id = String(value == null ? '' : value).trim();
  if (!id || id.length > 32) return null;
  return id;
}

function cleanInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return (i >= min && i <= max) ? i : null;
}

/* Only the three known groups, only real booleans. An unknown key from a
   future or tampered client is dropped rather than stored, so the table can
   never accumulate a preference the trigger engine does not understand. */
function cleanPrefs(value) {
  const source = (value && typeof value === 'object') ? value : {};
  const out = {};
  for (const group of PREF_GROUPS) out[group] = source[group] === true;
  return out;
}

function cleanApnsToken(value) {
  const token = String(value == null ? '' : value).trim().replace(/[<>\s]/g, '');
  return /^[0-9a-fA-F]{32,200}$/.test(token) ? token : null;
}

function cleanSubscription(value) {
  if (!webpush.validSubscription(value)) return null;
  /* Store exactly the three fields the transport needs, never the whole object
     the browser handed over. */
  return {
    endpoint: String(value.endpoint),
    keys: { p256dh: String(value.keys.p256dh), auth: String(value.keys.auth) },
  };
}

async function handleRegister(req, res) {
  applyHeaders(res, req, 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  /* ---- GET: client bootstrap ------------------------------------------- */
  if (req.method === 'GET') {
    res.status(200).json({
      configured: apns.isConfigured() || webpush.isConfigured(),
      apns: apns.isConfigured(),
      web: webpush.isConfigured(),
      vapidPublicKey: webpush.isConfigured() ? webpush.publicKey() : '',
      groups: PREF_GROUPS,
    });
    return;
  }

  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const supabase = getSupabase('mffu-vercel-notifications');
  if (!supabase) {
    console.error('[FSNPush] /api/notifications (register) cannot reach Supabase: ' +
      'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing from the environment.',
      new Error('SUPABASE_NOT_CONFIGURED'));
    res.status(503).json({ error: 'STORAGE_NOT_CONFIGURED' });
    return;
  }

  let body;
  try {
    body = await readBody(req, REGISTER_MAX_BODY_BYTES);
  } catch (err) {
    console.warn('[FSNPush] register received an unreadable body', err);
    res.status(400).json({ error: err.message === 'PAYLOAD_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_JSON' });
    return;
  }

  /* ---- Unsubscribe ------------------------------------------------------
     A reader turning the master switch off must be able to remove the row
     using only the receipt they were given, without re-presenting the push
     address. */
  const wantsRemoval = req.method === 'DELETE' || body.unsubscribe === true;
  if (wantsRemoval) {
    const deviceId = String(body.deviceId || '').trim();
    if (!/^[0-9a-f]{64}$/.test(deviceId)) {
      res.status(400).json({ error: 'BAD_DEVICE_ID' });
      return;
    }
    const { error } = await supabase
      .from('notification_devices')
      .delete()
      .eq('device_id', deviceId);
    if (error) {
      console.error('[FSNPush] failed to delete device ' + deviceId, error);
      res.status(500).json({ error: 'DELETE_FAILED', detail: error.message });
      return;
    }
    res.status(200).json({ ok: true, deviceId, removed: true });
    return;
  }

  /* ---- Register / update ------------------------------------------------ */
  const platform = String(body.platform || '').trim().toLowerCase();
  if (platform !== 'ios' && platform !== 'web') {
    res.status(400).json({ error: 'BAD_PLATFORM' });
    return;
  }

  let apnsToken = null;
  let subscription = null;
  let addressString = '';

  if (platform === 'ios') {
    apnsToken = cleanApnsToken(body.token);
    if (!apnsToken) {
      res.status(400).json({ error: 'BAD_APNS_TOKEN' });
      return;
    }
    /* Lower-case so the same physical device cannot register twice under two
       casings of one token and receive every alert in duplicate. */
    apnsToken = apnsToken.toLowerCase();
    addressString = 'ios:' + apnsToken;
  } else {
    subscription = cleanSubscription(body.subscription);
    if (!subscription) {
      res.status(400).json({ error: 'BAD_SUBSCRIPTION' });
      return;
    }
    addressString = 'web:' + subscription.endpoint;
  }

  const timezone = normalizeTimeZone(body.timezone);
  if (!timezone) {
    /* Without a usable zone four of the five triggers cannot be placed at all,
       so this is a hard failure rather than a silent default to UTC that would
       wake a reader at the wrong hour every week. */
    res.status(400).json({ error: 'BAD_TIMEZONE' });
    return;
  }

  const prefs = cleanPrefs(body.prefs);
  const deviceId = deviceIdFor(addressString);

  const row = {
    device_id: deviceId,
    platform,
    apns_token: apnsToken,
    subscription,
    league_id: cleanLeagueId(body.leagueId),
    team_id: cleanTeamId(body.teamId),
    timezone,
    prefs,
    season_year: cleanInt(body.seasonYear, 1990, 2100),
    week: cleanInt(body.week, 0, 30),
    first_kickoff_ms: cleanInt(body.firstKickoffMs, 0, 4102444800000),
    /* A re-register is how a previously dead address comes back: the OS only
       reissues a token to an app that is installed and permitted. */
    disabled_at: null,
    disabled_reason: null,
  };

  const { error } = await supabase
    .from('notification_devices')
    .upsert(row, { onConflict: 'device_id' });

  if (error) {
    console.error('[FSNPush] failed to upsert device ' + deviceId +
      ' (platform ' + platform + ')', error);
    res.status(500).json({ error: 'REGISTER_FAILED', detail: error.message });
    return;
  }

  res.status(200).json({ ok: true, deviceId, prefs, timezone });
}

/* ============================================================================
   SELFTEST — one real push to one named device

   Byte-identical behaviour to the retired /api/notifications-selftest: the
   deviceId is the SHA-256 of the push address, verified against
   notification_devices before a send, rate-limited on the row's last_test_at
   column so a leaked deviceId is a nuisance rather than a way to grind the
   transport. Writes no ledger row and stamps no last_sent_at.
============================================================================ */

async function handleSelftest(req, res) {
  applyHeaders(res, req, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const supabase = getSupabase('mffu-vercel-notifications-selftest');
  if (!supabase) {
    console.error('[FSNPush] /api/notifications (selftest) cannot reach Supabase: ' +
      'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing from the environment.',
      new Error('SUPABASE_NOT_CONFIGURED'));
    res.status(503).json({ error: 'STORAGE_NOT_CONFIGURED' });
    return;
  }

  let body;
  try {
    body = await readBody(req, SELFTEST_MAX_BODY_BYTES);
  } catch (err) {
    console.warn('[FSNPush] selftest received an unreadable body', err);
    res.status(400).json({ error: err.message === 'PAYLOAD_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_JSON' });
    return;
  }

  const deviceId = String((body && body.deviceId) || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(deviceId)) {
    res.status(400).json({
      error: 'BAD_DEVICE_ID',
      detail: 'deviceId must be the 64-character hex receipt /api/notifications returned.',
    });
    return;
  }

  const triggerId = String((body && body.trigger) || SELFTEST_DEFAULT_TRIGGER).trim() || SELFTEST_DEFAULT_TRIGGER;
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
  if (Number.isFinite(lastTestAt) && lastTestAt > 0 && (now - lastTestAt) < SELFTEST_COOLDOWN_MS) {
    const retryInMs = SELFTEST_COOLDOWN_MS - (now - lastTestAt);
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

/* ============================================================================
   ENTRY — dispatch by ?action=
============================================================================ */

async function handler(req, res) {
  const raw = req.query && req.query.action;
  const action = String(Array.isArray(raw) ? raw[0] : (raw || '')).trim().toLowerCase();
  if (action === 'selftest') return handleSelftest(req, res);
  /* Default is register: an empty action, a missing query, or the explicit
     'register' value all reach the same handler. This mirrors what the
     retired /api/notifications-register file did before consolidation, and
     matches the vercel.json rewrites for the two legacy paths. */
  return handleRegister(req, res);
}

module.exports = handler;
module.exports.deviceIdFor = deviceIdFor;
module.exports.cleanPrefs = cleanPrefs;
