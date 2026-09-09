'use strict';
const { createClient } = require('@supabase/supabase-js');
const providers = require('./providers');
const { build } = require('./engine');
const WINDOW = 14 * 86400000;

function database() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw Object.assign(new Error('Transaction wire storage is not configured'),{status:503});
  return createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
}
async function read(db,s) {
  const result = await db.from('fsn_transaction_articles').select('article').eq('scope',s.key).order('occurred_at',{ascending:false}).limit(250);
  if (result.error) throw result.error;
  return (result.data || []).map(row => row.article);
}
async function sync(db,s,req,dependencies = {}) {
  const observedAt = (dependencies.now || Date.now)();
  const state = await db.from('fsn_transaction_state').select('revision,injuries,observed_at').eq('scope',s.key).maybeSingle();
  if (state.error) throw state.error;
  // A completed sync throttles provider calls. The HTTP handler has already
  // authenticated this reader before entering here, including on a cache hit.
  if (state.data && observedAt - Date.parse(state.data.observed_at) < 60000) return { articles:await read(db,s), warnings:[], cached:true };
  const snapshot = await (dependencies.ingest || providers.ingest)(s,req,observedAt-WINDOW);
  const result = build(s,snapshot,state.data && state.data.injuries,observedAt,observedAt-WINDOW,state.data ? state.data.revision : 0);
  const saved = await db.rpc('fsn_commit_transaction_wire',{
    p_scope:s.key, p_revision:state.data ? state.data.revision : 0,
    p_observed_at:new Date(observedAt).toISOString(), p_injuries:result.injuries, p_articles:result.articles,
  });
  if (saved.error) throw saved.error;
  if (saved.data !== true) throw Object.assign(new Error('Transaction sync overlapped another run; retry shortly'),{status:409});
  return { articles:await read(db,s), warnings:result.warnings, cached:false };
}
module.exports = { database, read, sync };
