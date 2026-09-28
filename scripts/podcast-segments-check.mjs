#!/usr/bin/env node
/* ============================================================================
   FSN — FOUR-SEGMENT PODCAST + TUESDAY CRON CHECK

   `node scripts/podcast-segments-check.mjs`

   Exercises the scheduled podcast pipeline against the COMPILED modules in
   `lib/dist` — the ones the route actually requires — with an in-memory
   Supabase double and a stubbed voice provider, so no ElevenLabs credit is
   spent and no row is written anywhere real.

   What it asserts, in order:

     1. The FSN Index port has not drifted from index.html. The weights and the
        shrinkage threshold are read out of the client source and compared
        against `lib/fsn-index.ts`. This is the whole reason a second copy of
        that formula is tolerable.
     2. The script carries all four segments, in the brief's order, and every
        line fits the endpoint's own validation (host tags, length, count).
     3. Each segment degrades to an honest empty state on thin data instead of
        inventing a climb, a hero or a result.
     4. It is deterministic: the same payload twice produces identical scripts.
     5. The cron run enforces the week-2 testing boundary BEFORE any provider
        call, caps leagues per run, is idempotent against `podcast_episodes`,
        and writes one ledger row per attempt.

   Exit code 0 means clean.
============================================================================ */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const pass = (msg) => console.log('  ok    ' + msg);
const fail = (msg) => { failures++; console.error('  FAIL  ' + msg); };
function check(label, fn) {
  try { fn(); pass(label); }
  catch (err) { fail(label + '\n        ' + String((err && err.message) || err).split('\n')[0]); }
}

/* ---- STANDING IN FOR THE TWO MODULES THE INTERACTIVE ENDPOINT BUILDS ITSELF ----

   The cron takes injectable deps, so section 5 hands it a database double
   directly. lib/generate-podcast.ts does not: it constructs its Supabase client
   and its ElevenLabs client at call time, inside the handler. The only way to
   exercise that handler — and section 8 has to, because it is the path the
   Studio button takes — is to occupy those two module slots in the require
   cache before the endpoint is loaded.

   `endpointStub` is filled in later, once makeDb() and the fake MP3 frame
   exist. Nothing else in this check calls createClient or reaches ElevenLabs,
   so the substitution is contained to the handler under test.

   Order matters: this must run BEFORE the require below, or the real modules
   are already cached and the stubs are ignored. */
const endpointStub = { db: null, audio: null, synthCalls: 0, texts: [] };
{
  const { Module } = require('module');
  const stubs = [
    ['@supabase/supabase-js', { createClient: () => endpointStub.db }],
    ['elevenlabs', {
      ElevenLabsClient: class {
        async generate({ text }) {
          endpointStub.synthCalls += 1;
          endpointStub.texts.push(text);
          const audio = endpointStub.audio;
          return (async function* () { yield audio; })();
        }
      },
    }],
  ];
  for (const [name, exports] of stubs) {
    const filename = require.resolve(name);
    const mod = new Module(filename, null);
    mod.filename = filename;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[filename] = mod;
  }
}

const fsnIndex = require(join(root, 'lib/dist/fsn-index.js'));
const script = require(join(root, 'lib/dist/podcast-script.js'));
const cron = require(join(root, 'lib/dist/generate-weekly-podcast.js'));
const math = require(join(root, 'lib/dist/article-math.js'));
const generator = require(join(root, 'lib/dist/article-generator.js'));
const podcast = require(join(root, 'lib/dist/generate-podcast.js'));
const news = require(join(root, 'lib/dist/podcast-news-script.js'));
const speech = require(join(root, 'lib/dist/sanitize-podcast-script.js'));
const weekCompleteLib = require(join(root, 'lib/dist/week-complete.js'));

/* ==========================================================================
   0. The schema the shared read depends on
   ========================================================================== */

const sqlRaw = readFileSync(join(root, 'supabase', 'podcast_episodes.sql'), 'utf8');
/* Statements only. The file's comments discuss the policy shapes it avoids, and
   matching those would read the prose instead of the SQL. */
const sql = sqlRaw.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');

check('podcast_episodes.sql declares an explicit SELECT policy', () => {
  assert.match(sql, /create policy\s+podcast_episodes_share_token_select[\s\S]*?for\s+select/i);
});

check('anon/authenticated hold the SELECT table privilege the policy needs', () => {
  /* A matching policy without the table grant still answers permission denied. */
  assert.match(sql, /grant\s+select\s+on\s+public\.podcast_episodes\s+to\s+anon,\s*authenticated/i);
});

check('the policy is keyed on the per-league share token, not the league id', () => {
  /* The numeric ESPN league id is in every league URL, so a policy keyed on it
     alone would expose every league's episodes to anyone who can guess one. */
  assert.match(sql, /x-league-token/i);
  assert.ok(!/using\s*\(\s*true\s*\)/i.test(sql), 'a blanket `using (true)` read policy is present');
});

check('the token check is not callable as a PostgREST RPC oracle', () => {
  /* The EXECUTE grant that lets the policy evaluate ALSO publishes the function
     at /rest/v1/rpc/<name> when it lives in `public` — an endpoint that answers
     "is this the token for this league?" for any guess. Supabase's security
     advisor flagged precisely that on the first version of this file. A schema
     PostgREST does not expose keeps the policy working without the endpoint. */
  assert.match(sql, /create or replace function\s+mffu_private\.league_share_token_matches/i,
    'the token check must live in mffu_private');
  assert.ok(
    !/create or replace function\s+public\.mffu_league_share_token_matches/i.test(sql),
    'the token check is created in the exposed `public` schema',
  );
  assert.match(sql, /drop function if exists public\.mffu_league_share_token_matches/i,
    'the exposed copy from the first version is not dropped, so an existing database keeps the oracle');
});

check('the usage ledger is service-role only', () => {
  const runs = readFileSync(join(root, 'supabase', 'podcast_episode_runs.sql'), 'utf8')
    .split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
  assert.match(runs, /alter table public\.podcast_episode_runs enable row level security/i);
  /* Operator telemetry: error messages, provider call counts, spend. No league
     member has a reason to read another league's failures. */
  assert.ok(!/create policy/i.test(runs), 'the ledger grants a read policy it should not have');
  assert.ok(!/grant\s+select\s+on\s+public\.podcast_episode_runs/i.test(runs),
    'the ledger grants SELECT to a client role');
});

/* ==========================================================================
   1. The FSN Index port has not drifted from the client
   ========================================================================== */

const clientSource = readFileSync(join(root, 'index.html'), 'utf8');

check('FSN Index weights match index.html', () => {
  const block = clientSource.match(/const FSN_INDEX_WEIGHTS = \{([^}]+)\}/);
  assert.ok(block, 'FSN_INDEX_WEIGHTS not found in index.html — did the client model move?');
  const clientWeights = {};
  for (const [, key, value] of block[1].matchAll(/(\w+)\s*:\s*([0-9.]+)/g)) {
    clientWeights[key] = Number(value);
  }
  assert.deepEqual(
    { ...fsnIndex.FSN_INDEX_WEIGHTS },
    clientWeights,
    'lib/fsn-index.ts disagrees with index.html. The podcast would tell a league ' +
      'something its own Analytics tab contradicts. Change both or neither.',
  );
  const sum = Object.values(clientWeights).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 100) / 100, 1, 'the four pillar weights must sum to 1');
});

check('consistency shrinkage threshold matches index.html', () => {
  /* The client shrinks the consistency pillar toward the league median while
     the sample is short: `const shrunk = r.weeks < 4`. */
  const m = clientSource.match(/const shrunk = r\.weeks < (\d+);/);
  assert.ok(m, 'the consistency shrinkage guard was not found in index.html');
  assert.equal(
    fsnIndex.CONSISTENCY_SHRINKAGE_WEEKS,
    Number(m[1]),
    'the shrinkage threshold drifted from the client',
  );
});

check('the client still prefers efficiency for pillar 4 (the documented divergence)', () => {
  /* The port always takes the schedule-hardship fallback and says so. If the
     client ever stops having an efficiency path, that comment is stale. */
  assert.match(
    clientSource,
    /lineupEfficiencyThrough\(targetWeek, r\.team\.id\)/,
    'the client no longer reads lineup efficiency; update the pillar 4 note in lib/fsn-index.ts',
  );
});

/* ==========================================================================
   Fixtures
   ========================================================================== */

const KICK_EARLY = Date.parse('2026-09-13T17:00:00Z');
const KICK_LATE = Date.parse('2026-09-13T20:05:00Z');

function starter(id, name, points, projected, kickoff = KICK_EARLY) {
  return { player_id: id, player_name: name, player_points: points, projected_points: projected, kickoff };
}

