'use strict';
const crypto = require('node:crypto');
const { scope, authorize } = require('../lib/transaction-wire/providers');
const { database, cached, sync } = require('../lib/transaction-wire/service');

/* ============================================================
   /api/transaction-wire

   Two actions dispatched by ?action= so this file counts as one
   Vercel serverless function instead of two:

     (default)         the client-facing wire endpoint. GET
                       returns cached articles; POST re-syncs
                       from the upstream provider. Session auth
                       lives inside providers.authorize().
     ?action=dispatch  the scheduled cron target. Bearer
                       CRON_SECRET only, GET only. Fans out
                       across the FSN_TRANSACTION_TARGETS
                       allowlist.

   The dispatch action was previously a separate file at
   /api/transaction-wire-dispatch. Consolidating it here keeps
   the deployment under Vercel's Hobby-tier serverless-function
   cap without changing either contract:

     * the default action's request/response is byte-identical
       to what it was before consolidation, so the browser and
       the News Desk pipeline do not notice the merge;
     * the dispatch action still requires Bearer CRON_SECRET
       and still refuses anything but GET, so the cron auth
       model is unchanged; vercel.json rewrites the legacy
       /api/transaction-wire-dispatch path so the existing
       cron entry and any external caller keep reaching this
       handler at the right action.
============================================================ */

function cronAuthorized(req) {
  const secret = String(process.env.CRON_SECRET || '');
  if (!secret) return false;
  const expected = Buffer.from('Bearer ' + secret);
  const actual = Buffer.from(String(req.headers && req.headers.authorization || ''));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function handleDispatch(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error:'Method not allowed' });
  if (!cronAuthorized(req)) return res.status(401).json({ error:'Unauthorized' });
  try {
    // Deployment-owned allowlist. No endpoint accepts client-supplied cron
    // targets or persists credentials. Yahoo uses its existing revocable cookie.
    const targets = JSON.parse(process.env.FSN_TRANSACTION_TARGETS || '[]');
    if (!Array.isArray(targets) || targets.length > 10) throw new Error('FSN_TRANSACTION_TARGETS must contain at most 10 scopes');
    if (!targets.length) return res.status(503).json({ error:'No transaction cron targets configured' });
    const db = database(), results = [];
    for (const target of targets) {
      let s;
      try {
        s = scope(target);
        const reader = { headers:target.headers || {} };
        await authorize(s, reader);
        const result = await sync(db, s, reader);
        results.push({ scope:s.key, ok:result.storage === 'available' && result.mode !== 'stale', count:result.articles.length, warnings:result.warnings, mode:result.mode, storage:result.storage });
      } catch (err) {
        console.error('[TransactionWire] scheduled target failed ' + (s ? s.key : 'invalid scope'), err);
        results.push({ scope:s ? s.key : 'invalid', ok:false });
      }
    }
    return res.status(results.every(r => r.ok) ? 200 : 502).json({ results });
  } catch (err) {
    console.error('[TransactionWire] dispatcher failed', err);
    return res.status(503).json({ error:'Transaction dispatcher configuration/storage unavailable' });
  }
}

async function handleRequest(req, res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Vary','Cookie, x-league-token, x-espn-s2, x-espn-swid');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, x-espn-s2, x-espn-swid, x-league-token');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({ error:'Method not allowed' });
  try {
    const s = scope(req.query || {});
    // NEVER return cached private data based on a league ID or old sync alone.
    await authorize(s, req);
    let db = null;
    try { db = database(); }
    catch (err) { console.error('[TransactionWire] storage configuration unavailable for ' + s.key, err); }
    const result = req.method === 'GET' ? await cached(db, s) : await sync(db, s, req);
    return res.status(200).json({ scope:s.key, ...result });
  } catch (err) {
    console.error('[TransactionWire] request failed', err);
    const auth = err.status === 401 || err.status === 403;
    return res.status(err.status || 502).json({ error:auth ? 'Reconnect this league to read the transaction wire.' : 'Transaction wire unavailable; existing News Desk stories remain available.', code:auth ? 'AUTH_REQUIRED' : err.status === 400 ? 'INVALID_SCOPE' : err.status === 409 ? 'SYNC_CONFLICT' : 'PROVIDER_UNAVAILABLE' });
  }
}

module.exports = async function handler(req, res) {
  const raw = req.query && req.query.action;
  const action = String(Array.isArray(raw) ? raw[0] : (raw || '')).trim().toLowerCase();
  if (action === 'dispatch') return handleDispatch(req, res);
  return handleRequest(req, res);
};
