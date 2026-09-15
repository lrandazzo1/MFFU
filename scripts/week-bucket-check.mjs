#!/usr/bin/env node
/*
  Guard the two-part Week routing contract without requiring a browser:
    - the News Desk renders Week N advance coverage with Week N-1 postgame copy
    - a public recap's Local Read resolves its explicit source week
  Runtime rendering remains covered by the Playwright checks in CI.
*/
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'editorialScheduleEngine.js'), 'utf8');
const required = [
  ['postgame classifier', 'function postgame(article)'],
  ['Week 1 macro exception', "article.kind==='sotl'"],
  ['previous-week stream', 'var prior=original(display-1);'],
  ['previous-week postgame filter', 'var finished=(Array.isArray(prior)?prior:[]).filter(postgame);'],
  ['current-week advance filter', 'var advance=(Array.isArray(current)?current:[]).filter(function(article){return !postgame(article);});'],
  ['strict Week 2 boundary', 'if(display===2) return finished;'],
  ['week-scoped panel re-key', 'function rekeyNewsPanels(week)'],
  ['Week 2 Local Read suppression', 'function suppressLocalRead(){ return displayedWeek()===2; }'],
  ['Local Read output filter', "if(suppressLocalRead()) return '';"],
  ['Deep Stats output filter', "return Object.assign({},data,{local:'',players:[],scores:[],hasSplits:false});"],
  ['public source-week resolver', 'function sourceWeek(post)'],
  ['Local Read source-week context', 'view.context.currentWeek=week;'],
];

const missing = required.filter(([, token]) => !source.includes(token)).map(([label]) => label);
if (missing.length) {
  console.error('[week-bucket-check] missing routing guard(s): ' + missing.join(', '));
  process.exit(1);
}
const startMarker = '/* Week-bucket and Local Read context guard.';
const endMarker = '/* Matchup Preview + no-FAAB runtime guard';
const start = source.indexOf('(function(){', source.indexOf(startMarker));
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) {
  console.error('[week-bucket-check] could not isolate the runtime week guard.');
  process.exit(1);
}

const panels = new Map(['newsLeadWrap', 'timelineFeed', 'deskWireWrap'].map((id) => [id, { textContent: 'stale Week 1 copy', dataset: {} }]));
let selectedWeek = 1;
const stream = {
  1: [
    { id: 'week-1-preview', slot: 'primer' },
    { id: 'week-1-recap', slot: 'recap' },
  ],
  2: [
    { id: 'week-2-preview', slot: 'primer' },
    { id: 'week-2-recap', slot: 'recap' },
  ],
};
const windowFixture = {
  NewsDesk: {
    getTimelineStream: (week) => stream[week] || [],
    activeSeasonYear: () => 2026,
    viewedSeasonYear: () => 2026,
  },
  FSNLocalDesk: {
    localizeWire: () => 'Week 1 Local Read',
    deepData: () => ({ local: 'Week 1 Local Read', players: ['Player'], scores: ['Score'], hasSplits: true }),
  },
  effectiveWeek: () => selectedWeek,
};
vm.runInNewContext(source.slice(start, end), {
  window: windowFixture,
  document: { getElementById: (id) => panels.get(id) || null },
  console,
  setTimeout: (fn) => fn(),
});

const weekOne = windowFixture.NewsDesk.getTimelineStream(1).map((article) => article.id);
selectedWeek = 2;
const weekTwo = windowFixture.NewsDesk.getTimelineStream(2).map((article) => article.id);
const weekTwoLocal = windowFixture.FSNLocalDesk.localizeWire();
const weekTwoDeep = windowFixture.FSNLocalDesk.deepData();
const stalePanel = [...panels.values()].find((panel) => panel.textContent || panel.dataset.newsWeek !== '2');
if (weekOne.join(',') !== 'week-1-preview' || weekTwo.join(',') !== 'week-1-recap' || weekTwoLocal !== '' || weekTwoDeep.local || weekTwoDeep.players.length || weekTwoDeep.scores.length || stalePanel) {
  console.error('[week-bucket-check] runtime separation failed.', { weekOne, weekTwo, weekTwoLocal, weekTwoDeep, panels: [...panels.values()] });
  process.exit(1);
}
console.log('[week-bucket-check] passed: Week 2 only receives Week 1 postgame coverage, Local Read is hidden in Week 2, and week changes clear stale panels.');
