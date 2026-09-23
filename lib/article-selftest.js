'use strict';
/**
 * Article pipeline self-test. Runs against the COMPILED output in lib/dist,
 * which is what the serverless routes require, so a stale build fails here
 * rather than in production.
 *
 *   npm run test:articles
 *
 * Every fixture is deterministic: fixed kickoff timestamps, a fixed clock, and
 * an in-memory Supabase double that records exactly what the pipeline sends.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePlayerOutcomeFlags, classifyOutcome, featuredTrackedPlayers } = require('./dist/article-math');
const {
  generateAndPublishBlogArticle,
  assertOutcomeLanguage,
  articleSlug,
  buildSystemPrompt,
  buildUserPrompt,
  defaultComposer,
  ARTICLE_TYPE_BY_DAY,
  OUTCOME_FRAMING_RULE,
} = require('./dist/article-generator');

/* Week 2 of a 2026 season, on the real NFL clock (US Eastern). */
const THU = Date.parse('2026-09-10T20:15:00-04:00');
const SUN_EARLY = Date.parse('2026-09-13T13:00:00-04:00');
const SUN_LATE = Date.parse('2026-09-13T16:25:00-04:00');
const SNF = Date.parse('2026-09-13T20:20:00-04:00');
const MNF = Date.parse('2026-09-14T20:15:00-04:00');
const PUBLISHED = Date.parse('2026-09-15T13:00:00Z');

const starter = (id, name, points, kickoff, projected) =>
  ({ player_id: id, player_name: name, player_points: points, kickoff, projected_points: projected });

const side = (teamId, teamName, starters) => ({ team_id: teamId, team_name: teamName, starters });

/* One matchup per flag, so the table below is exercised end to end.
   Margins are always stated for the player's own team. */
function fixture() {
  return {
    matchups: [
      // 1. Comeback: Ridgeback trails 60 to 74 before the MNF back plays, wins
      //    by 6. 20 >= 14, so the flag is earned.
      { id: 'm1',
        home: side('1', 'Ridgeback FC', [
          starter('p1', 'Early Anchor', 60, SUN_EARLY, 58),
          starter('p2', 'Monday Back', 20, MNF, 15),
        ]),
        away: side('2', 'Cobalt Kings', [
          starter('p3', 'Sunday Wideout', 74, SUN_EARLY, 70),
          starter('p4', 'Quiet Tight End', 0, SUN_LATE, 8),
        ]) },
      // 2. Blowout: up 40 before the late game, up 65 after.
      { id: 'm2',
        home: side('3', 'Harbor Pilots', [
          starter('p5', 'Thursday Arm', 60, THU, 55),
          starter('p6', 'Late Padder', 25, SUN_LATE, 20),
        ]),
        away: side('4', 'Verdant Owls', [
          starter('p7', 'Thursday Dud', 20, THU, 24),
          starter('p8', 'Nobody Home', 0, SUN_LATE, 12),
        ]) },
      // 3. Valiant loss: 31 points on the night, team still loses by 9.
      { id: 'm3',
        home: side('5', 'Ninth Street', [
          starter('p9', 'Flat Opener', 10, SUN_EARLY, 14),
          starter('p10', 'Night Monster', 31, SNF, 18),
        ]),
        away: side('6', 'Gulf Current', [
          starter('p11', 'Steady Hand', 30, SUN_EARLY, 28),
          starter('p12', 'Second Wave', 20, SNF, 19),
        ]) },
      // 4. Dud: up 12 before Monday, loses by 8, finishes 22 under projection.
      { id: 'm4',
        home: side('7', 'Copper Ridge', [
          starter('p13', 'Solid Sunday', 42, SUN_EARLY, 40),
          starter('p14', 'Monday Ghost', 3, MNF, 25),
        ]),
        away: side('8', 'Iron Lantern', [
          starter('p15', 'Even Keel', 30, SUN_EARLY, 31),
          starter('p16', 'Closer', 23, MNF, 20),
        ]) },
    ],
  };
}

