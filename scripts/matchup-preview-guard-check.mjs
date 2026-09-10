#!/usr/bin/env node
/* ============================================================================
   FSN — MATCHUP PREVIEW GUARD CHECK

   Regression-pins the exact failure that motivated the dynamic preview repair:
   several `preview-game-*` stories may enter the output layer with identical
   canned copy, but they must leave it bound to their own teams, records,
   Record Book series, scoring context and model probability. The check is
   deterministic and fully offline.
============================================================================ */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'editorialScheduleEngine.js'), 'utf8');

const teams = Array.from({ length: 8 }, (_, i) => ({
  id: String(i + 1),
  ownerId: 'owner-' + (i + 1),
  name: ['Alpha','Bravo','Charlie','Delta','Echo','Foxtrot','Golf','Hotel'][i],
}));

const records = {
  '1':'2-0', '2':'1-1', '3':'0-2', '4':'2-0',
  '5':'1-1', '6':'0-2', '7':'2-0', '8':'1-1',
};
const probabilities = {
  '1-5':64,
  '2-6':55,
  '3-7':39,
  '4-8':73,
};
const series = {
  'owner-1|owner-5':{ winsFor:3, winsAgainst:1, ties:0, meetingCount:4 },
  'owner-2|owner-6':{ winsFor:2, winsAgainst:2, ties:0, meetingCount:4 },
  'owner-3|owner-7':{ winsFor:1, winsAgainst:4, ties:0, meetingCount:5 },
  'owner-4|owner-8':{ winsFor:5, winsAgainst:0, ties:0, meetingCount:5 },
};

const STATIC = 'Sunday is where theory goes to get audited.';
const previewIds = ['1-5','2-6','3-7','4-8'];
function rawFeed(){
  return previewIds.map((pair) => ({
    id:'preview-game-2-' + pair,
    week:2,
    kind:'preview',
    topic:'matchups',
    dek:'Identical static preview.',
    paragraphs:[STATIC, STATIC],
  })).concat([
    { id:'faab-week-2', kind:'faab', headline:'FAAB REPORT', paragraphs:['FAAB budget copy'] },
    { id:'safe-story', kind:'news', headline:'SAFE STORY', paragraphs:['No financial waiver language here.'] },
  ]);
}

const documentStub = {
  documentElement:{},
  querySelectorAll(){ return []; },
};
class MutationObserverStub {
  constructor(callback){ this.callback = callback; }
  observe(){}
  disconnect(){}
}

const windowStub = {
  LeagueData:{ getTeams:() => teams },
  FSNIntel:{
    getRecordAsOfWeek(teamId){ return records[String(teamId)]; },
    winProbability(_throughWeek, A, B){
      const value = probabilities[String(A.id) + '-' + String(B.id)];
      if(value == null) throw new Error('missing test probability for ' + A.id + '-' + B.id);
      return value;
    },
    standingsThrough(){
      return teams.map((team, index) => ({ team, avg:101 + index * 4.25 }));
    },
    faabReport(){ return { legacy:true }; },
  },
  getH2HAsOf(ownerA, ownerB){
    return series[String(ownerA) + '|' + String(ownerB)] || null;
  },
  NewsDesk:{
    viewedSeasonYear(){ return 2026; },
    getTimelineStream(){ return rawFeed(); },
    getNewsFeedForWeek(){ return rawFeed(); },
    generate(){ return rawFeed(); },
    tickerHeadlines(){ return ['FAAB $27 WAIVER CLAIM', 'Safe roster move']; },
  },
};

const context = {
  window:windowStub,
  document:documentStub,
  MutationObserver:MutationObserverStub,
  console,
  setTimeout(fn){ fn(); return 1; },
  clearTimeout(){},
};
vm.runInNewContext(source, context, { filename:'editorialScheduleEngine.js' });

assert.equal(windowStub.NewsDesk.__dynamicMatchupGuard, true, 'runtime guard must install');
const feed = windowStub.NewsDesk.getTimelineStream(2);
const previews = feed.filter((article) => /^preview-game-/.test(String(article.id)));
assert.equal(previews.length, 4, 'all four matchup previews must survive');
assert.equal(feed.some((article) => /faab/i.test(String(article.id))), false, 'FAAB-only stories must be suppressed');
assert.equal(windowStub.FSNIntel.faabReport(), null, 'legacy FAAB report must be disabled');
assert.deepEqual(windowStub.NewsDesk.tickerHeadlines(), ['Safe roster move'], 'FAAB ticker items must be stripped');

const expectedEdges = [64,55,61,73];
const serialized = [];
previews.forEach((article, index) => {
  const [aId, bId] = previewIds[index].split('-');
  const A = teams[Number(aId) - 1];
  const B = teams[Number(bId) - 1];
  const text = JSON.stringify(article);
  serialized.push(JSON.stringify(article.paragraphs));

  assert.equal(article.__dynamicMatchupBound, true, article.id + ' must be matchup-bound');
  assert.match(article.paragraphs[0], new RegExp(A.name), article.id + ' must name team A');
  assert.match(article.paragraphs[0], new RegExp(B.name), article.id + ' must name team B');
  assert.match(article.paragraphs[0], new RegExp(records[aId].replace('-', '\\-')), article.id + ' must carry team A record');
  assert.match(article.paragraphs[0], new RegExp(records[bId].replace('-', '\\-')), article.id + ' must carry team B record');
  assert.match(article.dek, new RegExp(String(expectedEdges[index]) + '%'), article.id + ' must carry its own probability');
  assert.doesNotMatch(text, /Sunday is where theory goes to get audited/i, article.id + ' must discard the stale canned override');
  assert.doesNotMatch(text, /Identical static preview/i, article.id + ' must replace the static dek');
  assert.doesNotMatch(text, /\bFAAB\b/i, article.id + ' must not expose FAAB language');
});

assert.equal(new Set(serialized).size, previews.length,
  'every game must leave the generator with a distinct paragraph set');
assert.equal(new Set(previews.map((article) => article.dek)).size, previews.length,
  'every game must leave the generator with a distinct matchup dek');

const repeat = windowStub.NewsDesk.getTimelineStream(2)
  .filter((article) => /^preview-game-/.test(String(article.id)))
  .map((article) => ({ id:article.id, dek:article.dek, paragraphs:article.paragraphs }));
assert.deepEqual(
  repeat,
  previews.map((article) => ({ id:article.id, dek:article.dek, paragraphs:article.paragraphs })),
  'same inputs must produce byte-stable matchup copy'
);

console.log('[matchup-preview-guard-check] 4 unique matchup previews, matchup-specific records/H2H/probabilities, deterministic replay, and no FAAB surfaces — clean');
