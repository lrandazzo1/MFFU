'use strict';

const { createHash } = require('node:crypto');
const { number } = require('./providers');
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pick = (pool, seed) => pool[parseInt(hash(seed).slice(0,8),16) % pool.length];
const fixed = value => Number(value).toFixed(1);
const STATUS = { ACTIVE:'ACTIVE', NORMAL:'ACTIVE', Q:'QUESTIONABLE', QUESTIONABLE:'QUESTIONABLE', D:'DOUBTFUL', DOUBTFUL:'DOUBTFUL', O:'OUT', OUT:'OUT', IR:'IR', INJURED_RESERVE:'IR', PUP:'PUP' };

const OPEN = {
  waiver:[
    'The waiver order just became a spending record. Somebody wanted an answer badly enough to put a number next to it.',
    'The claim cleared. The excuses are still pending. This is the part of the season when roster conviction starts leaving receipts.',
    'The wire has stopped being a shopping list and started being evidence. A manager has committed roster space; now the lineup has to justify it.',
    'One processed claim, one fresh obligation. Winning the auction is the easy half of a waiver decision.',
    'The front office has made its move. The rest of the league gets to keep the receipt until the scoreboard tells it what to do with it.',
    'The overnight board has a new owner. What looked like an option yesterday is now somebody else’s roster decision.',
  ],
  move:[
    'The roster is different. The burden of proof has not moved an inch. This transaction puts a new decision in front of a manager who will eventually have to start somebody.',
    'A roster spot just changed hands, and the old depth chart is already out of date. The transaction log is where a front office signs its work.',
    'The bench has been reopened for business. Every name kept is a vote of confidence; every name cut is a bet that the league will not make it hurt.',
    'Another roster decision is official. The interesting part begins when the player becomes a lineup choice instead of a name on a watchlist.',
    'The personnel file has a fresh entry. The roster gets one more revision before the scoreboard gets the final edit.',
    'The move is through. There is no appeal window for the opportunity cost of the spot it occupies.',
  ],
  trade:[
    'The deal is through, and the league has a new argument. Both front offices signed the same transaction; they do not have to be right about the same future.',
    'The trade block has produced an actual trade. The names are moving, the stakes are mutual, and the weekly lineup is where the sales pitch faces cross-examination.',
    'Two versions of roster ambition have met in the transaction log. The agreement is official. The verdict will take longer.',
    'The league’s personnel map has been redrawn. A completed trade creates a receipt on both sides, with nowhere to hide the players who changed hands.',
    'The negotiation has left the group chat and entered the record. Every incoming asset has an outgoing cost attached to it.',
    'The deal is no longer a rumor. The front offices have exchanged actual assets, and the rest of the league can finally argue about something that happened.',
  ],
};
const CLOSE = [
  'That is the front-office wager: turn an available name into usable production before the next roster problem arrives. The transaction is permanent evidence. The justification still has to be played.',
  'A completed move buys a different set of choices. It does not buy a clean Sunday. The next lineup will show which part of this decision was preparation and which part was merely activity.',
  'The league can debate the move all week. The useful audit is less forgiving: who actually enters the lineup, what that slot produces, and whether the outgoing asset makes the decision expensive in hindsight.',
  'The paperwork is finished. The football is not. Keep the asset ledger beside the next lineup; that is where the confident explanation will either acquire evidence or need a rewrite.',
  'Roster activity is easy to count. Roster improvement has to survive a scoring period. The transaction log has filed the claim; the lineup now carries the burden of proof.',
  'The front office has changed the available answers. The weekly score will decide whether it asked the right question. Until then, the receipt belongs to everybody in the league.',
];

function injuryState(snapshot) {
  const result = {};
  Object.values(snapshot.players).forEach(p => {
    const status = STATUS[String(p.status || '').toUpperCase()];
    if (p.teamId && status) result[p.id] = { status, teamId:p.teamId };
  });
  return result;
}

function injuryEvents(snapshot, previous, observedAt, week, revision) {
  if (!previous) return [];
  const current = injuryState(snapshot);
  return Object.keys(current).sort().flatMap(id => {
    const prior = previous[id], next = current[id];
    if (!prior || prior.teamId !== next.teamId || prior.status === next.status) return [];
    return [{ id:`injury:${id}:${revision}:${prior.status}:${next.status}`, kind:'injury', at:observedAt,
      week, playerId:id, fromStatus:prior.status, status:next.status, moves:[], assets:[] }];
  });
}

