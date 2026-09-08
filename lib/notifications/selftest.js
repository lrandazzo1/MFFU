/* ============================================================================
   FSN NOTIFICATIONS — TRIGGER ENGINE SELF-TEST

   `node lib/notifications/selftest.js`

   index.html has no test suite and the api/ routes have none either, so this
   is a standalone assertion script for the parts of the push stack that are
   pure computation and genuinely easy to get wrong: timezone-anchored
   scheduling across DST boundaries, the once-a-day delivery bands, the opt-in
   gate, copy determinism, and the rate limiter on the daily data pull.

   It requires no credentials, no database, and no network. Exit code 0 means
   every case passed.
============================================================================ */

'use strict';

const E = require('./triggers');
const FEED = require('./schedule-feed');

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; return; }
  failures.push(label + '\n     expected ' + b + '\n     actual   ' + a);
}

function checkTrue(label, value) { check(label, !!value, true); }

/* Readable UTC stamp for a failure message. */
const iso = (ms) => new Date(ms).toISOString();

/* ---------------------------------------------------------------------------
   1. tzParts / wallClockToInstant round-trip
--------------------------------------------------------------------------- */
{
  // 2026-09-08T13:00:00Z is 09:00 in New York (EDT, UTC-4) on a Tuesday.
  const p = E.tzParts('America/New_York', new Date(Date.UTC(2026, 8, 8, 13, 0, 0)));
  check('tzParts NY hour', p.hour, 9);
  check('tzParts NY weekday (Tue)', p.weekday, 2);
  check('tzParts NY day', p.day, 8);

  const back = E.wallClockToInstant('America/New_York', 2026, 9, 8, 9);
  check('wallClock->instant NY 09:00', iso(back), '2026-09-08T13:00:00.000Z');

  // Same wall clock, Los Angeles (PDT, UTC-7).
  const la = E.wallClockToInstant('America/Los_Angeles', 2026, 9, 8, 9);
  check('wallClock->instant LA 09:00', iso(la), '2026-09-08T16:00:00.000Z');

  // A zone with a half-hour offset, to catch offset math that assumes whole hours.
  const kolkata = E.wallClockToInstant('Asia/Kolkata', 2026, 9, 8, 9);
  check('wallClock->instant Kolkata 09:00', iso(kolkata), '2026-09-08T03:30:00.000Z');
}

/* ---------------------------------------------------------------------------
   2. DST correctness

   US fall-back is 2026-11-01. A Sunday 09:00 alert must stay 09:00 LOCAL on
   both sides of it, which means the UTC instant shifts by an hour. This is the
   case a fixed-offset implementation gets wrong.
--------------------------------------------------------------------------- */
{
  // Sunday 2026-10-25 09:00 EDT (UTC-4) -> 13:00Z
  const before = E.mostRecentLocalOccurrence(
    'America/New_York', 0, 9, Date.UTC(2026, 9, 25, 20, 0, 0));
  check('DST: Sun 09:00 local before fall-back', iso(before), '2026-10-25T13:00:00.000Z');

  // Sunday 2026-11-01 09:00 EST (UTC-5) -> 14:00Z
  const after = E.mostRecentLocalOccurrence(
    'America/New_York', 0, 9, Date.UTC(2026, 10, 1, 20, 0, 0));
  check('DST: Sun 09:00 local after fall-back', iso(after), '2026-11-01T14:00:00.000Z');
}

/* ---------------------------------------------------------------------------
   3. mostRecentLocalOccurrence never returns a future instant
--------------------------------------------------------------------------- */
{
  // Tuesday 2026-09-08, 07:00 local NY (11:00Z) — the 09:00 Tuesday window has
  // NOT opened yet, so the most recent occurrence is the previous Tuesday.
  const now = Date.UTC(2026, 8, 8, 11, 0, 0);
  const got = E.mostRecentLocalOccurrence('America/New_York', 2, 9, now);
  checkTrue('most recent occurrence is in the past', got <= now);
  check('pre-window Tuesday falls back a week', iso(got), '2026-09-01T13:00:00.000Z');
}

