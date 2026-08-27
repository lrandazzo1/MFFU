from pathlib import Path
import re
import textwrap

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
API = ROOT / "api" / "espn.js"

text = INDEX.read_text(encoding="utf-8")
original = text


def replace_once(pattern, replacement, label, flags=re.S):
    global text
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one replacement, got {count}")
    text = updated


def literal_once(old, new, label):
    global text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one literal match, got {count}")
    text = text.replace(old, new, 1)


# 1) Closed captions: centered, smooth swaps, and historical Studio gating CSS.
replace_once(
    r"/\* ---- captions ---- \*/\n\.st-cc\{[\s\S]*?\.st-cc\[data-hidden=\"true\"\]\{ display:none; \}",
    textwrap.dedent(r'''\
    /* ---- captions ---- */
    .st-cc{
      flex:none; position:relative; z-index:2; padding:9px 14px 15px;
      background:rgba(4,6,10,.82); border-top:1px solid var(--line);
      font-family:'Oswald',sans-serif; font-weight:300; font-size:13.5px; line-height:1.5;
      color:#e6ebf3; max-height:88px; overflow-y:auto;
      text-align:center; text-wrap:balance;
    }
    .st-cc .sp{
      font-weight:700; letter-spacing:.1em; text-transform:uppercase;
      font-size:10.5px; margin-right:7px;
    }
    .st-cc[data-hidden="true"]{ display:none; }
    .st-cc.st-cc-in{ animation:stCcIn .22s ease both; }
    @keyframes stCcIn{
      from{ opacity:.2; transform:translateY(3px); }
      to{ opacity:1; transform:none; }
    }
    html[data-studio-historical="true"] #studioBanner,
    html[data-studio-historical="true"] #articleLaunchBroadcastBtn,
    html[data-studio-historical="true"] [data-action="launch-studio"],
    html[data-studio-historical="true"] [data-studio],
    html[data-studio-historical="true"] #studio{
      display:none !important;
    }
    '''),
    "caption CSS",
)

# Keep reduced-motion users out of the caption cross-fade too.
literal_once(
    "  .st-gfx.fraud, .st-chy-q, .st-chy-label[data-mode=\"breaking\"]{ animation:none; }",
    "  .st-gfx.fraud, .st-chy-q, .st-chy-label[data-mode=\"breaking\"], .st-cc.st-cc-in{ animation:none; }",
    "reduced-motion caption rule",
)

# 2) ESPN transport: deployed builds use the same-origin Vercel function first and
# never leak over to public CORS proxies; only static/private-network previews do.
replace_once(
    r"/\* Proxies tried in order[\s\S]*?async function fetchLeagueDataViaProxies\(espnUrl\)\{[\s\S]*?\n\}\n\n/\* ============================================================\n   ALL-TIME LEAGUE HISTORY FETCH",
    textwrap.dedent(r'''\
    /* Public CORS fallbacks are retained strictly for static/local previews.
       Deployed builds use the same-origin Vercel route so one transport path
       serves live weeks and archive hydration without browser CORS variance. */
    const CORS_PROXIES = [
      (u)=> `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      (u)=> `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
      (u)=> `https://thingproxy.freeboard.io/fetch/${u}`,
      (u)=> u,
    ];

    function isStaticLocalPreview(){
      if(typeof window === 'undefined' || !window.location) return false;
      const loc = window.location;
      const host = String(loc.hostname || '').toLowerCase();
      if(loc.protocol === 'file:') return true;
      if(host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local')) return true;
      if(/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
      return false;
    }

    function serverlessEspnUrl(espnUrl){
      return '/api/espn?url=' + encodeURIComponent(espnUrl);
    }

    /* Parse proxy responses as text first. This accommodates raw JSON, proxies
       that return a JSON string, and AllOrigins-style { contents:"..." }
       envelopes without losing leagueHistory's array response shape. */
    function parseEspnProxyPayload(text){
      let data = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));

      for(let depth=0; depth<2 && typeof data === 'string'; depth++){
        data = JSON.parse(data);
      }

      if(data && !Array.isArray(data) && typeof data.contents === 'string'){
        data = JSON.parse(data.contents.replace(/^\uFEFF/, ''));
        for(let depth=0; depth<2 && typeof data === 'string'; depth++){
          data = JSON.parse(data);
        }
      }

      return data;
    }

    function validEspnPayload(rawData){
      return Array.isArray(rawData) || !!(rawData && (rawData.teams || rawData.schedule || rawData.status));
    }

    /* One fetch seam for every ESPN read. In Vercel/deployed environments the
       same-origin function is authoritative. Local previews may fall back to
       the legacy browser proxy chain when /api is not being served. */
    async function fetchLeagueDataViaProxies(espnUrl){
      let lastErr = null;
      const localPreview = isStaticLocalPreview();

      if(typeof window !== 'undefined' && window.location && window.location.protocol !== 'file:'){
        const apiUrl = serverlessEspnUrl(espnUrl);
        try{
          const res = await fetch(apiUrl, { headers:{ Accept:'application/json,text/plain,*/*' } });
          if(!res.ok) throw new Error('HTTP ' + res.status + ' from ' + apiUrl);
          const rawData = parseEspnProxyPayload(await res.text());
          if(validEspnPayload(rawData)) return rawData;
          throw new Error('Unexpected payload shape from ' + apiUrl);
        }catch(err){
          lastErr = err;
          if(!localPreview) throw err;
          console.warn('[FSN] Local /api/espn unavailable; trying static-preview CORS fallbacks.', err);
        }
      }

      if(!localPreview){
        throw lastErr || new Error('The deployed ESPN route /api/espn is unavailable.');
      }

      for(const wrapWithProxy of CORS_PROXIES){
        const attemptUrl = wrapWithProxy(espnUrl);
        try{
          const res = await fetch(attemptUrl);
          if(!res.ok){ lastErr = new Error('HTTP ' + res.status + ' from ' + attemptUrl); continue; }
          const rawData = parseEspnProxyPayload(await res.text());
          if(validEspnPayload(rawData)) return rawData;
          lastErr = new Error('Unexpected payload shape from ' + attemptUrl);
        }catch(err){
          lastErr = err;
        }
      }
      throw lastErr || new Error('ALL_LOCAL_PREVIEW_PROXIES_FAILED');
    }

    /* ============================================================
       ALL-TIME LEAGUE HISTORY FETCH'''),
    "ESPN transport",
)

