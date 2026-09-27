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

const fsnIndex = require(join(root, 'lib/dist/fsn-index.js'));
const script = require(join(root, 'lib/dist/podcast-script.js'));
const cron = require(join(root, 'lib/dist/generate-weekly-podcast.js'));
const math = require(join(root, 'lib/dist/article-math.js'));
const generator = require(join(root, 'lib/dist/article-generator.js'));
const podcast = require(join(root, 'lib/dist/generate-podcast.js'));

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
      insert(v) { action = 'insert'; value = v; return q.run(); },
      update(v) { action = 'update'; value = v; return q; },
      then(resolve, reject) { return q.run().then(resolve, reject); },
      async run() {
        if (table === 'leagues') {
          return { data: leagues.map((league_id) => ({ league_id })), error: null };
        }
        if (table === 'podcast_episode_runs') {
          runs.push(value);
          return { data: null, error: null };
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
          (r) => String(r.season) === filters.season && String(r.week) === filters.week,
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
/* A single valid MPEG-1 Layer III 128 kbps 44.1 kHz frame, which is what
   stitchPodcastMp3 scans for. 417 bytes is that frame's length. */
const frame = Buffer.alloc(417);
frame.set([0xff, 0xfb, 0x90, 0x00]);
const fakeMp3 = Buffer.concat([frame, frame]);

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
      assert.equal(row.episode.segments.length, 4, 'the stored episode lost its segments');
      assert.ok(Array.isArray(row.episode.lines), 'the stored episode lost its script');
      assert.equal(
        row.episode.lines.length,
        episode.lines.length,
        'the stored script has ' + row.episode.lines.length + ' turns, expected ' + episode.lines.length,
      );
      assert.equal(row.episode.markers.length, row.episode.lines.length);
    });
  });

  check('one ElevenLabs call per dialogue turn, and no more', () => {
    const turns = summary.results.filter((r) => r.status === 'created')
      .reduce((n, r) => n + r.turns, 0);
    assert.equal(synthCalls, turns, 'synthesis calls (' + synthCalls + ') != reported turns (' + turns + ')');
    assert.equal(turns, 2 * episode.lines.length);
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
    assert.equal(
      synthCalls,
      episode.lines.length,
      'only the one new league should have reached the voice provider',
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
    assert.equal(row.episode.segments.length, 4);
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
    flaky = await cron.runWeeklyPodcastCron({ season: 2026 }, deps(flakyDb, {
      fetchBoxScores: async () => {
        call += 1;
        if (call === 1) throw Object.assign(new Error('ESPN box score read failed (HTTP 401)'), { status: 401 });
        return leaguePayload();
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
   The route wiring
   ========================================================================== */

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

check('the Tuesday schedule exists and fires at 10:00 UTC on a Tuesday', () => {
  const workflow = readFileSync(join(root, '.github/workflows/generate-weekly-podcast.yml'), 'utf8');
  assert.match(workflow, /cron:\s*'0 10 \* \* 2'/, 'the Tuesday 10:00 UTC schedule is missing');
  assert.match(workflow, /generate-weekly-podcast/, 'the workflow does not call the route');
  assert.match(workflow, /CRON_SECRET/, 'the workflow does not present CRON_SECRET');
});

console.log(
  failures
    ? '\n[podcast-segments-check] FAILED: ' + failures + ' assertion(s)'
    : '\n[podcast-segments-check] four segments, week boundary, spend ceiling and ledger clean',
);
process.exit(failures ? 1 : 0);