/* ---------------------------------------------------------------------------
   4. dueTriggers — the once-a-day local-hour bands

   Every case below pins the clock to 16:00 UTC, which is when the cron fires.
   The point of the band model is that ONE such instant selects a different,
   correct alert in each timezone, so these assertions read as a map of what
   the single daily run does across the install base.
--------------------------------------------------------------------------- */
{
  const at = (tz, prefs) => Object.assign({
    deviceId: 'test',
    timezone: tz,
    seasonYear: 2026,
    week: 1,
    prefs: prefs || { tuesday: true, thursday: true, sunday: true },
  });
  const ids = (device, now, sent) => E.dueTriggers(device, now, sent || []).map((d) => d.trigger.id);

  /* Tuesday 2026-09-08, 16:00Z — the daily run. */
  const TUE_RUN = Date.UTC(2026, 8, 8, 16, 0, 0);

  check('Tue run, Honolulu 06:00 -> waivers', ids(at('Pacific/Honolulu'), TUE_RUN), ['waiver_wire']);
  check('Tue run, Los Angeles 09:00 -> waivers', ids(at('America/Los_Angeles'), TUE_RUN), ['waiver_wire']);
  check('Tue run, Chicago 11:00 -> waivers', ids(at('America/Chicago'), TUE_RUN), ['waiver_wire']);
  check('Tue run, New York 12:00 -> waivers', ids(at('America/New_York'), TUE_RUN), ['waiver_wire']);
  /* Same instant, but late afternoon in Europe: the recap is the alert that
     belongs at that hour, not a waiver result eight hours old. */
  check('Tue run, London 17:00 -> recap', ids(at('Europe/London'), TUE_RUN), ['weekly_recap']);
  check('Tue run, Berlin 18:00 -> recap', ids(at('Europe/Berlin'), TUE_RUN), ['weekly_recap']);

  /* A device gets at most one alert per run even with every switch on. */
  checkTrue('one run delivers at most one alert',
    E.dueTriggers(at('America/New_York'), TUE_RUN, []).length <= 1);

  /* Hobby-plan crons are only promised within the hour of their schedule. An
     alert must not vanish because the platform drifted. */
  check('cron 59 minutes late still delivers',
    ids(at('America/New_York'), Date.UTC(2026, 8, 8, 16, 59, 0)), ['waiver_wire']);
  check('cron an hour early still delivers',
    ids(at('America/New_York'), Date.UTC(2026, 8, 8, 15, 0, 0)), ['waiver_wire']);

  /* Outside the served band of zones nothing is delivered — 01:00 on the reader's
     clock is not a time to be told about waivers. Silent, and counted by the
     dispatcher's dry run as outsideDailyWindow. */
  check('Tokyo (01:00 local) receives nothing', ids(at('Asia/Tokyo'), TUE_RUN), []);
  check('a 03:00 local run delivers nothing',
    ids(at('America/New_York'), Date.UTC(2026, 8, 8, 7, 0, 0)), []);

  /* Wrong weekday: the Tuesday alerts do not leak into Wednesday. */
  check('Wednesday run fires no Tuesday alert',
    ids(at('America/New_York'), Date.UTC(2026, 8, 9, 16, 0, 0)), []);

  /* Sunday 2026-09-13, same 16:00Z run. West of Eastern it is still the
     morning, so the lineup check; in the East the slate is kicking off. */
  const SUN_RUN = Date.UTC(2026, 8, 13, 16, 0, 0);
  check('Sun run, Honolulu 06:00 -> lineup check', ids(at('Pacific/Honolulu'), SUN_RUN), ['sunday_lineup']);
  check('Sun run, Los Angeles 09:00 -> lineup check', ids(at('America/Los_Angeles'), SUN_RUN), ['sunday_lineup']);
  check('Sun run, New York 12:00 -> game day pulse', ids(at('America/New_York'), SUN_RUN), ['gameday_pulse']);

  /* Ledger suppression, on the merged (season, week) key. */
  const key = E.sendKey('waiver_wire', 2026, 1);
  check('ledger suppresses a repeat', ids(at('America/New_York'), TUE_RUN, [key]), []);
  check('a ledger row for another week does not suppress',
    ids(at('America/New_York'), TUE_RUN, [E.sendKey('waiver_wire', 2026, 2)]), ['waiver_wire']);

  /* Consent. */
  check('opted-out group never fires',
    ids(at('America/New_York', { thursday: true, sunday: true }), TUE_RUN), []);
  check('missing prefs means no consent',
    ids(Object.assign(at('America/New_York'), { prefs: undefined }), TUE_RUN), []);
  check('non-boolean pref is not consent',
    ids(Object.assign(at('America/New_York'), { prefs: { tuesday: 'yes' } }), TUE_RUN), []);

  /* Bands must tile the deliverable hours on every weekday they cover, or a
     timezone silently falls between two alerts. */
  for (const weekday of [0, 2]) {
    const bands = E.TRIGGERS.filter((t) => t.weekday === weekday);
    for (let hour = E.EARLIEST_LOCAL_HOUR; hour <= E.LATEST_LOCAL_HOUR; hour++) {
      const matches = bands.filter((t) => E.inLocalBand(t, { weekday, hour }));
      check('weekday ' + weekday + ' hour ' + hour + ' matches exactly one band',
        matches.length, 1);
    }
  }
}

