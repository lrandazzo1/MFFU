#!/usr/bin/env node
/* ============================================================================
   FSN — EDITORIAL TIMING AUDIT

   `npm run test:editorial-timing`

   A DRY RUN of lib/article-generator.ts across every window of the NFL week.
   Nothing here fetches, nothing writes, and nothing touches Supabase: the
   composer is called directly and its markdown is inspected. That is the whole
   point. The composer is the one part of the pipeline that decides what a
   reader sees, and it is pure by contract, so it can be audited exhaustively
   without credentials, without a network, and without a database.

   ---- WHY A MATRIX ----

   The article a reader gets depends on two things that used to be conflated:
   WHICH article the cron asked for, and HOW MUCH OF THE WEEK HAS BEEN PLAYED
   when it asks. The Friday run is the case that made this obvious. It fires at
   08:00 UTC, which is the morning AFTER Thursday night, and for a long time it
   published "Friday Night Preview" with pre-game projections for players who
   had already finished playing. The headline was wrong, the numbers were
   stale, and nothing in the suite noticed, because every existing test pinned
   one clock.

   So this audit sweeps the clock instead. Eleven windows, from Thursday
   teatime to the following Wednesday, crossed with the article types the cron
   actually requests in each, crossed with the payload shapes a provider
   actually returns.

   ---- THE SIMULATION MODEL ----

   One fixture holds the week's FINAL box score. `stateAt(payload, clock)` then
   returns what a provider would have reported at that instant:

     PENDING  his game has not kicked off      0.00, projection intact
     LIVE     his game is running              half his final points
     FINAL    his game is over                 his full points

   That is the honest model. A provider does not know Monday's points on
   Friday, and a test that hands the composer a finished box score at a Friday
   clock is testing a week that cannot happen.

   ---- WHAT IS ASSERTED ----

   UNIVERSAL, in every cell of the matrix, no exceptions:

     NON_EMPTY    the markdown has a body, not just a headline
     NO_BARE      no heading is left with nothing under it. "## What the math
                  says" followed by end of file is the shape this exists to
                  catch: it shipped, and it renders as a heading floating over
                  white space
     NO_EM_DASH   the house rule, enforced by build-blog.mjs downstream
     NO_JUNK      no NaN, undefined, null or Infinity reached the copy
     FRAMING      assertOutcomeLanguage passes, so no cell can overclaim
     TITLE_ECHO   the body opens with the title it reports
     NO_DUMP      the retired "[Player] starts for [Team] on a [X] point
                  projection" line is gone and stays gone
     NO_FRIDAY    "Friday Night Preview" never comes back
     DETERMINISM  composing twice is byte identical
     PURITY       identical output with Date.now and Math.random sabotaged,
                  and no Supabase client constructed by any cell

   TARGETED, per cell: the exact label, the category tag, and the structural
   claims that window is supposed to make.

   Exit code 0 means clean. Every failure is collected and printed, rather than
   throwing on the first, because the useful output of a matrix is the shape of
   what broke.

   ---- WHY .mjs AND NOT .ts ----

   Every check in scripts/ is an .mjs run straight by node. The repo compiles
   exactly four files (tsconfig.articles.json, emitting to lib/dist) and has no
   build step for scripts, so a .ts audit would need a compile pass that
   nothing else here needs. It reads lib/dist, which is what the serverless
   routes require, so a stale build fails here rather than in production.
============================================================================ */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const { defaultComposer, assertOutcomeLanguage, CATEGORY_BY_TYPE, DEFAULT_AUTHOR } =
  require(join(root, 'lib/dist/article-generator'));
const { calculatePlayerOutcomeFlags, featuredTrackedPlayers } =
  require(join(root, 'lib/dist/article-math'));

const VERBOSE = process.argv.includes('--verbose');

/* ------------------------------------------------------------------ *
 * The week, on the real NFL clock
 * ------------------------------------------------------------------ */

const T = (iso) => Date.parse(iso);