const flagFor = (rows, name) => rows.find((row) => row.player_name === name);

/* ------------------------------------------------------------------ *
 * article-math
 * ------------------------------------------------------------------ */

test('the four outcome flags are assigned strictly, from real margins', () => {
  const rows = calculatePlayerOutcomeFlags(fixture(), { week: 2 });

  const winner = flagFor(rows, 'Monday Back');
  assert.equal(winner.outcome_flag, 'GAME_WINNER');
  assert.equal(winner.entering_margin, -14);
  assert.equal(winner.final_margin, 6);
  assert.equal(winner.owner_team, 'Ridgeback FC');
  assert.equal(winner.slot, 'MNF');

  const padder = flagFor(rows, 'Late Padder');
  assert.equal(padder.outcome_flag, 'GARBAGE_TIME_BLOWOUT');
  assert.equal(padder.entering_margin, 40);
  assert.equal(padder.final_margin, 65);

  const wasted = flagFor(rows, 'Night Monster');
  assert.equal(wasted.outcome_flag, 'VALIANT_LOSS');
  assert.equal(wasted.final_margin, -9);
  assert.equal(wasted.slot, 'SNF');

  const dud = flagFor(rows, 'Monday Ghost');
  assert.equal(dud.outcome_flag, 'DUD_COST_WIN');
  assert.equal(dud.entering_margin, 12);
  assert.equal(dud.final_margin, -8);

  // Nothing decisive happened to these two, and the math says so plainly.
  assert.equal(flagFor(rows, 'Early Anchor').outcome_flag, null);
  assert.equal(flagFor(rows, 'Steady Hand').outcome_flag, null);
});

test('entering_margin counts only games that had already kicked off', () => {
  const rows = calculatePlayerOutcomeFlags(fixture(), { week: 2 });
  // Thursday is first on the slate, so nobody has scored before it.
  assert.equal(flagFor(rows, 'Thursday Arm').entering_margin, 0);
  // The Sunday late game sits behind the Thursday result only.
  assert.equal(flagFor(rows, 'Late Padder').entering_margin, 40);
  // Monday sits behind every Sunday game.
  assert.equal(flagFor(rows, 'Monday Ghost').entering_margin, 12);
});

test('each flag needs every one of its conditions', () => {
  // A comeback that falls short of the deficit is not a game winner.
  assert.equal(classifyOutcome({ entering_margin: -20, final_margin: 4, player_points: 19, projected_points: 12 }), null);
  assert.equal(classifyOutcome({ entering_margin: -20, final_margin: 4, player_points: 20, projected_points: 12 }), 'GAME_WINNER');
  // A blowout must be over 20 at both ends.
  assert.equal(classifyOutcome({ entering_margin: 20, final_margin: 40, player_points: 30, projected_points: 12 }), null);
  assert.equal(classifyOutcome({ entering_margin: 30, final_margin: 20, player_points: 30, projected_points: 12 }), null);
  // Exactly 20 points is not a monster game.
  assert.equal(classifyOutcome({ entering_margin: -5, final_margin: -5, player_points: 20, projected_points: 12 }), null);
  assert.equal(classifyOutcome({ entering_margin: -5, final_margin: -5, player_points: 20.5, projected_points: 12 }), 'VALIANT_LOSS');
  // A dud needs a projection, a lead beforehand, and a 5 point shortfall.
  assert.equal(classifyOutcome({ entering_margin: 3, final_margin: -2, player_points: 8, projected_points: 13 }), null);
  assert.equal(classifyOutcome({ entering_margin: 3, final_margin: -2, player_points: 7.9, projected_points: 13 }), 'DUD_COST_WIN');
  assert.equal(classifyOutcome({ entering_margin: 3, final_margin: -2, player_points: 1, projected_points: null }), null);
});