function teamAudit(team, seed, leagueTeams = []) {
  const values = [team.wins,team.losses,team.ties,team.points];
  if (!values.every(v => number(v) != null && Number(v) >= 0)) return null;
  const games = team.wins + team.losses + team.ties;
  if (!games) return null;
  // Do not divide PF by W/L/T: median games and doubleheaders can add
  // decisions without adding scoring weeks. Compare observed team totals.
  const total = leagueTeams.reduce((sum,t) => sum + (number(t.points) || 0),0);
  const comparable = leagueTeams.length > 1 && leagueTeams.every(t => number(t.points) != null && t.points >= 0) && total > 0;
  const average = comparable ? total / leagueTeams.length : null;
  const scoring = comparable ? ` That is <b>${fixed(team.points / total * 100)}%</b> of the league's recorded scoring and <b>${fixed(Math.abs(team.points-average))}</b> points ${team.points >= average ? 'above' : 'below'} the <b>${fixed(average)}</b>-point team average.` : '';
  return `<b>${esc(team.name)}</b> enters this observation at <b>${team.wins}-${team.losses}${team.ties ? '-'+team.ties : ''}</b>, with <b>${fixed(team.points)}</b> recorded points.${scoring} ` + pick([
    'That is the scoring baseline this front office has to improve. A fresh name on the roster changes the options; it does not retroactively repair a single point in that ledger.',
    'This is the existing production standard, not a forecast for the new arrival. The transaction earns its keep only when the manager converts the new options into a better weekly lineup.',
    'The record supplies the pressure. The scoring ledger supplies the benchmark. Neither gives a newly acquired player credit before the lineup produces it.',
  ],seed);
}