const KICK = {
  TNF: T('2026-09-24T20:15:00-04:00'),
  SUN_EARLY: T('2026-09-27T13:00:00-04:00'),
  SUN_LATE: T('2026-09-27T16:25:00-04:00'),
  SNF: T('2026-09-27T20:20:00-04:00'),
  MNF: T('2026-09-28T20:15:00-04:00'),
};

/** Mirrors GAME_WINDOW_MS in the generator: four hours covers regulation,
 *  overtime and the stat corrections that trail a game. */
const GAME_WINDOW_MS = 4 * 60 * 60 * 1000;

/* The eleven windows. `day` is what the cron would ask for at that instant:
   the Friday slot covers Thursday through Saturday, then Monday and Tuesday
   have their own runs, and Wednesday still resolves to the Tuesday recap. */
const WINDOWS = [
  { key: 'THU_PREGAME', label: 'Thursday, pre-game', at: T('2026-09-24T18:00:00-04:00'), day: 'fri' },
  { key: 'THU_MIDGAME', label: 'Thursday, mid-game', at: T('2026-09-24T21:30:00-04:00'), day: 'fri' },
  { key: 'FRI_MORNING', label: 'Friday morning (the cron slot)', at: T('2026-09-25T04:00:00-04:00'), day: 'fri' },
  { key: 'FRI_AFTERNOON', label: 'Friday afternoon', at: T('2026-09-25T15:00:00-04:00'), day: 'fri' },
  { key: 'SUN_EARLY', label: 'Sunday, early window live', at: T('2026-09-27T13:30:00-04:00'), day: 'fri' },
  { key: 'SUN_AFTERNOON', label: 'Sunday, late window live', at: T('2026-09-27T17:00:00-04:00'), day: 'fri' },
  { key: 'SUN_SNF', label: 'Sunday night football live', at: T('2026-09-27T21:00:00-04:00'), day: 'fri' },
  { key: 'MON_PRE_MNF', label: 'Monday, before MNF', at: T('2026-09-28T04:00:00-04:00'), day: 'mon' },
  { key: 'MON_MNF_LIVE', label: 'Monday night football live', at: T('2026-09-28T21:00:00-04:00'), day: 'mon' },
  { key: 'TUE_FINAL', label: 'Tuesday, week complete', at: T('2026-09-29T04:00:00-04:00'), day: 'tue' },
  { key: 'WED_FINAL', label: 'Wednesday, week complete', at: T('2026-09-30T04:00:00-04:00'), day: 'tue' },
];

const TYPE_BY_DAY = { fri: 'friday_tnf_preview', mon: 'monday_sweat', tue: 'tuesday_verdict' };

/* ------------------------------------------------------------------ *
 * The fixture: one week's FINAL box score
 *
 * Built so all four outcome flags are reachable once the week completes, and
 * so every kickoff window carries a starter. A fixture whose players all kick
 * off together cannot tell a Sunday article from a Monday one.
 * ------------------------------------------------------------------ */

const starter = (id, name, points, window, projected) =>
  ({ player_id: id, player_name: name, player_points: points, kickoff: KICK[window], projected_points: projected });

const side = (teamId, teamName, starters) => ({ team_id: teamId, team_name: teamName, starters });

