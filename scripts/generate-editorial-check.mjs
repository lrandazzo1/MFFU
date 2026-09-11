#!/usr/bin/env node
/* ============================================================================
   FSN GENERATE-EDITORIAL CHECK — scripts/generate-editorial-check.mjs

   scripts/generate-editorial.mjs fetches real Sleeper data over the network,
   which this sandboxed check must not depend on (CI and review environments
   may have no route to api.sleeper.app at all). So this check exercises the
   pure data-shaping and validation functions the CLI calls after its fetches
   resolve, feeding them fixture payloads shaped exactly like real Sleeper API
   responses (league, rosters, users, matchups, and a player index).

   It pins:
     1. manager/team names are resolved from real roster owner_id -> user_id
        joins, with a loud fallback (never a guess) when a roster has no
        matching user
     2. performances and matchup margins are computed only from fetched
        starters_points / points, never fabricated
     3. every entity the composer emits appears verbatim in the article body
        it wrote (the ghost-entity guard), and the composer never emits zero
        entities for a week with real performances
     4. the em dash / horizontal bar ban catches a violation in any field,
        including one smuggled in through an entity name
     5. validateArticle() accepts the exact payload composeArticle() produces
        for a realistic fixture, end to end, with no network involved

   Exit code 0 means clean.
============================================================================ */
import {
  buildTeamIndex,
  buildPerformances,
  buildMatchupResults,
  composeArticle,
  validateArticle,
} from './generate-editorial.mjs';

let failures = 0;
function check(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { console.log('  ok    ' + name); return; }
  failures++;
  console.error('  FAIL  ' + name + '\n          got  ' + g + '\n          want ' + w);
}
function checkThrows(name, fn, messageIncludes) {
  try {
    fn();
    failures++;
    console.error('  FAIL  ' + name + '\n          expected a throw, got none');
  } catch (err) {
    if (messageIncludes && !String(err.message).includes(messageIncludes)) {
      failures++;
      console.error('  FAIL  ' + name + '\n          threw, but message missing "' + messageIncludes + '"\n          got: ' + err.message);
      return;
    }
    console.log('  ok    ' + name);
  }
}

/* ---- fixture data, shaped like real Sleeper API responses ---------------- */
const league = { league_id: '999000111', name: "Founders' League", season: '2026' };

const users = [
  { user_id: 'u1', display_name: 'Alex' },
  { user_id: 'u2', display_name: 'Jordan', metadata: { team_name: 'Jordan Squad' } },
  // roster 3 deliberately has no matching user, to exercise the fallback path
];

const rosters = [
  { roster_id: 1, owner_id: 'u1' },
  { roster_id: 2, owner_id: 'u2' },
  { roster_id: 3, owner_id: 'u3' },
  { roster_id: 4, owner_id: null },
];

const playersIndex = {
  '100': { full_name: 'Fixture Runner', position: 'RB' },
  '101': { full_name: 'Fixture Target', position: 'WR' },
  '200': { full_name: 'Fixture Passer', position: 'QB' },
  '201': { full_name: 'Fixture Blocker', position: 'TE' },
};

const matchupEntries = [
  { roster_id: 1, matchup_id: 1, points: 142.7, starters: ['100', '101'], starters_points: [42.7, 30] },
  { roster_id: 2, matchup_id: 1, points: 110.2, starters: ['200'], starters_points: [110.2] },
  { roster_id: 3, matchup_id: 2, points: 90.0, starters: ['201', '0'], starters_points: [90.0, 0] },
  { roster_id: 4, matchup_id: 2, points: 88.5, starters: ['999'], starters_points: [12.0] }, // unknown player id
];

/* ---- 1. team index: real join, loud fallback ------------------------------ */
console.log('\n[team index]');
const teamIndex = buildTeamIndex(rosters, users);
check('roster 1 resolves the real display name', teamIndex.get('1').managerName, 'Alex');
check('roster 2 prefers the team_name from user metadata', teamIndex.get('2').teamName, 'Jordan Squad');
check('roster 3 (unmatched owner_id) falls back rather than guessing', teamIndex.get('3').managerName, 'Manager 3');
check('roster 4 (null owner_id) falls back rather than guessing', teamIndex.get('4').managerName, 'Manager 4');

