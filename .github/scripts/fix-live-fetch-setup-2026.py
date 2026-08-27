from pathlib import Path

path = Path("index.html")
s = path.read_text(encoding="utf-8")

def replace_section(start_marker, end_marker, replacement, label, include_end=True):
    global s
    start = s.find(start_marker)
    if start < 0:
        raise SystemExit(f"{label}: start marker not found")
    end = s.find(end_marker, start + len(start_marker))
    if end < 0:
        raise SystemExit(f"{label}: end marker not found")
    end_pos = end + (len(end_marker) if include_end else 0)
    s = s[:start] + replacement + s[end_pos:]

setup_replacement = '''      <!-- LEAGUE CONNECTION -->
      <div class="card p-4">
        <div class="section-head"><span class="bar"></span><h2>ESPN League</h2></div>
        <div class="space-y-3">
          <div>
            <label class="label" for="leagueIdInput">League ID</label>
            <input id="leagueIdInput" class="field" inputmode="numeric" autocomplete="off" placeholder="e.g. 1234567">
          </div>
          <span id="seasonYear" hidden aria-hidden="true"></span>
          <span id="weekNum" hidden aria-hidden="true"></span>
          <button id="fetchBtn" class="btn-primary">
            <span id="fetchSpinner" class="spinner hidden"></span>
            <span id="fetchLabel">FETCH LEAGUE DATA</span>
          </button>
          <p id="fetchStatus" class="text-[11.5px] text-[var(--dim)] leading-relaxed">Enter your ESPN League ID to load the live 2026 season.</p>
          <button id="historyUnlockToggle" type="button" class="pill pill-cyan w-full justify-center" aria-expanded="false" aria-controls="historyUploadPanel">OPTIONAL · LOAD ARCHIVE JSON</button>
          <p class="text-[10.5px] text-[var(--dim)] leading-relaxed">Historical seasons are optional and only needed for the full Record Book archive.</p>
        </div>
      </div>

      <!-- HISTORICAL ARCHIVE / RECORD BOOK -->'''
replace_section(
    '      <!-- LEAGUE CONNECTION -->',
    '      <!-- HISTORICAL ARCHIVE / RECORD BOOK -->',
    setup_replacement,
    'Setup core',
    include_end=True,
)

replace_section(
    '      <!-- BROADCAST AUDIO -->',
    '      <div class="text-center py-2">',
    '      <div class="text-center py-2">',
    'Broadcast Audio + Install cleanup',
    include_end=True,
)

old_banner = '''function showHistoryBanner(text){
  const el = $('historyBanner');
  el.textContent = text;
  el.classList.remove('hidden');
}
function hideHistoryBanner(){ $('historyBanner').classList.add('hidden'); }'''
new_banner = '''function showHistoryBanner(text){
  const el = $('historyBanner');
  if(!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
}
function hideHistoryBanner(){
  const el = $('historyBanner');
  if(el) el.classList.add('hidden');
}'''
if old_banner not in s:
    raise SystemExit("History banner helper block not found")
s = s.replace(old_banner, new_banner, 1)