test('a missing kickoff refuses the margin instead of guessing it', () => {
  const data = fixture();
  delete data.matchups[0].home.starters[0].kickoff;
  const rows = calculatePlayerOutcomeFlags(data, { week: 2 });
  const winner = flagFor(rows, 'Monday Back');
  assert.equal(winner.entering_margin, null);
  assert.equal(winner.outcome_flag, null);
  assert.equal(winner.unresolved_reason, 'MISSING_KICKOFF_DATA');
  // The other matchups are untouched by one bad lineup.
  assert.equal(flagFor(rows, 'Night Monster').outcome_flag, 'VALIANT_LOSS');
});

test('raw ESPN box score payloads are read without an adapter', () => {
  const espn = {
    schedule: [{
      id: 7,
      matchupPeriodId: 2,
      home: {
        teamId: 1, teamName: 'Ridgeback FC', totalPoints: 80,
        rosterForCurrentScoringPeriod: { entries: [
          { playerId: 1, lineupSlotId: 0, appliedStatTotal: 60, kickoff: SUN_EARLY,
            playerPoolEntry: { player: { id: 1, fullName: 'Early Anchor' } } },
          { playerId: 2, lineupSlotId: 2, appliedStatTotal: 20, kickoff: MNF,
            playerPoolEntry: { player: { id: 2, fullName: 'Monday Back', stats: [
              { statSourceId: 1, scoringPeriodId: 2, appliedTotal: 15 },
            ] } } },
          // Bench points are never on the board and must not move a margin.
          { playerId: 99, lineupSlotId: 20, appliedStatTotal: 500, kickoff: THU,
            playerPoolEntry: { player: { id: 99, fullName: 'Bench Mountain' } } },
        ] },
      },
      away: {
        teamId: 2, teamName: 'Cobalt Kings', totalPoints: 74,
        rosterForCurrentScoringPeriod: { entries: [
          { playerId: 3, lineupSlotId: 0, appliedStatTotal: 74, kickoff: SUN_EARLY,
            playerPoolEntry: { player: { id: 3, fullName: 'Sunday Wideout' } } },
        ] },
      },
    }, {
      // A different week in the same payload is filtered out, not scored.
      id: 8, matchupPeriodId: 3, home: { teamId: 1, teamName: 'Ridgeback FC', starters: [] }, away: null,
    }],
  };
  const rows = calculatePlayerOutcomeFlags(espn, { week: 2 });
  assert.equal(rows.some((row) => row.player_name === 'Bench Mountain'), false);
  assert.equal(rows.some((row) => row.matchup_id === '8'), false);
  const winner = flagFor(rows, 'Monday Back');
  assert.equal(winner.outcome_flag, 'GAME_WINNER');
  assert.equal(winner.entering_margin, -14);
  assert.equal(winner.projected_points, 15);
});

test('featured rows lead with the flagged performances and are reproducible', () => {
  const rows = calculatePlayerOutcomeFlags(fixture(), { week: 2 });
  const featured = featuredTrackedPlayers(rows, 4);
  assert.equal(featured.length, 4);
  assert.deepEqual(featured.map((row) => row.outcome_flag).filter(Boolean).length, 4);
  assert.deepEqual(featuredTrackedPlayers(rows, 4), featured);
});

/* ------------------------------------------------------------------ *
 * article-generator
 * ------------------------------------------------------------------ */

function fakeDb() {
  const rows = new Map();
  const calls = [];
  return {
    calls,
    rows,
    from(table) {
      calls.push(table);
      assert.equal(table, 'blog_articles');
      let pending = null;
      const query = {
        upsert(record, options) {
          assert.deepEqual(options, { onConflict: 'slug' });
          pending = { ...record, id: '00000000-0000-4000-8000-' + String(rows.size + 1).padStart(12, '0') };
          return query;
        },
        select() { return query; },
        async single() {
          if (!pending) return { data: null, error: new Error('nothing staged') };
          rows.set(pending.slug, pending);
          return { data: pending, error: null };
        },
      };
      return query;
    },
  };
}

const run = (overrides = {}) => generateAndPublishBlogArticle(
  { league_id: '123456', season: 2026, week: 2, day: 'tue', ...(overrides.input || {}) },
  { fetchBoxScores: async () => fixture(), now: () => PUBLISHED, ...overrides.deps },
);

