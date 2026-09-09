'use strict';
const crypto = require('node:crypto');
const { scope, authorize } = require('../lib/transaction-wire/providers');
const { database, sync } = require('../lib/transaction-wire/service');

module.exports = async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (req.method !== 'GET') return res.status(405).json({error:'Method not allowed'});
  const expected = Buffer.from('Bearer '+(process.env.CRON_SECRET || ''));
  const actual = Buffer.from(String(req.headers && req.headers.authorization || ''));
  if (!process.env.CRON_SECRET || actual.length !== expected.length || !crypto.timingSafeEqual(actual,expected)) return res.status(401).json({error:'Unauthorized'});
  try {
    // Deployment-owned allowlist. No endpoint accepts client-supplied cron
    // targets or persists credentials. Yahoo uses its existing revocable cookie.
    const targets = JSON.parse(process.env.FSN_TRANSACTION_TARGETS || '[]');
    if (!Array.isArray(targets) || targets.length > 10) throw new Error('FSN_TRANSACTION_TARGETS must contain at most 10 scopes');
    if (!targets.length) return res.status(503).json({error:'No transaction cron targets configured'});
    const db = database(), results = [];
    for (const target of targets) {
      let s;
      try {
        s = scope(target);
        const reader = {headers:target.headers || {}};
        await authorize(s,reader);
        const result = await sync(db,s,reader);
        results.push({scope:s.key,ok:result.storage === 'available' && result.mode !== 'stale',count:result.articles.length,warnings:result.warnings,mode:result.mode,storage:result.storage});
      } catch (err) {
        console.error('[TransactionWire] scheduled target failed '+(s ? s.key : 'invalid scope'),err);
        results.push({scope:s ? s.key : 'invalid',ok:false});
      }
    }
    return res.status(results.every(r => r.ok) ? 200 : 502).json({results});
  } catch (err) {
    console.error('[TransactionWire] dispatcher failed',err);
    return res.status(503).json({error:'Transaction dispatcher configuration/storage unavailable'});
  }
};
