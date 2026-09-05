/* ============================================================================
   FSN NOTIFICATIONS — /api/notifications-register

   GET                          -> { configured, vapidPublicKey, groups }
   POST   { platform, token | subscription, prefs, timezone, ... }
                                -> { ok, deviceId }
   DELETE { deviceId } | POST { ...,'unsubscribe':true }
                                -> { ok }

   The device-token boundary. Browsers and the iOS binary hand a push address
   to this route; it hashes it into a stable id, stores it with the reader's
   three preference switches, and returns only the id. Nothing about the reader
   beyond that ever enters the table — see supabase/notifications.sql.

   GET is the client's bootstrap read: it reports whether push is configured on
   this deployment at all and hands back the VAPID public key a browser needs
   before it can even build a subscription. Serving that key publicly is by
   design; it is the public half of the pair.
============================================================================ */

'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { PREF_GROUPS, normalizeTimeZone } = require('./notifications/triggers');
const apns = require('./notifications/apns');
const webpush = require('./notifications/webpush');

const MAX_BODY_BYTES = 32 * 1024;

/* Same origin set as /api/waitlist. The Capacitor binary serves the app from
   capacitor://localhost and sends either that or a null Origin, so the
   fallback stays permissive — this route stores a push address the caller
   already owns and returns no secret, so an origin check is not the control
   that matters here. Consent is: the caller had to hold a real APNs token or a
   real browser subscription, both of which the OS only issues after the user
   granted permission. */
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
      global: { headers: { 'X-Client-Info': 'mffu-vercel-notifications' } },
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

async function handler(req, res) {
  applyHeaders(res, req);
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

  const supabase = getSupabase();
  if (!supabase) {
    console.error('[FSNPush] /api/notifications-register cannot reach Supabase: ' +
      'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing from the environment.',
      new Error('SUPABASE_NOT_CONFIGURED'));
    res.status(503).json({ error: 'STORAGE_NOT_CONFIGURED' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
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

module.exports = handler;
module.exports.deviceIdFor = deviceIdFor;
module.exports.cleanPrefs = cleanPrefs;