function generate(s, event, snapshot, observedAt) {
  const seed = `${s.key}:${event.id}`;
  const id = 'wire-'+hash(seed).slice(0,32);
  const name = pid => snapshot.players[pid] && snapshot.players[pid].name;
  const team = tid => snapshot.teams[tid];
  const paragraphs = [], rows = [];
  let headline, dek, topic, tag;
  if (event.kind === 'injury') {
    const p = snapshot.players[event.playerId], t = team(p.teamId);
    if (!t || !p.name) throw new Error('Injury player/team unresolved');
    const healthy = Object.values(snapshot.players).filter(q => q.id !== p.id && q.teamId === p.teamId && q.pos && q.pos === p.pos && !q.starter && STATUS[String(q.status).toUpperCase()] === 'ACTIVE').sort((a,b) => a.id.localeCompare(b.id));
    tag = 'INJURY WIRE'; topic = 'breaking';
    headline = `${esc(p.name.toUpperCase())} NOW ${esc(event.status)}: ${esc(t.name.toUpperCase())} FACES THE ROSTER CHECK`;
    dek = `${esc(event.fromStatus)} → ${esc(event.status)}. ${esc(t.name)} has a changed designation to account for.`;
    paragraphs.push(`<b>${esc(p.name)}</b> has moved from <b>${esc(event.fromStatus)}</b> to <b>${esc(event.status)}</b> in the latest roster observation. <b>${esc(t.name)}</b> now has a different availability designation attached to the same roster spot. The designation changed; the obligation to field a usable lineup did not.`);
    paragraphs.push(event.status === 'ACTIVE'
      ? `The active designation reopens an option. It is not a promise of workload, a medical clearance from this desk, or an automatic promotion into the lineup. The manager gets a choice back and still has to make it.`
      : `The designation puts the roster construction under examination. ${p.starter ? 'This player is currently listed in a starting slot, so the decision reaches the scoring lineup directly.' : 'This player is currently outside the starting lineup; the immediate exposure is in the depth chart.'} A status flag is a planning problem before it becomes a scoring problem.`);
    paragraphs.push(healthy.length
      ? `The current bench contains <b>${healthy.length}</b> active same-position option${healthy.length === 1 ? '' : 's'}: <b>${healthy.map(q => esc(q.name)).join(', ')}</b>. Those are actual rostered alternatives, not free agents presumed to be available. Matching a position establishes a depth option; league slot rules still decide where that player can be used.`
      : `There is no active same-position bench alternative in this roster observation${p.pos ? ' at '+esc(p.pos) : ''}. That narrows the internal response. Flex eligibility, any later acquisition, and the final lineup remain separate decisions; this desk will not promote an imaginary replacement.`);
    const audit = teamAudit(t,seed,Object.values(snapshot.teams)); if (audit) paragraphs.push(audit);
    paragraphs.push(pick(CLOSE,seed+':close'));
    rows.push({label:esc(p.name),value:esc(event.status),note:'Previously '+esc(event.fromStatus)}, {label:'Active same-position bench options',value:String(healthy.length),note:esc(p.pos || 'Position unavailable')});
  } else {
    if (!event.moves.length && !event.assets.length) throw new Error('Transaction has no supported assets');
    const involved = new Set();
    event.moves.forEach(m => {
      if (!name(m.playerId) || (!m.from && !m.to) || (m.from && !team(m.from)) || (m.to && !team(m.to))) throw new Error('Transaction player/team unresolved');
      if (m.from) involved.add(m.from); if (m.to) involved.add(m.to);
    });
    event.assets.forEach(a => { if (!team(a.from) || !team(a.to)) throw new Error('Trade asset team unresolved'); involved.add(a.from); involved.add(a.to); });
    const teams = [...involved].sort().map(team);
    if (!teams.length) throw new Error('Transaction teams unresolved');
    tag = event.kind === 'trade' ? 'TRADE DESK' : event.kind === 'waiver' ? 'WAIVER WIRE' : 'ROSTER MOVE';
    topic = event.kind === 'trade' ? 'breaking' : 'waivers';
    const focus = event.moves[0];
    headline = event.kind === 'trade'
      ? `${teams.map(t => esc(t.name.toUpperCase())).join(' / ')}: THE DEAL IS DONE`
      : `${esc(teams[0].name.toUpperCase())} ${focus.to ? 'ADDS' : 'CUTS'} ${esc(name(focus.playerId).toUpperCase())}${event.bid != null && event.kind === 'waiver' ? ' FOR $'+event.bid : ''}`;
    dek = `${event.moves.length} player movement${event.moves.length === 1 ? '' : 's'}${event.assets.length ? ', '+event.assets.length+' additional asset movement'+(event.assets.length === 1 ? '' : 's') : ''}. The completed transaction and the roster audit, on the record.`;
    paragraphs.push(pick(OPEN[event.kind],seed+':open'));
    const ledger = event.moves.map(m => {
      const verb = m.from && m.to ? `${esc(team(m.from).name)} sends <b>${esc(name(m.playerId))}</b> to <b>${esc(team(m.to).name)}</b>`
        : m.to ? `<b>${esc(team(m.to).name)}</b> adds <b>${esc(name(m.playerId))}</b>` : `<b>${esc(team(m.from).name)}</b> drops <b>${esc(name(m.playerId))}</b>`;
      rows.push({label:esc(name(m.playerId)),value:m.from && m.to ? 'TRADED' : m.to ? 'ADDED' : 'DROPPED',note:esc(m.from ? team(m.from).name : 'Free agents')+' → '+esc(m.to ? team(m.to).name : 'Free agents')});
      return verb+'.';
    });
    event.assets.forEach(a => {
      const label = a.type === 'pick' ? `${a.season} round ${a.round} pick (original roster ${a.original})` : `$${a.amount} FAAB`;
      if (a.type === 'pick' && !(a.season > 0 && a.round > 0) || a.type === 'budget' && !(number(a.amount) != null && a.amount >= 0)) throw new Error('Invalid trade asset');
      ledger.push(`<b>${esc(team(a.from).name)}</b> sends <b>${esc(label)}</b> to <b>${esc(team(a.to).name)}</b>.`);
      rows.push({label:esc(label),value:'TRADED',note:esc(team(a.from).name)+' → '+esc(team(a.to).name)});
    });
    paragraphs.push(ledger.join(' '));
    if (event.kind === 'waiver' && event.bid != null) {
      if (event.bid < 0) throw new Error('Negative waiver bid');
      rows.push({label:'Winning FAAB bid',value:'$'+event.bid,note:'Completed claim; no losing bid inferred'});
      paragraphs.push(`The recorded winning bid is <b>$${event.bid}</b>. ${event.bid === 0 ? 'A zero-dollar claim preserves bidding money, but it still occupies a roster spot.' : 'That amount is the acquisition cost, not a valuation model and not proof that another manager was one dollar away.'} The useful efficiency question comes next: how much usable lineup production does this particular roster get for the budget and space it committed? A winning claim alone cannot answer it.`);
    }
    teams.forEach(t => {
      const audit = teamAudit(t,seed+':'+t.id,Object.values(snapshot.teams)); if (audit) paragraphs.push(audit);
      const incoming = event.moves.filter(m => m.to === t.id), outgoing = event.moves.filter(m => m.from === t.id);
      const positions = [...new Set(incoming.map(m => snapshot.players[m.playerId].pos).filter(Boolean))].sort();
      paragraphs.push(`<b>${esc(t.name)}</b> takes in <b>${incoming.length}</b> player${incoming.length === 1 ? '' : 's'} and sends out <b>${outgoing.length}</b>${event.assets.length ? '; additional traded assets remain separately itemized in the ledger' : ''}. ${positions.length ? 'The incoming positions are <b>'+positions.map(esc).join(', ')+'</b>. ' : ''}${incoming.length && outgoing.length ? 'This is a personnel exchange, so evaluating only the arrival misses the opportunity given up. The outgoing name belongs in the audit for as long as the incoming one does.' : incoming.length ? 'The addition creates an option. Whether that option fixes a starting slot or simply lengthens the bench is the next decision to watch.' : outgoing.length ? 'The released player no longer occupies this roster. That frees a spot while surrendering the chance to benefit from that player here; a future rebound would belong to whoever makes the next move.' : 'This side of the deal moves future or budget assets without a player transfer. Its effect belongs in the asset ledger until those resources turn into a roster decision.'}`);
      positions.forEach(pos => {
        const group = Object.values(snapshot.players).filter(p => p.teamId === t.id && p.pos === pos);
        if (!group.length) return;
        const active = group.filter(p => STATUS[String(p.status).toUpperCase()] === 'ACTIVE');
        const flagged = group.filter(p => STATUS[String(p.status).toUpperCase()] && STATUS[String(p.status).toUpperCase()] !== 'ACTIVE');
        const bench = active.filter(p => p.starter === false);
        const share = active.length / group.length * 100;
        paragraphs.push(`The current <b>${esc(pos)}</b> room at <b>${esc(t.name)}</b> contains <b>${group.length}</b> player${group.length===1?'':'s'}: <b>${active.length}</b> with an active designation and <b>${flagged.length}</b> carrying an availability flag. That leaves <b>${fixed(share)}%</b> of the position group explicitly active, with <b>${bench.length}</b> active option${bench.length===1?'':'s'} outside the starting lineup. ${bench.length ? 'There is an internal choice to make here. Collecting alternatives only helps if the manager sorts them correctly before the lineup locks.' : 'There is no active bench cushion at this position in the current observation. That makes the next availability change a front-office problem with very little room for ceremony.'}`);
        rows.push({label:esc(t.name)+' · '+esc(pos)+' active depth',value:active.length+'/'+group.length+' ('+fixed(share)+'%)',note:bench.length+' active bench options; observed at filing'});
      });
    });
    paragraphs.push(event.kind === 'trade'
      ? 'The asset count describes the deal, not who won it. Two bench players do not automatically equal one starter, and a draft pick is a claim on a later season rather than present-week scoring. The correct comparison follows each side into its actual lineup instead of declaring a winner from the number of names exchanged.'
      : 'The next audit should follow this player from transaction to lineup. A pickup who remains on the bench may still be useful depth, but it cannot be credited with points the starting lineup never received. Activity and realized production have separate columns.');
    paragraphs.push(pick(CLOSE,seed+':close'));
  }
  return { id, articleKey:id, articleType:'transaction_wire', engine:'deterministic', narrativeLocked:true,
    provider:s.provider, leagueId:s.league, season:s.season, week:event.week,
    sourceEventId:event.id, source:s.provider, at:event.at, createdAt:observedAt, observedAt,
    kind:'transaction-wire', topic, tag, metaTag:tag, tone:event.kind === 'injury' ? 'red' : 'green',
    priority:75, timeline:true, byline:'FSN Front Office Correspondent', dateline:'TRANSACTION WIRE · '+s.season,
    meta:new Date(event.at).toISOString().slice(0,16).replace('T',' ')+' UTC · '+tag,
    headline, dek, paragraphs, numbers:{ title:'The Transaction Ledger', rows,
      note:'Provider: '+s.provider+'. Roster and record context observed '+new Date(observedAt).toISOString()+'. Injury timestamps denote first observation, not medical onset.' } };
}