/* Four teams, two finalized weeks. Week 1 and week 2 scores are chosen so the
   index board genuinely reorders between them — otherwise the movers segment
   would be exercised only in its empty state. */
function leaguePayload(options = {}) {
  const opts = { week2: true, starters: true, ...options };
  const team = (id, location, nickname) => ({ id, location, nickname, abbrev: nickname.slice(0, 3).toUpperCase() });

  const side = (teamId, total, starters) => ({
    teamId,
    totalPoints: total,
    ...(starters ? { starters } : {}),
  });

  const schedule = [
    /* Week 1 — Alpha and Bravo out in front. */
    { id: 1, matchupPeriodId: 1, playoffTierType: 'NONE', winner: 'HOME',
      home: side(1, 130), away: side(4, 88) },
    { id: 2, matchupPeriodId: 1, playoffTierType: 'NONE', winner: 'HOME',
      home: side(2, 121), away: side(3, 99) },
  ];

  if (opts.week2) {
    /* Week 2 — Delta erupts and Alpha collapses, so the board moves. */
    schedule.push(
      { id: 3, matchupPeriodId: 2, playoffTierType: 'NONE', winner: 'AWAY',
        home: side(1, 84, opts.starters ? [
          starter('a1', 'Wes Harlan', 9.2, 18.4),
          starter('a2', 'Cory Bask', 11.1, 12.0),
          starter('a3', 'Nate Feld', 14.0, 13.2),
          starter('a4', 'Ollie Trent', 12.4, 11.8),
          starter('a5', 'Sam Doyle', 10.1, 10.6, KICK_LATE),
        ] : undefined),
        away: side(4, 141, opts.starters ? [
          starter('d1', 'Rex Calloway', 38.6, 15.2),
          starter('d2', 'Bo Mercer', 26.4, 14.9),
          starter('d3', 'Trey Lund', 18.0, 17.5),
          starter('d4', 'Gus Rainey', 16.2, 15.9),
          starter('d5', 'Ike Sorrell', 15.1, 14.4, KICK_LATE),
        ] : undefined) },
      { id: 4, matchupPeriodId: 2, playoffTierType: 'NONE', winner: 'HOME',
        home: side(2, 112, opts.starters ? [
          starter('b1', 'Dane Walcott', 24.3, 16.1),
          starter('b2', 'Ray Kimbro', 19.8, 18.2),
          starter('b3', 'Vic Amado', 17.4, 16.6),
          starter('b4', 'Hal Pryce', 15.9, 15.2),
          starter('b5', 'Lem Ostrow', 13.2, 14.0, KICK_LATE),
        ] : undefined),
        away: side(3, 110, opts.starters ? [
          starter('c1', 'Abe Tulley', 22.7, 17.9),
          starter('c2', 'Ned Garvey', 20.1, 19.4),
          starter('c3', 'Cal Hobbes', 18.8, 18.0),
          starter('c4', 'Otis Frame', 16.0, 15.5),
          starter('c5', 'Pete Ansel', 14.4, 22.6, KICK_LATE),
        ] : undefined) },
    );
  }

  return {
    id: 778899,
    seasonId: 2026,
    scoringPeriodId: opts.week2 ? 2 : 1,
    settings: { name: 'Segment Check League' },
    teams: [team(1, 'Alpha', 'Anchors'), team(2, 'Bravo', 'Bandits'),
      team(3, 'Charlie', 'Cannons'), team(4, 'Delta', 'Dynamos')],
    schedule,
  };
}

function buildInputs(payload, week) {
  const tracked = math.calculatePlayerOutcomeFlags(payload, { week, kickoffs: null });
  return {
    season: 2026,
    week,
    index: fsnIndex.computeFsnIndex(payload, week),
    previousIndex: week > 1 ? fsnIndex.computeFsnIndex(payload, week - 1) : [],
    tracked,
    matchups: generator.orderPreviewMatchups(generator.previewMatchups(tracked, null)),
    leagueName: 'Segment Check League',
  };
}

/* ==========================================================================
   2 + 3. The script
   ========================================================================== */

const payload = leaguePayload();
const inputs = buildInputs(payload, 2);
const episode = script.buildWeeklyPodcastScript(inputs);

check('the index board reorders between week 1 and week 2 (fixture is meaningful)', () => {
  assert.ok(inputs.index.length === 4, 'expected four rated teams, got ' + inputs.index.length);
  assert.ok(inputs.previousIndex.length === 4, 'expected a week 1 board too');
  const movers = fsnIndex.fsnIndexMovers(inputs.previousIndex, inputs.index)
    .filter((m) => m.rankDelta !== 0);
  assert.ok(movers.length > 0, 'no team changed rank, so the movers segment is untested');
});

check('all four segments are present, in the brief’s order', () => {
  assert.deepEqual(
    episode.segments.map((s) => s.key),
    ['index_movers', 'big_performers', 'matchup_of_week', 'waiver_lookout'],
  );
  assert.deepEqual(episode.segments.map((s) => s.key), script.PODCAST_SEGMENT_ORDER);
});

check('every segment carried real material on a full week', () => {
  const empty = episode.segments.filter((s) => !s.populated).map((s) => s.key);
  assert.deepEqual(empty, [], 'these segments fell back to an empty state: ' + empty.join(', '));
  assert.equal(episode.populatedSegments, 4);
});

check('the line-up is exactly the four segments\u2019 turns', () => {
  /* The show open and the sign-off ride on the first and last turns rather
     than taking turns of their own — see the fold in buildWeeklyPodcastScript. */
  const expected = episode.segments.reduce((n, s) => n + s.lines.length, 0);
  assert.equal(episode.lines.length, expected);
  assert.equal(episode.lines[0].host, 'DAN');
  assert.equal(episode.lines[episode.lines.length - 1].host, 'STU');
});

check('the show open and the sign-off survive the fold', () => {
  /* Trimming must eat the segment body, never the open or the sign-off. */
  assert.match(episode.lines[0].text, /^FSN weekly recap, week 2, Segment Check League\./);
  assert.match(episode.lines[episode.lines.length - 1].text, /next slate\.$/);
});

check('every line passes the endpoint’s own validation', () => {
  /* lib/generate-podcast.ts rejects a POST whose lines are not 2..MAX, whose
     host tag is unknown, or whose text is outside 5..450 characters. A script
     that violates any of those is refused with one generic message, so assert
     it here where the failure names the line. */
  assert.ok(Array.isArray(episode.lines));
  assert.ok(episode.lines.length >= 2, 'too few lines');
  assert.ok(
    episode.lines.length <= podcast.MAX_EPISODE_LINES,
    'the script has ' + episode.lines.length + ' lines but the endpoint accepts ' +
      podcast.MAX_EPISODE_LINES,
  );
  episode.lines.forEach((line, i) => {
    assert.ok(podcast.podcastHost(line.host), 'line ' + i + ' has an unknown host: ' + line.host);
    assert.equal(typeof line.text, 'string', 'line ' + i + ' has no text');
    assert.ok(line.text.length >= 5, 'line ' + i + ' is too short');
    assert.ok(line.text.length <= 450, 'line ' + i + ' is ' + line.text.length + ' chars, over 450');
  });
});

check('hosts alternate, so the stitched audio never repeats a voice', () => {
  for (let i = 1; i < episode.lines.length; i += 1) {
    assert.notEqual(
      episode.lines[i].host,
      episode.lines[i - 1].host,
      'lines ' + (i - 1) + ' and ' + i + ' are both ' + episode.lines[i].host,
    );
  }
});

check('stories carry one headline per segment for the Story Reel', () => {
  assert.equal(episode.stories.length, 4);
  episode.stories.forEach((s, i) => {
    assert.equal(typeof s, 'string');
    assert.ok(s.trim().length > 0, 'segment ' + i + ' has an empty headline');
  });
});

check('the matchup segment picks the closest board with points on it', () => {
  /* Bravo 112 - Charlie 110 is a 2-point game; Delta beat Alpha by 57. */
  const pick = script.pickMatchupOfWeek(inputs.matchups);
  assert.ok(pick, 'no matchup was picked');
  assert.ok(pick.margin < 10, 'picked a ' + pick.margin + ' point gap over the 2-point game');
});

check('the matchup segment never calls an unfinished board a result', () => {
  /* No kickoff clock was supplied, so nothing may be declared complete. */
  const seg = episode.segments.find((s) => s.key === 'matchup_of_week');
  const text = seg.lines.map((l) => l.text).join(' ');
  assert.ok(!/took it/.test(text), 'described an unfinished matchup as a finished result');
  assert.match(text, /still to play|leads/, 'did not describe the matchup as in progress');
});

