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
const { parseProTeamKickoffs, scoreboardUrl } = require('./notifications/schedule-feed');
const {
  generateAndPublishBlogArticle,
  assertOutcomeLanguage,
  articleSlug,
  buildSystemPrompt,
  buildUserPrompt,
  defaultComposer,
  sentenceFor,
  boardRows,
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

/* fetchKickoffs is stubbed by default for the same reason fetchBoxScores is:
   the real one reads ESPN's scoreboard over the network, and a self-test that
   reaches the internet is a self-test that fails on a plane. A case that wants
   the failure path overrides it. */
const run = (overrides = {}) => generateAndPublishBlogArticle(
  { league_id: '123456', season: 2026, week: 2, day: 'tue', ...(overrides.input || {}) },
  {
    fetchBoxScores: async () => fixture(),
    fetchKickoffs: async () => parseProTeamKickoffs(scoreboard()),
    now: () => PUBLISHED,
    ...overrides.deps,
  },
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

/* A compose request carrying exactly the rows a case is about, so each flag's
   framing can be asserted on its own rather than hoping it survives the
   board's four-row cap. */
const composeWith = (tracked_players, article_type = 'tuesday_verdict') => defaultComposer({
  system_prompt: '', user_prompt: '', league_id: '123456',
  season: 2026, week: 2, day: 'tue', article_type, tracked_players,
});

const trackedRow = (over) => ({
  player_id: 'x', player_name: 'A Player', owner_team: 'A Team', opponent_team: 'B Team',
  player_points: 20, projected_points: 15, entering_margin: -10, final_margin: 6,
  slot: 'MNF', kickoff: MNF, matchup_id: 'm', outcome_flag: null, ...over,
});

test('the local composer frames every flag the way the rule demands', () => {
  /* Asserted one flag at a time. The board only carries four rows and drops
     blowouts, so a single article can no longer show every framing. */
  const winner = composeWith([trackedRow({
    player_name: 'Monday Back', owner_team: 'Ridgeback FC', outcome_flag: 'GAME_WINNER',
    player_points: 20, entering_margin: -14, final_margin: 6,
  })]).content_markdown;
  assert.match(winner, /\*\*Monday Back\*\* won the matchup for \*\*Ridgeback FC\*\*/);

  const wasted = composeWith([trackedRow({
    player_name: 'Night Monster', owner_team: 'Ninth Street', outcome_flag: 'VALIANT_LOSS',
    player_points: 31, entering_margin: -20, final_margin: -9,
  })]).content_markdown;
  assert.match(wasted, /A monster game, wasted/);
  assert.match(wasted, /\*\*Night Monster\*\* went for \*\*31 pts\*\*/);

  const dud = composeWith([trackedRow({
    player_name: 'Monday Ghost', owner_team: 'Copper Ridge', outcome_flag: 'DUD_COST_WIN',
    player_points: 3, projected_points: 25, entering_margin: 12, final_margin: -8,
  })]).content_markdown;
  assert.match(dud, /\*\*Copper Ridge\*\* led by \*\*12\*\* before \*\*Monday Ghost\*\* played/);
  assert.match(dud, /that gap is the matchup/);

  /* The blowout framing is asserted on sentenceFor directly. The board drops
     blowouts as filler, so no composed article can reach that branch any more,
     but it is still the reference wording for the flag and must keep saying
     what it says. */
  const padding = sentenceFor(trackedRow({
    player_name: 'Late Padder', owner_team: 'Harbor Pilots', outcome_flag: 'GARBAGE_TIME_BLOWOUT',
    player_points: 25, entering_margin: 40, final_margin: 65,
  }));
  assert.match(padding, /Unneeded stat-padding/);
  assert.match(padding, /\*\*Late Padder\*\* put up \*\*25 pts\*\*/);
  assert.equal(/hero|game-saver|saved the/i.test(padding), false,
    'and a blowout is never framed as having decided anything');

  // House rule from the existing blog build: em dashes never ship.
  for (const body of [winner, wasted, dud, padding]) assert.ok(!/[—―]/.test(body));
});

test('boardRows is the one order the board and the callout share', () => {
  const rows = [
    trackedRow({ player_id: 'p', player_name: 'Padder', outcome_flag: 'GARBAGE_TIME_BLOWOUT', entering_margin: 40, final_margin: 65 }),
    trackedRow({ player_id: 'v', player_name: 'Wasted', outcome_flag: 'VALIANT_LOSS', final_margin: -9 }),
    trackedRow({ player_id: 'g', player_name: 'Winner', outcome_flag: 'GAME_WINNER', entering_margin: -14, final_margin: 6 }),
  ];
  assert.deepEqual(boardRows(rows).map((row) => row.player_name), ['Winner', 'Wasted']);
  assert.deepEqual(boardRows(rows, 1).map((row) => row.player_name), ['Winner']);
  assert.deepEqual(boardRows([]), []);

  /* A blowout-only week produces neither, which is what keeps the headline,
     the callout and the bullets from contradicting each other. */
  const blowoutsOnly = [rows[0]];
  assert.deepEqual(boardRows(blowoutsOnly), []);
  assert.equal(composeWith(blowoutsOnly).match_impact_summary, '');
});

test('the board carries the few results that turned, not every starter', () => {
  const result = composeWith([
    trackedRow({ player_id: '1', player_name: 'Padder One', outcome_flag: 'GARBAGE_TIME_BLOWOUT', entering_margin: 40, final_margin: 65 }),
    trackedRow({ player_id: '2', player_name: 'Padder Two', outcome_flag: 'GARBAGE_TIME_BLOWOUT', entering_margin: 30, final_margin: 55 }),
    trackedRow({ player_id: '3', player_name: 'Nothing Happened', outcome_flag: null }),
    trackedRow({ player_id: '4', player_name: 'Wasted One', outcome_flag: 'VALIANT_LOSS', final_margin: -9 }),
    trackedRow({ player_id: '5', player_name: 'Winner One', outcome_flag: 'GAME_WINNER', entering_margin: -14, final_margin: 6 }),
    trackedRow({ player_id: '6', player_name: 'Dud One', outcome_flag: 'DUD_COST_WIN', entering_margin: 12, final_margin: -8, player_points: 3 }),
  ]);
  const bullets = result.content_markdown.split('\n').filter((line) => line.startsWith('- '));

  assert.equal(bullets.length, 3, 'blowouts and unflagged rows are not bullets');
  // Priority, stated: won > thrown away > wasted.
  assert.match(bullets[0], /Winner One/);
  assert.match(bullets[1], /Dud One/);
  assert.match(bullets[2], /Wasted One/);
  assert.equal(/Padder One|Padder Two/.test(result.content_markdown), false,
    'repetitive stat-padding filler is dropped from the prose');
  assert.equal(/Nothing Happened/.test(result.content_markdown), false,
    'a player who decided nothing is not a bullet');

  // And the headline counts what the board shows, not every flagged row.
  assert.match(result.title, /3 Results That Turned/);
});

test('the board is capped at four bullets however busy the week', () => {
  const winners = Array.from({ length: 9 }, (unused, i) => trackedRow({
    player_id: 'w' + i, player_name: 'Winner ' + i, outcome_flag: 'GAME_WINNER',
    entering_margin: -14, final_margin: 6,
  }));
  const result = composeWith(winners);
  const bullets = result.content_markdown.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(bullets.length, 4);
  assert.match(result.title, /4 Results That Turned/);
});

test('every bullet emboldens the player, the team and the numbers', () => {
  const result = composeWith([trackedRow({
    player_name: 'Jaxon Smith-Njigba', owner_team: "Chase N' Destroy", outcome_flag: 'GAME_WINNER',
    player_points: 47.5, entering_margin: -42.5, final_margin: 20,
  })]);
  const bullet = result.content_markdown.split('\n').find((line) => line.startsWith('- '));

  for (const wanted of ['**Jaxon Smith-Njigba**', "**Chase N' Destroy**", '**42.50**', '**20**', '**47.50 pts**']) {
    assert.ok(bullet.includes(wanted), bullet + ' must embolden ' + wanted);
  }
  /* index.html's markdown subset matches **...** with no asterisk inside, so
     every pair must be balanced or the line renders with stray asterisks. */
  assert.equal((bullet.match(/\*\*/g) || []).length % 2, 0, 'the bold markers are balanced');
});

test('a week with nothing decisive says so rather than listing the board', () => {
  const result = composeWith([
    trackedRow({ player_id: '1', player_name: 'Quiet One', outcome_flag: null }),
    trackedRow({ player_id: '2', player_name: 'Padder', outcome_flag: 'GARBAGE_TIME_BLOWOUT', entering_margin: 40, final_margin: 65 }),
  ]);
  assert.match(result.title, /No Swings To Report/);
  assert.equal(result.match_impact_summary, '', 'and no callout is invented');
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

/* --------------------------------------------------------------------------
   KICKOFFS FROM THE SCOREBOARD

   The bug these cover, in one line: the ESPN FANTASY league endpoint carries
   no kickoff times, so every starter resolved to kickoff null, every matchup
   was MISSING_KICKOFF_DATA, no outcome flag was ever assigned, and every
   published article read "No Swings To Report" with an empty impact summary.

   The times live on the public NFL scoreboard, which the push dispatcher
   already reads. These assert the join: scoreboard in, flags out.
-------------------------------------------------------------------------- */

/* A scoreboard document in the shape ESPN serves, covering the four NFL teams
   the fixture's starters play for, at the fixture's own kickoff times. */
function scoreboard() {
  const game = (id, date, teams) => ({
    id,
    date,
    competitions: [{
      date,
      competitors: teams.map(([teamId, abbrev]) => ({ team: { id: teamId, abbreviation: abbrev } })),
    }],
  });
  return {
    events: [
      game('e1', new Date(THU).toISOString(), [['1', 'ATL'], ['2', 'BUF']]),
      game('e2', new Date(SUN_EARLY).toISOString(), [['3', 'CHI'], ['4', 'DAL']]),
      game('e3', new Date(SUN_LATE).toISOString(), [['5', 'DEN'], ['6', 'GB']]),
      game('e4', new Date(SNF).toISOString(), [['7', 'KC'], ['8', 'LAR']]),
      game('e5', new Date(MNF).toISOString(), [['9', 'MIA'], ['10', 'NE']]),
    ],
  };
}

/* The same four matchups as fixture(), with the kickoff stripped off every
   starter and an NFL team put on instead. This is the shape the real ESPN
   fantasy endpoint actually returns. */
function fixtureWithoutKickoffs() {
  const teamOf = {
    THU: '1', SUN_EARLY: '3', SUN_LATE: '5', SNF: '7', MNF: '9',
  };
  const windowName = (kickoff) => (
    kickoff === THU ? 'THU' :
    kickoff === SUN_EARLY ? 'SUN_EARLY' :
    kickoff === SUN_LATE ? 'SUN_LATE' :
    kickoff === SNF ? 'SNF' : 'MNF'
  );
  const payload = fixture();
  for (const matchup of payload.matchups) {
    for (const s of [matchup.home, matchup.away]) {
      s.starters = s.starters.map((row) => {
        const stripped = { ...row };
        const proTeamId = teamOf[windowName(stripped.kickoff)];
        delete stripped.kickoff;
        return { ...stripped, proTeamId };
      });
    }
  }
  return payload;
}

test('parseProTeamKickoffs indexes every team by id and abbreviation', () => {
  const index = parseProTeamKickoffs(scoreboard());
  assert.equal(index['1'], THU, 'by numeric ESPN team id');
  assert.equal(index.ATL, THU, 'and by abbreviation');
  assert.equal(index['9'], MNF);
  assert.equal(index.NE, MNF);
  // A team on bye is absent, not zero: it has no game to be placed against.
  assert.equal('99' in index, false);
  assert.equal('CLE' in index, false);
});

test('parseProTeamKickoffs survives the shapes a scoreboard actually ships', () => {
  /* The index is a null-prototype object on purpose: it is keyed by strings
     from an upstream document, and a team abbreviated "constructor" must be a
     miss rather than a function. That is why these compare key counts instead
     of deep-equalling {}. */
  const empty = (payload, label) =>
    assert.equal(Object.keys(parseProTeamKickoffs(payload)).length, 0, label);

  empty(null, 'a null payload');
  empty({}, 'an empty document');
  empty({ events: 'not an array' }, 'events of the wrong type');
  // An event with no date contributes nothing rather than an Invalid Date.
  empty({ events: [{ id: 'x', competitions: [{ competitors: [{ team: { id: '1' } }] }] }] }, 'an undated event');
  // An unparseable date is skipped, not stored as NaN.
  empty({ events: [{ id: 'x', date: 'not a date', competitions: [{ competitors: [{ team: { id: '1' } }] }] }] }, 'an unparseable date');
  // And a key that would collide with Object.prototype is just a miss.
  assert.equal(parseProTeamKickoffs(scoreboard()).constructor, undefined);
  // The competition's own date wins over the event's, for a rescheduled game.
  const moved = parseProTeamKickoffs({
    events: [{ id: 'x', date: new Date(THU).toISOString(), competitions: [{ date: new Date(MNF).toISOString(), competitors: [{ team: { id: '1' } }] }] }],
  });
  assert.equal(moved['1'], MNF);
});

test('scoreboardUrl asks for one specific week of the regular season', () => {
  const url = new URL(scoreboardUrl({ season: 2026, week: 2 }));
  assert.equal(url.searchParams.get('dates'), '2026');
  assert.equal(url.searchParams.get('week'), '2');
  assert.equal(url.searchParams.get('seasontype'), '2');
});

test('without a kickoff index a payload carrying none resolves nothing', () => {
  // This is exactly what shipped: real points, no times, no flags.
  const rows = calculatePlayerOutcomeFlags(fixtureWithoutKickoffs(), { week: 2 });
  assert.ok(rows.length > 0, 'the starters are still read');
  assert.equal(rows.every((row) => row.kickoff === null), true);
  assert.equal(rows.every((row) => row.outcome_flag === null), true);
  assert.equal(rows.every((row) => row.unresolved_reason === 'MISSING_KICKOFF_DATA'), true);
});

test('with the index, the same payload produces the same flags as declared kickoffs', () => {
  const withIndex = calculatePlayerOutcomeFlags(fixtureWithoutKickoffs(), {
    week: 2, kickoffs: parseProTeamKickoffs(scoreboard()),
  });
  const declared = calculatePlayerOutcomeFlags(fixture(), { week: 2 });

  const shape = (rows) => rows
    .map((row) => [row.player_name, row.outcome_flag, row.entering_margin, row.final_margin, row.slot].join('|'))
    .sort();
  assert.deepEqual(shape(withIndex), shape(declared),
    'the scoreboard join must reproduce the declared-kickoff result exactly');

  // And spot-check the one the whole feature is for.
  const winner = withIndex.find((row) => row.player_name === 'Monday Back');
  assert.equal(winner.outcome_flag, 'GAME_WINNER');
  assert.equal(winner.entering_margin, -14);
  assert.equal(winner.final_margin, 6);
  assert.equal(winner.slot, 'MNF');
  assert.equal(winner.unresolved_reason, undefined);
});

test('an entry that states its own kickoff outranks the index', () => {
  /* A payload naming a kickoff for this specific player knows something the
     league-wide schedule does not, such as a relocated game. */
  const payload = fixtureWithoutKickoffs();
  payload.matchups[0].home.starters[1].kickoff = SNF;   // Monday Back, moved
  const rows = calculatePlayerOutcomeFlags(payload, {
    week: 2, kickoffs: parseProTeamKickoffs(scoreboard()),
  });
  assert.equal(rows.find((row) => row.player_name === 'Monday Back').slot, 'SNF');
});

test('an index missing one team leaves that matchup unresolved, not guessed', () => {
  /* Half a schedule is worse than none: a starter whose game cannot be placed
     would silently drop out of the "before" sum and manufacture a deficit. */
  const index = parseProTeamKickoffs(scoreboard());
  delete index['9'];
  delete index.MIA;
  const rows = calculatePlayerOutcomeFlags(fixtureWithoutKickoffs(), { week: 2, kickoffs: index });
  const ghost = rows.find((row) => row.player_name === 'Monday Ghost');
  assert.equal(ghost.outcome_flag, null);
  assert.equal(ghost.unresolved_reason, 'MISSING_KICKOFF_DATA');
});

test('the pipeline joins the scoreboard and publishes a real impact summary', async () => {
  /* The whole point, end to end: a box score with NO kickoff times of its own
     (which is what ESPN's fantasy endpoint returns) plus the scoreboard, and
     the article comes out with flags and a populated tier 2. */
  const db = fakeDb();
  const asked = [];
  const result = await run({ deps: {
    db,
    fetchBoxScores: async () => fixtureWithoutKickoffs(),
    fetchKickoffs: async (input) => { asked.push(input); return parseProTeamKickoffs(scoreboard()); },
  } });

  assert.deepEqual(asked, [{ season: 2026, week: 2 }], 'the scoreboard is asked for this article\'s week');
  assert.ok(result.kickoffs > 0, 'the run reports how many teams the index covered');

  const record = result.record;
  assert.ok(record.match_impact_summary.length > 0, 'tier 2 is populated');

  /* The callout must name a GAME_WINNER when the week has one, and say of him
     only what that flag allows. Checked against the row the article actually
     carries rather than a hardcoded name: this fixture has two legitimate
     game-winners and either is a correct pick. */
  const winners = record.tracked_players.filter((row) => row.outcome_flag === 'GAME_WINNER');
  assert.ok(winners.length > 0, 'the fixture week has a game-winner to call out');
  const named = winners.find((row) => record.match_impact_summary.startsWith(row.player_name));
  assert.ok(named, 'the callout leads with a GAME_WINNER, not a lesser flag: ' +
    JSON.stringify(record.match_impact_summary));
  assert.equal(
    record.match_impact_summary,
    named.player_name + ' scored ' + named.player_points + ' points, just enough for ' + named.owner_team + '.',
    'and it is the flag\'s own fixed phrasing, with his real number',
  );

  const flagged = record.tracked_players.filter((row) => row.outcome_flag);
  assert.ok(flagged.length > 0, 'the math assigned outcome flags');
  assert.equal(record.tracked_players.some((row) => row.unresolved_reason === 'MISSING_KICKOFF_DATA'), false,
    'nothing is left unplaced once the index is in hand');
  assert.equal(record.headline.includes('No Swings To Report'), false,
    'and the headline is no longer the empty-week one');
});

test('the same payload without the scoreboard publishes the unresolved article', async () => {
  /* The degrade, stated: a scoreboard that cannot be read costs the flags and
     the callout, and still publishes. Losing the league's article entirely
     would be worse than losing the swing analysis. */
  const db = fakeDb();
  const result = await run({ deps: {
    db,
    fetchBoxScores: async () => fixtureWithoutKickoffs(),
    fetchKickoffs: async () => { throw new Error('KICKOFF_FEED_HTTP_503'); },
  } });

  assert.equal(result.stored, true, 'the article is still published');
  assert.equal(result.kickoffs, 0, 'and the run reports that the index was empty');
  assert.equal(result.record.match_impact_summary, '', 'with no callout invented');
  assert.equal(result.record.tracked_players.every((row) => row.outcome_flag === null), true);
});

test('a scoreboard that returns nothing usable is the same degrade, not a crash', async () => {
  for (const bad of [null, undefined, {}]) {
    const db = fakeDb();
    const result = await run({ deps: {
      db,
      fetchBoxScores: async () => fixtureWithoutKickoffs(),
      fetchKickoffs: async () => bad,
    } });
    assert.equal(result.stored, true, JSON.stringify(bad) + ' must still publish');
    assert.equal(result.record.match_impact_summary, '');
  }
});

test('the callout prefers the flag that actually decided something', async () => {
  /* Order stated, not inherited: a matchup that was won outranks one thrown
     away, which outranks a big score that changed nothing, which outranks
     padding in a game already decided. The fixture carries all four, and
     featuredTrackedPlayers ranks a VALIANT_LOSS above a GAME_WINNER, so
     taking its first flagged row picked the wrong one. */
  const { record } = await run({ deps: { db: fakeDb() } });

  const flags = new Set(record.tracked_players.map((row) => row.outcome_flag).filter(Boolean));
  assert.ok(flags.has('GAME_WINNER'), 'the fixture week has a game-winner');
  assert.ok(flags.size > 1, 'alongside lesser flags, or this asserts nothing');

  const winners = record.tracked_players.filter((row) => row.outcome_flag === 'GAME_WINNER');
  assert.ok(winners.some((row) => record.match_impact_summary.startsWith(row.player_name)),
    'the callout leads with a game-winner: ' + JSON.stringify(record.match_impact_summary));

  /* A GARBAGE_TIME_BLOWOUT is the least meaningful thing the math can flag and
     must never be the callout while anything else is available. */
  assert.equal(/did not affect the blowout/.test(record.match_impact_summary), false);
});

test('a payload that already carries kickoffs is unaffected by the join', async () => {
  /* Non-regression: the fixture with declared kickoffs must publish exactly
     what it published before the scoreboard existed. */
  const withScoreboard = await run({ deps: { db: fakeDb() } });
  const withoutScoreboard = await run({ deps: { db: fakeDb(), fetchKickoffs: async () => ({}) } });

  assert.equal(withScoreboard.record.headline, withoutScoreboard.record.headline);
  assert.equal(withScoreboard.record.match_impact_summary, withoutScoreboard.record.match_impact_summary);
  assert.equal(withScoreboard.record.content, withoutScoreboard.record.content);
  assert.ok(withScoreboard.record.match_impact_summary.length > 0);
});

/* --------------------------------------------------------------------------
   TEAM NAMES

   ESPN's schedule[] entries carry only teamId; the names live in the payload's
   top-level teams[]. A side normalized from the schedule alone fell back to
   "Team 3", and every published article named its teams that way:
   "Davante Adams won the matchup for Team 3."
-------------------------------------------------------------------------- */

/* The schedule shape ESPN actually returns: sides keyed by teamId only, with
   the names carried separately. */
function espnShapedPayload(teams) {
  const entry = (id, name, points, proTeamId) => ({
    lineupSlotId: 2,
    appliedStatTotal: points,
    proTeamId,
    playerPoolEntry: { id, appliedStatTotal: points, player: { id, fullName: name, proTeamId } },
  });
  return {
    teams,
    schedule: [{
      id: 'm1',
      matchupPeriodId: 2,
      home: { teamId: 1, totalPoints: 80, rosterForCurrentScoringPeriod: { entries: [
        entry(1, 'Early Anchor', 60, '3'), entry(2, 'Monday Back', 20, '9'),
      ] } },
      away: { teamId: 2, totalPoints: 74, rosterForCurrentScoringPeriod: { entries: [
        entry(3, 'Sunday Wideout', 74, '3'), entry(4, 'Quiet Tight End', 0, '5'),
      ] } },
    }],
  };
}

const teamNamesOf = (payload) => {
  const rows = calculatePlayerOutcomeFlags(payload, {
    week: 2, kickoffs: parseProTeamKickoffs(scoreboard()),
  });
  return [...new Set(rows.map((row) => row.owner_team))].sort();
};

test('a side is named from the payload\'s teams[], not "Team <id>"', () => {
  const named = teamNamesOf(espnShapedPayload([
    { id: 1, name: 'Ridgeback FC', abbrev: 'RID' },
    { id: 2, name: 'Cobalt Kings', abbrev: 'COB' },
  ]));
  assert.deepEqual(named, ['Cobalt Kings', 'Ridgeback FC']);
});

test('the older location + nickname split is joined', () => {
  const named = teamNamesOf(espnShapedPayload([
    { id: 1, location: 'Ridgeback', nickname: 'FC', abbrev: 'RID' },
    { id: 2, location: 'Cobalt', nickname: 'Kings', abbrev: 'COB' },
  ]));
  assert.deepEqual(named, ['Cobalt Kings', 'Ridgeback FC']);
});

test('an abbreviation beats the numeric fallback, which still exists', () => {
  const abbrevOnly = teamNamesOf(espnShapedPayload([
    { id: 1, abbrev: 'RID' }, { id: 2, abbrev: 'COB' },
  ]));
  assert.deepEqual(abbrevOnly, ['COB', 'RID']);

  // No teams[] at all is still an article, just an unnamed one.
  const nameless = teamNamesOf(espnShapedPayload([]));
  assert.deepEqual(nameless, ['Team 1', 'Team 2']);
});

test('a side carrying its own name keeps it over the teams[] index', () => {
  /* The fixture shape used throughout this file names its sides inline, and
     must not start being overwritten by a teams[] lookup. */
  const payload = espnShapedPayload([{ id: 1, name: 'From The Index' }]);
  payload.schedule[0].home.team_name = 'From The Side';
  const rows = calculatePlayerOutcomeFlags(payload, {
    week: 2, kickoffs: parseProTeamKickoffs(scoreboard()),
  });
  assert.ok(rows.some((row) => row.owner_team === 'From The Side'));
  assert.equal(rows.some((row) => row.owner_team === 'From The Index'), false);
});
