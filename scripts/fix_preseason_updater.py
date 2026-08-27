from pathlib import Path

p = Path('scripts/apply_2026_preseason_studio.py')
s = p.read_text()
s = s.replace("\"  let segments = [];\\n\\n  if(phase === 'draft' || phase === 'preseason'){\n\",", "\"  let segments = [];\\n\\n  if(phase === 'draft' || phase === 'preseason'){\\n\",")
s = s.replace("\"  let segments = [];\\n\\n  if(studio2026PreseasonSpecial(requestedWeek)){\\n    segments = build2026PreseasonSpecial(1);\\n  } else if(phase === 'draft' || phase === 'preseason'){\n\",", "\"  let segments = [];\\n\\n  if(studio2026PreseasonSpecial(requestedWeek)){\\n    segments = build2026PreseasonSpecial(1);\\n  } else if(phase === 'draft' || phase === 'preseason'){\\n\",")
marker = "'Desk launcher preseason label',"
pos = s.find(marker)
if pos >= 0:
    start = s.rfind('\nliteral_once(', 0, pos)
    end = s.find('\n)\n', pos)
    if start < 0 or end < 0:
        raise RuntimeError('Could not isolate legacy launcher patch block')
    s = s[:start] + '\n' + s[end + 3:]
p.write_text(s)

idx = Path('index.html')
html = idx.read_text()
old = """    const sub = launcher.querySelector('.min-w-0 span');
    if(sub && !historical && window.FSNStudio && typeof FSNStudio.formatInfo === 'function'){
      const info = FSNStudio.formatInfo(effectiveWeek());
      if(info && info.subtitle) sub.textContent = info.subtitle;
    }"""
new = """    const labelWrap = launcher.querySelector('.min-w-0');
    const sub = launcher.querySelector('.min-w-0 span');
    if(!historical && window.FSNStudio && typeof FSNStudio.formatInfo === 'function'){
      const info = FSNStudio.formatInfo(effectiveWeek());
      if(labelWrap && labelWrap.firstChild) labelWrap.firstChild.nodeValue = (info && info.id === 'preseason-2026') ? '2026 PRESEASON SPECIAL ' : 'FSN Studio Show ';
      if(sub && info && info.subtitle) sub.textContent = info.subtitle;
    }"""
if old not in html:
    raise RuntimeError('Current Desk launcher block not found')
idx.write_text(html.replace(old, new, 1))
