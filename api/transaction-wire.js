'use strict';
const { scope, authorize } = require('../lib/transaction-wire/providers');
const { database, read, sync } = require('../lib/transaction-wire/service');

module.exports = async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Vary','Cookie, x-league-token, x-espn-s2, x-espn-swid');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, x-espn-s2, x-espn-swid, x-league-token');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({error:'Method not allowed'});
  try {
    const s = scope(req.query || {});
    // NEVER return cached private data based on a league ID or old sync alone.
    await authorize(s,req);
    const db = database();
    const result = req.method === 'GET' ? {articles:await read(db,s)} : await sync(db,s,req);
    return res.status(200).json({scope:s.key,...result});
  } catch (err) {
    console.error('[TransactionWire] request failed',err);
    return res.status(err.status || 502).json({error:err.status === 401 ? 'Reconnect this league to read the transaction wire.' : 'Transaction wire unavailable; existing News Desk stories remain available.',code:err.code || 'TRANSACTION_WIRE_FAILED'});
  }
};
