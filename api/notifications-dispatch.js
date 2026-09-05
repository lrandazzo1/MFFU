/* ============================================================================
   FSN NOTIFICATIONS — /api/notifications-dispatch

   The cron target. Runs hourly (see vercel.json), asks the trigger engine which
   of the five weekly alerts each registered device is now due, and delivers
   them over APNs or Web Push.

   GET  /api/notifications-dispatch            deliver
   GET  /api/notifications-dispatch?dry=1      evaluate and report, send nothing

   ---- WHY HOURLY ----

   The three engagement windows expand to five alerts, each of which has to land
   at a sensible hour in the READER's timezone. One cron per alert would fire at
   one fixed UTC instant for the whole world. Instead this runs every hour and
   api/notifications/triggers.js decides, per device, whether that device's local
   window has just opened. Four timezones in one league get four correct send
   times from one schedule. It also means a missed run is self-healing: the
   engine's grace window re-offers a recent alert on the next pass.

   ---- AT-MOST-ONCE ----

   The ledger row is inserted BEFORE the provider call. A duplicate insert
   violates the composite primary key and that device/trigger/week is skipped,
   so two overlapping cron runs cannot both deliver. The explicit trade: a
   provider call that fails after the insert drops that alert rather than
   risking a double-send. For a weekly nudge that is the right side to fail on,
   and the dropped send is recorded with status='failed' rather than lost.

   ---- AUTH ----

   Vercel attaches `Authorization: Bearer $CRON_SECRET` to scheduled
   invocations when CRON_SECRET is set in the project environment. Set it. With
   no secret configured the route refuses to run rather than defaulting open —
   an unauthenticated push fan-out is not something to leave to chance.
============================================================================ */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const engine = require('./notifications/triggers');
const apns = require('./notifications/apns');
const webpush = require('./notifications/webpush');

/* Ceiling per invocation, so one run cannot exceed the function timeout. With
   an hourly cron and a grace window measured in hours, a backlog beyond this
   drains on the following passes rather than being lost. */
const MAX_DEVICES = 2000;

/* How far back to read the send ledger when building the per-device suppression
   set. The dedupe key is scoped to (season, week), so anything older than a
   couple of weeks cannot suppress a live send. */
const LEDGER_LOOKBACK_DAYS = 21;

let supabaseClient;

function getSupabase() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  if (!supabaseClient) {
    supabaseClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'X-Client-Info': 'mffu-vercel-notifications-dispatch' } },
    });
  }
  return supabaseClient;
}

