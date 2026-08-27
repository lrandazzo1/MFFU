from pathlib import Path
import re

path = Path('index.html')
s = path.read_text(encoding='utf-8')
original = s

def require_replace(old, new, label=None, count=None):
    global s
    found = s.count(old)
    if found == 0:
        raise RuntimeError(f'missing expected pattern: {label or old[:80]}')
    if count is not None and found != count:
        raise RuntimeError(f'unexpected count for {label or old[:80]}: {found} != {count}')
    s = s.replace(old, new)

# -----------------------------------------------------------------------------
# 1) THE VAULT -> THE RECORD BOOK (display copy + internal references)
# -----------------------------------------------------------------------------
s = s.replace('THE VAULT', 'THE RECORD BOOK').replace('The Vault', 'The Record Book')
# CamelCase/PascalCase identifiers, e.g. renderVault -> renderRecordBook.
s = re.sub(r'(?<=\w)Vault|Vault(?=\w)', 'RecordBook', s)
# Remaining standalone display/comment references.
s = re.sub(r'\bVault\b', 'Record Book', s)
# Lowercase ids, state keys, CSS classes and data attributes.
s = s.replace('vault-', 'record-book-').replace('-vault', '-record-book')
s = re.sub(r'\bvault(?=[A-Z_])', 'recordBook', s)
s = s.replace('data-vault', 'data-record-book').replace('dataset.vault', 'dataset.recordBook')
s = re.sub(r"(['\"])vault\1", lambda m: m.group(1) + 'recordbook' + m.group(1), s)
s = re.sub(r'\bvault\b', 'recordbook', s)

# -----------------------------------------------------------------------------
# 2) SETUP: instant current-season path + optional one-file historical archive
# -----------------------------------------------------------------------------
league_input = '<input id="leagueIdInput" class="field" inputmode="numeric" autocomplete="off" placeholder="e.g. 1234567">\n          </div>'
league_insert = '''<input id="leagueIdInput" class="field" inputmode="numeric" autocomplete="off" placeholder="e.g. 1234567">\n          </div>\n          <div>\n            <button id="historyUnlockToggle" type="button" class="pill pill-cyan w-full justify-center" aria-expanded="false" aria-controls="historyUploadPanel">Want to unlock historical seasons &amp; the Record Book?</button>\n            <p class="text-[10.5px] text-[var(--dim)] leading-relaxed mt-2">Current season loads instantly from League ID only. Historical seasons are optional.</p>\n          </div>'''
require_replace(league_input, league_insert, 'League ID setup block', 1)

archive_header_pattern = re.compile(
    r'<!-- JSON FALLBACK -->\s*<div class="card p-4">\s*'
    r'<div class="section-head"><span class="bar" style="background:var\(--red\)"></span><h2>JSON Fallback</h2></div>\s*'
    r'<p class="text-\[11\.5px\] text-\[var\(--dim\)\] leading-relaxed mb-3">\s*'
    r'If the proxies are rate-limited, open the API link, save the raw JSON, then drop or paste it here\. Nothing leaves your phone\.\s*'
    r'</p>'
)
archive_header = '''<!-- HISTORICAL ARCHIVE / RECORD BOOK -->\n      <div id="historyUploadPanel" class="card p-4 hidden">\n        <div class="section-head"><span class="bar" style="background:var(--cyan)"></span><h2>Historical Archive &amp; Record Book</h2></div>\n        <p class="text-[11.5px] text-[var(--dim)] leading-relaxed mb-3">\n          ESPN locks historical endpoints behind authentication. To unlock past seasons, rivalries and all-time records, upload one JSON export containing the league's historical seasons. The file is read locally in your browser and is never sent to OpenAI or ElevenLabs.\n        </p>'''
s, n = archive_header_pattern.subn(archive_header, s, count=1)
if n != 1:
    raise RuntimeError(f'Historical archive card replacement failed: {n}')
s = s.replace('aria-label="Upload league JSON"', 'aria-label="Upload historical league archive JSON"')

# Toggle the optional archive panel without changing the existing dropzone parser.
league_listener = '''$('leagueIdInput').addEventListener('input', ()=>{\n  savePrefs();\n  refreshHistoryUrlLink();\n});'''
league_listener_new = league_listener + '''\n\n$('historyUnlockToggle').addEventListener('click', ()=>{\n  const panel = $('historyUploadPanel');\n  const btn = $('historyUnlockToggle');\n  const opening = panel.classList.contains('hidden');\n  panel.classList.toggle('hidden', !opening);\n  btn.setAttribute('aria-expanded', String(opening));\n  btn.textContent = opening\n    ? 'Hide historical archive upload'\n    : 'Want to unlock historical seasons & the Record Book?';\n});'''
require_replace(league_listener, league_listener_new, 'League ID listener', 1)