test('the published record matches the blog_articles schema', async () => {
  const db = fakeDb();
  const result = await run({ deps: { db } });
  const record = result.record;

  assert.equal(record.league_id, '123456');
  assert.equal(record.slug, '2026-week-2-tuesday-verdict-123456');
  assert.equal(record.article_type, 'tuesday_verdict');
  assert.equal(record.season, 2026);
  assert.equal(record.week, 2);
  assert.equal(record.published_at, '2026-09-15T13:00:00.000Z');
  assert.ok(record.title.length > 0);
  assert.ok(record.excerpt.length > 0);
  assert.ok(record.content_markdown.includes('#'));
  assert.equal(result.stored, true);
  assert.equal(db.rows.size, 1);

  // tracked_players carries the contract fields on every row.
  assert.ok(record.tracked_players.length > 0);
  for (const row of record.tracked_players) {
    assert.equal(typeof row.player_id, 'string');
    assert.equal(typeof row.player_name, 'string');
    assert.equal(typeof row.owner_team, 'string');
    assert.ok(row.outcome_flag === null || typeof row.outcome_flag === 'string');
  }
});

test('a re-run of the same league week overwrites its own row', async () => {
  const db = fakeDb();
  await run({ deps: { db } });
  await run({ deps: { db } });
  assert.equal(db.rows.size, 1);
});

test('each day maps to its article type and its own slug', async () => {
  for (const [day, type] of Object.entries(ARTICLE_TYPE_BY_DAY)) {
    const db = fakeDb();
    const result = await run({ input: { day }, deps: { db } });
    assert.equal(result.record.article_type, type);
    assert.equal(result.record.slug, articleSlug({ league_id: '123456', season: 2026, week: 2, day }));
  }
  assert.notEqual(
    articleSlug({ league_id: '123456', season: 2026, week: 2, day: 'mon' }),
    articleSlug({ league_id: '123456', season: 2026, week: 2, day: 'tue' }),
  );
});

test('the framing rule reaches the model verbatim, with the resolved facts', async () => {
  let seen = null;
  await run({ deps: { db: fakeDb(), compose: (request) => { seen = request; return defaultComposer(request); } } });
  assert.ok(seen.system_prompt.includes(OUTCOME_FRAMING_RULE));
  assert.ok(seen.system_prompt.includes(buildSystemPrompt('tuesday_verdict')));
  assert.ok(seen.user_prompt.includes('outcome_flag GAME_WINNER'));
  assert.ok(seen.user_prompt.includes('entering_margin -14'));
  assert.ok(seen.user_prompt.includes('wasted monster game'));
  assert.ok(seen.user_prompt.includes('unneeded stat-padding'));
  assert.equal(seen.user_prompt, buildUserPrompt(seen));
});

test('the local composer frames every flag the way the rule demands', async () => {
  const result = await run({ deps: { db: fakeDb() } });
  const body = result.record.content_markdown;
  assert.match(body, /Monday Back won the matchup for Ridgeback FC/);
  assert.match(body, /Unneeded stat-padding/);
  assert.match(body, /A monster game, wasted/);
  assert.match(body, /Monday Ghost/);
  // House rule from the existing blog build: em dashes never ship.
  assert.ok(!/[—―]/.test(body));
});

test('hero language without a GAME_WINNER flag is refused, not published', async () => {
  const db = fakeDb();
  const overclaim = () => ({
    title: 'Night Monster Saved The Week',
    excerpt: 'A hero emerged.',
    content_markdown: '# Week 2\n\nNight Monster was the hero of the week.\n',
  });
  await assert.rejects(
    run({ deps: { db, compose: overclaim } }),
    (err) => /hero or game-saver/.test(err.message) && err.status === 422,
  );
  assert.equal(db.rows.size, 0, 'nothing may be written when the copy overclaims');
});

