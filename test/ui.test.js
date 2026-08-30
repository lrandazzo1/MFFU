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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