/* ---------------------------------------------------------------------------
   5. Kickoff anchoring — the last daily run before the game

   A once-a-day schedule cannot warn a league exactly two hours before kickoff.
   What it CAN promise is the last run that still precedes it, which is what
   this asserts — including the case that matters most: a week with no game in
   the next day stays quiet rather than crying lock.
--------------------------------------------------------------------------- */
{
  // TNF kickoff 2026-09-10 20:15 ET = 2026-09-11T00:15Z.
  const kickoff = Date.UTC(2026, 8, 11, 0, 15, 0);
  const base = {
    deviceId: 'anchored',
    seasonYear: 2026,
    week: 1,
    firstKickoffMs: kickoff,
    prefs: { thursday: true },
  };
  const ids = (device, now) => E.dueTriggers(device, now, []).map((d) => d.trigger.id);
  const ny = Object.assign({}, base, { timezone: 'America/New_York' });
  const la = Object.assign({}, base, { timezone: 'America/Los_Angeles' });

  const THU_RUN = Date.UTC(2026, 8, 10, 16, 0, 0);  // 8h15m before kickoff
  check('the last run before kickoff warns NY', ids(ny, THU_RUN), ['tnf_lock']);
  check('the last run before kickoff warns LA', ids(la, THU_RUN), ['tnf_lock']);

  const WED_RUN = Date.UTC(2026, 8, 9, 16, 0, 0);   // 32h out: another run to come
  check('a run more than a day out holds', ids(ny, WED_RUN), []);

  const AFTER = Date.UTC(2026, 8, 11, 16, 0, 0);    // kickoff already happened
  check('no lock warning after kickoff', ids(ny, AFTER), []);

  /* A week whose opener is Sunday has no Thursday game. Warning about a lock
     that is three days away would be noise, so the trigger stays silent. */
  const sundayOpener = Object.assign({}, ny, { firstKickoffMs: Date.UTC(2026, 8, 13, 17, 0, 0) });
  check('a week with no game inside a day stays silent', ids(sundayOpener, THU_RUN), []);

  /* A Saturday opener moves the warning to Saturday's run — the last one
     before the game — rather than firing on a hardcoded Thursday. Friday's run
     is still more than a day out, so it holds. */
  const satOpener = Object.assign({}, ny, { firstKickoffMs: Date.UTC(2026, 8, 12, 21, 0, 0) });
  check('a Saturday opener warns on the Saturday run',
    ids(satOpener, Date.UTC(2026, 8, 12, 16, 0, 0)), ['tnf_lock']);
  check('a Saturday opener holds on the Friday run',
    ids(satOpener, Date.UTC(2026, 8, 11, 16, 0, 0)), []);
  check('a Saturday opener does not warn on Thursday', ids(satOpener, THU_RUN), []);

  /* With no hydrated kickoff at all the trigger falls back to its Thursday
     band, so a reader is still warned on the usual day. */
  const noKick = Object.assign({}, ny, { firstKickoffMs: null });
  check('kickoff fallback uses the Thursday band', ids(noKick, THU_RUN), ['tnf_lock']);
  check('kickoff fallback does not fire on Wednesday', ids(noKick, WED_RUN), []);
}