# Historical uploads enrich the archive; once a live season is loaded they must
# not overwrite it with the final season in the uploaded historical file.
require_replace(
    "  if(single && single.teams && single.teams.length){\n    resetWeekContext(true);",
    "  if(!LeagueData.hasLive() && single && single.teams && single.teams.length){\n    resetWeekContext(true);",
    'archive upload live overwrite guard',
    1,
)

# The current-season fetch no longer requests leagueHistory at all. It connects
# the live payload, merges any archive already uploaded in this session, then
# explicitly warms the four requested renderers and moves to the Desk.
fetch_pattern = re.compile(
    r"async function fetchLeagueData\(options\)\{.*?\n\}\n\$\('fetchBtn'\)\.addEventListener\('click', \(\)=> fetchLeagueData\(\)\);",
    re.S,
)
fetch_replacement = r'''async function fetchLeagueData(options){
  const opts = options && typeof options === 'object' ? options : {};
  const silent = !!opts.silent;
  const navigate = opts.navigate !== false;
  const league = String(opts.leagueId || $('leagueIdInput').value || '').trim();
  const currentYear = uiActiveSeasonYear();
  const liveUrl = buildEspnUrlForYear(league, currentYear, null);

  if(!league || !liveUrl){
    if(!silent) $('fetchStatus').textContent = 'Enter a League ID first.';
    return false;
  }

  $('leagueIdInput').value = league;
  setFetchLoading(true);
  hideHistoryBanner();
  $('fetchStatus').textContent = silent ? 'Restoring current season…' : 'Fetching current season…';
  $('historyStatus').textContent = LeagueData.hasHistory()
    ? $('historyStatus').textContent
    : 'Historical archive is optional — upload one JSON export to unlock the full Record Book.';

  try{
    const raw = await fetchLeagueDataViaProxies(liveUrl);
    const liveData = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    if(!liveData || !Array.isArray(liveData.teams) || !liveData.teams.length){
      throw new Error('NO_LIVE_LEAGUE_DATA');
    }

    const liveInfo = applyLiveLeaguePayload(league, liveData, currentYear);
    setConn('live');

    // Keep an uploaded archive intact, but never fetch historical ESPN routes
    // from this instant League-ID path.
    const uploadedArchive = Array.isArray(window._franchiseYearsData)
      ? window._franchiseYearsData.slice()
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

    $('fetchStatus').textContent = `✓ Current season connected — ${liveInfo.activeSeason} · ${liveData.teams.length} teams`;
    if(!uploadedArchive.length){
      $('historyStatus').textContent = 'Current season is ready. Historical seasons remain optional — upload one JSON export to unlock the full Record Book.';
    }

    try{ localStorage.setItem(SAVED_LEAGUE_ID_KEY, league); }catch(e){}
    savePrefs();
    refreshHistoryUrlLink();
    refreshOpenAIStatus();

    if(navigate) setScreen('home');

    // Explicit renderer warm-up requested by the two-path setup flow.
    safeRun('desk', renderDesk, ()=> renderScreenFallback('home'));
    safeRun('matchups', renderMatchups, ()=> renderScreenFallback('matchups'));
    safeRun('recordbook', renderRecordBook, ()=> renderScreenFallback('recordbook'));
    safeRun('news', renderNews, ()=> renderScreenFallback('news'));

    if(!silent) toast(`Current season connected · ${liveInfo.activeSeason}`);
    return true;
  }catch(err){
    console.error(err);
    setConn('error');
    const auth = /\\bHTTP 40[13]\\b/.test(String(err && (err.message || err)));
    $('fetchStatus').textContent = auth
      ? 'ESPN denied the current-season request (401/403). Confirm the league is public or configure ESPN authentication.'
      : 'The current season could not be loaded. Check the League ID and try again.';
    return false;
  }finally{
    setFetchLoading(false);
  }
}
$('fetchBtn').addEventListener('click', ()=> fetchLeagueData());'''
s, n = fetch_pattern.subn(fetch_replacement, s, count=1)
if n != 1:
    raise RuntimeError(f'fetchLeagueData replacement failed: {n}')

# The existing Desk renderer is named renderHome; expose the requested semantic
# entry point while preserving renderHome/renderHomeStories behavior.
home_marker = '''function renderHome(){'''
if 'function renderDesk(){' not in s:
    require_replace(home_marker, '''function renderDesk(){\n  renderHome();\n  renderHomeStories();\n}\n\nfunction renderHome(){''', 'renderDesk alias', 1)

