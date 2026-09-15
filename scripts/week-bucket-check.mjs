#!/usr/bin/env node
/*
  Guard the two-part Week routing contract without requiring a browser:
    - the News Desk renders Week N advance coverage with Week N-1 postgame copy
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
  ['current-week advance filter', 'var advance=(Array.isArray(current)?current:[]).filter(function(article){return !postgame(article);});'],
  ['public source-week resolver', 'function sourceWeek(post)'],
  ['Local Read source-week context', 'view.context.currentWeek=week;'],
];

const missing = required.filter(([, token]) => !source.includes(token)).map(([label]) => label);
if (missing.length) {
  console.error('[week-bucket-check] missing routing guard(s): ' + missing.join(', '));
  process.exit(1);
}
console.log('[week-bucket-check] passed: Week N advance coverage, Week N-1 postgame coverage, and source-week Local Read context are all wired.');
