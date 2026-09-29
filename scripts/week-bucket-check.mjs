#!/usr/bin/env node
/*
  Guard the two-part Week routing contract without requiring a browser:
    - the News Desk renders Week N advance coverage with Week N-1 postgame copy
    - postgame copy only rolls forward once its OWN slate is complete, so an
      in-progress week keeps its recaps (the monday_sweat rule, applied to the
      deterministic timeline)
    - a public recap's Local Read resolves its explicit source week
  Runtime rendering remains covered by the Playwright checks in CI.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'editorialScheduleEngine.js'), 'utf8');
const required = [
  ['postgame classifier', 'function postgame(article)'],
  ['Week 1 macro exception', "article.kind==='sotl'"],
  ['previous-week stream', 'var prior=original(display-1);'],
  ['forward merge', 'var finished=(Array.isArray(prior)?prior:[]).filter(postgame);'],
  ['current-week advance filter', 'var advance=(Array.isArray(current)?current:[]).filter(function(article){return !rolls||!postgame(article);});'],
  ['slate-completion test', 'function slateComplete(week)'],
  ['slate-completion authority', 'window.weekBoxScoresComplete(week)'],
  ['current-week roll gate', 'var rolls=slateComplete(display);'],
  ['previous-week roll gate', 'if(display===1||!slateComplete(display-1)) return advance;'],
  ['public source-week resolver', 'function sourceWeek(post)'],
  ['Local Read source-week context', 'view.context.currentWeek=week;'],
];

const missing = required.filter(([, token]) => !source.includes(token)).map(([label]) => label);
if (missing.length) {
  console.error('[week-bucket-check] missing routing guard(s): ' + missing.join(', '));
  process.exit(1);
}
/* The forward roll must be gated on the SOURCE week's slate, not on the slot
   alone. A reintroduced unconditional filter is the regression this guards. */
if (source.includes('filter(function(article){return !postgame(article);})')) {
  console.error('[week-bucket-check] postgame coverage is rolled forward on the slot alone; ' +
    'an in-progress week would lose its recaps to the next week\'s feed.');
  process.exit(1);
}
console.log('[week-bucket-check] passed: Week N advance coverage, Week N-1 postgame coverage gated on a ' +
  'complete slate, and source-week Local Read context are all wired.');