literal_once(
    "The live league request could not be completed through the proxy chain. Check the League ID or use the JSON fallback below.",
    "The live league request could not be completed through the ESPN data route. Check the League ID or use the JSON fallback below.",
    "ESPN error copy",
)

# 3) Studio caption pacing: 15 characters/sec fallback and smooth cue swaps.
replace_once(
    r"function estimateMs\(text\)\{[\s\S]*?\n\}",
    textwrap.dedent(r'''\
    function estimateMs(text){
      const clean = String(text || '').replace(/\s+/g, ' ').trim();
      const punctuation = (clean.match(/[,.!?;:]/g) || []).length;
      const charTimed = Math.round((clean.length / 15) * 1000) + punctuation * 70 + 250;
      return Math.max(2200, Math.min(45000, charTimed));
    }'''),
    "caption pacing",
)

literal_once(
    "  $('stCaption').innerHTML =\n    `<span class=\"sp\" style=\"color:${host.color}\">${esc(c.name || host.label)}</span>${esc(c.text)}`;",
    textwrap.dedent(r'''\
      const caption = $('stCaption');
      if(caption){
        caption.classList.remove('st-cc-in');
        caption.innerHTML = `<span class="sp" style="color:${host.color}">${esc(c.name || host.label)}</span>${esc(c.text)}`;
        caption.scrollTop = 0;
        void caption.offsetWidth;
        caption.classList.add('st-cc-in');
      }''').rstrip(),
    "caption paint",
)

# Device speech stays tied to the real speechSynthesis end event; only an
# obviously broken/instant end uses character-paced fallback.
literal_once(
    "    if(!started || elapsed < need * 0.5) state.timer = setTimeout(done, Math.max(500, need - elapsed));\n    else done();",
    "    if(!started || elapsed < 650) state.timer = setTimeout(done, Math.max(500, need - elapsed));\n    else done();",
    "device speech early-end guard",
)