fetch_impl = r'''async function fetchLeagueData(options){
  const opts = options && typeof options === 'object' ? options : {};
  const silent = !!opts.silent;
  const navigate = opts.navigate !== false;
  const league = String(opts.leagueId || $('leagueIdInput').value || '').trim();
  const currentYear = 2026;
  const liveUrl = buildEspnUrlForYear(league, currentYear, null);

  if(!league || !liveUrl){
    if(!silent) $('fetchStatus').textContent = 'Enter a League ID first.';
    return false;
  }

  $('leagueIdInput').value = league;
  setFetchLoading(true);
  hideHistoryBanner();
  $('fetchStatus').textContent = silent ? 'Restoring live 2026 season…' : 'Fetching live 2026 season…';

  try{
    const proxyUrl = '/api/espn?url=' + encodeURIComponent(liveUrl);
    const headers = { 'Accept':'application/json' };
    try{
      if(typeof espnCredHeaders === 'function') Object.assign(headers, espnCredHeaders() || {});
    }catch(e){}

    const response = await fetch(proxyUrl, {
      method:'GET',
      headers,
      cache:'no-store',
    });
    const text = await response.text();
    if(!response.ok){
      const detail = String(text || '').replace(/\s+/g, ' ').slice(0, 180);
      throw new Error(`HTTP ${response.status}${detail ? ': ' + detail : ''}`);
    }

    let parsed;
    try{
      parsed = JSON.parse(text);
    }catch(err){
      throw new Error('INVALID_ESPN_JSON');
    }

    const unwrap = (value)=>{
      let v = value;
      for(let i=0; i<4; i++){
        if(typeof v === 'string'){
          try{ v = JSON.parse(v); continue; }catch(e){ break; }
        }
        if(v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'contents')){
          v = v.contents;
          continue;
        }
        if(v && typeof v === 'object' && !Array.isArray(v.teams) && v.data && typeof v.data === 'object'){
          v = v.data;
          continue;
        }
        break;
      }
      return v;
    };

    const root = unwrap(parsed);
    const candidates = [];
    const addCandidate = (value)=>{
      const v = unwrap(value);
      if(v && typeof v === 'object'){
        candidates.push(v);
        if(v.league && typeof v.league === 'object') candidates.push(unwrap(v.league));
      }
    };
    if(Array.isArray(root)) root.forEach(addCandidate); else addCandidate(root);

    const liveData = candidates.find(v=>
      Array.isArray(v.teams) && v.teams.length && Number(v.seasonId || v.season || currentYear) === currentYear
    ) || candidates.find(v=> Array.isArray(v.teams) && v.teams.length);

    if(!liveData) throw new Error('NO_LIVE_LEAGUE_DATA');

    const liveInfo = applyLiveLeaguePayload(league, liveData, currentYear);
    setConn('live');

    // Preserve a manually supplied archive, but keep live 2026 authoritative.
    const uploadedArchive = Array.isArray(window._franchiseYearsData)
      ? window._franchiseYearsData.filter(row=> Number(row && row.year) !== currentYear)
      : [];
    let historySeed = uploadedArchive;
    if(!historySeed.length){
      historySeed = normalizeHistoryPayload([liveData]).yearsData || [];
    }
    if(historySeed.length){
      applyLeagueHistory(
        withCurrentSeason(historySeed),
        [],
        uploadedArchive.length ? 'Historical archive + current season' : 'Current season',
        { silent:true }
      );
      renderWeekScrubbers();
    }

    $('fetchStatus').textContent = `✓ 2026 connected · ${liveData.teams.length} teams · Week ${liveInfo.activeWeek}`;
    if(!uploadedArchive.length && $('historyStatus')){
      $('historyStatus').textContent = 'Current season is ready. Upload an archive JSON only if you want historical Record Book seasons.';
    }

    try{ localStorage.setItem(SAVED_LEAGUE_ID_KEY, league); }catch(e){}
    savePrefs();
    refreshOpenAIStatus();

    if(navigate) setScreen('home');

    safeRun('desk', renderDesk, ()=> renderScreenFallback('home'));
    safeRun('matchups', renderMatchups, ()=> renderScreenFallback('matchups'));
    safeRun('recordbook', renderRecordBook, ()=> renderScreenFallback('recordbook'));
    safeRun('news', renderNews, ()=> renderScreenFallback('news'));

    if(!silent) toast(`2026 league connected · Week ${liveInfo.activeWeek}`);
    return true;
  }catch(err){
    console.error('[ESPN live fetch]', err);
    setConn('error');
    const message = String(err && (err.message || err) || '');
    const auth = /\bHTTP 40[13]\b/.test(message);
    $('fetchStatus').textContent = auth
      ? 'ESPN denied the 2026 request (401/403). Confirm the server-side ESPN relay credentials and try again.'
      : 'The live 2026 season could not be loaded. Check the League ID and try again.';
    return false;
  }finally{
    setFetchLoading(false);
  }
}
$('fetchBtn').addEventListener('click', ()=> fetchLeagueData());'''

replace_section(
    "async function fetchLeagueData(options){",
    "$('fetchBtn').addEventListener('click', ()=> fetchLeagueData());",
    fetch_impl,
    "fetchLeagueData",
    include_end=True,
)

api_start = "/* ---- API URL display ---- */"
start = s.find(api_start)
if start < 0:
    raise SystemExit("API URL display start not found")
end = s.find("\n});", start)
if end < 0:
    raise SystemExit("API URL display end not found")
s = s[:start] + s[end + len("\n});"):]

old = "  const a = $('historyUrlLink');\n  if(url){"
new = "  const a = $('historyUrlLink');\n  if(!a) return;\n  if(url){"
if old not in s:
    raise SystemExit("historyUrlLink helper anchor not found")
s = s.replace(old, new, 1)

reset_start = "$('resetBtn').addEventListener('click', ()=>{"
start = s.find(reset_start)
if start >= 0:
    end = s.find("\n});", start)
    if end < 0:
        raise SystemExit("resetBtn listener end not found")
    s = s[:start] + s[end + len("\n});"):]
if reset_start in s:
    raise SystemExit("More than one unguarded resetBtn listener remains")

path.write_text(s, encoding="utf-8")
print("Patched index.html")
