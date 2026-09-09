'use strict';
const { createClient } = require('@supabase/supabase-js');
const providers = require('./providers');
const { build } = require('./engine');
const WINDOW = 14 * 86400000;

function database() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw Object.assign(new Error('Transaction wire storage is not configured'),{status:503});
  return createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{
    auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(5000)})},
  });
}
async function read(db,s) {
  const result = await db.from('fsn_transaction_articles').select('article').eq('scope',s.key).order('occurred_at',{ascending:false}).limit(250);
  if (result.error) throw result.error;
  const articles = (result.data || []).map(row => row.article);
  if (articles.some(a=>!a || a.articleType !== 'transaction_wire' || a.provider !== s.provider || String(a.leagueId) !== s.league || Number(a.season) !== s.season || typeof a.id !== 'string' || !Array.isArray(a.paragraphs))) {
    throw new Error('Transaction cache payload does not match the requested scope/schema');
  }
  return articles;
}
async function cached(db,s) {
  if (!db) return {articles:[],mode:'cache-unavailable',storage:'unavailable'};
  try { return {articles:await read(db,s),mode:'cache',storage:'available'}; }
  catch (err) {
    console.error('[TransactionWire] cache read failed for '+s.key,err);
    return {articles:[],mode:'cache-unavailable',storage:'unavailable'};
  }
}
async function sync(db,s,req,dependencies = {}) {
  const observedAt = (dependencies.now || Date.now)();
  const savedCache = await cached(db,s);
  let state = {data:null}, writable = !!db && savedCache.storage === 'available';
  if (writable) {
    try {
      state = await db.from('fsn_transaction_state').select('revision,injuries,observed_at').eq('scope',s.key).maybeSingle();
      if (state.error) throw state.error;
    } catch (err) {
      console.error('[TransactionWire] injury baseline unavailable for '+s.key,err);
      state = {data:null}; writable = false;
    }
  }
  // A completed sync throttles provider calls. The HTTP handler has already
  // authenticated this reader before entering here, including on a cache hit.
  if (state.data && savedCache.storage === 'available' && observedAt - Date.parse(state.data.observed_at) < 60000) return {...savedCache,warnings:[],cached:true};
  let snapshot;
  try { snapshot = await (dependencies.ingest || providers.ingest)(s,req,observedAt-WINDOW); }
  catch (err) {
    // An expired/revoked provider session is never a reason to serve a cache.
    if (err.status === 401 || err.status === 403) throw err;
    console.error('[TransactionWire] live provider read failed for '+s.key,err);
    if (savedCache.storage === 'available') return {...savedCache,mode:'stale',warnings:['PROVIDER_UNAVAILABLE'],cached:true};
    throw err;
  }
  const result = build(s,snapshot,state.data && state.data.injuries,observedAt,observedAt-WINDOW,state.data ? state.data.revision : 0);
  const warnings = [...(snapshot.warnings || []),...result.warnings];
  if (writable) {
    try {
      const saved = await db.rpc('fsn_commit_transaction_wire',{
        p_scope:s.key, p_revision:state.data ? state.data.revision : 0,
        p_observed_at:new Date(observedAt).toISOString(), p_injuries:result.injuries, p_articles:result.articles,
      });
      if (saved.error) throw saved.error;
      if (saved.data !== true) throw Object.assign(new Error('Transaction sync overlapped another run; retry shortly'),{status:409});
      return {articles:await read(db,s),warnings,cached:false,mode:'live',storage:'available'};
    } catch (err) {
      if (err.status === 409) throw err;
      console.error('[TransactionWire] archive commit/read failed for '+s.key,err);
    }
  }
  // A missing migration or unavailable cache is not a provider outage. Return
  // verified live articles without pretending they were durably saved. Keep
  // the original published copy when an ID already exists in the read cache.
  const articles = new Map(result.articles.map(a=>[a.id,a]));
  savedCache.articles.forEach(a=>articles.set(a.id,a));
  return {articles:[...articles.values()].sort((a,b)=>b.at-a.at),warnings,cached:false,mode:'live',storage:'unavailable'};
}
module.exports = { database, read, cached, sync };
