'use strict';

/* A dated, explicit market snapshot keeps scoring deterministic and prevents a
   provider outage from turning an elite player into a cheap weekly projection.
   Update the snapshot with scripts/refresh-trade-market.mjs. */
const snapshot = require('./data/trade-market-2026.json');
const byId = new Map(snapshot.players.map(function (row) { return [row.id, row]; }));
const protectedIds = new Set(['3918298', '3916387', '3929630']);
const protectedNames = new Set(['Josh Allen', 'Lamar Jackson', 'Saquon Barkley']);
/* Product policy: these assets cannot be the singleton return for an elite QB,
   even when a public chart ranks them highly in a one-QB league. */
const nonEliteIds = new Set(['4428331', '4379399', '3042519']);
const nonEliteNames = new Set(['Rashee Rice', 'James Cook', 'James Cook III', 'Aaron Jones', 'Aaron Jones Sr.']);

function marketOf(player, context) {
  if (context && context.compatible === false && !context.byId) {
    return { tier: null, value: 0, known: false, source: 'No chart for this season or scoring format' };
  }
  const custom = context && context.byId;
  const row = custom ? custom[String(player.id)] : byId.get(String(player.id));
  let value; let rank; let positionRank; let source;
  if (row && Number(row.value) > 0) {
    value = Number(row.value); rank = Number(row.rank) || 999;
    positionRank = Number(row.positionRank) || 999;
    source = custom ? (context.source || 'Explicit market override') : snapshot.source;
  } else if (player.draftRank > 0 && player.draftRank <= 150) {
    /* No weekly-point pricing. Unknown identities use conservative draft tier
       rankings on the same value scale, and disclose that fallback. */
    const nearest = snapshot.players.reduce(function (best, p) {
      return !best || Math.abs(p.rank - player.draftRank) < Math.abs(best.rank - player.draftRank) ? p : best;
    }, null);
    value = nearest.value; rank = player.draftRank; positionRank = 999;
    source = 'ESPN draft-rank fallback';
  } else {
    return { tier: null, value: 0, known: false, source: 'Market value unavailable' };
  }
  let tier = rank <= 10 && ['RB', 'WR'].indexOf(player.pos) !== -1 ? 1 :
    rank <= 50 ? 2 : rank <= 100 ? 3 : 4;
  if (player.pos === 'QB' && positionRank <= 2) tier = 1;
  if (protectedIds.has(String(player.id)) || protectedNames.has(player.name)) tier = 1;
  if (nonEliteIds.has(String(player.id)) || nonEliteNames.has(player.name)) tier = Math.max(2, tier);
  return { tier: tier, value: value, known: true, source: source,
    asOf: context && context.asOf || snapshot.asOf };
}

function packageMarket(give, receive, context) {
  const g = give.map(function (p) { return marketOf(p, context); });
  const r = receive.map(function (p) { return marketOf(p, context); });
  const result = { accepted: false, reason: '', giveValue: 0, receiveValue: 0, ratio: 0,
    giveMarkets: g, receiveMarkets: r };
  if (g.concat(r).some(function (m) { return !m.known; })) {
    result.reason = 'Missing market value'; return result;
  }
  result.giveValue = g.reduce(function (v, m) { return v + m.value; }, 0);
  result.receiveValue = r.reduce(function (v, m) { return v + m.value; }, 0);
  const hasElite = g.concat(r).some(function (m) { return m.tier === 1; });
  if (hasElite && give.length === 1 && receive.length === 1) {
    result.reason = 'Elite assets require a multi-player package'; return result;
  }
  for (const pair of [[g, r], [r, g]]) {
    const stars = pair[0].filter(function (m) { return m.tier === 1; });
    if (!stars.length || pair[1].some(function (m) { return m.tier === 1; })) continue;
    const eliteValue = Math.max.apply(null, stars.map(function (m) { return m.value; }));
    if (pair[1].length < 2 || pair[1].some(function (m) { return m.tier > 3 || m.value < eliteValue * 0.2; }) ||
        pair[1].reduce(function (v, m) { return v + m.value; }, 0) < eliteValue * 1.1 - 1e-6) {
      result.reason = 'Elite return needs two meaningful assets and a consolidation premium'; return result;
    }
  }
  result.ratio = Math.min(result.giveValue, result.receiveValue) / Math.max(result.giveValue, result.receiveValue);
  if (result.ratio < 0.85) { result.reason = 'Market values differ by more than 15%'; return result; }
  if (give.length === 1 && receive.length === 1 && Math.abs(g[0].tier - r[0].tier) > 1) {
    result.reason = 'Player tiers do not match'; return result;
  }
  result.accepted = true;
  return result;
}

module.exports = { snapshot: snapshot, marketOf: marketOf, packageMarket: packageMarket };
