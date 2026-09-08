#!/usr/bin/env node
/* ============================================================================
   FSN — LANDING CLAIMS / REMOVED-METRIC CHECK

   `node scripts/landing-claims-check.mjs`

   Two drifts that no other check in `npm run verify` can see, because both are
   about agreement BETWEEN files rather than correctness within one.

   ---- 1. THE LANDING PAGE SELLS WHAT THE APP SHIPS ----

   landing/index.html is a separate Vercel project with its own deploy. Nothing
   links its feature copy to index.html, so a model can be renamed, replaced or
   never built and the marketing claim keeps running unchallenged. That is an
   App Review problem, not just an accuracy one: Guideline 2.3.1 treats a
   screenshot or description promising a feature the binary does not have as
   inaccurate metadata, and the reviewer reads the landing page the support URL
   points at.

   This already happened. The Analytics card advertised "strength of schedule,
   luck index, playoff odds" — and playoff odds was never one of the six models
   on the Season Stats tab. The other two map to real models (Schedule Hardship,
   Adjusted Expected Wins / Luck Δ); the third was selling a probability metric
   that does not exist anywhere in the app.

   So: the claimed model COUNT must equal the number of models the Analytics tab
   actually renders, and every model the claim names must resolve to one of them.

   ---- 2. WIN PROBABILITY STAYS OUT OF THE UI ----

   The matchup board and the onboarding walkthrough used to carry a
   win-probability readout. It was deliberately removed. What survives is
   FSNIntel.winProbability() — the model itself — and the News Desk pre-game
   previews that quote it in prose, which are deterministic article generators
   and therefore off-limits to change (CLAUDE.md rule 2).

   That split is easy to undo by accident: re-adding a probability readout to a
   matchup card is a one-line call to an engine that is still exported and still
   works. Nothing would fail. So this check pins the split by LOCATION — the
   model may be referenced from the block that defines it and from the News Desk
   block, and nowhere else, including the static markup where the onboarding
   slide lives.

   Both halves are string-level checks over the real files. Neither can produce
   a false alarm for correct code: a new model added to the Analytics tab moves
   the count on both sides, and a probability reference inside the News Desk is
   explicitly allowed.
============================================================================ */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let failed = false;
const pass = (msg) => console.log('  ok    ' + msg);
const fail = (msg) => { failed = true; console.error('  FAIL  ' + msg); };

const app = readFileSync(join(root, 'index.html'), 'utf8');
const landing = readFileSync(join(root, 'landing', 'index.html'), 'utf8');