function fixture() {
  return {
    matchups: [
      /* Ridgeback trail by 10 into Monday night and win by 7 on a 22 point
         MNF back: GAME_WINNER for him, DUD_COST_WIN for the man opposite who
         came in 9 under projection in a game his side led. */
      { id: 'm1',
        home: side('1', 'Ridgeback FC', [
          starter('r1', 'Ridge Thursday', 12.0, 'TNF', 14.0),
          starter('r2', 'Ridge Early', 18.0, 'SUN_EARLY', 16.0),
          starter('r3', 'Ridge Late', 9.0, 'SUN_LATE', 11.0),
          starter('r4', 'Ridge Sunday Night', 7.0, 'SNF', 8.0),
          starter('r5', 'Ridge Monday', 22.0, 'MNF', 15.0),
        ]),
        away: side('2', 'Cobalt Kings', [
          starter('c1', 'Cobalt Thursday', 20.0, 'TNF', 15.0),
          starter('c2', 'Cobalt Early', 14.0, 'SUN_EARLY', 13.0),
          starter('c3', 'Cobalt Late', 12.0, 'SUN_LATE', 12.0),
          starter('c4', 'Cobalt Sunday Night', 10.0, 'SNF', 9.0),
          starter('c5', 'Cobalt Monday', 5.0, 'MNF', 14.0),
        ]) },

      /* A rout from the first whistle: GARBAGE_TIME_BLOWOUT. */
      { id: 'm2',
        home: side('3', 'Harbor Watch', [
          starter('h1', 'Harbor Thursday', 30.0, 'TNF', 25.0),
          starter('h2', 'Harbor Early', 25.0, 'SUN_EARLY', 20.0),
          starter('h3', 'Harbor Late', 20.0, 'SUN_LATE', 18.0),
          starter('h4', 'Harbor Sunday Night', 15.0, 'SNF', 14.0),
          starter('h5', 'Harbor Monday', 18.0, 'MNF', 12.0),
        ]),
        away: side('4', 'Pine Street', [
          starter('p1', 'Pine Thursday', 5.0, 'TNF', 12.0),
          starter('p2', 'Pine Early', 8.0, 'SUN_EARLY', 14.0),
          starter('p3', 'Pine Late', 6.0, 'SUN_LATE', 11.0),
          starter('p4', 'Pine Sunday Night', 4.0, 'SNF', 9.0),
          starter('p5', 'Pine Monday', 7.0, 'MNF', 13.0),
        ]) },

      /* A 40 point Sunday afternoon in a losing week: VALIANT_LOSS. */
      { id: 'm3',
        home: side('5', 'Copper Lane', [
          starter('k1', 'Copper Thursday', 8.0, 'TNF', 10.0),
          starter('k2', 'Copper Early', 40.0, 'SUN_EARLY', 18.0),
          starter('k3', 'Copper Late', 5.0, 'SUN_LATE', 10.0),
          starter('k4', 'Copper Sunday Night', 6.0, 'SNF', 8.0),
          starter('k5', 'Copper Monday', 4.0, 'MNF', 12.0),
        ]),
        away: side('6', 'Delta Nine', [
          starter('d1', 'Delta Thursday', 15.0, 'TNF', 12.0),
          starter('d2', 'Delta Early', 20.0, 'SUN_EARLY', 16.0),
          starter('d3', 'Delta Late', 14.0, 'SUN_LATE', 12.0),
          starter('d4', 'Delta Sunday Night', 12.0, 'SNF', 10.0),
          starter('d5', 'Delta Monday', 10.0, 'MNF', 11.0),
        ]) },
    ],
  };
}

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * What a provider would report at `clock`.
 *
 * `zeroTotals` reproduces the shape ESPN actually returns for a matchup period
 * that has not closed: both side totals come back 0 while the individual
 * starters carry real points. Every margin the math derives from a side total
 * is then 0, which is the bug that had every live matchup reading "dead
 * level". The composer sums the board instead, and this flag is how that stays
 * proven rather than remembered.
 */