# 4) Adaptive regular-season show formats. Existing draft/preseason builders,
# graphics, data helpers, audio system and safe fallbacks remain the source of truth.
replace_once(
    r"function buildShow\(week\)\{[\s\S]*?\n\}\n\n/\* ============================================================\n   GRAPHICS RENDERER",
    textwrap.dedent(r'''\
    function studioHistoricalView(){
      try{
        const viewed = Number(NewsDesk.viewedSeasonYear());
        const active = Number(NewsDesk.activeSeasonYear());
        return viewed > 0 && active > 0 && viewed < active;
      }catch(e){ return false; }
    }

    function studioFormatInfo(week, now){
      const w = Math.max(1, parseInt(week, 10) || 1);
      const phase = safeStudioCall('season phase for format', ()=> FSNIntel.seasonPhase(w), 'season');
      if(phase === 'draft' || phase === 'preseason'){
        return { id:'preseason', label:'PRESEASON EDITION', subtitle:'Preseason Edition · Dynamic League Desk', segments:0 };
      }
      const d = now instanceof Date ? now : new Date();
      const day = d.getDay();
      if(day === 3 || day === 4 || day === 5){
        return { id:'primetime', label:'PRIMETIME PREVIEW', subtitle:'Primetime Preview · 3 segments', segments:3 };
      }
      if(day === 6 || day === 0){
        return { id:'gameday', label:'GAMEDAY COUNTDOWN', subtitle:'Gameday Countdown · 3 segments', segments:3 };
      }
      return { id:'debrief', label:'TUESDAY DEBRIEF', subtitle:'Tuesday Debrief · 4 segments', segments:4 };
    }

    function studioDialogueHash(value){
      const s = String(value || '');
      let h = 0;
      for(let i=0; i<s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0;
      return h;
    }

    const STUDIO_DIALOGUE = {
      debriefScoreboard:[
        v=>`The Monday night dust has settled. Week ${v.week} is final, and we start where every Tuesday show should start: the scoreboard and the game everybody is still talking about.`,
        v=>`Tuesday means receipts, Dee. Week ${v.week} is in the books, so put the final board on the wall and take me straight to the headline matchup.`,
        v=>`No projections now. These are final numbers from week ${v.week}, and one matchup earned the top line of the show.`,
        v=>`The week is closed, the excuses are closed with it, and this is the week ${v.week} final scoreboard. Start with the marquee game.`,
        v=>`Welcome to the Tuesday Debrief. Week ${v.week} left a full set of final scores behind, and the tightest headline belongs at the top of the rundown.`,
      ],
      coaching:[
        v=>`Now grade the decisions, not just the points. Week ${v.week} had good lineups, wasted bench points, and at least one manager who squeezed more out of Sunday than the rest of the room.`,
        v=>`The scoreboard tells us who won. Coaching efficiency tells us how. Week ${v.week} is where we separate clean lineup work from bench regret.`,
        v=>`Time for the manager tape. We are checking lineup efficiency first, then the bench decisions that will look worse every time somebody reopens the box score.`,
        v=>`Winning is one thing; extracting the right points is another. Put week ${v.week} under the coaching microscope and show me the bench blunders.`,
        v=>`This is the decision desk: starts, sits, efficiency, and the points that never made it into the lineup in week ${v.week}.`,
      ],
      fraud:[
        v=>`Good teams can have bad Sundays. Bad decisions can also expose a team in a hurry. Week ${v.week} gives us a Hot Seat and a Fraud Alert, and the numbers get the first word.`,
        v=>`Here comes the uncomfortable part of Tuesday. Somebody owns the low end of week ${v.week}, and the Hot Seat graphic is not interested in alibis.`,
        v=>`We have praised the winners. Now put the weakest week ${v.week} performance under the red lights and decide whether this is noise or a real warning.`,
        v=>`The Fraud Alert is live. Week ${v.week} left one roster with too much explaining to do, especially once the bench is part of the evidence.`,
        v=>`This segment comes with a warning label: week ${v.week} has a Hot Seat candidate, and the gap to the field is hard to talk around.`,
      ],
      power:[
        v=>`Last word on week ${v.week}: the Power Index moves after the games, not before them. Show me who climbed, who slipped, and who changed tiers.`,
        v=>`Final segment, and this is where one Sunday changes the hierarchy. Week ${v.week} has a new Power Index board.`,
        v=>`Take the final scores, fold in the underlying profile, and redraw the league map. This is the week ${v.week} Power Index shakeup.`,
        v=>`The standings tell one story; the Power Index tells us who the model actually trusts after week ${v.week}. Put the movers on screen.`,
        v=>`Before we leave Tuesday, reset the pecking order. Week ${v.week} changed the Power Index, and not everybody is going to enjoy the new seat.`,
      ],
      rosterLocks:[
        v=>`Thursday night is the first hard checkpoint of week ${v.week}. Before the opening kickoff, this is the roster-lock board every manager should be staring at.`,
        v=>`Primetime Preview starts with the Thursday window. Week ${v.week} lineups still have flexibility, but the first lock is coming fast.`,
        v=>`It is Thursday setup time: active slots, questionable tags, and every player whose kickoff can turn a maybe into a locked decision in week ${v.week}.`,
        v=>`Before we debate matchups, handle the operational stuff. Thursday night starts the lock sequence for week ${v.week}, so every early player needs a decision.`,
        v=>`The weekend begins with roster discipline. Week ${v.week} hits its first kickoff on Thursday, and late lineup regret usually starts before the game does.`,
      ],
      matchup:[
        v=>`Now to the matchup we circled for week ${v.week}. Put the Tale of the Tape up and let the win-probability model make the first argument.`,
        v=>`One game gets the primetime treatment in week ${v.week}. Records on one side, model probability on the other, and plenty of room for Dee to disagree.`,
        v=>`This is the week ${v.week} feature matchup. Forget the noise and start with the two rosters, the pregame edge, and the paths to an upset.`,
        v=>`Every slate has one matchup that deserves a longer look. Week ${v.week} has ours, and the model has already picked a side.`,
        v=>`Bring up the tape for week ${v.week}. The favorite has a number; the underdog has a case. That is exactly where the debate starts.`,
      ],
      injuryWaiver:[
        v=>`The last primetime check is availability. Week ${v.week} has injury tags to track and waiver names that matter more if one of those tags goes the wrong way.`,
        v=>`Injuries and waivers are one conversation this late in the week. For week ${v.week}, every questionable player creates a second-order roster decision somewhere else.`,
        v=>`Open the injury wire. Week ${v.week} managers do not just need statuses; they need the replacement plan sitting next to each status.`,
        v=>`This is the contingency board for week ${v.week}: who is tagged, who can be stashed, and which waiver move protects the lineup before Sunday.`,
        v=>`Primetime ends on the transaction desk. Week ${v.week} injury news can change a starting slot and the waiver market with the same update.`,
      ],
      sundaySlate:[
        v=>`It is Gameday Countdown for week ${v.week}. The Sunday slate is set, so run every matchup across the board before the first window opens.`,
        v=>`Sunday is close enough to hear it now. Week ${v.week} has a full fantasy slate, and this is the matchup-by-matchup countdown.`,
        v=>`No more midweek theory. Week ${v.week} is at the Sunday gate, and every matchup gets one last pre-kickoff look.`,
        v=>`The lineup clock is moving. Put the week ${v.week} Sunday slate on screen and show me where the projected scoreboard is tightest.`,
        v=>`Gameday starts with the whole map. Week ${v.week} has favorites, coin flips, and a few matchups one ceiling game can completely rewrite.`,
      ],
      ceiling:[
        v=>`Now zoom in from teams to players. Week ${v.week} turns on a handful of ceiling outcomes, and the key-player board tells us where the leverage lives.`,
        v=>`Team projections are useful; player ceilings decide the screenshots. These are the week ${v.week} names sitting closest to the matchup swing points.`,
        v=>`The next layer is individual leverage. Week ${v.week} has key players who can drag an entire fantasy matchup above its projection.`,
        v=>`Give me the ceiling plays for week ${v.week}. These are the players and lineup anchors with the clearest chance to break the expected script.`,
        v=>`Every upset needs a player who outruns the median. Week ${v.week} has a short list of those swing pieces, and this is where they line up.`,
      ],
      upset:[
        v=>`Final check before kickoff: where is the model most vulnerable? Week ${v.week} Upset Watch pairs the win probabilities with the projected scoreboard.`,
        v=>`Favorites are not guarantees. Week ${v.week} closes with the underdogs carrying the most believable path to flipping the board.`,
        v=>`This is the danger zone for the favorites. Week ${v.week} has projected scores on one side and upset probability on the other.`,
        v=>`Before the countdown hits zero, circle the week ${v.week} matchups where the favorite should be the least comfortable.`,
        v=>`One last board: projected finals and the upset cases most likely to make those projections look silly by Sunday night.`,
      ],
    };

    function studioDialogue(key, week, vars){
      const deck = STUDIO_DIALOGUE[key] || [];
      if(!deck.length) return '';
      const season = safeStudioCall('dialogue season', ()=> Number(NewsDesk.viewedSeasonYear()), 0) || 0;
      const idx = Math.abs((Number(week) || 0) + season + studioDialogueHash(key)) % deck.length;
      return deck[idx](Object.assign({ week }, vars || {}));
    }

    function stripStudioText(value){
      return String(value == null ? '' : value)
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    }

    function retitleStudioSegment(segment, id, title, dialogueKey, week, vars){
      if(!segment) return null;
      segment.id = id;
      segment.title = title;
      if(Array.isArray(segment.cues) && segment.cues[0]){
        const line = studioDialogue(dialogueKey, week, vars);
        if(line) segment.cues[0].text = line;
        segment.cues[0].chyron = String(title).toUpperCase();
      }
      return segment;
    }

    function studioStandbySegment(id, title, dialogueKey, week){
      const gfx = {
        title,
        rows:[{ idx:'W' + week, name:'League feed standing by', sub:'The segment will populate from ESPN data as soon as it is available', value:'LIVE' }],
        note:'FSN keeps the scheduled rundown intact without inventing missing league facts.',
      };
      return seg(id, title, [
        cue('host', studioDialogue(dialogueKey, week) || `Week ${week} data is still arriving. We will keep this segment on the rundown without inventing a result.`, 'rundown', gfx, String(title).toUpperCase()),
      ]);
    }

    function resolveStudioContentWeek(week, formatId){
      const w = Math.max(1, parseInt(week, 10) || 1);
      if(formatId !== 'debrief' || w <= 1) return w;
      const current = studioWeekState(w);
      if(!current.preview) return w;
      const previous = studioWeekState(w - 1);
      return previous.unplayed ? w : (w - 1);
    }

    function segFinalScoreboard(week){
      const games = validStudioGames(week).filter(g=> (Number(g.homeScore) || 0) > 0 || (Number(g.awayScore) || 0) > 0);
      if(!games.length) return null;
      const marquee = games.slice().sort((a,b)=>{
        const am = Math.abs((Number(a.homeScore)||0) - (Number(a.awayScore)||0));
        const bm = Math.abs((Number(b.homeScore)||0) - (Number(b.awayScore)||0));
        if(am !== bm) return am - bm;
        return ((Number(b.homeScore)||0) + (Number(b.awayScore)||0)) - ((Number(a.homeScore)||0) + (Number(a.awayScore)||0));
      })[0];
      const rows = games.slice(0, 10).map((g, i)=>{
        const hs = Number(g.homeScore)||0, as = Number(g.awayScore)||0;
        const winner = hs === as ? 'TIE' : (hs > as ? g.homeTeam.name : g.awayTeam.name);
        return { idx:i + 1, name:g.awayTeam.name + ' at ' + g.homeTeam.name, sub:winner === 'TIE' ? 'FINAL · TIE' : 'FINAL · ' + winner + ' WINS', value:n1(as) + '–' + n1(hs) };
      });
      const board = { title:'Final Scoreboard · Week ' + week, rows, note:games.length + ' scored matchup' + (games.length === 1 ? '' : 's') + ' on the final board.' };
      const ma = marquee.awayTeam.name, mh = marquee.homeTeam.name;
      const mas = Number(marquee.awayScore)||0, mhs = Number(marquee.homeScore)||0;
      const margin = Math.abs(mas - mhs);
      return seg('final-scoreboard', 'Final Scoreboard & Headline Marquee Game', [
        cue('host', studioDialogue('debriefScoreboard', week), 'rundown', board, 'FINAL SCOREBOARD · WEEK ' + week, { sfx:'whoosh' }),
        cue('analyst', `${ma} and ${mh} get the headline slot after a ${n1(margin)}-point finish, ${n1(mas)} to ${n1(mhs)}. That is the game to start with because the final margin left the least room for one wrong lineup decision.`, 'rundown', board, 'MARQUEE FINAL · ' + ma.toUpperCase() + ' ' + n1(mas) + ' · ' + mh.toUpperCase() + ' ' + n1(mhs), { sfx:'sting' }),
        cue('host', `The rest of the week ${week} board is final too. No projection language, no future tense — these are the scores that now move standings, power ratings, and every argument we have for the next six days.`, 'rundown', board, 'WEEK ' + week + ' · FINAL BOARD'),
      ]);
    }

    function segCoachingEfficiency(week){
      const ctx = safeStudioCall('coaching efficiency context', ()=> NewsDesk.weekContext(week), null);
      const stories = ctx ? safeStudioCall('manager of the week generator', ()=> NewsDesk.genManagerOfTheWeek(ctx), []) : [];
      const feature = Array.isArray(stories) && stories.length ? stories[0] : null;
      const rows = [];
      if(feature && feature.numbers && Array.isArray(feature.numbers.rows)){
        feature.numbers.rows.slice(0, 6).forEach((r, i)=> rows.push({
          idx:i + 1,
          name:stripStudioText(r.label || r.name || ('Coaching note ' + (i + 1))),
          sub:'COACHING EFFICIENCY',
          value:stripStudioText(r.value == null ? '—' : r.value),
        }));
      }

      let benchLine = '';
      if(ctx && ctx.lowSide && ctx.lowSide.side){
        const low = ctx.lowSide;
        const side = low.side;
        const roster = side.game && side.game.homeTeam && String(side.game.homeTeam.id) === String(low.team.id) ? side.homeRoster : side.awayRoster;
        const topBench = roster && roster.topBench;
        const worstStarter = roster && roster.worstStarter;
        if(topBench && worstStarter){
          const swing = Math.max(0, (Number(topBench.points)||0) - (Number(worstStarter.points)||0));
          benchLine = `${topBench.name || 'A bench player'} posted ${n1(topBench.points)} on the bench while ${worstStarter.name || 'a starter'} delivered ${n1(worstStarter.points)} in the lineup — a ${n1(swing)}-point decision gap.`;
          rows.unshift({ idx:'BN', name:topBench.name || 'Bench player', sub:'BENCH BLUNDER · ' + (low.team && low.team.name ? low.team.name : 'LINEUP'), value:'+' + n1(swing) });
        }
      }
      if(!rows.length){
        validStudioGames(week).slice(0, 6).forEach((g, i)=> rows.push({ idx:i + 1, name:g.awayTeam.name + ' / ' + g.homeTeam.name, sub:'LINEUP REVIEW', value:n1((Number(g.awayScore)||0) + (Number(g.homeScore)||0)) + ' PTS' }));
      }
      const board = {
        title:'Coaching Efficiency · Week ' + week,
        rows:rows.slice(0, 7),
        note:feature ? stripStudioText(feature.dek || feature.headline) : 'Manager of the Week uses the same News Desk coaching-efficiency engine shown in the weekly feed.',
      };
      return seg('coaching-efficiency', 'Coaching Efficiency & Bench Blunders', [
        cue('host', studioDialogue('coaching', week), 'rundown', board, 'COACHING EFFICIENCY · WEEK ' + week, { sfx:'whoosh' }),
        feature ? cue('analyst', `${stripStudioText(feature.headline)}. ${stripStudioText(feature.dek || '')}`.trim(), 'rundown', board, 'MANAGER OF THE WEEK · DECISION GRADE', { sfx:'sting' }) : null,
        cue('host', benchLine || `The detailed bench feed is thinner this week, so the desk will not invent a start-sit mistake. The efficiency board stays limited to decisions ESPN actually exposed.`, 'rundown', board, benchLine ? 'BENCH BLUNDER · POINTS LEFT OUT' : 'BENCH CHECK · VERIFIED DATA ONLY'),
      ]);
    }

    function segRosterLocks(week){
      const games = validStudioGames(week);
      const injuries = safeStudioCall('roster lock injuries', ()=> FSNIntel.injuries(), []);
      const rows = games.slice(0, 8).map((g, i)=>({
        idx:i + 1,
        name:g.awayTeam.name + ' at ' + g.homeTeam.name,
        sub:recordSafe(g.awayTeam.id, week) + ' vs ' + recordSafe(g.homeTeam.id, week),
        value:(projectedSafe(g, 'away') !== '—' || projectedSafe(g, 'home') !== '—') ? projectedSafe(g, 'away') + '–' + projectedSafe(g, 'home') : 'LOCK CHECK',
      }));
      if(!rows.length) rows.push({ idx:'TNF', name:'Thursday roster lock', sub:'Matchup feed is still populating', value:'CHECK LINEUPS' });
      const board = { title:'Thursday Kickoff & Roster Locks', rows, note:(Array.isArray(injuries) ? injuries.length : 0) + ' current injury tag' + ((Array.isArray(injuries) ? injuries.length : 0) === 1 ? '' : 's') + ' visible in the league feed.' };
      return seg('roster-locks', 'Thursday Kickoff & Roster Locks', [
        cue('host', studioDialogue('rosterLocks', week), 'rundown', board, 'THURSDAY KICKOFF · ROSTER LOCKS', { sfx:'whoosh' }),
        cue('analyst', `The rule for the first window is simple: decide every Thursday player before that player's kickoff. Do not let an early game remove an option you thought you still had on Sunday.`, 'rundown', board, 'LOCK DISCIPLINE · EARLY PLAYERS FIRST'),
        cue('host', `${Array.isArray(injuries) ? injuries.length : 0} injury tag${(Array.isArray(injuries) ? injuries.length : 0) === 1 ? '' : 's'} are currently visible to the desk. Any one of them can change a flex spot, a handcuff, or the waiver priority before the weekend.`, 'rundown', board, 'ROSTER CHECK · INJURY TAGS MATTER'),
      ]);
    }

    function studioInjuryName(item){
      return (item && item.player && item.player.name) || (item && item.name) || (item && item.playerName) || 'Tagged player';
    }
    function studioInjuryStatus(item){
      return (item && item.status) || (item && item.injuryStatus) || (item && item.player && item.player.injuryStatus) || 'MONITOR';
    }
    function studioInjuryTeam(item){
      return (item && item.team && item.team.name) || (item && item.teamName) || (item && item.fantasyTeam && item.fantasyTeam.name) || 'League roster';
    }

    function segInjuryWaiver(week){
      const injuries = safeStudioCall('injury wire', ()=> FSNIntel.injuries(), []);
      const stashes = safeStudioCall('waiver stash candidates', ()=> FSNIntel.stashCandidates(4), []);
      const rows = (Array.isArray(injuries) ? injuries : []).slice(0, 6).map((x, i)=>({
        idx:i + 1, name:studioInjuryName(x), sub:studioInjuryTeam(x), value:String(studioInjuryStatus(x)).toUpperCase(), dir:/out|ir|doubt/i.test(String(studioInjuryStatus(x))) ? 'down' : '',
      }));
      (Array.isArray(stashes) ? stashes : []).slice(0, Math.max(0, 8 - rows.length)).forEach((x, i)=> rows.push({
        idx:'W' + (i + 1), name:(x && x.player && x.player.name) || (x && x.name) || 'Waiver candidate', sub:'WAIVER / STASH IMPACT', value:(x && (x.pos || x.position)) || 'WATCH', dir:'up',
      }));
      if(!rows.length) rows.push({ idx:'OK', name:'No active injury flags in the current feed', sub:'Continue normal late-week checks', value:'CLEAR' });
      const board = { title:'Injury Wire & Waiver Impact', rows, note:'Statuses and stash candidates come from the current ESPN roster feed; FSN does not invent injury news.' };
      return seg('injury-waiver', 'Injury Wire & Waiver Impact', [
        cue('host', studioDialogue('injuryWaiver', week), 'rundown', board, 'INJURY WIRE · WAIVER IMPACT', { sfx:'whoosh' }),
        cue('analyst', `${Array.isArray(injuries) ? injuries.length : 0} injury tag${(Array.isArray(injuries) ? injuries.length : 0) === 1 ? '' : 's'} are on the current board. The actionable part is not the label by itself — it is which starting slot and backup plan that label touches.`, 'rundown', board, 'AVAILABILITY · BUILD THE BACKUP PLAN'),
        cue('host', `${Array.isArray(stashes) ? stashes.length : 0} stash or waiver candidate${(Array.isArray(stashes) ? stashes.length : 0) === 1 ? '' : 's'} made the short list. That is where injury news turns into a transaction decision instead of just another notification.`, 'rundown', board, 'WAIVER IMPACT · CONTINGENCY DEPTH'),
      ]);
    }

    function segSundaySlate(week){
      const games = validStudioGames(week);
      const rows = games.slice(0, 10).map((g, i)=>({
        idx:i + 1,
        name:g.awayTeam.name + ' at ' + g.homeTeam.name,
        sub:recordSafe(g.awayTeam.id, week) + ' vs ' + recordSafe(g.homeTeam.id, week),
        value:(projectedSafe(g, 'away') !== '—' || projectedSafe(g, 'home') !== '—') ? projectedSafe(g, 'away') + '–' + projectedSafe(g, 'home') : 'PREGAME',
      }));
      if(!rows.length) rows.push({ idx:'SUN', name:'Sunday slate pending', sub:'The matchup feed has not posted complete pairings yet', value:'STANDBY' });
      const board = { title:'Sunday Slate · Week ' + week, rows, note:'Projected totals remain forecasts until fantasy points actually post.' };
      return seg('sunday-slate', 'Sunday Slate Matchup Previews', [
        cue('host', studioDialogue('sundaySlate', week), 'rundown', board, 'GAMEDAY COUNTDOWN · SUNDAY SLATE', { sfx:'whoosh' }),
        cue('analyst', `${games.length} matchup${games.length === 1 ? '' : 's'} are on the week ${week} board. The closest projected games deserve the most lineup attention because one late swap has a better chance to change the result.`, 'rundown', board, 'SUNDAY BOARD · PROJECTIONS, NOT RESULTS'),
      ]);
    }

    function segCeilingPlays(week){
      const games = validStudioGames(week);
      const rows = [];
      games.forEach((g)=>{
        [g.awayTeam, g.homeTeam].forEach((team)=>{
          if(!team || rows.length >= 8) return;
          const player = safeStudioCall('ceiling play starter', ()=> FSNIntel.startingQB(week, team.id), null);
          if(!player || !player.name) return;
          const proj = Number(player.projected || player.projectedPoints || player.projection || 0);
          rows.push({ idx:player.pos || 'QB', name:player.name, sub:team.name + ' · KEY STARTER', value:proj > 0 ? n1(proj) + ' PROJ' : 'CEILING PLAY', dir:'up' });
        });
      });
      if(!rows.length){
        games.slice(0, 6).forEach((g, i)=> rows.push({ idx:i + 1, name:g.awayTeam.name + ' / ' + g.homeTeam.name, sub:'TEAM CEILING MATCHUP', value:projectedSafe(g, 'away') + '–' + projectedSafe(g, 'home') }));
      }
      if(!rows.length) rows.push({ idx:'KEY', name:'Starting lineups still populating', sub:'No player-level projection will be invented', value:'STANDBY' });
      const board = { title:'Key Player Matchups & Ceiling Plays', rows:rows.slice(0, 8), note:'Player names come from posted starting lineups; missing player projections stay unlabeled rather than being estimated.' };
      return seg('ceiling-plays', 'Key Player Matchups & Ceiling Plays', [
        cue('host', studioDialogue('ceiling', week), 'rundown', board, 'KEY PLAYER MATCHUPS · CEILING PLAYS', { sfx:'whoosh' }),
        cue('analyst', `These are leverage points, not guarantees. A ceiling play matters because the matchup around it is sensitive to one player beating expectation, not because the desk can promise a spike week.`, 'rundown', board, 'CEILING WATCH · HIGH LEVERAGE, NOT CERTAINTY'),
      ]);
    }

    function segUpsetWatch(week){
      const games = validStudioGames(week);
      const candidates = games.map(g=>{
        let awayProb = safeStudioCall('upset probability', ()=> Number(FSNIntel.winProbability(week, g.awayTeam, g.homeTeam)), 50);
        if(!Number.isFinite(awayProb)) awayProb = 50;
        awayProb = Math.max(1, Math.min(99, awayProb));
        const dog = awayProb >= 50 ? g.homeTeam : g.awayTeam;
        const dogProb = awayProb >= 50 ? 100 - awayProb : awayProb;
        return { g, dog, dogProb };
      }).sort((a,b)=> b.dogProb - a.dogProb);
      const rows = candidates.slice(0, 8).map((x, i)=>({
        idx:i + 1,
        name:x.dog.name,
        sub:'UPSET WATCH · ' + x.g.awayTeam.name + ' at ' + x.g.homeTeam.name,
        value:Math.round(x.dogProb) + '% · ' + projectedSafe(x.g, 'away') + '–' + projectedSafe(x.g, 'home'),
        dir:'up',
      }));
      if(!rows.length) rows.push({ idx:'UP', name:'Upset board pending', sub:'Complete matchups are not available yet', value:'STANDBY' });
      const board = { title:'Upset Watch & Projected Scoreboard', rows, note:'Underdog probability is the same FSN matchup model used by the Tale of the Tape.' };
      return seg('upset-watch', 'Upset Watch & Projected Scoreboard', [
        cue('host', studioDialogue('upset', week), 'rundown', board, 'UPSET WATCH · PROJECTED SCOREBOARD', { sfx:'whoosh' }),
        candidates[0] ? cue('analyst', `${candidates[0].dog.name} is the underdog with the strongest model case on this board at roughly ${Math.round(candidates[0].dogProb)} percent. That is not a pick to win outright; it is the matchup where the favorite has the thinnest cushion.`, 'rundown', board, 'TOP UPSET CASE · ' + candidates[0].dog.name.toUpperCase(), { sfx:'sting' }) : null,
        cue('host', `And every score beside those probabilities is still projected. Once live points arrive, the preview language stops and the scoreboard takes over.`, 'rundown', board, 'COUNTDOWN · PROJECTIONS UNTIL KICKOFF'),
      ]);
    }

    function buildAdaptiveStudioSegments(formatId, week){
      let segments = [];
      if(formatId === 'debrief'){
        segments = [
          safeSegment('final scoreboard', ()=> segFinalScoreboard(week)) || studioStandbySegment('final-scoreboard', 'Final Scoreboard & Headline Marquee Game', 'debriefScoreboard', week),
          safeSegment('coaching efficiency', ()=> segCoachingEfficiency(week)) || studioStandbySegment('coaching-efficiency', 'Coaching Efficiency & Bench Blunders', 'coaching', week),
          retitleStudioSegment(safeSegment('fraud roast', ()=> segFraudRoast(week)), 'hot-seat', 'Hot Seat & Fraud Alert', 'fraud', week) || studioStandbySegment('hot-seat', 'Hot Seat & Fraud Alert', 'fraud', week),
          retitleStudioSegment(safeSegment('power index', ()=> segPower(week)), 'power-shakeup', 'Power Index Shakeup', 'power', week) || studioStandbySegment('power-shakeup', 'Power Index Shakeup', 'power', week),
        ];
      } else if(formatId === 'gameday'){
        segments = [
          safeSegment('sunday slate', ()=> segSundaySlate(week)) || studioStandbySegment('sunday-slate', 'Sunday Slate Matchup Previews', 'sundaySlate', week),
          safeSegment('ceiling plays', ()=> segCeilingPlays(week)) || studioStandbySegment('ceiling-plays', 'Key Player Matchups & Ceiling Plays', 'ceiling', week),
          safeSegment('upset watch', ()=> segUpsetWatch(week)) || studioStandbySegment('upset-watch', 'Upset Watch & Projected Scoreboard', 'upset', week),
        ];
      } else {
        segments = [
          safeSegment('roster locks', ()=> segRosterLocks(week)) || studioStandbySegment('roster-locks', 'Thursday Kickoff & Roster Locks', 'rosterLocks', week),
          retitleStudioSegment(safeSegment('matchup preview', ()=> segMatchupHype(week)), 'matchup-preview', 'Matchup of the Week & Win Probability', 'matchup', week) || studioStandbySegment('matchup-preview', 'Matchup of the Week & Win Probability', 'matchup', week),
          safeSegment('injury waiver', ()=> segInjuryWaiver(week)) || studioStandbySegment('injury-waiver', 'Injury Wire & Waiver Impact', 'injuryWaiver', week),
        ];
      }
      return segments.filter(Boolean);
    }

    function buildShow(week){
      const requestedWeek = Math.max(1, parseInt(week, 10) || 1);
      const phase = safeStudioCall('season phase', ()=> FSNIntel.seasonPhase(requestedWeek), 'season');
      const draftBoard = safeStudioCall('draft board', ()=> FSNIntel.draft(), null);
      const hasDraftPicks = !!(draftBoard && Array.isArray(draftBoard.picks) && draftBoard.picks.length);
      const format = studioFormatInfo(requestedWeek);
      const contentWeek = resolveStudioContentWeek(requestedWeek, format.id);
      const weekState = studioWeekState(contentWeek);
      let segments = [];

      if(phase === 'draft' || phase === 'preseason'){
        if(weekState.preview){
          segments = [
            safeSegment('week preview', ()=> segWeekPreview(contentWeek)),
            safeSegment('matchup hype', ()=> segMatchupHype(contentWeek)),
          ].filter(Boolean);
        } else {
          segments = hasDraftPicks
            ? [
                safeSegment('state of league', ()=> segStateOfLeague(contentWeek)),
                safeSegment('draft board', ()=> segDraftBoard()),
                safeSegment('draft value', ()=> segDraftValue()),
                safeSegment('draft grades', ()=> segDraftGrades()),
                safeSegment('power index', ()=> segPower(contentWeek)),
              ].filter(Boolean)
            : [safeSegment('state of league', ()=> segStateOfLeague(contentWeek))].filter(Boolean);
        }
      } else {
        segments = buildAdaptiveStudioSegments(format.id, contentWeek);
      }

      if(!segments.length) return fallbackStudioShow(contentWeek, 'No segment builder returned a usable cue list.');

      segments.forEach((segment, i)=>{
        segment.index = i + 1;
        segment.elapsed = 0;
        if(!segment.title) segment.title = 'Studio Segment ' + (i + 1);
        if(!Array.isArray(segment.cues) || !segment.cues.length){
          segment.cues = [cue('host', 'The desk is standing by while the league feed updates.', null, null, 'FSN STUDIO SHOW · STANDBY')];
        }
      });
      return { requestedWeek, week:contentWeek, league:leagueName(), format:format.label, formatId:format.id, segments };
    }

    /* ============================================================
       GRAPHICS RENDERER'''),
    "adaptive Studio buildShow",
)