# -----------------------------------------------------------------------------
# 3) SECURE BACKEND AI: no raw OpenAI / ElevenLabs keys in browser storage/UI
# -----------------------------------------------------------------------------
# OpenAI UI: replace the visible secret field with status-only backend state.
openai_field_pattern = re.compile(
    r'<label class="label" for="openaiKey">OpenAI API Key</label>\s*'
    r'<div class="flex gap-2">\s*'
    r'<input id="openaiKey"[^>]*>\s*'
    r'<button id="openaiReveal"[^>]*>SHOW</button>\s*'
    r'</div>'
)
openai_field = '''<input id="openaiKey" type="hidden" value="backend">\n        <button id="openaiReveal" type="button" hidden>SHOW</button>\n        <div class="pill pill-green w-full justify-center" role="status">● Backend AI Connected</div>'''
s, n = openai_field_pattern.subn(openai_field, s, count=1)
if n != 1:
    raise RuntimeError(f'OpenAI key field replacement failed: {n}')
s = s.replace('directly in this browser.', 'through the secure backend proxy.')
s = s.replace('No key saved. Current-season news uses the deterministic no-replacement engine.', 'Backend AI is unavailable; current-season news uses the deterministic no-replacement engine.')

# Backend is the capability flag; no browser secret is read or required.
s = re.sub(
    r"function getAIKey\(\)\{\s*try\{ return \(localStorage\.getItem\(OPENAI_KEY_STORE\) \|\| ''\)\.trim\(\); \}catch\(e\)\{ return ''; \}\s*\}",
    "function getAIKey(){ return 'backend'; }",
    s,
    count=1,
)

# OpenAI request now goes through the same-origin serverless endpoint and never
# sends an Authorization header from the browser.
s = s.replace("fetch('https://api.openai.com/v1/chat/completions', {", "fetch('/api/ai-news', {")
s = s.replace("headers:{'Content-Type':'application/json','Authorization':'Bearer ' + key},", "headers:{'Content-Type':'application/json'},")

# Status UI no longer inspects browser storage for a secret.
status_pattern = re.compile(r"function refreshOpenAIStatus\(\)\{.*?\n\}", re.S)
status_replacement = '''function refreshOpenAIStatus(){
  const el = $('openaiStatus');
  if(!el) return;
  const viewed = parseInt(($('seasonYear').value || '').trim(), 10) || 0;
  const active = uiActiveSeasonYear();
  if(viewed && viewed !== active){
    const relation = viewed < active ? 'historical' : 'not the active season';
    el.innerHTML = `<span style="color:var(--green)">DETERMINISTIC MODE</span> · ${viewed} is ${relation}; active season is ${active}, so AI requests are bypassed completely.`;
  } else {
    el.innerHTML = `<span style="color:var(--green)">BACKEND AI CONNECTED</span> · OpenAI requests are proxied through /api/ai-news; no API key is stored in this browser.`;
  }
}'''
s, n = status_pattern.subn(status_replacement, s, count=1)
if n != 1:
    raise RuntimeError(f'OpenAI status replacement failed: {n}')

# Remove any legacy OpenAI secret immediately when loading preferences. Keep the
# hidden compatibility node so old listener wiring remains harmless.
s = s.replace(
    "  try{ $('openaiKey').value = localStorage.getItem(OPENAI_KEY_STORE) || ''; }catch(e){ $('openaiKey').value = ''; }",
    "  try{ localStorage.removeItem(OPENAI_KEY_STORE); $('openaiKey').value = 'backend'; }catch(e){ $('openaiKey').value = 'backend'; }",
)
s = s.replace("  $('openaiKey').value = '';", "  $('openaiKey').value = 'backend';")

# ElevenLabs setup UI: status only; voice selectors remain intact.
eleven_field_pattern = re.compile(
    r'<label class="label" for="elevenKey">API Key</label>\s*'
    r'<div class="flex gap-2">\s*'
    r'<input id="elevenKey"[^>]*>\s*'
    r'<button id="elevenReveal"[^>]*>SHOW</button>\s*'
    r'</div>'
)
eleven_field = '''<input id="elevenKey" type="hidden" value="backend">\n          <button id="elevenReveal" type="button" hidden>SHOW</button>\n          <div class="pill pill-green w-full justify-center" role="status">● Backend AI Connected</div>'''
s, n = eleven_field_pattern.subn(eleven_field, s, count=1)
if n != 1:
    raise RuntimeError(f'ElevenLabs key field replacement failed: {n}')