function stateAt(payload, clock, { zeroTotals = false, limitStarters = 0 } = {}) {
  const shape = (entry) => {
    const kickoff = entry.kickoff;
    let points = 0;
    if (clock >= kickoff + GAME_WINDOW_MS) points = entry.player_points;
    else if (clock >= kickoff) points = round2(entry.player_points / 2);
    return { ...entry, player_points: points };
  };

  const shapeSide = (s) => {
    let starters = s.starters.map(shape);
    if (limitStarters) starters = starters.slice(0, limitStarters);
    const visible = round2(starters.reduce((sum, e) => sum + e.player_points, 0));
    return { ...s, starters, total_points: zeroTotals ? 0 : visible };
  };

  return {
    matchups: payload.matchups.map((m) => ({
      id: m.id, home: shapeSide(m.home), away: shapeSide(m.away),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Failure collection
 * ------------------------------------------------------------------ */

const failures = [];
let checks = 0;

function check(cell, name, condition, detail) {
  checks++;
  if (condition) {
    if (VERBOSE) console.log(`  ok    ${cell} ${name}`);
    return true;
  }
  failures.push({ cell, name, detail: String(detail == null ? '' : detail).slice(0, 400) });
  return false;
}

/* ------------------------------------------------------------------ *
 * Universal invariants
 * ------------------------------------------------------------------ */

const BANNED_JUNK = /\b(?:NaN|undefined|null|Infinity)\b/;
const PROJECTION_DUMP = /starts for .+ on an? [\d.]+ point projection/i;

/**
 * Headings with nothing underneath them.
 *
 * A section counts as having a body if prose appears anywhere before the next
 * heading AT THE SAME OR A HIGHER LEVEL. Nesting is not emptiness: the preview
 * opens "## Where the week stands" and then puts every sentence under a "###"
 * per matchup, which is ordinary structure. What this is looking for is the
 * shape that actually shipped, where "## What the math says" was the last
 * thing in the file and rendered as a heading floating over white space.
 */
function bareHeadings(markdown) {
  const lines = String(markdown).split('\n');
  const bare = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,6})\s+\S/.exec(lines[i].trim());
    if (!heading) continue;
    const level = heading[1].length;
    let hasBody = false;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next) continue;
      const nested = /^(#{1,6})\s+/.exec(next);
      if (nested) {
        // A deeper heading is a subsection: its content counts as this one's.
        if (nested[1].length <= level) break;
        continue;
      }
      hasBody = true;
      break;
    }
    if (!hasBody) bare.push(lines[i].trim());
  }
  return bare;
}

function universal(cell, draft, tracked) {
  const md = String(draft.content_markdown || '');
  check(cell, 'NON_EMPTY', md.trim().length > 40, JSON.stringify(md.slice(0, 120)));
  const bare = bareHeadings(md);
  check(cell, 'NO_BARE', bare.length === 0, 'bare heading(s): ' + bare.join(' | '));
  check(cell, 'NO_EM_DASH', !/[—―]/.test(md + draft.title + draft.excerpt), md);
  check(cell, 'NO_JUNK', !BANNED_JUNK.test(md) && !BANNED_JUNK.test(draft.match_impact_summary || ''),
    md.split('\n').find((l) => BANNED_JUNK.test(l)));
  check(cell, 'NO_DUMP', !PROJECTION_DUMP.test(md), md.split('\n').find((l) => PROJECTION_DUMP.test(l)));
  check(cell, 'NO_FRIDAY', !/Friday Night Preview/.test(md) && !/Friday/.test(draft.title), draft.title);
  check(cell, 'TITLE_ECHO', md.startsWith('# ' + draft.title), draft.title + ' vs ' + md.slice(0, 80));

  let framingThrew = null;
  try { assertOutcomeLanguage(draft, tracked); } catch (err) { framingThrew = err.message; }
  check(cell, 'FRAMING', framingThrew === null, framingThrew);
}

/* ------------------------------------------------------------------ *
 * Determinism and purity
 *
 * The composer is documented as pure: no clock, no randomness, no I/O, and
 * every draw from the data it was handed. That is asserted rather than
 * trusted, by SABOTAGING the two ambient sources and requiring byte identical
 * output. A composer that read either one would diverge here.
 *
 * The Supabase check is the direct reading of "without writing to Supabase":
 * `database()` in the generator lazily requires @supabase/supabase-js, so if
 * any composed cell had reached for storage, the module would appear in the
 * require cache. It must not.
 * ------------------------------------------------------------------ */

const SUPABASE_MODULE = /@supabase[\\/]supabase-js/;

function supabaseLoaded() {
  return Object.keys(require.cache).some((key) => SUPABASE_MODULE.test(key));
}

function composeTwiceUnderSabotage(cell, request) {
  const first = defaultComposer(request);

  const realNow = Date.now;
  const realRandom = Math.random;
  let second;
  try {
    Date.now = () => 8.64e12;          // a different decade
    Math.random = () => 0.999999;      // a different draw
    second = defaultComposer(request);
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }

  check(cell, 'DETERMINISM', first.content_markdown === second.content_markdown,
    'output differed when Date.now and Math.random were replaced');
  check(cell, 'DETERMINISM_TITLE', first.title === second.title, first.title + ' vs ' + second.title);
  check(cell, 'DETERMINISM_CALLOUT', first.match_impact_summary === second.match_impact_summary,
    first.match_impact_summary + ' vs ' + second.match_impact_summary);
  return first;
}

/* ------------------------------------------------------------------ *
 * One cell
 * ------------------------------------------------------------------ */

function runCell(window, payloadOptions, variantLabel) {
  const articleType = TYPE_BY_DAY[window.day];
  const cell = `${window.key}/${variantLabel}`;

  const shaped = stateAt(fixture(), window.at, payloadOptions);
  const evaluated = calculatePlayerOutcomeFlags(shaped, { week: 3, kickoffs: {} });
  const tracked = featuredTrackedPlayers(evaluated);

  const request = {
    system_prompt: '', user_prompt: '', league_id: '123456',
    season: 2026, week: 3, day: window.day, article_type: articleType,
    tracked_players: tracked, all_players: evaluated, now: window.at,
  };

  const draft = composeTwiceUnderSabotage(cell, request);
  universal(cell, draft, tracked);

  check(cell, 'CATEGORY', draft.category === CATEGORY_BY_TYPE[articleType], draft.category);
  check(cell, 'AUTHOR', draft.author === DEFAULT_AUTHOR, draft.author);

  return { cell, window, articleType, draft, evaluated, tracked, shaped };
}

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

console.log('[audit-editorial-timing] sweeping ' + WINDOWS.length + ' windows\n');

const VARIANTS = [
  { label: 'normal', options: {} },
  /* The real ESPN shape for an open matchup period. */
  { label: 'zeroed-totals', options: { zeroTotals: true } },
  /* The featured-eight truncation: enough rows to compose, not enough to be a
     lineup. Nothing may claim a finished matchup off this. */
  { label: 'thin-data', options: { limitStarters: 2 } },
];

const results = [];
for (const window of WINDOWS) {
  for (const variant of VARIANTS) {
    results.push(runCell(window, variant.options, variant.label));
  }
}

check('PURITY', 'NO_SUPABASE', !supabaseLoaded(),
  'a composed cell caused @supabase/supabase-js to be required');

/* ------------------------------------------------------------------ *
 * Targeted expectations
 * ------------------------------------------------------------------ */

const byCell = new Map(results.map((r) => [r.cell, r]));
const get = (key, variant = 'normal') => byCell.get(`${key}/${variant}`);

/* ---- 1. The label matches the day AND the state ---- */

const LABEL_EXPECTATIONS = {
  THU_PREGAME: 'Thursday Night Preview: Week 3,',
  THU_MIDGAME: 'TNF Breakdown: Week 3,',
  FRI_MORNING: 'TNF Breakdown: Week 3,',
  FRI_AFTERNOON: 'TNF Breakdown: Week 3,',
  SUN_EARLY: 'TNF Breakdown: Week 3,',
  SUN_AFTERNOON: 'TNF Breakdown: Week 3,',
  SUN_SNF: 'TNF Breakdown: Week 3,',
  MON_PRE_MNF: 'Monday Sweat: Week 3,',
  MON_MNF_LIVE: 'Monday Sweat: Week 3,',
  TUE_FINAL: 'Tuesday Verdict: Week 3,',
  WED_FINAL: 'Tuesday Verdict: Week 3,',
};

for (const [key, expected] of Object.entries(LABEL_EXPECTATIONS)) {
  for (const variant of VARIANTS) {
    const r = get(key, variant.label);
    check(r.cell, 'LABEL', r.draft.title.startsWith(expected),
      `expected "${expected}..." got "${r.draft.title}"`);
  }
}

/* ---- 2. Friday groups Thursday's actual points with what is still to come ---- */

{
  const r = get('FRI_MORNING');
  const md = r.draft.content_markdown;
  check(r.cell, 'FRI_SECTION_LIVE', md.includes('## Where the week stands'), md.slice(0, 200));
  check(r.cell, 'FRI_SECTION_UPCOMING', md.includes('## Still on the clock') || md.includes('still to play'),
    md.slice(0, 300));
  /* Thursday is FINAL at this clock, so the real number is quoted. */
  check(r.cell, 'FRI_TNF_ACTUAL', /\*\*30\.00 pts\*\*/.test(md), 'Harbor Thursday 30.00 not quoted');
  /* Sunday and Monday have not kicked off, so they appear as projections. */
  check(r.cell, 'FRI_UPCOMING_PROJECTED', /projected/.test(md), md.slice(0, 400));
  /* And both live in the SAME matchup block, which is the grouping claim. */
  const block = md.split('### ').find((b) => /pts\*\*/.test(b) && /projected/.test(b));
  check(r.cell, 'FRI_GROUPED', Boolean(block),
    'no block carried both a played number and an upcoming projection');
  /* Nothing is called finished while 24 starters have yet to play. */
  check(r.cell, 'FRI_NOT_FINAL', !/The Board Is In|Every starter is in|came out/.test(md), md.slice(0, 300));
}

/* ---- 3. Thursday pre-game is a projection article, not a results one ---- */

{
  const r = get('THU_PREGAME');
  const md = r.draft.content_markdown;
  check(r.cell, 'THU_NO_RESULTS', !/pts\*\*/.test(md), 'quoted points before a snap was played');
  check(r.cell, 'THU_PROJECTIONS', /project within|on the projections|projected/.test(md), md.slice(0, 300));
  check(r.cell, 'THU_ON_THE_CLOCK', /On The Clock/.test(r.draft.title), r.draft.title);
}

/* ---- 4. Margin math survives zeroed totals and thin data ----

   The board-summed margin is the PREVIEW path's guarantee, so it is asserted
   on preview cells. The recap path still reads `final_margin`, which is
   `side.total - opponent.total` out of `article-math`, so a recap composed
   against zeroed totals does inherit them. That is latent rather than live:
   the recap runs Monday and Tuesday, by which point the matchup period has
   closed and ESPN reports real totals. It is asserted as a KNOWN BOUNDARY
   below rather than left undocumented, so that if it ever stops being merely
   latent, this notices. */

for (const key of ['FRI_MORNING', 'SUN_EARLY', 'SUN_SNF']) {
  const normal = get(key);
  const zeroed = get(key, 'zeroed-totals');

  /* The whole point: ESPN reporting 0 for both side totals must not change a
     single number the reader sees, because the board is summed instead. */
  check(zeroed.cell, 'ZEROED_MATCHES_NORMAL', zeroed.draft.content_markdown === normal.draft.content_markdown,
    'zeroed side totals changed the article');
  check(zeroed.cell, 'ZEROED_NOT_LEVEL', !/dead level|Nothing separates/.test(zeroed.draft.content_markdown),
    zeroed.draft.content_markdown.slice(0, 300));

  /* Every row the math produced carried final_margin 0 in the zeroed variant.
     If that is no longer true the fixture has stopped reproducing the bug. */
  const allZero = zeroed.evaluated.every((row) => row.final_margin === 0);
  check(zeroed.cell, 'ZEROED_FIXTURE_VALID', allZero,
    'fixture no longer reproduces the zeroed-total shape');
}

for (const key of ['FRI_MORNING', 'TUE_FINAL']) {
  const thin = get(key, 'thin-data');
  check(thin.cell, 'THIN_NO_FINALITY', !/The Board Is In|Every starter is in|came out \*\*/.test(thin.draft.content_markdown),
    thin.draft.content_markdown.slice(0, 300));
}

/* The recap boundary, stated as an assertion so it cannot drift silently.
   Monday and Tuesday derive their margins from the provider's side totals, so
   zeroing those DOES change the recap. The cron never composes a recap against
   an open matchup period, which is why this is recorded rather than fixed
   here: changing it means changing article-math's margin source, which CLAUDE.md
   puts off limits without a request naming it. */
{
  const normal = get('MON_MNF_LIVE');
  const zeroed = get('MON_MNF_LIVE', 'zeroed-totals');
  check(zeroed.cell, 'RECAP_ZEROED_IS_KNOWN_BOUNDARY',
    zeroed.draft.content_markdown !== normal.draft.content_markdown,
    'the recap path no longer depends on provider side totals: this boundary note is now stale ' +
      'and the assertion should be tightened to match the preview path');
  /* Whatever it says, it may not say nothing, and it may not overclaim. */
  check(zeroed.cell, 'RECAP_ZEROED_STILL_HONEST',
    zeroed.draft.content_markdown.trim().length > 40 &&
      !/padded the score with \*\*0\.00 pts\*\*/.test(zeroed.draft.content_markdown),
    zeroed.draft.content_markdown.slice(0, 300));
}

/* ---- 5. A recap board never credits a man who has not played ----

   Found by this matrix. A Thursday night clock flags four of Harbor Watch's
   starters GARBAGE_TIME_BLOWOUT, because the matchup is already 25 clear
   before any of them kick off, and the board printed "padded the score with
   0.00 pts" for a player who would not be on a field until Sunday. The flags
   are right; crediting an unplayed man for them is not. ---- */

const ZERO_CREDIT = /(?:tacked on|padded the score with|notched|scoring|adding|dropping|banking) \*\*0\.00 pts\*\*/i;

for (const r of results) {
  check(r.cell, 'NO_ZERO_CREDIT', !ZERO_CREDIT.test(r.draft.content_markdown),
    r.draft.content_markdown.split('\n').find((l) => ZERO_CREDIT.test(l)));
}

{
  /* Thursday night only, as a recap. Every Sunday and Monday starter is still
     at 0.00, so the board may only carry men who have actually played. */
  const clock = KICK.TNF + GAME_WINDOW_MS + 1000;
  const shaped = stateAt(fixture(), clock, {});
  const evaluated = calculatePlayerOutcomeFlags(shaped, { week: 3, kickoffs: {} });
  const tracked = featuredTrackedPlayers(evaluated);
  const draft = defaultComposer({
    system_prompt: '', user_prompt: '', league_id: '123456', season: 2026, week: 3,
    day: 'tue', article_type: 'tuesday_verdict', tracked_players: tracked,
    all_players: evaluated, now: clock,
  });
  const cell = 'RECAP_THURSDAY_ONLY/normal';
  universal(cell, draft, tracked);
  check(cell, 'NO_ZERO_CREDIT', !ZERO_CREDIT.test(draft.content_markdown),
    draft.content_markdown.split('\n').find((l) => ZERO_CREDIT.test(l)));

  /* Every bullet names a Thursday player, because nobody else has played. */
  const bullets = draft.content_markdown.split('\n').filter((l) => l.trim().startsWith('- '));
  check(cell, 'ONLY_PLAYED_ON_BOARD',
    bullets.every((l) => /Thursday/.test(l)),
    bullets.find((l) => !/Thursday/.test(l)));

  /* And a board with nothing left on it is prose, never a bare heading. */
  const empty = defaultComposer({
    system_prompt: '', user_prompt: '', league_id: '123456', season: 2026, week: 3,
    day: 'tue', article_type: 'tuesday_verdict',
    tracked_players: tracked.map((row) => ({ ...row, outcome_flag: null })),
    all_players: evaluated, now: clock,
  });
  universal('RECAP_EMPTY_BOARD/normal', empty, []);
  check('RECAP_EMPTY_BOARD/normal', 'EMPTY_BOARD_PROSE',
    /Nothing in week 3 turned a matchup/.test(empty.content_markdown), empty.content_markdown);
}

/* ---- 6. The Monday margin actually moves across MNF ---- */

{
  const pre = get('MON_PRE_MNF');
  const live = get('MON_MNF_LIVE');
  const final = get('TUE_FINAL');

  const marginFor = (r, team) => {
    const row = r.evaluated.find((x) => x.owner_team === team);
    return row ? row.final_margin : null;
  };

  /* Ridgeback trail into Monday night and are ahead by the end. A matrix that
     reports the same margin in all three windows is not simulating a clock. */
  check(pre.cell, 'MON_PRE_MARGIN', marginFor(pre, 'Ridgeback FC') === -10, marginFor(pre, 'Ridgeback FC'));
  check(final.cell, 'MON_FINAL_MARGIN', marginFor(final, 'Ridgeback FC') === 7, marginFor(final, 'Ridgeback FC'));
  check(live.cell, 'MON_LIVE_BETWEEN',
    marginFor(live, 'Ridgeback FC') > -10 && marginFor(live, 'Ridgeback FC') < 7,
    marginFor(live, 'Ridgeback FC'));

  /* Ridgeback trailed at every one of their kickoffs and won, so all four of
     their later starters clear the GAME_WINNER bar. The claim worth asserting
     is not that exactly one man is flagged, it is that the biggest of them
     leads the ranking the board is built from. */
  const winners = final.evaluated.filter((r) => r.outcome_flag === 'GAME_WINNER');
  check(final.cell, 'MON_GAME_WINNERS', winners.some((r) => r.player_name === 'Ridge Monday'),
    winners.map((r) => r.player_name).join(', ') || 'no GAME_WINNER flagged');
  /* Copper Early's wasted 40 outranks him on raw points, which is what the
     news weighting is supposed to do. The callout is where precedence matters:
     it takes GAME_WINNER ahead of VALIANT_LOSS by DECISIVE_PRIORITY, so the
     one line a reader takes away names the man who actually turned a matchup
     and not the biggest number on the page. */
  check(final.cell, 'MON_WINNER_RANKED_FIRST',
    final.tracked.find((r) => r.outcome_flag === 'GAME_WINNER')?.player_name === 'Ridge Monday',
    final.tracked.filter((r) => r.outcome_flag === 'GAME_WINNER').map((r) => r.player_name).join(', '));
  check(final.cell, 'MON_CALLOUT_PREFERS_WINNER',
    final.draft.match_impact_summary.startsWith('Ridge Monday scored'),
    final.draft.match_impact_summary);
  check(final.cell, 'MON_WINNER_IN_COPY',
    final.draft.content_markdown.includes('Ridge Monday'), final.draft.content_markdown.slice(0, 300));
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('WINDOW', 34) + pad('TYPE', 20) + 'HEADLINE');
console.log('-'.repeat(120));
for (const window of WINDOWS) {
  const r = get(window.key);
  console.log(pad(window.label, 34) + pad(r.articleType, 20) + r.draft.title);
}

console.log('\n' + checks + ' assertions across ' + results.length + ' matrix cells');

if (failures.length) {
  console.error('\n[audit-editorial-timing] ' + failures.length + ' FAILED\n');
  for (const f of failures) console.error(`  FAIL  ${f.cell}  ${f.name}\n        ${f.detail}`);
  process.exit(1);
}
console.log('[audit-editorial-timing] clean');