/* ---------------------------------------------------------------------------
   Inline <script> blocks, so a reference can be attributed to the engine it
   lives in. Mirrors scope-scan.mjs: an external <script src> is a file, not a
   block.
--------------------------------------------------------------------------- */
function inlineBlocks(html) {
  const blocks = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    if (/\bsrc\s*=/.test(match[1] || '')) continue;
    blocks.push({
      body: match[2],
      startLine: html.slice(0, match.index).split('\n').length,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return blocks;
}

/* Everything that is NOT an inline script block: the static markup, which is
   where the onboarding walkthrough slides and the matchup card templates live
   as literal HTML. */
function markupOutsideScripts(html, blocks) {
  let out = '';
  let cursor = 0;
  for (const block of blocks) {
    out += html.slice(cursor, block.start);
    cursor = block.end;
  }
  return out + html.slice(cursor);
}

const blocks = inlineBlocks(app);
const markup = markupOutsideScripts(app, blocks);

console.log('\n[claims] the Analytics models the landing page sells');

/* ---------------------------------------------------------------------------
   1. What the app actually renders on the Season Stats tab.

   Each model is one analyticsModel('NN','Title',…) call. Reading the calls
   rather than a hand-kept list means a model added or removed in index.html
   moves this number on its own.
--------------------------------------------------------------------------- */
const shipped = [...app.matchAll(/analyticsModel\(\s*'(\d+)'\s*,\s*'([^']+)'/g)]
  .map((m) => ({ id: m[1], title: m[2] }));

if (shipped.length === 0) {
  fail('found no analyticsModel(...) calls in index.html — the Analytics tab was ' +
    'restructured, so this check can no longer see what ships. Update the pattern.');
} else {
  pass('index.html renders ' + shipped.length + ' analytics models: ' +
    shipped.map((m) => m.id + ' ' + m.title).join(' · '));
}

/* ---------------------------------------------------------------------------
   2. What the landing page claims.
--------------------------------------------------------------------------- */
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const claim = landing.match(/(\w+)\s+mathematical models\s*[—-]\s*([^—-]+?)\s*(?:and more\s*)?[—-]/i);

if (!claim) {
  fail('could not find the "<N> mathematical models — …" claim in landing/index.html. ' +
    'If the Analytics card was reworded, update this check to read the new copy — do not ' +
    'delete the check, or the landing page can drift from the app again.');
} else {
  const word = claim[1].toLowerCase();
  const claimed = NUMBER_WORDS[word] != null ? NUMBER_WORDS[word] : Number(word);

  if (!Number.isFinite(claimed)) {
    fail('the landing claim says "' + claim[1] + ' mathematical models", which is not a number.');
  } else if (claimed !== shipped.length) {
    fail('the landing page advertises ' + claimed + ' analytics models but index.html renders ' +
      shipped.length + '. Update landing/index.html (or the Analytics tab) so the two agree — ' +
      'a promised model the binary does not have is App Review Guideline 2.3.1.');
  } else {
    pass('the model count matches: landing says ' + claimed + ', the app renders ' + shipped.length);
  }

  /* Every model named in the claim has to be one that ships. Matched on
     significant words rather than exact titles, because the marketing name
     ("strength of schedule") is deliberately plainer than the in-app one
     ("Schedule Hardship") — the app itself glosses that pair in the Power Index
     explainer. A name that shares no vocabulary with any shipped model is the
     real failure: that is what "playoff odds" looked like. */
  const SYNONYMS = {
    'strength of schedule': 'schedule',
    'schedule hardship': 'schedule',
    'luck index': 'expected wins',
    'luck delta': 'expected wins',
    'expected wins': 'expected wins',
    'lineup efficiency': 'lineup efficiency',
    'bench blunders': 'lineup efficiency',
    'consistency': 'consistency',
    'heartbreak': 'heartbreak',
    'blowout': 'heartbreak',
    'waiver wire': 'waiver',
    'waiver roi': 'waiver',
  };

  const shippedHaystack = shipped.map((m) => m.title.toLowerCase()).join(' | ');
  const named = claim[2].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  for (const name of named) {
    const key = Object.keys(SYNONYMS).find((k) => name.includes(k));
    const needle = key ? SYNONYMS[key] : name;
    if (shippedHaystack.includes(needle)) {
      pass('"' + name + '" resolves to a shipped model');
    } else {
      fail('the landing page names "' + name + '", which matches none of the ' + shipped.length +
        ' models the Analytics tab renders (' + shipped.map((m) => m.title).join(', ') + '). ' +
        'Either the model was never built or it was renamed — fix the copy in ' +
        'landing/index.html rather than the check.');
    }
  }
}

/* ---------------------------------------------------------------------------
   3. No probability metric is advertised anywhere on the landing page.
--------------------------------------------------------------------------- */
const BANNED_LANDING = [
  /win\s*probability/i,
  /playoff\s*odds/i,
  /championship\s*odds/i,
  /title\s*odds/i,
  /playoff\s*chances/i,
];

const landingHits = BANNED_LANDING.filter((re) => re.test(landing));
if (landingHits.length === 0) {
  pass('the landing page advertises no probability metric the app does not ship');
} else {
  fail('the landing page advertises a probability metric that was removed from the app: ' +
    landingHits.map((re) => String(re)).join(', ') + '. The matchup board and the onboarding ' +
    'walkthrough no longer carry one, so selling it is inaccurate metadata.');
}

/* ---------------------------------------------------------------------------
   4. Win probability stays inside the two blocks allowed to hold it.
--------------------------------------------------------------------------- */
console.log('\n[metric] win probability is confined to the model and the News Desk');

const OWNER = /window\.FSNIntel\s*=/;          // block 3 — defines winProbability()
const NEWSDESK = /window\.NewsDesk\s*=/;       // block 4 — deterministic articles

const ownerBlock = blocks.findIndex((b) => OWNER.test(b.body));
const newsBlock = blocks.findIndex((b) => NEWSDESK.test(b.body));

if (ownerBlock === -1) {
  fail('no inline block defines window.FSNIntel — the block layout changed and this check can ' +
    'no longer tell the model apart from a UI surface. Update the pattern.');
}
if (newsBlock === -1) {
  fail('no inline block defines window.NewsDesk — same problem: the News Desk is the one place ' +
    'allowed to quote win probability in prose, and it can no longer be identified.');
}

const PROB = /win\s*probability|winProbability|matchupWinProbBar|mu-winprob|ftu-m-prob/i;

if (ownerBlock !== -1 && newsBlock !== -1) {
  blocks.forEach((block, i) => {
    if (i === ownerBlock || i === newsBlock) return;
    const lines = block.body.split('\n');
    const offenders = [];
    lines.forEach((line, n) => {
      if (PROB.test(line)) offenders.push('index.html:' + (block.startLine + n));
    });
    if (offenders.length) {
      fail('script block starting at index.html:' + block.startLine + ' references win probability at ' +
        offenders.join(', ') + '. The readout was removed from the UI on purpose; only the ' +
        'FSNIntel block (which defines the model) and the News Desk block (which quotes it in ' +
        'article prose) may mention it.');
    }
  });
  if (!failed) pass('no script block outside FSNIntel and the News Desk references it');
}

/* The static markup is where the onboarding walkthrough slide and the matchup
   card shells live. A probability readout re-added there would render for every
   reader without any JavaScript claiming it. */
const markupLines = markup.split('\n');
const markupOffenders = markupLines.filter((line) => PROB.test(line));
if (markupOffenders.length === 0) {
  pass('the static markup (onboarding slides, card shells) carries no probability readout');
} else {
  fail('the static markup re-introduces a win-probability surface: ' +
    markupOffenders.slice(0, 3).map((l) => l.trim().slice(0, 90)).join(' / ') +
    '. The onboarding walkthrough and the matchup card were cleared of it deliberately.');
}

/* Dead styling is its own signal: .mu-winprob / .ftu-m-prob rules surviving
   with no markup to match them means a removal was left half-finished. */
const DEAD_CSS = ['.mu-winprob', '.mu-wp-', '.ftu-m-prob'];
const deadCss = DEAD_CSS.filter((sel) => app.includes(sel));
if (deadCss.length === 0) {
  pass('no orphaned win-probability CSS left behind');
} else {
  fail('index.html still carries win-probability styles with nothing to style: ' +
    deadCss.join(', ') + '. Remove them so the next reader does not assume the feature exists.');
}

if (failed) {
  console.error('\n[landing-claims-check] FAILED');
  process.exit(1);
}
console.log('\n[landing-claims-check] clean');
