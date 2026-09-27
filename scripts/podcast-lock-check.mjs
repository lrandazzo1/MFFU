#!/usr/bin/env node
// Exercise the actual TypeScript handler with an in-memory Supabase double.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../lib/generate-podcast.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021,
} }).outputText;
const token = 'x'.repeat(43);
const rows = new Map();
const files = new Map();
let calls = 0;
const frame = Buffer.alloc(417);
frame.set([0xff, 0xfb, 0x90, 0x00]);
const mp3 = Buffer.concat([frame, frame]);

function table(name){
  const filters = {};
  let action = 'select', value;
  const q = {
    select(){ return q; }, eq(k,v){ filters[k] = v; return q; }, not(){ return q; },
    limit(){ return q; }, maybeSingle(){ return q.execute(true); }, single(){ return q.execute(true); },
    insert(v){ action = 'insert'; value = v; return q.execute(false); },
    update(v){ action = 'update'; value = v; return q; },
    then(resolve, reject){ return q.execute(false).then(resolve, reject); },
    async execute(single){
      if(name === 'leagues') return { data:[{ share_token: token }], error:null };
      const key = `${filters.league_id || value?.league_id}:${filters.season || value?.season}:${filters.week || value?.week}`;
      if(action === 'insert'){
        if(rows.has(key)) return { error:{ code:'23505' } };
        rows.set(key, value);
        return { error:null };
      }
      const row = rows.get(key);
      if(action === 'update' && row && row.status === filters.status){ Object.assign(row, value); return { data:row, error:null }; }
      return { data:single ? row || null : row ? [row] : [], error:null };
    },
  };
  return q;
}
const client = {
  from:table,
  storage:{ from(){ return {
    async upload(path, bytes){
      if(files.has(path)) return { error:new Error('duplicate upload') };
      files.set(path, bytes); return { error:null };
    },
    getPublicUrl(path){ return { data:{ publicUrl:'https://example.test/' + path } }; },
  }; } },
};
const exports = {};
const context = {
  exports, Buffer, console, process:{ env:{ SUPABASE_URL:'https://example.test',
    SUPABASE_SERVICE_ROLE_KEY:'key', ELEVENLABS_API_KEY:'key' } },
  require(name){
    if(name === '@supabase/supabase-js') return { createClient:()=> client };
    if(name === 'elevenlabs') return { ElevenLabsClient:class {
      async generate(){ calls++; await new Promise(resolve=>setTimeout(resolve, 10)); return (async function*(){ yield mp3; })(); }
    } };
    return require(name);
  },
};
vm.runInNewContext(code, context, { filename:'generate-podcast.ts' });
function response(){
  return { code:200, headers:{}, status(code){ this.code = code; return this; },
    setHeader(k,v){ this.headers[k] = v; }, json(value){ this.body = value; },
    end(){},
  };
}
const body = { leagueId:'123', season:2026, week:3, title:'Week 3',
  lines:[{ host:'DAN', text:'This is the first line.' }, { host:'STU', text:'This is the second line.' }],
  stories:['First', 'Second'] };
const req = { method:'POST', headers:{ 'x-league-token':token }, body };
const a = response(), b = response();
await Promise.all([exports.default(req, a), exports.default(req, b)]);
assert.deepEqual([a.code, b.code].sort(), [200, 202]);
assert.equal(calls, 2, 'only one two-turn episode reaches ElevenLabs');
assert.equal(files.size, 1);
const cached = response();
await exports.default(req, cached);
assert.equal(cached.code, 200);
assert.equal(calls, 2);
assert.equal(cached.body.audioUrl, 'https://example.test/123/2026/3.mp3');
const get = response();
await exports.default({ method:'GET', headers:{ 'x-league-token':token },
  query:{ leagueId:'123', season:'2026', week:'3' } }, get);
assert.equal(get.body.status, 'ready');
console.log('[podcast-lock-check] concurrent claim, cached POST and GET clean');
