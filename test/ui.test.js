/* Unit tests for two pure helpers that live inside index.html: the
   head-to-head series verdict (tie handling) and the /api/espn error reader
   (what is safe to show a user). Both are extracted by name from the single-file
   app and exercised directly, so index.html itself stays the source of truth. */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Lift a top-level `function NAME(...)` out of index.html by brace-matching.
function extract(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('index.html no longer defines ' + name);
  let depth = 0, i = SRC.indexOf('{', start);
  const open = i;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) break;
  }
  return SRC.slice(start, i + 1);
}

const h2hSeriesVerdict = new Function(extract('h2hSeriesVerdict') + '; return h2hSeriesVerdict;')();
// readRelayError logs through console.warn; give it a real console.
const readRelayError = new Function(extract('readRelayError') + '; return readRelayError;')();
const standingsRecordParts = new Function(extract('standingsRecordParts') + '; return standingsRecordParts;')();
const mergeStandingsRecords = new Function(
  extract('standingsRecordParts') + '\n' + extract('mergeStandingsRecords') + '; return mergeStandingsRecords;')();
// leagueScopeToken must be a global, reachable from every closure in the app.
const leagueScopeTokenSrc = extract('leagueScopeToken');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

console.log('h2hSeriesVerdict — a tied series has no leader');

let v = h2hSeriesVerdict({ winsFor: 3, winsAgainst: 3, ties: 0, meetingCount: 6, diff: 12.4 }, 'Ravens', 'Steelers');
check('3-3 reports tied', v.tied === true);
check('3-3 names no leader', v.leaderName === null, v.leaderName);
check('3-3 keeps the record readable', v.record === '3-3', v.record);

// Every meeting a tie: 0-0 is still a tie, not a win for whoever is listed first.
v = h2hSeriesVerdict({ winsFor: 0, winsAgainst: 0, ties: 2, meetingCount: 2, diff: 0 }, 'Ravens', 'Steelers');
check('0-0-2 reports tied', v.tied === true);
check('0-0-2 names no leader', v.leaderName === null, v.leaderName);
check('0-0-2 record carries the ties', v.record === '0-0-2', v.record);
check('0-0-2 points read level', v.pointsTied === true && v.pointsLeaderName === null);

v = h2hSeriesVerdict({ winsFor: 0, winsAgainst: 0, ties: 0, meetingCount: 0, diff: 0 }, 'Ravens', 'Steelers');
check('no meetings reports meetings=0', v.meetings === 0);
check('no meetings names no leader', v.leaderName === null);

v = h2hSeriesVerdict({ winsFor: 1, winsAgainst: 3, ties: 0, meetingCount: 4, diff: -88.2 }, 'Ravens', 'Steelers');
check('trailing A -> leader is B', v.leaderName === 'Steelers', v.leaderName);
check('trailing A -> trailer is A', v.trailerName === 'Ravens', v.trailerName);
check('tape reads leader-first (3-1, not 1-3)', v.tape === '3-1', v.tape);
check('record stays A-first for the tale of the tape', v.record === '1-3', v.record);
check('points leader tracked separately', v.pointsLeaderName === 'Steelers' && v.pointsMargin === 88.2,
  [v.pointsLeaderName, v.pointsMargin]);

v = h2hSeriesVerdict({ winsFor: 4, winsAgainst: 2, ties: 1, meetingCount: 7, diff: 0 }, 'Ravens', 'Steelers');
check('wins leader and level points coexist',
  v.leaderName === 'Ravens' && v.pointsTied === true && v.pointsLeaderName === null);
check('tape carries the tie column', v.tape === '4-2-1', v.tape);

v = h2hSeriesVerdict({ winsFor: 2, winsAgainst: 2, ties: 0, meetingCount: 4, diff: 0.03 }, 'A', 'B');
check('a sub-tenth point gap counts as level', v.pointsTied === true, v.pointsMargin);

v = h2hSeriesVerdict({ winsFor: 2, winsAgainst: 1, ties: 0, meetingCount: 3, diff: undefined }, 'A', 'B');
check('missing diff invents no points leader', v.pointsMargin === null && v.pointsLeaderName === null);
check('null input returns null', h2hSeriesVerdict(null, 'A', 'B') === null);

console.log('\nreadRelayError — only safe, plain text reaches the status line');

let r = readRelayError(JSON.stringify({
  error: 'ESPN has no 2026 season for League ID 1234567 yet.',
  reason: 'season-not-available', season: 2026, priorSeasonAvailable: 2025,
}));
check('reads the relay sentence', /no 2026 season/.test(r.error), r.error);
check('reads the reason code', r.reason === 'season-not-available', r.reason);
check('reads the season fields', r.season === 2026 && r.priorSeasonAvailable === 2025, r);

r = readRelayError('<html><body>Error: at Object.handler (/var/task/index.js:88:11)</body></html>');
check('non-JSON body yields no displayable message', r.error === '', r.error);
check('non-JSON body yields no reason', r.reason === '', r.reason);

r = readRelayError(JSON.stringify({ error: '<script>alert(1)</script> failed' }));
check('markup in the relay message is refused', r.error === '', r.error);

r = readRelayError(JSON.stringify({ error: 'x'.repeat(5000) }));
check('an oversized message is refused', r.error === '', r.error.length);

r = readRelayError(JSON.stringify({ error: '  ESPN   is   slow\n  right now. ' }));
check('whitespace is collapsed', r.error === 'ESPN is slow right now.', r.error);

check('empty body is handled', readRelayError('').error === '');
check('null body is handled', readRelayError(null).reason === '');
check('a JSON scalar is handled', readRelayError('42').error === '');