test('hero language IS allowed for the player the math credits', () => {
  const tracked = calculatePlayerOutcomeFlags(fixture(), { week: 2 })
    .filter((row) => row.outcome_flag === 'GAME_WINNER');
  assert.doesNotThrow(() => assertOutcomeLanguage({
    title: 'Monday Back Is The Hero',
    excerpt: 'Monday Back saved the week for Ridgeback FC.',
    content_markdown: '# Week 2\n\nMonday Back was the hero here, and the margin says so.\n',
  }, tracked));
  // The same praise aimed at anyone else still fails.
  assert.throws(() => assertOutcomeLanguage({
    title: 'Week 2',
    excerpt: 'Steady.',
    content_markdown: 'Late Padder was the hero of the afternoon.',
  }, tracked));
});

test('an em dash in composed copy is refused', async () => {
  const db = fakeDb();
  await assert.rejects(
    run({ deps: { db, compose: () => ({ title: 'Week 2 — Verdict', excerpt: 'x', content_markdown: 'body' }) } }),
    (err) => /em dash/.test(err.message),
  );
  assert.equal(db.rows.size, 0);
});

test('bad scopes are rejected before anything is fetched or written', async () => {
  const db = fakeDb();
  let fetched = 0;
  const deps = { db, fetchBoxScores: async () => { fetched++; return fixture(); }, now: () => PUBLISHED };
  for (const bad of [
    { league_id: '' }, { league_id: '../etc' }, { season: 1900 }, { week: 0 }, { week: 19 }, { day: 'wed' },
  ]) {
    await assert.rejects(run({ input: bad, deps }));
  }
  assert.equal(fetched, 0);
  assert.equal(db.rows.size, 0);
});

test('an empty box score fails loudly instead of publishing an empty article', async () => {
  const db = fakeDb();
  await assert.rejects(
    run({ deps: { db, fetchBoxScores: async () => ({ matchups: [] }) } }),
    (err) => err.status === 404,
  );
  assert.equal(db.rows.size, 0);
});

test('a failed write surfaces to the caller rather than reporting success', async () => {
  const broken = { from: () => ({
    upsert: () => broken.from(), select: () => broken.from(),
    single: async () => ({ data: null, error: Object.assign(new Error('relation does not exist'), { code: '42P01' }) }),
  }) };
  await assert.rejects(run({ deps: { db: broken } }), /relation does not exist/);
});

/* --------------------------------------------------------------------------
   THE COMPILED OUTPUT'S OWN REQUIRE PATHS

   The routes require lib/dist, not lib. A runtime `require()` is a string
   TypeScript copies through untouched, so a relative path that reads correctly
   in lib/article-generator.ts resolves one directory too high once the file is
   emitted into lib/dist — and it fails at call time, in production, not at
   build time or in a test that injects the dependency.

   That is not hypothetical: `require('../api/espn')` shipped, resolved to
   lib/api/espn, and threw on every scheduled run for every league before a
   single box score was fetched. `cron_article_logs` recorded "Cannot find
   module '../api/espn'" 22 times and blog_articles stayed empty.

   So this asserts the whole class, not the one instance: every relative
   require in every compiled file must resolve from where that file actually
   sits.
-------------------------------------------------------------------------- */
test('every relative require in lib/dist resolves from lib/dist', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dist = path.join(__dirname, 'dist');

  const files = fs.readdirSync(dist).filter((name) => name.endsWith('.js'));
  assert.ok(files.length, 'lib/dist must hold compiled output; run npm run build:articles');

  let checked = 0;
  for (const name of files) {
    const file = path.join(dist, name);
    const source = fs.readFileSync(file, 'utf8');
    const pattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const spec = match[1];
      checked++;
      assert.doesNotThrow(
        () => require.resolve(spec, { paths: [dist] }),
        'lib/dist/' + name + " requires '" + spec + "', which does not resolve from lib/dist. " +
          'Relative requires in the TypeScript sources must be written for the emitted ' +
          'location (lib/dist), not for the source location (lib).',
      );
    }
  }
  assert.ok(checked > 0, 'the scan found no relative requires to check, which means it is not scanning');
});