function build(s,snapshot,previous,observedAt,since,revision = 0) {
  const year = new Date(observedAt).getUTCFullYear() - (new Date(observedAt).getUTCMonth() < 2 ? 1 : 0);
  const injuries = s.season === year && Number.isInteger(snapshot.week) && snapshot.week >= 1 && snapshot.week <= 18
    ? injuryEvents(snapshot,previous,observedAt,snapshot.week,revision) : [];
  const seen = new Set(), articles = [], warnings = [];
  [...snapshot.events,...injuries].sort((a,b) => (a.at-b.at) || a.id.localeCompare(b.id)).forEach(e => {
    if (seen.has(e.id)) return; seen.add(e.id);
    if (!e.id || !Number.isFinite(e.at) || e.at <= 0) { warnings.push('Event missing stable identity or execution timestamp'); return; }
    if (e.at < since || e.at > observedAt) return;
    if (e.week != null && (!Number.isInteger(e.week) || e.week < 1 || e.week > 18)) { warnings.push('Event '+e.id+' has invalid week'); return; }
    try { articles.push(generate(s,e,snapshot,observedAt)); }
    catch (err) { console.warn('[TransactionWire] skipped event '+e.id+' in '+s.key,err); warnings.push('Event '+e.id+': '+err.message); }
  });
  return { articles, injuries:injuryState(snapshot), warnings };
}

module.exports = { build, generate, injuryState, injuryEvents, teamAudit };