/* ---------------------------------------------------------------------------
   6. Bad timezone is contained, not fatal
--------------------------------------------------------------------------- */
{
  check('unknown timezone rejected', E.normalizeTimeZone('Mars/Olympus_Mons'), null);
  check('empty timezone rejected', E.normalizeTimeZone(''), null);
  check('valid timezone accepted', E.normalizeTimeZone('Europe/London'), 'Europe/London');

  const broken = {
    deviceId: 'broken',
    timezone: 'Not/AZone',
    seasonYear: 2026,
    week: 1,
    prefs: { tuesday: true },
  };
  // Must return [] rather than throwing — one bad row cannot take down a batch.
  check('bad timezone yields no sends', E.dueTriggers(broken, Date.UTC(2026, 8, 8, 13, 5, 0), []), []);
}

/* ---------------------------------------------------------------------------
   7. Copy determinism
--------------------------------------------------------------------------- */
{
  const ctx = { leagueId: '123456', seasonYear: 2026, week: 3 };
  const a = E.buildNotification('waiver_wire', ctx);
  const b = E.buildNotification('waiver_wire', ctx);
  check('same context yields identical copy', a, b);
  checkTrue('title carries the week', a.title.indexOf('Week 3') !== -1);
  check('payload carries routing data', a.data.trigger, 'waiver_wire');
  check('payload carries the group', a.data.group, 'tuesday');

  // A different week must be able to draw differently, and must at minimum
  // relabel — otherwise the seed is not actually reaching the draw.
  const other = E.buildNotification('waiver_wire', { leagueId: '123456', seasonYear: 2026, week: 4 });
  checkTrue('a different week changes the title', other.title !== a.title);

  // Every trigger must have a copy pool wired up.
  for (const t of E.TRIGGERS) {
    const n = E.buildNotification(t.id, ctx);
    checkTrue('copy exists for ' + t.id, !!(n && n.title && n.body));
  }

  check('unknown trigger returns null', E.buildNotification('nope', ctx), null);
}

/* The feed's rate-limit cases are async. CommonJS has no top-level await, so
   the promise is held here and the report below waits on it. */
let feedChecks = Promise.resolve();