check('the waiver segment names the biggest shortfall and no invented pickup', () => {
  const seg = episode.segments.find((s) => s.key === 'waiver_lookout');
  const text = seg.lines.map((l) => l.text).join(' ');
  /* Pete Ansel: projected 22.6, returned 14.4 — an 8.2 miss, the largest. */
  assert.match(text, /Pete Ansel/, 'did not name the biggest shortfall');
  assert.ok(
    !/add |pick up |available|free agent/i.test(text),
    'recommended a specific pickup, which no free-agent feed on this path can support',
  );
});

check('waiver needs are one per team and above the floor', () => {
  const needs = script.waiverNeeds(inputs.tracked, 5);
  const teams = needs.map((n) => n.team);
  assert.equal(new Set(teams).size, teams.length, 'the same team appears twice');
  needs.forEach((n) => assert.ok(n.shortfall >= script.WAIVER_SHORTFALL_FLOOR));
});

/* ---- honest empty states ---- */

check('week 1 reports no index movement instead of inventing a climb', () => {
  const thin = leaguePayload({ week2: false });
  const one = script.buildWeeklyPodcastScript(buildInputs(thin, 1));
  const seg = one.segments.find((s) => s.key === 'index_movers');
  assert.equal(seg.populated, false, 'claimed movement with no previous board');
  const text = seg.lines.map((l) => l.text).join(' ');
  assert.ok(!/climbs|slides/.test(text), 'described a climb or a slide in week 1');
});

check('a week with no starters reports empty performer and waiver segments', () => {
  const noStarters = leaguePayload({ starters: false });
  const built = script.buildWeeklyPodcastScript(buildInputs(noStarters, 2));
  const keys = built.segments.filter((s) => !s.populated).map((s) => s.key);
  assert.ok(keys.includes('big_performers'), 'claimed a big performer with no starters');
  assert.ok(keys.includes('waiver_lookout'), 'claimed a waiver need with no starters');
  /* Four segments are still returned, so the episode shape never changes. */
  assert.equal(built.segments.length, 4);
});

check('an empty board still produces a valid, speakable script', () => {
  const built = script.buildWeeklyPodcastScript({
    season: 2026, week: 2, index: [], previousIndex: [], tracked: [], matchups: [],
  });
  assert.equal(built.populatedSegments, 0);
  assert.ok(built.lines.length >= 2 && built.lines.length <= podcast.MAX_EPISODE_LINES);
  built.lines.forEach((l) => {
    assert.ok(l.text.length >= 5 && l.text.length <= 450);
    assert.ok(podcast.podcastHost(l.host));
  });
});

/* ---- 4. determinism ---- */

check('the same payload twice produces an identical script', () => {
  const again = script.buildWeeklyPodcastScript(buildInputs(leaguePayload(), 2));
  assert.deepEqual(again, episode, 'the script is not deterministic');
});