/* Constant-time compare so the secret cannot be recovered a byte at a time. */
function secretMatches(presented, expected) {
  const a = Buffer.from(String(presented || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return require('crypto').timingSafeEqual(a, b);
}

function authorized(req) {
  const expected = String(process.env.CRON_SECRET || '').trim();
  if (!expected) return false;
  const header = String((req.headers && req.headers.authorization) || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const direct = String((req.headers && req.headers['x-cron-secret']) || '');
  return secretMatches(bearer, expected) || secretMatches(direct, expected);
}

/* Map a stored row into the shape the trigger engine expects. */
function toEngineDevice(row) {
  return {
    deviceId: row.device_id,
    timezone: row.timezone,
    prefs: (row.prefs && typeof row.prefs === 'object') ? row.prefs : {},
    seasonYear: row.season_year,
    week: row.week,
    firstKickoffMs: row.first_kickoff_ms == null ? null : Number(row.first_kickoff_ms),
  };
}

/* --------------------------------------------------------------------------
   claim(supabase, device, due)

   Insert the ledger row. Returns true when THIS run won the claim and should
   proceed to send, false when the row already existed (another run, or an
   earlier pass in this one) or the insert genuinely failed.
-------------------------------------------------------------------------- */
async function claim(supabase, deviceId, due) {
  const { error } = await supabase.from('notification_sends').insert({
    device_id: deviceId,
    trigger_id: due.trigger.id,
    season_year: Number(due.deviceSeason) || 0,
    week: Number(due.deviceWeek) || 0,
    status: 'sent',
  });
  if (!error) return true;

  /* 23505 = unique_violation. Expected and benign: it is the dedupe working. */
  if (String(error.code) === '23505') return false;

  console.error('[FSNPush] could not claim ' + due.trigger.id + ' for device ' + deviceId +
    '; skipping the send rather than risking a duplicate.', error);
  return false;
}

/* Record the real outcome on the ledger row already claimed above. */
async function markResult(supabase, deviceId, due, result) {
  const patch = {
    status: result.ok ? 'sent' : 'failed',
    detail: result.ok ? null : String(result.reason || result.status || '').slice(0, 200),
  };
  const { error } = await supabase
    .from('notification_sends')
    .update(patch)
    .eq('device_id', deviceId)
    .eq('trigger_id', due.trigger.id)
    .eq('season_year', Number(due.deviceSeason) || 0)
    .eq('week', Number(due.deviceWeek) || 0);
  if (error) {
    console.warn('[FSNPush] delivered ' + due.trigger.id + ' to device ' + deviceId +
      ' but could not write the ledger outcome', error);
  }
}

/* Retire a permanently dead push address. The row is kept, not deleted, so a
   later re-register restores the reader's preferences instead of resetting
   them. */
async function retire(supabase, deviceId, reason) {
  const { error } = await supabase
    .from('notification_devices')
    .update({ disabled_at: new Date().toISOString(), disabled_reason: String(reason || '').slice(0, 200) })
    .eq('device_id', deviceId);
  if (error) {
    console.error('[FSNPush] failed to retire dead device ' + deviceId, error);
  } else {
    console.warn('[FSNPush] retired device ' + deviceId + ' (' + reason + ')');
  }
}

/* --------------------------------------------------------------------------
   isDryRun(req)

   `req.query` is a convenience the Vercel Node helper layer adds; it is NOT
   part of Node's own http.IncomingMessage. Reading the flag from there alone
   made the safety of a dry run depend on a runtime nicety, and the failure
   mode is the worst one available: on any runtime that does not pre-parse the
   query string, `?dry=1` silently became a REAL dispatch while the operator
   believed they were rehearsing. (The route audit reproduces exactly that —
   one live push and three ledger writes from a ?dry=1 request.)

   So the URL is the source of truth, with req.query accepted as well. A
   malformed URL falls back to a LIVE run only if req.query says nothing about
   dry, because defaulting an unparseable request to "dry" would silently
   suppress a real cron run instead.
-------------------------------------------------------------------------- */
function isDryRun(req) {
  const fromQuery = req && req.query ? String(req.query.dry || '') : '';
  if (fromQuery === '1') return true;

  try {
    const url = new URL(String((req && req.url) || ''), 'http://dispatch.local');
    if (String(url.searchParams.get('dry') || '') === '1') return true;
  } catch (err) {
    console.warn('[FSNPush] could not parse the request URL to look for ?dry=1; ' +
      'falling back to req.query only. Request URL was: ' + String(req && req.url), err);
  }
  return false;
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  if (!authorized(req)) {
    if (!String(process.env.CRON_SECRET || '').trim()) {
      console.error('[FSNPush] dispatch refused: CRON_SECRET is not set in this environment, ' +
        'so the route cannot authenticate its caller and will not fan out notifications.',
        new Error('CRON_SECRET_MISSING'));
    }
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const dryRun = isDryRun(req);
  const now = Date.now();

  const supabase = getSupabase();
  if (!supabase) {
    console.error('[FSNPush] dispatch cannot reach Supabase: SUPABASE_URL or ' +
      'SUPABASE_SERVICE_ROLE_KEY is missing from the environment.',
      new Error('SUPABASE_NOT_CONFIGURED'));
    res.status(503).json({ error: 'STORAGE_NOT_CONFIGURED' });
    return;
  }

  const apnsReady = apns.isConfigured();
  const webReady = webpush.isConfigured();

  /* A LIVE run with nowhere to send is a misconfiguration and must fail loudly.
     A DRY run must not: the first health check anyone performs is against a
     deployment whose keys are not provisioned yet, and that is precisely when
     an operator needs to see that the schedule, timezones and ledger all
     evaluate correctly. Refusing there would answer "503" to the one question
     the dry run exists to answer, so the readiness of each transport is
     reported in the diagnostic instead. */
  if (!apnsReady && !webReady && !dryRun) {
    console.error('[FSNPush] dispatch has no configured transport. Set the APNS_* ' +
      'variables for iOS, the VAPID_* variables for browsers, or both.',
      new Error('NO_TRANSPORT_CONFIGURED'));
    res.status(503).json({ error: 'NO_TRANSPORT_CONFIGURED' });
    return;
  }
  if (!apnsReady && !webReady) {
    console.warn('[FSNPush] dry run proceeding with NO transport configured. The plan ' +
      'below is what would be attempted once APNS_* or VAPID_* variables are set.');
  }

  /* ---- 1. Live devices -------------------------------------------------- */
  const { data: devices, error: devicesError } = await supabase
    .from('notification_devices')
    .select('device_id, platform, apns_token, subscription, league_id, team_id, timezone, prefs, season_year, week, first_kickoff_ms')
    .is('disabled_at', null)
    .limit(MAX_DEVICES);

  if (devicesError) {
    console.error('[FSNPush] dispatch could not read notification_devices', devicesError);
    res.status(500).json({ error: 'DEVICE_READ_FAILED', detail: devicesError.message });
    return;
  }
  if (!devices || !devices.length) {
    res.status(200).json({ ok: true, evaluated: 0, due: 0, sent: 0, failed: 0, dryRun });
    return;
  }

  /* ---- 2. Ledger, one read for the whole batch -------------------------- */
  const since = new Date(now - LEDGER_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();
  const { data: ledger, error: ledgerError } = await supabase
    .from('notification_sends')
    .select('device_id, trigger_id, season_year, week')
    .in('device_id', devices.map((d) => d.device_id))
    .gte('sent_at', since);

  if (ledgerError) {
    /* Without the ledger there is no dedupe, and re-sending a week of alerts to
       every device is far worse than sending nothing this hour. Stop. */
    console.error('[FSNPush] dispatch could not read the send ledger; aborting this run ' +
      'rather than risking duplicate notifications.', ledgerError);
    res.status(500).json({ error: 'LEDGER_READ_FAILED', detail: ledgerError.message });
    return;
  }

  const sentByDevice = new Map();
  for (const row of (ledger || [])) {
    if (!sentByDevice.has(row.device_id)) sentByDevice.set(row.device_id, new Set());
    sentByDevice.get(row.device_id).add(
      engine.sendKey(row.trigger_id, row.season_year, row.week)
    );
  }

  /* ---- 3. Resolve what is due ------------------------------------------ */
  const work = [];
  for (const row of devices) {
    const device = toEngineDevice(row);
    let due;
    try {
      due = engine.dueTriggers(device, now, sentByDevice.get(row.device_id) || new Set());
    } catch (err) {
      console.error('[FSNPush] trigger evaluation threw for device ' + row.device_id +
        '; skipping this device for this run.', err);
      continue;
    }
    for (const item of due) {
      work.push({
        row,
        due: Object.assign({}, item, { deviceSeason: row.season_year, deviceWeek: row.week }),
      });
    }
  }

  if (dryRun) {
    const PLAN_LIMIT = 50;

    /* The most useful thing a health check can report is why nothing is due,
       so summarise the two conditions that silence a device entirely — an
       unusable timezone and every group switched off — rather than leaving an
       operator to guess from an empty plan. */
    let missingTimezone = 0;
    let noGroupsEnabled = 0;
    let ios = 0;
    let web = 0;
    for (const row of devices) {
      if (row.platform === 'ios') ios++; else web++;
      if (!engine.normalizeTimeZone(row.timezone)) missingTimezone++;
      const prefs = (row.prefs && typeof row.prefs === 'object') ? row.prefs : {};
      if (!engine.PREF_GROUPS.some((g) => prefs[g] === true)) noGroupsEnabled++;
    }

    res.status(200).json({
      ok: true,
      dryRun: true,
      now: new Date(now).toISOString(),

      /* Whether a real run could actually deliver anything right now. */
      transports: { apns: apnsReady, web: webReady },
      deliverable: apnsReady || webReady,

      evaluated: devices.length,
      due: work.length,
      ledgerRowsScanned: (ledger || []).length,
      ledgerLookbackDays: LEDGER_LOOKBACK_DAYS,

      devices: { total: devices.length, ios, web, missingTimezone, noGroupsEnabled },

      /* Truncation is stated rather than silent: `due` is the real total. */
      planTruncated: work.length > PLAN_LIMIT,
      plan: work.slice(0, PLAN_LIMIT).map((w) => ({
        deviceId: w.row.device_id,
        platform: w.row.platform,
        timezone: w.row.timezone,
        trigger: w.due.trigger.id,
        group: w.due.trigger.group,
        targetAt: new Date(w.due.target).toISOString(),
        lateByMinutes: Math.round(w.due.age / 60000),
        wouldDeliver: w.row.platform === 'ios' ? apnsReady : webReady,
      })),
    });
    return;
  }

  /* ---- 4. Deliver ------------------------------------------------------- */
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const retiring = new Map();
  /* Devices that actually received something this run. Tracked explicitly
     rather than derived from `work`, so a device whose only send failed is not
     stamped as having been reached. */
  const delivered = new Set();

  /* One HTTP/2 session for every iOS send in this run, opened only if there is
     iOS work to do. */
  const needsApns = work.some((w) => w.row.platform === 'ios');
  let session = null;
  if (needsApns && apnsReady) {
    try {
      session = apns.openSession();
    } catch (err) {
      console.error('[FSNPush] could not open an APNs session; iOS sends are skipped this run.', err);
    }
  }

  try {
    for (const { row, due } of work) {
      const transportReady = row.platform === 'ios' ? (apnsReady && !!session) : webReady;
      if (!transportReady) {
        console.warn('[FSNPush] no configured transport for platform "' + row.platform +
          '"; skipping ' + due.trigger.id + ' for device ' + row.device_id);
        skipped++;
        continue;
      }

      const notification = engine.buildNotification(due.trigger.id, {
        leagueId: row.league_id,
        seasonYear: row.season_year,
        week: row.week,
      });
      if (!notification) { skipped++; continue; }

      /* Claim before sending. See the header comment. */
      const won = await claim(supabase, row.device_id, due);
      if (!won) { skipped++; continue; }

      let result;
      try {
        result = row.platform === 'ios'
          ? await apns.send(session, row.apns_token, notification)
          : await webpush.send(row.subscription, notification);
      } catch (err) {
        console.error('[FSNPush] transport threw sending ' + due.trigger.id +
          ' to device ' + row.device_id + ' (' + row.platform + ')', err);
        result = { ok: false, status: 0, reason: String(err && err.message || 'THREW'), retryable: true, unregister: false };
      }

      if (result.ok) {
        sent++;
        delivered.add(row.device_id);
      } else {
        failed++;
        console.error('[FSNPush] ' + due.trigger.id + ' was rejected for device ' +
          row.device_id + ' (' + row.platform + '): status ' + result.status +
          ' ' + (result.reason || ''),
          new Error('PUSH_REJECTED'));
        if (result.unregister) retiring.set(row.device_id, result.reason || ('status ' + result.status));
      }

      await markResult(supabase, row.device_id, due, result);
    }
  } finally {
    apns.closeSession(session);
  }

  /* ---- 5. Retire dead addresses ---------------------------------------- */
  for (const [deviceId, reason] of retiring) {
    await retire(supabase, deviceId, reason);
  }

  /* ---- 6. Touch last_sent_at for everything delivered ------------------- */
  if (delivered.size > 0) {
    const { error } = await supabase
      .from('notification_devices')
      .update({ last_sent_at: new Date(now).toISOString() })
      .in('device_id', Array.from(delivered));
    if (error) console.warn('[FSNPush] could not stamp last_sent_at', error);
  }

  res.status(200).json({
    ok: true,
    now: new Date(now).toISOString(),
    evaluated: devices.length,
    due: work.length,
    sent,
    failed,
    skipped,
    retired: retiring.size,
  });
}

module.exports = handler;