s = s.replace('ElevenLabs · Optional / Dev Mode', 'ElevenLabs · Secure Backend')
s = s.replace(
    'Paste a key and the hosts are voiced with <span class="font-mono text-[var(--off)]">eleven_flash_v2_5</span>.',
    'Studio Show voices use <span class="font-mono text-[var(--off)]">eleven_flash_v2_5</span> through the secure backend proxy.'
)
s = s.replace(
    'The key is stored on this device only and is sent straight from this page to ElevenLabs — nothing routes through a server of ours.\n            Browser-side keys are visible to anyone with this device, so use a restricted key.',
    'The ElevenLabs API key stays server-side in <span class="font-mono text-[var(--off)]">ELEVENLABS_API_KEY</span> and is never exposed to the browser.'
)
s = s.replace('Auto</b> uses ElevenLabs when a key is saved below and falls back to the device voice.', 'Auto</b> uses the secure ElevenLabs backend and falls back to the device voice.')
s = s.replace('keyed client-side from Setup, with an in-memory clip cache and a', 'proxied server-side, with an in-memory clip cache and a')
s = s.replace('saved in Setup, the device\'s speech synthesis otherwise.', 'available from the backend, the device\'s speech synthesis otherwise.')

# Force the audio capability flag to backend mode and stop persisting raw keys.
s = s.replace("  key: '',", "  key: 'backend',", 1)
s = s.replace("    prefs.key = typeof saved.key === 'string' ? saved.key : '';", "    prefs.key = 'backend';")
s = s.replace(
    "  try{ localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); }catch(e){}",
    "  try{ const persisted = Object.assign({}, prefs); delete persisted.key; localStorage.setItem(PREF_KEY, JSON.stringify(persisted)); }catch(e){}",
    1,
)
s = s.replace(
    "  Object.assign(prefs, { mode:'auto', sfx:true, bed:true, key:'', voiceHost:'', voiceAnalyst:'' });",
    "  Object.assign(prefs, { mode:'auto', sfx:true, bed:true, key:'backend', voiceHost:'', voiceAnalyst:'' });",
)

# TTS browser call -> /api/tts. Voice id becomes request data, not a URL secret.
tts_url_pattern = re.compile(
    r"fetch\('https://api\.elevenlabs\.io/v1/text-to-speech/' \+ encodeURIComponent\(vid\) \+\s*'\?output_format=mp3_44100_128', \{"
)
s, n = tts_url_pattern.subn("fetch('/api/tts', {", s, count=1)
if n != 1:
    raise RuntimeError(f'ElevenLabs URL replacement failed: {n}')
s = s.replace(
    "headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },",
    "headers: { 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },",
    1,
)
# Add voiceId next to the existing text payload exactly once.
s = s.replace(
    "    body: JSON.stringify({\n      text: String(text == null || String(text).trim() === '' ? 'The desk is standing by while the league feed updates.' : text),",
    "    body: JSON.stringify({\n      voiceId: vid,\n      text: String(text == null || String(text).trim() === '' ? 'The desk is standing by while the league feed updates.' : text),",
    1,
)

# Legacy stored voice secret is stripped on module load as a migration.
loadprefs_return = '''  return prefs;\n}\nfunction savePrefs(patch){'''
if loadprefs_return in s:
    s = s.replace(loadprefs_return, '''  prefs.key = 'backend';\n  try{\n    const persisted = Object.assign({}, prefs);\n    delete persisted.key;\n    localStorage.setItem(PREF_KEY, JSON.stringify(persisted));\n  }catch(e){}\n  return prefs;\n}\nfunction savePrefs(patch){''', 1)

# Replace user-facing errors that still ask for a key.
s = s.replace('No OpenAI API key', 'Backend OpenAI unavailable')
s = s.replace('No ElevenLabs key', 'Backend ElevenLabs unavailable')
s = s.replace('Paste an ElevenLabs API key first.', 'Backend ElevenLabs is not available.')
s = s.replace('ElevenLabs rejected that key (401).', 'ElevenLabs backend authentication failed (401).')

# -----------------------------------------------------------------------------
# Sanity checks
# -----------------------------------------------------------------------------
if 'https://api.openai.com/v1/chat/completions' in s:
    raise RuntimeError('direct OpenAI browser URL remains')
if 'https://api.elevenlabs.io/v1/text-to-speech' in s:
    raise RuntimeError('direct ElevenLabs browser URL remains')
if "'xi-api-key': key" in s or "'Authorization':'Bearer ' + key" in s:
    raise RuntimeError('client AI authorization header remains')
if 'renderVault' in s or 'The Vault' in s or 'THE VAULT' in s:
    raise RuntimeError('Vault-era naming remains')
if 'function renderRecordBook' not in s:
    raise RuntimeError('renderRecordBook missing after rename')
if "fetch('/api/ai-news'" not in s or "fetch('/api/tts'" not in s:
    raise RuntimeError('backend proxy wiring missing')
if s == original:
    raise RuntimeError('migration made no changes')

path.write_text(s, encoding='utf-8')
print('index.html migrated successfully')
print('remaining case-insensitive vault tokens:', len(re.findall(r'vault', s, flags=re.I)))
print('record book tokens:', len(re.findall(r'record book', s, flags=re.I)))