/* ---------------------------------------------------------------------------
   8. The daily schedule feed

   The parser, and — the assertion that actually protects the upstream — the
   rate limiter. No network: `pull` is injected with a stub fetch, and the
   Supabase client is a recording double, so every case here proves what would
   have been requested rather than requesting it.
--------------------------------------------------------------------------- */
{
  /* ---- parseScoreboard ---- */
  const doc = {
    season: { year: 2026, type: { type: 2 } },
    week: { number: 3 },
    events: [
      { date: '2026-09-27T17:00Z', week: { number: 3 } },
      { date: '2026-09-24T00:15Z', week: { number: 3 } },   // the Thursday opener
      { date: '2026-09-27T20:05Z', week: { number: 3 } },
    ],
  };
  const parsed = FEED.parseScoreboard(doc);
  check('feed reads the season', parsed.seasonYear, 2026);
  check('feed reads the week', parsed.week, 3);
  check('feed reads the season type', parsed.seasonType, 2);
  check('feed takes the EARLIEST kickoff, not the first listed',
    iso(parsed.firstKickoffMs), '2026-09-24T00:15:00.000Z');

  /* The same values nested under leagues[0], which the endpoint has also shipped. */
  const nested = FEED.parseScoreboard({ leagues: [{ season: { year: 2027 } }], events: [{ week: { number: 7 } }] });
  check('feed falls back to leagues[0].season', nested.seasonYear, 2027);
  check('feed recovers the week from the events', nested.week, 7);

  /* A document with no usable schedule must yield nulls, not zeroes or NaN —
     the dispatcher tests these with Number.isFinite before trusting them. */
  const empty = FEED.parseScoreboard({});
  check('an empty document yields nulls', [empty.seasonYear, empty.week, empty.firstKickoffMs], [null, null, null]);
  const junk = FEED.parseScoreboard({ week: { number: 4 }, events: [{ date: 'not-a-date' }] });
  check('an unparseable kickoff is dropped, not NaN', junk.firstKickoffMs, null);
  check('a bad kickoff does not cost the week number', junk.week, 4);

  /* ---- feedUrl host guard ---- */
  const savedUrl = process.env.NOTIFICATIONS_SCHEDULE_URL;
  /* These two cases deliberately drive the loud-rejection branch, so the
     console.error it is required to emit is captured rather than printed —
     the assertion is that the URL was refused, and a stack trace in the middle
     of a passing test run only teaches the reader to ignore stack traces. */
  const realError = console.error;
  console.error = () => {};
  try {
    process.env.NOTIFICATIONS_SCHEDULE_URL = 'https://evil.example/scoreboard';
    check('an off-allowlist override falls back to the default feed', FEED.feedUrl(), FEED.DEFAULT_FEED_URL);
    process.env.NOTIFICATIONS_SCHEDULE_URL = 'http://site.api.espn.com/x';
    check('a plaintext override falls back to the default feed', FEED.feedUrl(), FEED.DEFAULT_FEED_URL);
    process.env.NOTIFICATIONS_SCHEDULE_URL = 'https://site.api.espn.com/mirror';
    check('an allowlisted https override is honoured',
      FEED.feedUrl(), 'https://site.api.espn.com/mirror');
  } finally {
    console.error = realError;
    if (savedUrl === undefined) delete process.env.NOTIFICATIONS_SCHEDULE_URL;
    else process.env.NOTIFICATIONS_SCHEDULE_URL = savedUrl;
  }

  /* ---- Supabase double ----
     Chainable and thenable, exactly like the real client's builder, recording
     every upsert so the rate-limit assertions can read them back. */
  function makeDb(row) {
    const writes = [];
    const db = {
      writes,
      row,
      from() {
        const q = {
          _op: null,
          select() { this._op = 'select'; return this; },
          upsert(patch) { this._op = 'upsert'; this._patch = patch; return this; },
          eq() { return this; },
          limit() { return this; },
          then(resolve) {
            if (this._op === 'select') return Promise.resolve({ data: db.row ? [db.row] : [], error: null }).then(resolve);
            writes.push(this._patch);
            db.row = Object.assign({}, db.row, this._patch);
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return q;
      },
    };
    return db;
  }

  /* The two failure cases below are required to log loudly (CLAUDE.md rule 3).
     Capturing console.error turns that requirement into an assertion instead of
     a stack trace scrolling past a passing run. */
  const logged = [];
  function captureErrors(fn) {
    const realError = console.error;
    logged.length = 0;
    console.error = (...args) => { logged.push(args); };
    return Promise.resolve()
      .then(fn)
      .finally(() => { console.error = realError; });
  }

  const okBody = JSON.stringify(doc);
  function stubFetch(counter, body) {
    return async () => {
      counter.n++;
      return { ok: true, status: 200, text: async () => (body === undefined ? okBody : body) };
    };
  }

  const NOW = Date.UTC(2026, 8, 22, 16, 0, 0);
  const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

  feedChecks = (async () => {
    /* Fresh row: inside the interval, so NOTHING is requested. This is the
       assertion that keeps a manual curl (or ten) from spending requests. */
    let calls = { n: 0 };
    let db = makeDb({ season_year: 2026, week: 2, first_kickoff_ms: 1, attempted_at: hoursAgo(1), fetched_at: hoursAgo(1) });
    let out = await FEED.refresh(db, NOW, { fetchImpl: stubFetch(calls) });
    check('a recent attempt makes ZERO requests', calls.n, 0);
    check('a rate-limited refresh says so', out.reason, 'RATE_LIMITED');
    check('a rate-limited refresh serves the cached week', out.week, 2);
    check('a rate-limited refresh writes nothing', db.writes.length, 0);

    /* Past the interval: exactly one request, and the row is updated. */
    calls = { n: 0 };
    db = makeDb({ season_year: 2026, week: 2, attempted_at: hoursAgo(21) });
    out = await FEED.refresh(db, NOW, { fetchImpl: stubFetch(calls) });
    check('a stale row pulls exactly once', calls.n, 1);
    check('the pull is reported as a pull', out.reason, 'PULLED');
    check('the pulled week replaces the cached one', out.week, 3);
    check('the pull stamps fetched_at', db.writes[0].fetched_at, new Date(NOW).toISOString());
    check('the pull stamps attempted_at', db.writes[0].attempted_at, new Date(NOW).toISOString());
    check('a successful pull clears the last error', db.writes[0].last_error, null);

    /* No row at all — first run against a fresh database. */
    calls = { n: 0 };
    db = makeDb(null);
    out = await FEED.refresh(db, NOW, { fetchImpl: stubFetch(calls) });
    check('an empty cache pulls once', calls.n, 1);
    check('an empty cache yields the live week', out.week, 3);

    /* A FAILING upstream still stamps attempted_at, keeps the cached data, and
       is not retried. Gating the limiter on success instead would turn an
       outage into a retry storm. */
    calls = { n: 0 };
    db = makeDb({ season_year: 2026, week: 2, first_kickoff_ms: 42, attempted_at: hoursAgo(30), fetched_at: hoursAgo(30) });
    await captureErrors(async () => {
      out = await FEED.refresh(db, NOW, {
        fetchImpl: async () => { calls.n++; return { ok: false, status: 503, text: async () => '' }; },
      });
    });
    checkTrue('a failed pull logs a tagged [FSNPush] error',
      logged.some((args) => String(args[0]).startsWith('[FSNPush]')));
    checkTrue('a failed pull logs the error OBJECT, not just a message',
      logged.some((args) => args[args.length - 1] instanceof Error));
    check('a failed pull is attempted exactly once', calls.n, 1);
    check('a failed pull reports the failure', out.reason, 'PULL_FAILED');
    check('a failed pull keeps the cached week', out.week, 2);
    check('a failed pull keeps the cached kickoff', out.firstKickoffMs, 42);
    check('a failed pull records the error', db.writes[0].last_error, 'FEED_HTTP_503');
    check('a failed pull does NOT stamp fetched_at', db.writes[0].fetched_at, undefined);
    check('a failed pull still stamps attempted_at (the rate limiter)',
      db.writes[0].attempted_at, new Date(NOW).toISOString());

    /* ...and the next invocation, immediately after, requests nothing. */
    calls = { n: 0 };
    out = await FEED.refresh(db, NOW + 60000, { fetchImpl: stubFetch(calls) });
    check('the run after a failure makes ZERO requests', calls.n, 0);

    /* A body the upstream shape no longer matches must fail loudly rather than
       writing nulls over a good week. */
    calls = { n: 0 };
    db = makeDb({ season_year: 2026, week: 2, attempted_at: hoursAgo(30) });
    await captureErrors(async () => {
      out = await FEED.refresh(db, NOW, { fetchImpl: stubFetch(calls, '{"unexpected":true}') });
    });
    check('an unrecognised shape is recorded', db.writes[0].last_error, 'FEED_SHAPE_UNRECOGNISED');
    check('an unrecognised shape keeps the cached week', out.week, 2);

    /* readCached is what a dry run uses: no request, no write, ever. */
    calls = { n: 0 };
    db = makeDb({ season_year: 2026, week: 5, attempted_at: hoursAgo(99) });
    const cached = await FEED.readCached(db);
    check('readCached makes no request', calls.n, 0);
    check('readCached writes nothing', db.writes.length, 0);
    check('readCached returns the cached week', cached.week, 5);
    check('readCached never claims a refresh', cached.refreshed, false);
  })();

  /* ---- applyTo: the feed wins, the device report is the fallback ---- */
  const device = { seasonYear: 2025, week: 1, firstKickoffMs: 111 };
  const merged = FEED.applyTo(device, { seasonYear: 2026, week: 4, firstKickoffMs: 222 });
  check('the live feed overrides the device report', [merged.seasonYear, merged.week, merged.firstKickoffMs], [2026, 4, 222]);
  const partial = FEED.applyTo(device, { seasonYear: null, week: 4, firstKickoffMs: null });
  check('a missing feed field leaves the device value alone',
    [partial.seasonYear, partial.week, partial.firstKickoffMs], [2025, 4, 111]);
  check('an absent feed changes nothing', FEED.applyTo(device, null), device);
  checkTrue('applyTo does not mutate the caller\'s row', device.week === 1);
}

/* --------------------------------------------------------------------------- */
feedChecks.then(() => {
  if (failures.length) {
    console.error('\n[selftest] ' + failures.length + ' FAILED, ' + passed + ' passed\n');
    failures.forEach((f, i) => console.error('  ' + (i + 1) + ') ' + f + '\n'));
    process.exit(1);
  }
  console.log('[selftest] all ' + passed + ' assertions passed');
}).catch((err) => {
  console.error('\n[selftest] the async feed checks threw before they could be asserted\n', err);
  process.exit(1);
});