console.log('\nstandingsRecordParts — every shape a team record arrives in');

// Shape 3: the LeagueData.getTeams() display string. This is the one that used
// to read as all zeros, because "8-0".overall is undefined.
let p = standingsRecordParts('8-0');
check('string "8-0" -> 8 wins', p.wins === 8, p);
check('string "8-0" -> 0 losses', p.losses === 0, p);
check('string "8-0" -> 0 ties', p.ties === 0, p);
check('string "8-0" keeps the label', p.label === '8-0', p.label);
check('string "8-0" reports no points (a string cannot carry them)',
  p.pointsFor === null && p.pointsAgainst === null, p);

p = standingsRecordParts('7-3-1');
check('string "7-3-1" reads the tie column', p.wins === 7 && p.losses === 3 && p.ties === 1, p);

p = standingsRecordParts(' 10 - 4 ');
check('string tolerates whitespace', p.wins === 10 && p.losses === 4, p);

p = standingsRecordParts('8-0-1 (4-2)');
check('string tolerates a trailing split', p.wins === 8 && p.losses === 0 && p.ties === 1, p);

check('empty string yields nothing', standingsRecordParts('').wins === null);
check('non-record string yields nothing', standingsRecordParts('—').wins === null);
check('null yields nothing', standingsRecordParts(null).wins === null);
check('undefined yields nothing', standingsRecordParts(undefined).wins === null);

// Shape 2: a raw ESPN team record.
p = standingsRecordParts({ overall: { wins: 8, losses: 1, ties: 0, pointsFor: 1488.6, pointsAgainst: 1302.4 } });
check('ESPN {overall:{...}} reads W/L/T', p.wins === 8 && p.losses === 1 && p.ties === 0, p);
check('ESPN {overall:{...}} reads PF/PA', p.pointsFor === 1488.6 && p.pointsAgainst === 1302.4, p);

// Shape 1: an already-flat object.
p = standingsRecordParts({ wins: 5, losses: 5, ties: 0, pointsFor: 900, pointsAgainst: 910 });
check('flat object reads through', p.wins === 5 && p.pointsFor === 900 && p.pointsAgainst === 910, p);
p = standingsRecordParts({ w: 5, l: 5, pf: 900, pa: 910 });
check('short field names are accepted', p.wins === 5 && p.losses === 5 && p.pointsFor === 900, p);

// Zero must survive: it is a real value, not a missing one.
p = standingsRecordParts({ wins: 0, losses: 6, pointsFor: 0, pointsAgainst: 700 });
check('a genuine 0 is kept, not treated as absent', p.wins === 0 && p.pointsFor === 0, p);

// Garbage must not become a number.
p = standingsRecordParts({ wins: 'many', pointsFor: NaN });
check('non-numeric fields report as absent', p.wins === null && p.pointsFor === null, p);

console.log('\nmergeStandingsRecords — field-by-field across candidate shapes');

// The real fallback case: a getTeams() team, whose W/L is only in the display
// string and whose points only exist on the structured record.
let m = mergeStandingsRecords([
  { wins: undefined, losses: undefined, ties: undefined, pointsFor: undefined, pointsAgainst: undefined },
  undefined,
  { wins: 8, losses: 1, ties: 0, pointsFor: 1488.6, pointsAgainst: 1302.4 },
  '8-1',
]);
check('merge fills W/L/PF/PA from the structured record',
  m.wins === 8 && m.losses === 1 && m.pointsFor === 1488.6 && m.pointsAgainst === 1302.4, m);
check('merge keeps the display label', m.label === '8-1', m.label);

// A row that has its own counts but no points: points come from the team.
m = mergeStandingsRecords([
  { wins: 5, losses: 3, ties: 0, pointsFor: undefined, pointsAgainst: undefined },
  null,
  { wins: 9, losses: 9, ties: 9, pointsFor: 972, pointsAgainst: 948 },
]);
check('row counts win over the team record', m.wins === 5 && m.losses === 3, m);
check('points still come from the team record', m.pointsFor === 972 && m.pointsAgainst === 948, m);

// String-only team, no structured record at all: W/L parse, points stay absent.
m = mergeStandingsRecords([{}, undefined, null, '6-4-1']);
check('string-only team still yields W/L/T', m.wins === 6 && m.losses === 4 && m.ties === 1, m);
check('string-only team reports no points', m.pointsFor === null, m);

// Nothing anywhere.
m = mergeStandingsRecords([{}, null, undefined, '']);
check('no sources -> everything absent', m.wins === null && m.pointsFor === null && m.label === '', m);

console.log('\nleagueScopeToken — must not depend on a closure-local `ui`');
check('scope token reads the provider from the shared store',
  /LeagueData\.meta[\s\S]*provider/.test(leagueScopeTokenSrc), leagueScopeTokenSrc);
check('scope token no longer reaches for the UI layer\'s `ui`',
  !/typeof ui/.test(leagueScopeTokenSrc), leagueScopeTokenSrc);
{
  // Run it against a stubbed store to prove the token is provider-scoped.
  const run = (provider, leagueId) => new Function('LeagueData', 'document',
    extract('selectedLeagueId') + '\n' + leagueScopeTokenSrc + '; return leagueScopeToken();'
  )({ meta: { provider, leagueId } }, { getElementById: () => null });
  check('token namespaces by provider', run('espn', '111') === 'espn:111', run('espn', '111'));
  check('same id on another platform is a different token',
    run('sleeper', '111') === 'sleeper:111' && run('sleeper', '111') !== run('espn', '111'));
  check('missing provider falls back to espn', run('', '111') === 'espn:111', run('', '111'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