# Studio open is defensive even if a stale/hidden launcher is activated.
literal_once(
    "function open(week, opts){\n  const w = Math.max(1, parseInt(week, 10) || 1);",
    "function open(week, opts){\n  if(studioHistoricalView()) return false;\n  const w = Math.max(1, parseInt(week, 10) || 1);",
    "historical Studio open guard",
)

literal_once(
    "    buildCrawl(w);",
    "    buildCrawl((state.show && state.show.week) || w);",
    "Studio crawl content week",
)

literal_once(
    "  open, close, buildShow,\n  play, pause, skipSegment, toggleMute, toggleFullscreen,\n  isOpen: ()=> state.open,\n  audioSource,",
    "  open, close, buildShow,\n  play, pause, skipSegment, toggleMute, toggleFullscreen,\n  isOpen: ()=> state.open,\n  isHistoricalView: studioHistoricalView,\n  formatInfo: studioFormatInfo,\n  audioSource,",
    "Studio public API",
)

# 5) UI-level historical gating and adaptive launcher subtitle. Root data attr means
# newly-rendered reader buttons are hidden immediately too.
literal_once(
    "/* One launch path for every Studio Show trigger. Keeping this synchronous inside\n   the original click preserves the browser user gesture required by Web Audio,\n   speechSynthesis and HTMLAudioElement.play(). */\nfunction startStudioShow(trigger){",
    textwrap.dedent(r'''\
    function isHistoricalStudioView(){
      try{
        const viewed = Number(NewsDesk.viewedSeasonYear());
        const active = Number(NewsDesk.activeSeasonYear());
        return viewed > 0 && active > 0 && viewed < active;
      }catch(e){ return false; }
    }

    function syncStudioAvailability(){
      const historical = isHistoricalStudioView();
      document.documentElement.dataset.studioHistorical = String(historical);
      if(historical && window.FSNStudio && FSNStudio.isOpen()) FSNStudio.close();

      const launcher = $('studioPlayBtn');
      if(launcher){
        launcher.disabled = historical;
        launcher.setAttribute('aria-disabled', String(historical));
        const sub = launcher.querySelector('.min-w-0 span');
        if(sub && !historical && window.FSNStudio && typeof FSNStudio.formatInfo === 'function'){
          const info = FSNStudio.formatInfo(effectiveWeek());
          if(info && info.subtitle) sub.textContent = info.subtitle;
        }
      }
      document.querySelectorAll('#articleLaunchBroadcastBtn,[data-action="launch-studio"],[data-studio]').forEach((btn)=>{
        if(btn && btn.setAttribute) btn.setAttribute('aria-disabled', String(historical));
      });
    }

    /* One launch path for every Studio Show trigger. Keeping this synchronous inside
       the original click preserves the browser user gesture required by Web Audio,
       speechSynthesis and HTMLAudioElement.play(). */
    function startStudioShow(trigger){'''),
    "Studio UI availability helpers",
)