/* ---- 2. performances: only real starters_points survive ------------------ */
console.log('\n[performances]');
const performances = buildPerformances(matchupEntries, playersIndex, teamIndex);
check('sorted descending by real points', performances.map((p) => p.playerId), ['200', '201', '100', '101']);
check('an empty lineup slot ("0") is skipped, not fabricated', performances.some((p) => p.playerId === '0'), false);
check('an unresolvable player_id is skipped and never invented', performances.some((p) => p.playerId === '999'), false);
check('leader is attributed to the real owning manager', performances[0].managerName, 'Jordan');

/* ---- 3. matchup margins: computed from real points only ------------------ */
console.log('\n[matchup margins]');
const results = buildMatchupResults(matchupEntries, teamIndex);
check('two matchups resolved from four roster entries', results.length, 2);
const byMargin = results.slice().sort((a, b) => a.margin - b.margin);
check('closest margin computed from real scores (90.0 vs 88.5)', byMargin[0].margin, 1.5);
check('largest margin computed from real scores (142.7 vs 110.2)', byMargin[byMargin.length - 1].margin, 32.5);

/* ---- 4. composeArticle + validateArticle: real, end to end --------------- */
console.log('\n[composeArticle + validateArticle]');
const article = composeArticle({ league, week: 3, performances, results, date: '2026-09-18' });
{
  const name = 'a realistic fixture validates cleanly (throws nothing)';
  try {
    validateArticle(article);
    console.log('  ok    ' + name);
  } catch (err) {
    failures++;
    console.error('  FAIL  ' + name + '\n          unexpected throw: ' + err.message);
  }
}
check('slug is lowercase kebab-case derived from the real league name', article.slug, 'week-3-recap-founders-league');
check('every emitted entity is one of the real fetched players', article.entities.every((e) => Object.values(playersIndex).some((p) => p.full_name === e.name)), true);
const bodyHaystack = (article.title + ' ' + article.body).toLowerCase();
check('every entity name appears verbatim in the article body', article.entities.every((e) => bodyHaystack.includes(e.name.toLowerCase())), true);
check('article names the real leading scorer, not a placeholder', article.body.includes('Fixture Passer'), true);
check('no em dash anywhere in the composed body', /[—―]/.test(article.body), false);

/* ---- 5. validation guards actually catch a violation ---------------------- */
console.log('\n[validation guards]');
checkThrows('a ghost entity (never mentioned in the body) is rejected', () => {
  validateArticle({ ...article, entities: [...article.entities, { name: 'Nobody Mentioned', position: 'WR', sleeperPlayerId: '555' }] });
}, 'ghost entity');
checkThrows('an em dash smuggled into the excerpt is rejected', () => {
  validateArticle({ ...article, excerpt: 'A recap ' + String.fromCharCode(0x2014) + ' with a banned character.' });
}, 'em dash');
checkThrows('an em dash smuggled into an entity name is rejected', () => {
  validateArticle({ ...article, entities: [{ name: 'Bad' + String.fromCharCode(0x2014) + 'Name', position: 'WR', sleeperPlayerId: '1' }] });
}, 'em dash');
checkThrows('zero entities on a would-be recap is rejected', () => {
  validateArticle({ ...article, entities: [] });
}, 'zero entities');
checkThrows('composeArticle refuses to run with no performances', () => {
  composeArticle({ league, week: 3, performances: [], results, date: '2026-09-18' });
}, 'no starter performances');
checkThrows('composeArticle refuses to run with no matchup results', () => {
  composeArticle({ league, week: 3, performances, results: [], date: '2026-09-18' });
}, 'no completed head to head');

if (failures) {
  console.error('\n[generate-editorial-check] ' + failures + ' failed.');
  process.exit(1);
}
console.log('\n[generate-editorial-check] clean');
