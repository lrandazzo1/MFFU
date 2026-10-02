#!/usr/bin/env node
/* Refresh outside the scoring path; committed snapshots are deterministic. */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const args = new Map(process.argv.slice(2).map((arg) => {
  const at = arg.indexOf('='); return [arg.slice(0, at), arg.slice(at + 1)];
}));
const url = 'https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=12&ppr=1';
const destination = fileURLToPath(new URL('../lib/data/trade-market-2026.json', import.meta.url));
try {
  const rows = args.has('--fixture') ? JSON.parse(readFileSync(args.get('--fixture'), 'utf8')) :
    await fetch(url, { signal: AbortSignal.timeout(30000) }).then(async (response) => {
      if (!response.ok) throw new Error('FantasyCalc answered HTTP ' + response.status);
      return response.json();
    });
  if (!Array.isArray(rows)) throw new Error('Expected a player array');
  const players = rows.filter((r) => r.player && r.player.espnId && ['QB', 'RB', 'WR', 'TE'].includes(r.player.position))
    .map((r) => ({ id: String(r.player.espnId), name: String(r.player.name), pos: r.player.position,
      value: Number(r.value), rank: Number(r.overallRank), positionRank: Number(r.positionRank) }));
  if (players.length < 100 || new Set(players.map((p) => p.id)).size !== players.length ||
      players.some((p) => !Number.isFinite(p.value) || p.value < 0 || !(p.rank > 0) || !(p.positionRank > 0))) {
    throw new Error('Incomplete or invalid market snapshot; previous file retained');
  }
  const snapshot = { source: 'FantasyCalc redraft trade values', url, asOf: new Date().toISOString(),
    season: 2026, format: { numQbs: 1, numTeams: 12, ppr: 1 }, players };
  writeFileSync(destination + '.tmp', JSON.stringify(snapshot, null, 2) + '\n');
  renameSync(destination + '.tmp', destination);
  console.log('[TradeMarket] Saved ' + players.length + ' player values for 2026, 12-team PPR, 1QB.');
} catch (err) {
  console.error('[TradeMarket] Refresh failed; the previous snapshot remains available.', err);
  process.exitCode = 1;
}