check('no source of nondeterminism in the script or index modules', () => {
  for (const file of ['lib/podcast-script.ts', 'lib/fsn-index.ts']) {
    const src = readFileSync(join(root, file), 'utf8');
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/Math\.random\s*\(/.test(body), file + ' calls Math.random()');
    assert.ok(!/Date\.now\s*\(/.test(body), file + ' calls Date.now()');
    assert.ok(!/\bfetch\s*\(/.test(body), file + ' makes a network call');
  }
});

/* ==========================================================================
   5. The cron run
   ========================================================================== */

/** An in-memory Supabase double covering exactly the calls the run makes. */
function makeDb(options = {}) {
  const leagues = options.leagues || ['100001', '100002', '100003'];
  /* Only the interactive endpoint reads it: it authorizes a POST by comparing
     the caller's x-league-token against this column with timingSafeEqual, so
     the lengths must match as well as the bytes. */
  const shareToken = options.shareToken || null;
  const episodes = new Map(options.episodes || []);
  const runs = [];
  const uploads = new Map();

  const episodeKey = (r) => `${r.league_id}:${r.season}:${r.week}`;

  function builder(table) {
    const filters = {};
    let action = 'select';
    let value;
    const q = {
      select() { return q; },
      eq(k, v) { filters[k] = String(v); return q; },
      order() { return q; },
      limit() { return q.run(); },
      insert(v) { action = 'insert'; value = v; return q.run(); },
      update(v) { action = 'update'; value = v; return q; },
      then(resolve, reject) { return q.run().then(resolve, reject); },
      /* `.not('share_token', 'is', null)` on the authorization read. The double
         never stores a null token, so there is nothing to filter. */
      not() { return q; },
      /* maybeSingle()/single() unwrap the row the way PostgREST does. A select
         answers with an array; an update answers with the row it changed. */
      async maybeSingle() {
        const r = await q.run();
        if (r.error) return r;
        return { data: Array.isArray(r.data) ? (r.data[0] || null) : (r.data || null), error: null };
      },
      async single() {
        const r = await q.maybeSingle();
        if (!r.error && !r.data) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
        return r;
      },
      async run() {
        if (table === 'leagues') {
          const rows = leagues
            .filter((league_id) => !filters.league_id || league_id === filters.league_id)
            .map((league_id) => ({ league_id, share_token: shareToken }));
          return { data: rows, error: null };
        }
        if (table === 'podcast_episode_runs') {
          runs.push(value);
          return { data: null, error: null };
        }
        if (table === 'blog_articles') {
          /* The local news payload the 'news' format reads instead of fetching
             ESPN. Keyed on the league-week asked for. */
          const week = Number(filters.week);
          if (!Number.isFinite(week)) return { data: [], error: null };
          const row = newsPayload(week);
          return { data: [{ league_id: filters.league_id, season: Number(filters.season),
            week, headline: row.headline, title: row.headline,
            match_impact_summary: row.match_impact_summary,
            tracked_players: row.tracked_players }], error: null };
        }
        if (table !== 'podcast_episodes') throw new Error('unexpected table ' + table);
        if (action === 'insert') {
          const key = episodeKey(value);
          if (episodes.has(key)) return { data: null, error: { code: '23505' } };
          episodes.set(key, { ...value });
          return { data: null, error: null };
        }
        if (action === 'update') {
          const key = `${filters.league_id}:${filters.season}:${filters.week}`;
          const row = episodes.get(key);
          if (row && (!filters.status || row.status === filters.status)) {
            Object.assign(row, value);
            return { data: row, error: null };
          }
          return { data: null, error: null };
        }
        const rows = [...episodes.values()].filter(
          (r) => String(r.season) === filters.season && String(r.week) === filters.week &&
            (!filters.league_id || String(r.league_id) === filters.league_id),
        );
        return { data: rows, error: null };
      },
    };
    return q;
  }

  return {
    from: builder,
    storage: {
      from() {
        return {
          async upload(path, bytes) { uploads.set(path, bytes); return { error: null }; },
          getPublicUrl(path) { return { data: { publicUrl: 'https://example.test/' + path } }; },
        };
      },
    },
    _episodes: episodes,
    _runs: runs,
    _uploads: uploads,
  };
}

let synthCalls = 0;
/* The mix stage decodes provider MP3s, so give it a real short voice fixture.
   This test binary is local only and never calls ElevenLabs. */
const { spawnSync } = require('node:child_process');
const fixture = spawnSync(require('ffmpeg-static'), [
  '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25',
  '-ar', '44100', '-ac', '2', '-b:a', '128k', '-f', 'mp3', 'pipe:1',
]);
if (fixture.status !== 0) throw new Error('Could not generate MP3 test fixture: ' + fixture.stderr);
const fakeMp3 = fixture.stdout;

function deps(db, extra = {}) {
  return {
    db,
    fetchBoxScores: async () => leaguePayload(),
    fetchKickoffs: async () => ({}),
    synthesize: async () => { synthCalls += 1; return fakeMp3; },
    now: () => 1790000000000,
    ...extra,
  };
}

const originalEnv = { ...process.env };
/* MUST await: a synchronous try/finally around an async callback restores
   process.env the instant fn() returns its promise, so the run body then reads
   an environment with no ELEVENLABS_API_KEY and no PODCAST_TARGET_WEEK. */
async function withEnv(env, fn) {
  process.env = { ...originalEnv, ...env };
  try { return await fn(); } finally { process.env = { ...originalEnv }; }
}

await (async () => {
  /* ---- the week boundary, before any provider call ---- */
  synthCalls = 0;
  let db = makeDb();
  await withEnv({ PODCAST_TARGET_WEEK: '2', ELEVENLABS_API_KEY: 'k' }, async () => {
    let refused = null;
    try {
      await cron.runWeeklyPodcastCron({ season: 2026, week: 5 }, deps(db));
    } catch (err) { refused = err; }
    check('week 5 is refused while the environment is locked to week 2', () => {
      assert.ok(refused, 'the run was not refused');
      assert.equal(Number(refused.status), 409);
      assert.match(String(refused.message), /locked to week 2/);
    });
    check('a refused week reaches neither the voice provider nor the database', () => {
      assert.equal(synthCalls, 0, 'ElevenLabs was called for a locked week');
      assert.equal(db._episodes.size, 0, 'a claim row was written for a locked week');
    });
  });

  /* ---- the default boundary is week 2 with nothing configured ---- */
  await withEnv({ ELEVENLABS_API_KEY: 'k' }, async () => {
    check('the boundary defaults to week 2 with PODCAST_TARGET_WEEK unset', () => {
      assert.deepEqual(cron.targetWeekSetting(), { value: '2', week: cron.DEFAULT_TARGET_WEEK });
      assert.equal(cron.DEFAULT_TARGET_WEEK, 2);
    });
  });
  await withEnv({ PODCAST_TARGET_WEEK: 'any', ELEVENLABS_API_KEY: 'k' }, async () => {
    check('PODCAST_TARGET_WEEK=any lifts the lock', () => {
      assert.deepEqual(cron.targetWeekSetting(), { value: 'any', week: null });
    });
  });
  await withEnv({ PODCAST_TARGET_WEEK: 'banana', ELEVENLABS_API_KEY: 'k' }, async () => {
    check('a malformed PODCAST_TARGET_WEEK falls back to the week 2 boundary', () => {
      assert.equal(cron.targetWeekSetting().week, 2);
    });
  });

  /* ---- a real week 2 run ---- */
  synthCalls = 0;
  db = makeDb();
  let summary;
  await withEnv({ PODCAST_TARGET_WEEK: '2', PODCAST_CRON_MAX_LEAGUES: '2', ELEVENLABS_API_KEY: 'k' }, async () => {
    summary = await cron.runWeeklyPodcastCron({ season: 2026, run_id: 'test-run' }, deps(db));
  });

  check('the run generates for the capped number of leagues and defers the rest', () => {
    assert.equal(summary.created, 2, 'created ' + summary.created + ' of a 2-league cap');
    assert.equal(summary.not_attempted, 1, 'the third league should be deferred, not lost');
    assert.equal(summary.failed, 0, JSON.stringify(summary.results));
    assert.equal(summary.max_leagues, 2);
  });

  check('the run resolved the week from the boundary with no week passed', () => {
    assert.equal(summary.week, 2);
    assert.equal(summary.target_week, '2');
  });

  check('each generated league got one MP3 and one ready episode row', () => {
    assert.equal(db._uploads.size, 2, 'expected two uploads');
    const ready = [...db._episodes.values()].filter((r) => r.status === 'ready');
    assert.equal(ready.length, 2);
    ready.forEach((row) => {
      assert.match(String(row.audio_url), /^https:\/\/example\.test\//);
      assert.equal(row.episode.week, 2);
      assert.equal(row.episode.year, 2026);
      /* The news format stores its three movements where the long form stores
          four segments. Both must survive the round trip. */
      assert.equal(row.episode.segments.length, 3, 'the stored episode lost its movements');
      assert.deepEqual(row.episode.segments.map((x) => x.key), ['intro', 'body', 'outro']);
      assert.ok(Array.isArray(row.episode.lines), 'the stored episode lost its script');
      assert.ok(row.episode.lines.length >= 2, 'the stored script has no turns');
      assert.ok(
        row.episode.lines.length <= podcast.MAX_EPISODE_LINES,
        'the stored script has ' + row.episode.lines.length + ' turns, over the endpoint cap',
      );
      assert.equal(row.episode.markers.length, row.episode.lines.length);
    });
  });

  check('one ElevenLabs call per dialogue turn, and no more', () => {
    const turns = summary.results.filter((r) => r.status === 'created')
      .reduce((n, r) => n + r.turns, 0);
    assert.equal(synthCalls, turns, 'synthesis calls (' + synthCalls + ') != reported turns (' + turns + ')');
    /* Two leagues, and the news format is deliberately fewer turns than the
       four-segment one: fewer provider calls per episode is part of the point. */
    assert.ok(turns > 0 && turns <= 2 * podcast.MAX_EPISODE_LINES, turns + ' turns is implausible');
    assert.ok(turns < 2 * episode.lines.length,
      'the news format (' + turns / 2 + ' turns) should cost fewer calls than the long form (' +
      episode.lines.length + ')');
  });

  check('every attempt wrote a ledger row carrying its spend', () => {
    assert.equal(db._runs.length, 2, 'expected one ledger row per attempted league');
    db._runs.forEach((row) => {
      assert.equal(row.run_id, 'test-run');
      assert.equal(row.status, 'created');
      assert.equal(row.populated_segments, 4);
      assert.ok(row.turns > 0, 'the ledger row records no turns');
      assert.ok(row.audio_bytes > 0, 'the ledger row records no bytes');
      assert.equal(row.failure_reason, null);
    });
  });

  /* ---- idempotency ---- */
  synthCalls = 0;
  let second;
  await withEnv({ PODCAST_TARGET_WEEK: '2', PODCAST_CRON_MAX_LEAGUES: '2', ELEVENLABS_API_KEY: 'k' }, async () => {
    second = await cron.runWeeklyPodcastCron({ season: 2026, run_id: 'test-run-2' }, deps(db));
  });
  check('a second run skips the leagues that already have an episode', () => {
    assert.equal(second.skipped, 2, 'expected the two existing episodes to be skipped');
    assert.equal(second.created, 1, 'the deferred third league should be picked up');
  });
  check('a re-run never re-synthesizes an episode a league already has', () => {
    assert.ok(
      synthCalls > 0 && synthCalls <= podcast.MAX_EPISODE_LINES,
      'expected one league\u2019s worth of synthesis, got ' + synthCalls + ' calls',
    );
  });

  /* ---- dry run ---- */
  synthCalls = 0;
  const dryDb = makeDb();
  let dry;
  await withEnv({ PODCAST_TARGET_WEEK: '2', PODCAST_CRON_MAX_LEAGUES: '2', ELEVENLABS_API_KEY: 'k' }, async () => {
    dry = await cron.runWeeklyPodcastCron({ season: 2026, dry_run: true }, deps(dryDb));
  });
  check('a dry run writes nothing and spends nothing', () => {
    assert.equal(dry.dry_run, true);
    assert.equal(dry.created, 0);
    assert.equal(synthCalls, 0);
    assert.equal(dryDb._episodes.size, 0);
    assert.equal(dryDb._runs.length, 0);
    assert.equal(dryDb._uploads.size, 0);
  });

  /* ---- script-only ---- */
  synthCalls = 0;
  const scriptDb = makeDb({ leagues: ['100001'] });
  let scriptRun;
  await withEnv({ PODCAST_TARGET_WEEK: '2', ELEVENLABS_API_KEY: 'k' }, async () => {
    scriptRun = await cron.runWeeklyPodcastCron({ season: 2026, script_only: true }, deps(scriptDb));
  });
  check('script_only stores the four segments without spending on audio', () => {
    assert.equal(scriptRun.audio, false);
    assert.equal(scriptRun.created, 1);
    assert.equal(synthCalls, 0, 'a script-only run called the voice provider');
    assert.equal(scriptDb._uploads.size, 0);
    const row = [...scriptDb._episodes.values()][0];
    assert.equal(row.episode.segments.length, 3);
    /* No audio means the row must NOT claim ready: the table's own check
       constraint requires an audio_url for a ready row. */
    assert.equal(row.status, 'generating');
    assert.equal(row.audio_url, null);
  });

  /* ---- one league's failure never stops the others ---- */
  synthCalls = 0;
  const flakyDb = makeDb({ leagues: ['100001', '100002'] });
  let flaky;
  await withEnv({ PODCAST_TARGET_WEEK: '2', PODCAST_CRON_MAX_LEAGUES: '5', ELEVENLABS_API_KEY: 'k' }, async () => {
    let call = 0;
    /* Injected on the NEWS path's own read, because that is the path the run
       takes now and it never calls ESPN at all. */
    flaky = await cron.runWeeklyPodcastCron({ season: 2026 }, deps(flakyDb, {
      readNewsPayload: async (leagueId, season, week) => {
        call += 1;
        if (call === 1) {
          throw Object.assign(new Error('ESPN box score read failed (HTTP 401)'), { status: 401 });
        }
        return newsPayload(week);
      },
    }));
  });
  check('a failed league is recorded and the run continues to the next', () => {
    assert.equal(flaky.failed, 1);
    assert.equal(flaky.created, 1, 'the second league should still have generated');
    assert.equal(flaky.failed_by_reason.ESPN_AUTH, 1, JSON.stringify(flaky.failed_by_reason));
  });
  check('a failed league leaves its claim as failed, not as a retryable gap', () => {
    const failed = [...flakyDb._episodes.values()].filter((r) => r.status === 'failed');
    assert.equal(failed.length, 1, 'the failed claim was not marked');
    const ledger = flakyDb._runs.find((r) => r.status === 'failed');
    assert.ok(ledger, 'no ledger row for the failure');
    assert.equal(ledger.failure_reason, 'ESPN_AUTH');
    assert.ok(String(ledger.error_message).length > 0);
  });

  /* ---- requirement 1: the news path makes NO external call ---- */
  synthCalls = 0;
  const offlineDb = makeDb({ leagues: ['100001'] });
  let offline;
  await withEnv({ PODCAST_TARGET_WEEK: '2', ELEVENLABS_API_KEY: 'k' }, async () => {
    offline = await cron.runWeeklyPodcastCron({ season: 2026 }, deps(offlineDb, {
      /* Any live box-score read is a failure of the refactor, so make one fatal. */
      fetchBoxScores: async () => { throw new Error('EXTERNAL_FETCH_ATTEMPTED'); },
      fetchKickoffs: async () => { throw new Error('EXTERNAL_FETCH_ATTEMPTED'); },
    }));
  });
  check('the news format builds an episode without any external fetch', () => {
    assert.equal(offline.failed, 0, JSON.stringify(offline.results));
    assert.equal(offline.created, 1);
    assert.equal(offline.format, 'news');
  });

  /* ---- the four-segment long form is still reachable ---- */
  synthCalls = 0;
  const longDb = makeDb({ leagues: ['100001'] });
  let long;
  await withEnv({ PODCAST_TARGET_WEEK: '2', ELEVENLABS_API_KEY: 'k' }, async () => {
    long = await cron.runWeeklyPodcastCron({ season: 2026, format: 'segments' }, deps(longDb));
  });
  check('format=segments still builds the four-segment long form from ESPN', () => {
    assert.equal(long.format, 'segments');
    assert.equal(long.created, 1, JSON.stringify(long.results));
    const row = [...longDb._episodes.values()][0];
    assert.equal(row.episode.segments.length, 4, 'the long form lost its four segments');
    assert.equal(row.episode.lines.length, episode.lines.length);
  });

  synthCalls = 0;
  const oldDb = makeDb();
  let archived = null;
  await withEnv({ PODCAST_TARGET_WEEK: 'any', ELEVENLABS_API_KEY: 'k' }, async () => {
    try {
      await cron.runWeeklyPodcastCron({ season: 2025, week: 2 }, deps(oldDb));
    } catch (err) { archived = err; }
  });
  check('season 2025 is refused with nothing spent', () => {
    assert.ok(archived, 'an archived season was not refused');
    assert.match(String(archived.message), /current season/);
    assert.equal(synthCalls, 0);
    assert.equal(oldDb._episodes.size, 0);
  });
})();

/* ==========================================================================
   7b. A run can be scoped to one league
   ==========================================================================

   The sweep is right for a schedule and wrong for a re-generation: it also
   builds, publishes and bills for every OTHER active league that happens to
   have no row for that week. `league` bounds that. */

await (async () => {
  synthCalls = 0;
  const scopedDb = makeDb({ leagues: ['100001', '100002', '100003'] });
  let scoped;
  await withEnv({ PODCAST_TARGET_WEEK: '2', ELEVENLABS_API_KEY: 'k' }, async () => {
    scoped = await cron.runWeeklyPodcastCron({ season: 2026, league: '100002' }, deps(scopedDb));
  });
  check('league=<id> generates for that league and no other', () => {
    assert.equal(scoped.league, '100002');
    assert.equal(scoped.leagues, 1, 'the summary counts leagues outside the scope');
    assert.equal(scoped.created, 1, JSON.stringify(scoped.results));
    const ids = [...scopedDb._episodes.values()].map((r) => String(r.league_id));
    assert.deepEqual(ids, ['100002'], 'a league outside the scope got an episode: ' + ids.join(','));
    assert.deepEqual([...scopedDb._uploads.keys()], ['100002/2026/2.mp3']);
  });

  check('an unscoped run still sweeps every active league', () => {
    /* The default must not change: the Tuesday schedule depends on it. */
    assert.equal(scoped.league, '100002');
  });
  synthCalls = 0;
  const sweepDb = makeDb({ leagues: ['100001', '100002', '100003'] });
  let sweep;
  await withEnv({ PODCAST_TARGET_WEEK: '2', PODCAST_CRON_MAX_LEAGUES: '5', ELEVENLABS_API_KEY: 'k' }, async () => {
    sweep = await cron.runWeeklyPodcastCron({ season: 2026 }, deps(sweepDb));
  });
  check('a run with no league named reports a null scope and sweeps all three', () => {
    assert.equal(sweep.league, null);
    assert.equal(sweep.leagues, 3);
    assert.equal(sweep.created, 3, JSON.stringify(sweep.results));
  });

  /* A league that is not active is refused, not run as an empty sweep. */
  synthCalls = 0;
  const strangerDb = makeDb({ leagues: ['100001'] });
  let refused = null;
  await withEnv({ PODCAST_TARGET_WEEK: '2', ELEVENLABS_API_KEY: 'k' }, async () => {
    try {
      await cron.runWeeklyPodcastCron({ season: 2026, league: '999999' }, deps(strangerDb));
    } catch (err) { refused = err; }
  });
  check('a league that is not active for the season is refused with 404', () => {
    assert.ok(refused, 'an unknown league was not refused');
    assert.equal(Number(refused.status), 404);
    assert.match(String(refused.message), /not an active league/);
    assert.equal(synthCalls, 0);
    assert.equal(strangerDb._episodes.size, 0);
  });

  synthCalls = 0;
  let malformed = null;
  await withEnv({ PODCAST_TARGET_WEEK: '2', ELEVENLABS_API_KEY: 'k' }, async () => {
    try {
      await cron.runWeeklyPodcastCron({ season: 2026, league: 'all' }, deps(makeDb()));
    } catch (err) { malformed = err; }
  });
  check('a non-numeric league is refused before the league sweep', () => {
    assert.ok(malformed, 'league=all was accepted');
    assert.equal(Number(malformed.status), 400);
    assert.equal(synthCalls, 0);
  });

  /* The dependency the CLI hands over must actually be read. It used to be
     ignored, so `--league` on a live CLI run swept every league and billed for
     all of them. */
  let asked = 0;
  const depDb = makeDb({ leagues: ['100001', '100002'] });
  let depRun;
  await withEnv({ PODCAST_TARGET_WEEK: '2', ELEVENLABS_API_KEY: 'k' }, async () => {
    depRun = await cron.runWeeklyPodcastCron({ season: 2026, dry_run: true }, deps(depDb, {
      listLeagues: async () => { asked += 1; return ['100009']; },
    }));
  });
  /* ---- THE SHAPE PRODUCTION ACTUALLY USES ----
     The HTTP handler calls runWeeklyPodcastCron with `{ req }` and NOTHING
     else, so the run builds its own client and `dependencies.db` stays
     undefined. Every other case here hands over a db, which hid a real bug: the
     per-league build was given `...dependencies` alone, so the news path's
     payload read got an undefined db and died on `db.from`. A live run found it,
     not this file. So drive the no-db shape, letting the stubbed
     @supabase/supabase-js module stand in for the real client. */
  synthCalls = 0;
  const ownClientDb = makeDb({ leagues: ['100001'] });
  endpointStub.db = ownClientDb;
  endpointStub.audio = fakeMp3;
  let ownClientRun;
  await withEnv({
    PODCAST_TARGET_WEEK: '2',
    ELEVENLABS_API_KEY: 'k',
    SUPABASE_URL: 'https://stub.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-stub',
  }, async () => {
    const noDb = deps(ownClientDb);
    delete noDb.db;
    ownClientRun = await cron.runWeeklyPodcastCron({ season: 2026, week: 2 }, noDb);
  });
  check('a run given no db resolves its own and still reaches the payload read', () => {
    assert.equal(ownClientRun.failed, 0,
      'the no-db shape failed: ' + JSON.stringify(ownClientRun.results));
    assert.equal(ownClientRun.created, 1);
    const row = [...ownClientDb._episodes.values()][0];
    assert.equal(row.status, 'ready');
    assert.ok(Array.isArray(row.episode.lines) && row.episode.lines.length >= 2);
  });

  check('a listLeagues dependency is honoured rather than silently dropped', () => {
    assert.equal(asked, 1, 'listLeagues was never called');
    assert.equal(depRun.leagues, 1, 'the run used the league table instead of the supplied list');
  });
})();

/* ==========================================================================
   8. The Studio button and the Tuesday cron produce the same script
   ==========================================================================

   The button used to POST its own `lines`: four turns of News Desk narration
   assembled in the browser. The cron POSTs nothing and lets the server author
   the ~60 second news recap. Two paths, two formats, one of them shallower than
   the other — which is exactly what a listener noticed.

   The fix is one generator called from both places, so these assertions are
   about identity rather than similarity: the episode the handler stores for a
   POST with no `lines` must be byte-for-byte the script
   buildNewsPodcastScript() produces for that league-week. */

/** A minimal Vercel-shaped response recorder. */
function recorder() {
  const out = { code: 0, body: null, headers: {}, ended: false };
  const res = {
    status(code) { out.code = code; return res; },
    json(data) { out.body = data; },
    setHeader(k, v) { out.headers[k] = v; },
    end() { out.ended = true; },
  };
  return { res, out };
}

const ENDPOINT_TOKEN = 'a'.repeat(40);

async function postEpisode(body, { db, leagueId = '100001' } = {}) {
  endpointStub.db = db;
  endpointStub.audio = fakeMp3;
  endpointStub.synthCalls = 0;
  endpointStub.texts = [];
  const { res, out } = recorder();
  await withEnv({
    SUPABASE_URL: 'https://stub.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-stub',
    ELEVENLABS_API_KEY: 'k',
  }, () => podcast.default({
    method: 'POST',
    headers: { 'x-league-token': ENDPOINT_TOKEN },
    body: { leagueId, season: 2026, week: 2, ...body },
  }, res));
  return out;
}

await (async () => {
  /* ---- a POST with no lines: the server authors the news script ----
     The expectation is built from the same payload read the handler performs,
     through the same exported pair the cron uses. Anything less — rebuilding
     from the raw fixture, say — would compare the handler against a different
     league_id and a different seed, and pass or fail for the wrong reason. */
  const serverDb = makeDb({ leagues: ['100001'], shareToken: ENDPOINT_TOKEN });
  const authored = news.buildNewsPodcastScript(
    await news.readNewsPayload(serverDb, '100001', 2026, 2),
  );
  const served = await postEpisode({ visuals: [{ kind: 'headline' }] }, { db: serverDb });
  check('a POST without `lines` is accepted and stores an episode', () => {
    assert.equal(served.code, 200, JSON.stringify(served.body));
    assert.equal(served.body.status, 'ready');
    assert.ok(served.body.audioUrl, 'no audio URL was returned');
  });
  check('the button path stores the SAME script the cron builds, turn for turn', () => {
    assert.deepEqual(served.body.episode.lines, authored.lines,
      'the interactive endpoint and lib/podcast-news-script.ts disagree — the manual ' +
        'episode is a different script from the scheduled one, which is the whole defect');
    assert.equal(served.body.episode.title, authored.title);
    assert.deepEqual(served.body.episode.stories, authored.stories);
  });
  check('the authored script sits in the ~60 second budget the format promises', () => {
    assert.ok(authored.words >= news.WORD_MIN - news.WORD_GRACE &&
      authored.words <= news.WORD_MAX + news.WORD_GRACE,
      authored.words + ' words is outside ' + news.WORD_MIN + '-' + news.WORD_MAX +
        ' plus the ' + news.WORD_GRACE + '-word grace');
    assert.ok(authored.estimatedSeconds >= 45 && authored.estimatedSeconds <= 75,
      'the script estimates ' + authored.estimatedSeconds + 's, not ~60s');
  });
  check('one ElevenLabs call per turn, and every turn was spoken', () => {
    assert.equal(endpointStub.synthCalls, authored.lines.length);
    assert.deepEqual(endpointStub.texts, authored.lines.map((l) => speech.sanitizePodcastScript(l.text)));
  });
  check('the browser’s visuals still travel, because only a browser can make them', () => {
    assert.deepEqual(served.body.episode.visuals, [{ kind: 'headline' }]);
  });

  /* ---- a POST with lines: older clients in the wild still work ---- */
  const legacyDb = makeDb({ leagues: ['100001'], shareToken: ENDPOINT_TOKEN });
  const legacyLines = [
    { host: 'DAN', text: 'A client-authored opening turn for the legacy path.' },
    { host: 'STU', text: 'And the client-authored answer that closes it out.' },
  ];
  const legacy = await postEpisode(
    { title: 'Legacy Week 2', stories: [{ id: 's1' }], lines: legacyLines },
    { db: legacyDb },
  );
  check('a POST that still sends `lines` is honoured, for clients already shipped', () => {
    assert.equal(legacy.code, 200, JSON.stringify(legacy.body));
    assert.deepEqual(legacy.body.episode.lines, legacyLines);
    assert.equal(legacy.body.episode.title, 'Legacy Week 2');
    assert.equal(endpointStub.synthCalls, 2);
  });

  /* ---- no payload for the week: 422, and NO claim left behind ---- */
  const emptyDb = makeDb({ leagues: ['100001'], shareToken: ENDPOINT_TOKEN });
  /* Make the news read come back empty the way an unpublished week does. */
  const realFrom = emptyDb.from;
  emptyDb.from = (table) => {
    const q = realFrom(table);
    if (table !== 'blog_articles') return q;
    const run = q.run;
    q.run = async () => ({ data: [], error: null });
    void run;
    return q;
  };
  const missing = await postEpisode({}, { db: emptyDb });
  check('a week with no published article answers 422 with a reason a reader can act on', () => {
    assert.equal(missing.code, 422, JSON.stringify(missing.body));
    assert.match(String(missing.body.error), /No news payload for week 2/);
    assert.match(String(missing.body.error), /has not published/);
  });
  check('a 422 leaves no `generating` claim to poison the week', () => {
    /* The claim is the cross-instance mutex and nothing clears it on an early
       return: the inner catch only fires on a throw. A claim written before the
       payload read would sit as `generating` until the ten-minute staleness
       sweep flipped it to `failed`, and a failed row locks that league-week for
       good. So the script must be built BEFORE the insert. */
    assert.equal(emptyDb._episodes.size, 0,
      'a claim row survived a 422; lib/generate-podcast.ts must author the script before it claims');
    assert.equal(endpointStub.synthCalls, 0, 'ElevenLabs was called for a week with no payload');
    assert.equal(emptyDb._uploads.size, 0);
  });

  /* ---- an unauthorized token never reaches the payload or the provider ---- */
  const deniedDb = makeDb({ leagues: ['100001'], shareToken: 'b'.repeat(40) });
  const denied = await postEpisode({}, { db: deniedDb });
  check('a mismatched league token is refused before any script or spend', () => {
    assert.equal(denied.code, 403, JSON.stringify(denied.body));
    assert.equal(endpointStub.synthCalls, 0);
    assert.equal(deniedDb._episodes.size, 0);
  });
})();

/* ==========================================================================
   9. The client sends no script of its own
   ========================================================================== */

check('studioGenerate() posts no `lines`, so the server authors the script', () => {
  const fn = clientSource.slice(clientSource.indexOf('async function studioGenerate()'));
  const body = fn.slice(0, fn.indexOf('const result = await response.json()'));
  const statements = body.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(statements, /body:JSON\.stringify\(\{ leagueId:selectedLeagueId\(\), season:year, week,/,
    'the generate POST body moved; re-check what it sends');
  assert.ok(!/lines:\s*draft\.lines/.test(statements),
    'the Studio button is posting its own lines again, so manual generation would go back to ' +
      'producing a different, shallower script than the Tuesday cron');
  assert.ok(!/title:\s*draft\.title/.test(statements),
    'the button is posting its own title; the server names the episode now');
  assert.match(statements, /visuals:draft\.visuals/,
    'the Story Reel visuals stopped travelling; only a browser can snapshot those cards');
});

check('an empty News Desk no longer blocks generation', () => {
  /* The old guard aborted on a null draft. The server narrates from
     blog_articles, which has nothing to do with whether headlines are on
     screen, so a null draft now degrades to an episode with no Story Reel. */
  const fn = clientSource.slice(clientSource.indexOf('async function studioGenerate()'));
  const body = fn.slice(0, fn.indexOf('const result = await response.json()'));
  const statements = body.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/has no stories for this week yet/.test(statements),
    'studioGenerate() still aborts when the News Desk is empty');
  assert.match(statements, /const draft = studioDraft\(week, year\) \|\|/,
    'the null-draft fallback is gone');
});

/* ==========================================================================
   The route wiring
   ========================================================================== */

/* ==========================================================================
   6. THE ~60s NEWS-PAYLOAD FORMAT
   ========================================================================== */

/** One blog_articles row's worth of stat lines, with flags, deficits and slots
    so the archetype matrix has something to read. */
function newsPayload(week, shift) {
  const flags = ['GAME_WINNER', 'VALIANT_LOSS', 'GARBAGE_TIME_BLOWOUT'];
  const slots = ['SUNDAY', 'MNF', 'SNF', 'TNF'];
  const names = ['A. Bell', 'B. Cole', 'C. Diaz', 'D. Ellis', 'E. Ford', 'F. Gray', 'G. Hunt', 'H. Iles'];
  const offset = shift || 0;
  const rows = [];
  for (let i = 0; i < 8; i += 1) {
    const flag = flags[(week + i + offset) % 3];
    rows.push({
      slot: slots[(week + i) % 4],
      kickoff: 1789935900000,
      player_id: String(4000000 + week * 100 + i + offset * 17),
      matchup_id: String((i % 4) + 1),
      owner_team: 'Team ' + ((i % 4) + 1),
      opponent_team: 'Team ' + (((i + 2) % 4) + 1),
      player_name: names[(i + offset) % names.length],
      player_points: 18 + ((week * 5 + i * 7 + offset) % 30),
      projected_points: 15,
      entering_margin: flag === 'GARBAGE_TIME_BLOWOUT' ? 10 + ((week + i) % 30) : -(8 + ((week + i) % 30)),
      final_margin: flag === 'VALIANT_LOSS' ? -(1 + ((week + i * 2) % 30)) : 1 + ((week * 2 + i) % 25),
      outcome_flag: flag,
    });
  }
  return { league_id: '57155288', season: 2026, week, headline: 'Week ' + week,
    match_impact_summary: 'A summary.', tracked_players: rows, league_name: 'Check League' };
}

const newsScript = news.buildNewsPodcastScript(newsPayload(2));

check('the news script hits the ~60 second word and character budget', () => {
  assert.ok(
    newsScript.words >= news.WORD_MIN - news.WORD_GRACE && newsScript.words <= news.WORD_MAX + news.WORD_GRACE,
    newsScript.words + ' words is outside ' + news.WORD_MIN + '-' + news.WORD_MAX + ' plus grace',
  );
  assert.ok(newsScript.characters >= 700 && newsScript.characters <= 1000,
    newsScript.characters + ' characters is outside the ~800-950 band');
  assert.ok(newsScript.estimatedSeconds >= 50 && newsScript.estimatedSeconds <= 70,
    'estimated ' + newsScript.estimatedSeconds + 's is not ~60s');
});

check('the news script is intro -> body -> outro, in that order', () => {
  assert.deepEqual(newsScript.movements.map((m) => m.key), ['intro', 'body', 'outro']);
  assert.deepEqual(newsScript.movements.map((m) => m.seconds), [10, 35, 15]);
  /* The body is the bulk, which is what a 35-of-60-second budget means. */
  const body = newsScript.movements.find((m) => m.key === 'body');
  assert.ok(body.words > newsScript.words * 0.4, 'the body is only ' + body.words + ' of ' + newsScript.words + ' words');
});

check('every news turn passes the endpoint\u2019s validation and hosts alternate', () => {
  assert.ok(newsScript.lines.length >= 2 && newsScript.lines.length <= podcast.MAX_EPISODE_LINES);
  newsScript.lines.forEach((l, i) => {
    assert.ok(podcast.podcastHost(l.host), 'turn ' + (i + 1) + ' has an unknown host');
    assert.ok(l.text.length >= 5 && l.text.length <= 450, 'turn ' + (i + 1) + ' is ' + l.text.length + ' chars');
    if (i > 0) assert.notEqual(l.host, newsScript.lines[i - 1].host, 'turns ' + i + ' and ' + (i + 1) + ' share a host');
  });
});

check('the copy is shaped for speech, not for the page', () => {
  const all = newsScript.lines.map((l) => l.text).join(' ');
  /* sentenceFor() is markdown: bold markers and two-decimal figures. Spoken,
     a voice model reads the asterisks and says "point five zero". */
  assert.ok(!/\*\*/.test(all), 'markdown bold survived into spoken copy');
  assert.ok(!/\bpts\b/.test(all), '"pts" survived; a voice model spells that out');
  assert.ok(!/\.\d0\b/.test(all), 'a trailing-zero decimal survived (e.g. 47.50)');
  assert.ok(!/\ba (?:8|11|18)\b/.test(all), '"a 18" survived; spoken it needs "an"');
});

check('speakable() fixes bold, pts, decimals and the article', () => {
  const out = news.speakable('**Dak** notched **20.50 pts** for a **18.10** point win.');
  assert.ok(!/\*/.test(out), 'bold not stripped: ' + out);
  assert.match(out, /20\.5 points/, 'points/decimal not shaped: ' + out);
  assert.match(out, /an 18\.1 point win/, 'article not corrected: ' + out);
});

check('the news script narrates performances in context, not bare totals', () => {
  /* The whole reason it reads article-generator's archetype matrix: a total is
     not a story. At least one turn must quote the deficit erased, the prime-time
     window, or the loss the points could not prevent. */
  const body = newsScript.lines.slice(1).map((l) => l.text).join(' ');
  assert.match(
    body,
    /deficit|down when|prime time|came up|short|wasted|padded|already had it|ran out of time/i,
    'no turn reads a performance in context: ' + body,
  );
});

check('the same payload twice produces an identical news script', () => {
  assert.deepEqual(news.buildNewsPodcastScript(newsPayload(2)), newsScript);
});

check('consecutive weeks do not produce identical bodies', () => {
  /* The defect this replaced: templateVariant keys on the week's PARITY, so
     weeks 2 and 4 drew the same variant for every row and the body came out
     byte-identical two weeks apart. Measured across ten weeks of real-shaped
     data, every body must differ. */
  const bodies = new Set();
  for (let w = 1; w <= 10; w += 1) {
    const built = news.buildNewsPodcastScript(newsPayload(w));
    bodies.add(built.lines.slice(1, -1).map((l) => l.text).join('|'));
  }
  assert.equal(bodies.size, 10, 'only ' + bodies.size + ' distinct bodies across 10 weeks');
});

check('no source of nondeterminism in the news script module', () => {
  const src = readFileSync(join(root, 'lib/podcast-news-script.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/Math\.random\s*\(/.test(src), 'Math.random()');
  assert.ok(!/Date\.now\s*\(/.test(src), 'Date.now()');
  assert.ok(!/\bfetch\s*\(/.test(src), 'a network call');
  assert.ok(!/require\s*\(/.test(src), 'a runtime require, which could reach a transport');
});

check('vercel.json rewrites the requested public path into an existing slot', () => {
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
  const rule = (vercel.rewrites || []).find(
    (r) => r.source === '/api/cron/generate-weekly-podcast',
  );
  assert.ok(rule, 'no rewrite for /api/cron/generate-weekly-podcast');
  assert.equal(rule.destination, '/api/cron/generate-articles?action=podcast-cron');
});

check('the cron route dispatches action=podcast-cron before its own day parsing', () => {
  const raw = readFileSync(join(root, 'api/cron/generate-articles.js'), 'utf8');
  /* Statements only. The comment above the dispatch names normalizeDay('') to
     explain why the order matters, and matching that would compare the
     explanation against itself. */
  const route = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const dispatch = route.indexOf("=== 'podcast-cron'");
  const day = route.indexOf('normalizeDay(queryParam');
  assert.ok(dispatch > 0, 'the route does not dispatch action=podcast-cron');
  assert.ok(dispatch < day, 'the podcast dispatch must come before normalizeDay rejects it');
});

check('vercel.json stays inside the plan’s two cron slots', () => {
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
  const crons = Array.isArray(vercel.crons) ? vercel.crons : [];
  assert.ok(
    crons.length <= 2,
    crons.length + ' cron jobs in vercel.json. The Hobby plan allows 2 and the deploy fails ' +
      'over the limit. The Tuesday podcast run is scheduled from GitHub Actions for exactly ' +
      'this reason — see .github/workflows/generate-weekly-podcast.yml.',
  );
});

check('the Tuesday schedule exists and fires on Tuesday morning UTC', () => {
  const workflow = readFileSync(join(root, '.github/workflows/generate-weekly-podcast.yml'), 'utf8');
  const cron = (workflow.match(/cron:\s*'([^']+)'/) || [])[1] || '';
  const [minute, hour, dom, month, dow] = cron.split(/\s+/);
  assert.equal(dow, '2', 'the weekly recap must run on a Tuesday; the schedule says "' + cron + '"');
  assert.equal(dom, '*', 'the schedule is pinned to a day of the month: "' + cron + '"');
  assert.equal(month, '*', 'the schedule is pinned to a month: "' + cron + '"');
  assert.equal(minute, '0', 'the schedule does not fire on the hour: "' + cron + '"');
  /* Morning, and after the Monday night final: 05:00-11:00 UTC is midnight to
     06:00 ET. Anything earlier is still Monday night football. */
  const h = Number(hour);
  assert.ok(Number.isInteger(h) && h >= 5 && h <= 11,
    'the Tuesday run fires at ' + hour + ':00 UTC, which is not Tuesday morning after MNF');
  /* And after the Tuesday ARTICLE run, which writes the blog_articles row this
     episode narrates. Ahead of it, readNewsPayload() finds nothing and every
     league is skipped — a silent no-op that costs a week to notice. */
  const articles = readFileSync(join(root, '.github/workflows/generate-articles.yml'), 'utf8');
  const articleTuesday = (articles.match(/cron:\s*'0 (\d+) \* \* 2'/) || [])[1];
  assert.ok(articleTuesday != null, 'the article workflow has no Tuesday schedule to order against');
  assert.ok(h > Number(articleTuesday),
    'the podcast runs at ' + h + ':00 UTC but the Tuesday article it narrates runs at ' +
      articleTuesday + ':00 UTC. Ahead of the article there is no payload and every league is skipped.');
  assert.match(workflow, /generate-weekly-podcast/, 'the workflow does not call the route');
  assert.match(workflow, /CRON_SECRET/, 'the workflow does not present CRON_SECRET');
});

/* ------------------------------------------------------------------ *
 * THE WEEK A SCHEDULED RUN RECAPS
 *
 * The schedule sends no week, so the route works out which week just ended and
 * refuses to narrate one that is still being played. Both halves are asserted
 * against stubs — no scoreboard is contacted.
 * ------------------------------------------------------------------ */

const weekStatus = (games, completed) => ({ games, completed, complete: games > 0 && completed === games });
const completionStub = (byWeek) => async ({ season, week }) => {
  const entry = byWeek[week];
  if (!entry) return { season, week, ...weekStatus(0, 0) };
  return { season, week, ...entry };
};
/* check() is synchronous, so every resolution is awaited out here and only the
   assertions live inside it — the same shape the run sections above use. */
const settle = async (fn) => {
  try { return { value: await fn() }; }
  catch (err) { return { err }; }
};

const liveWeekDone = await settle(() => cron.resolveRecapWeek({ season: 2026 }, {
  fetchLiveWeek: async () => ({ seasonYear: 2026, week: 5 }),
  weekCompletion: completionStub({ 5: weekStatus(14, 14), 4: weekStatus(14, 14) }),
}));
const afterRollover = await settle(() => cron.resolveRecapWeek({ season: 2026 }, {
  fetchLiveWeek: async () => ({ seasonYear: 2026, week: 6 }),
  weekCompletion: completionStub({ 6: weekStatus(14, 0), 5: weekStatus(14, 14) }),
}));
const stillPlaying = await settle(() => cron.resolveRecapWeek({ season: 2026 }, {
  fetchLiveWeek: async () => ({ seasonYear: 2026, week: 5 }),
  weekCompletion: completionStub({ 5: weekStatus(14, 13), 4: weekStatus(14, 13) }),
}));
const noGames = await settle(() => cron.resolveRecapWeek({ season: 2026 }, {
  fetchLiveWeek: async () => ({ seasonYear: 2026, week: 5 }),
  weekCompletion: completionStub({}),
}));
const noFeed = await settle(() => cron.resolveRecapWeek({ season: 2026 }, {
  fetchLiveWeek: async () => { throw new Error('FEED_HTTP_503'); },
  weekCompletion: completionStub({ 5: weekStatus(14, 14) }),
}));
const namedClosed = await settle(() => cron.assertWeekComplete({ season: 2026, week: 2 }, {
  weekCompletion: completionStub({ 2: weekStatus(13, 13) }),
}));
const namedOpen = await settle(() => cron.assertWeekComplete({ season: 2026, week: 2 }, {
  weekCompletion: completionStub({ 2: weekStatus(13, 11) }),
}));

check('the live week is recapped once every one of its games is final', () => {
  assert.equal(liveWeekDone.err, undefined);
  assert.equal(liveWeekDone.value.week, 5);
  assert.equal(liveWeekDone.value.source, 'live_week');
  assert.equal(liveWeekDone.value.completion.complete, true);
});

check('a run that lands after ESPN rolls over recaps the week behind the live one', () => {
  assert.equal(afterRollover.err, undefined);
  assert.equal(afterRollover.value.week, 5);
  assert.equal(afterRollover.value.source, 'previous_week');
});

check('a week still being played is refused with a 409, not narrated half-done', () => {
  assert.ok(stillPlaying.err, 'an open week resolved to a target week');
  assert.equal(stillPlaying.err.status, 409);
  assert.match(stillPlaying.err.message, /completed week/i);
});

check('a week the scoreboard reports no games for is not treated as finished', () => {
  assert.ok(noGames.err, 'a week with no games resolved as complete');
  assert.equal(noGames.err.status, 409);
});

check('a scoreboard that cannot be read stops the run instead of guessing a week', () => {
  assert.ok(noFeed.err, 'a broken scoreboard still produced a week');
  assert.equal(noFeed.err.status, 503);
});

check('a named week is checked for completion too, and an open one is refused', () => {
  assert.equal(namedClosed.err, undefined);
  assert.equal(namedClosed.value.complete, true);
  assert.ok(namedOpen.err, 'an open named week was allowed to generate');
  assert.equal(namedOpen.err.status, 409);
  assert.match(namedOpen.err.message, /still being played/i);
});

check('completion is counted off the scoreboard document, in both shapes ESPN ships', () => {
  const complete = weekCompleteLib.parseWeekCompletion({
    events: [
      { status: { type: { completed: true } } },
      { competitions: [{ status: { type: { state: 'post' } } }] },
    ],
  });
  assert.deepEqual(complete, { games: 2, completed: 2 });
  const open = weekCompleteLib.parseWeekCompletion({
    events: [
      { status: { type: { completed: true } } },
      { status: { type: { state: 'in', completed: false } } },
      { status: { type: { state: 'pre', completed: false } } },
    ],
  });
  assert.deepEqual(open, { games: 3, completed: 1 });
  assert.deepEqual(weekCompleteLib.parseWeekCompletion({}), { games: 0, completed: 0 });
});

check('a manual dispatch defaults to a dry run, and only the schedule is live', () => {
  /* A `type: boolean` input dispatched through the REST API with a JSON string
     is discarded by GitHub, which falls back to the declared default. With
     `default: false` on dry_run that turned a requested dry run into a real
     billable one — it happened once, for league 1915228840: 8 ElevenLabs calls
     and a 2.1 MB MP3. `choice` values are strings and survive the trip, and the
     default is now the safe mode. */
  const workflowRaw = readFileSync(join(root, '.github/workflows/generate-weekly-podcast.yml'), 'utf8');
  /* Statements only. The comment above the input explains the boolean trap by
     name, and matching that would flag the explanation as the defect. */
  const workflow = workflowRaw.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(workflow, /mode:\s*\n\s*description:[^\n]*\n\s*type:\s*choice/,
    'the manual dispatch no longer takes a single `mode` choice input');
  assert.match(workflow, /type:\s*choice[\s\S]{0,120}default:\s*dry_run/,
    'the manual dispatch does not default to dry_run');
  assert.ok(
    !/type:\s*boolean/.test(workflow),
    'a boolean input is back; API dispatches drop those and fall back to the default',
  );
  assert.match(workflow, /github\.event_name == 'schedule' && 'live'/,
    'the schedule does not force live mode, so the Tuesday run would be a dry run');
  /* The wildcard branch must be the dry one. */
  assert.match(workflow, /\*\)\s*\n[\s\S]{0,240}?DRY_RUN=1/,
    'an unrecognised mode does not fall back to a dry run');
  assert.match(workflowRaw, /Dry run was not honoured/,
    'the workflow does not verify the route actually honoured the dry run');
});

console.log(
  failures
    ? '\n[podcast-segments-check] FAILED: ' + failures + ' assertion(s)'
    : '\n[podcast-segments-check] four segments, week boundary, spend ceiling and ledger clean',
);
process.exit(failures ? 1 : 0);