literal_once(
    "  if(!LeagueData.hasLive()){\n    toast('Connect your league in Setup first');\n    return false;\n  }\n\n  const reader = $('reader');",
    "  if(!LeagueData.hasLive()){\n    toast('Connect your league in Setup first');\n    return false;\n  }\n  if(isHistoricalStudioView()){\n    syncStudioAvailability();\n    toast('Studio Show audio is available only for the active season.');\n    return false;\n  }\n\n  const reader = $('reader');",
    "Studio UI historical launch guard",
)

literal_once(
    "    FSNStudio.open(effectiveWeek(), { autoplay:true });\n    return true;",
    "    const opened = FSNStudio.open(effectiveWeek(), { autoplay:true });\n    if(opened === false){\n      syncStudioAvailability();\n      toast('Studio Show audio is available only for the active season.');\n      return false;\n    }\n    return true;",
    "Studio open return handling",
)

literal_once(
    "function renderAll(){\n  renderTicker();",
    "function renderAll(){\n  syncStudioAvailability();\n  renderTicker();",
    "render Studio availability",
)

# Write the Vercel serverless route. The host allowlist prevents the endpoint from
# becoming an arbitrary open proxy while covering the ESPN hosts used by this app.
API.parent.mkdir(parents=True, exist_ok=True)
API.write_text(textwrap.dedent(r'''\
const ALLOWED_ESPN_HOSTS = new Set([
  'lm-api-reads.fantasy.espn.com',
  'fantasy.espn.com',
  'site.api.espn.com',
]);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const raw = Array.isArray(req.query && req.query.url)
    ? req.query.url[0]
    : req.query && req.query.url;
  if (!raw) return res.status(400).json({ error: 'Missing url query parameter' });

  let target;
  try {
    target = new URL(String(raw));
  } catch (error) {
    return res.status(400).json({ error: 'Invalid ESPN URL' });
  }

  if (target.protocol !== 'https:' || !ALLOWED_ESPN_HOSTS.has(target.hostname)) {
    return res.status(400).json({ error: 'Unsupported ESPN host' });
  }

  try {
    const upstream = await fetch(target.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'MFFU-FSN/1.0',
      },
      redirect: 'follow',
    });
    const body = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    return res.status(upstream.status).send(body);
  } catch (error) {
    console.error('[api/espn] upstream request failed', error);
    return res.status(502).json({ error: 'ESPN upstream request failed' });
  }
};
'''), encoding="utf-8")

# Final integrity checks before writing index.html.
required = [
    'id="franchiseModal"',
    'playoff-bracket',
    'class="story-rail',
    'id="writeStoryBtn"',
    'function composeCommunity',
    'function renderVault',
    'function renderPlayoffBracket',
    'function fetchLeagueDataViaProxies',
    'function buildShow(week)',
    'TUESDAY DEBRIEF',
    'PRIMETIME PREVIEW',
    'GAMEDAY COUNTDOWN',
]
for marker in required:
    if marker not in text:
        raise RuntimeError(f"Integrity marker missing after patch: {marker}")

for key in ('debriefScoreboard', 'coaching', 'fraud', 'power', 'rosterLocks', 'matchup', 'injuryWaiver', 'sundaySlate', 'ceiling', 'upset'):
    m = re.search(rf"{re.escape(key)}:\[(.*?)\n\s*\],", text, re.S)
    if not m or m.group(1).count('v=>') < 5:
        raise RuntimeError(f"Dialogue deck {key} does not contain five templates")

if text == original:
    raise RuntimeError('Patch produced no index.html changes')

INDEX.write_text(text, encoding="utf-8")
print('Patched index.html and wrote api/espn.js')
