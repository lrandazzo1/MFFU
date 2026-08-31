# MFFU — Development Guardrails

Standing rules for every session in this repository. They are not style
preferences; each one exists because breaking it has already shipped a
production regression. Read them before editing `index.html`.

## Repository shape

`index.html` is the entire mobile app: ~16.5k lines, served as a static file by
Vercel. It is composed of **six independent inline `<script>` blocks**, each of
which wraps an engine in its own IIFE:

| Block | Contents | Exposed as |
|---|---|---|
| 1 | Global helpers, data engine, ESPN fetch/proxy chain, history aggregator | `window.LeagueData`, globals |
| 2 | Supabase / cloud sync | — |
| 3 | League intel: standings, power ratings, player index | `window.FSNIntel` |
| 4 | News Desk — deterministic article generators | `window.NewsDesk` |
| 5 | Season analytics models | `window.SeasonAnalytics` |
| 6 | Mobile UI layer, renderers, boot | `window.__fsnRender` |

`landing/` is the separate marketing page. `api/` holds Vercel serverless
functions. `league-media-studio.html` is the legacy desktop build.

---

## 1. Global Scope Rule

**Because `index.html` uses multiple independent script blocks, any helper or
utility function called across blocks MUST be defined at global scope in the
first script block. Never nest shared functions inside IIFEs.**

Each block's IIFE is a closed scope. A function defined inside one is invisible
to the other five, and the failure mode is the worst kind: not a parse error,
not a build failure, but a **runtime `ReferenceError` thrown mid-render**, which
the calling renderer catches and degrades into an empty card. The build is
green, the deploy succeeds, and the user sees "This week's board hit a snag
while rendering."

That is not hypothetical. `leagueScopeToken()` was defined inside the News Desk
IIFE (block 4) and called from `FSNIntel.memo()` (block 3) and the
`SeasonAnalytics` cache (block 5). Every memoised read — records, streaks,
standings, the whole matchup board — threw before it could compute anything.

**Where things go:**

- **Pure helpers shared across blocks** → global scope, first script block.
  Currently: `$`, `selectedLeagueId()`, `leagueScopeToken()`, `window.FSNScope`.
- **Renderers that genuinely need block 6's closure** → keep them in block 6 and
  register them on `window.FSNBridge`; call them from other blocks with
  `FSNBridge.call('name')`, which logs loudly if a handler is missing or throws
  instead of taking the caller's render down.
- **Block-private helpers** → stay inside their IIFE. Do not export what only
  one block uses.

**Never** reach for `typeof someFn === 'function'` as a cross-block guard. It
does not throw, so a scoping mistake degrades silently and permanently — the
guard is simply always false. Use `FSNBridge.has()` / `FSNBridge.call()`, which
report the miss.

**Before committing any change to `index.html`, run the scope scan** (see
_Verifying a change_ below). It parses every block and reports identifiers that
resolve to nothing. It must come back clean.

## 2. Strict Non-Regression

**Historical data pipelines, Supabase connections, and pre-existing
deterministic article generators are strictly read-only and untouchable. Never
touch or rewrite existing deterministic articles or core narrative content.**

Specifically off-limits unless the request names the file and the behaviour:

- **Historical data pipelines** — `computeLeagueHistoryStats`, the multi-season
  archive hydrator, manager tracking by `ownerId`, the all-time record book.
  Twenty years of league history are reconstructed here; a subtle change is
  invisible in review and corrupts every record in the book.
- **Supabase** — the client wiring, `supabase/` schema, `api/` serverless
  handlers, the waitlist flow, and the cloud sync path.
- **Deterministic article generators** — the News Desk (block 4) and everything
  it seeds. Articles are stable for a given league/season/week by design: the
  seed is `selectedLeagueId() + season + week + team_ids`, hashed. A reader who
  reloads must get the same article. Changing a template, a seed term, a hash,
  or a phase pool silently rewrites league history for every existing reader.
- **Core narrative content** — the copy pools, tier labels, and voice matrices.
  These are edited by hand, deliberately. Do not "improve," reword, condense, or
  regenerate them as a side effect of another task.

**Additive only.** A new story type is a new generator alongside the existing
ones. New data is a new memo key, not a changed one. If a fix appears to require
touching one of these, stop and say so rather than editing through it.

The determinism contract also means: **no `Math.random()`, no `Date.now()`, no
network call, and no model call inside a generator.** Every draw comes from the
seeded hash.

## 3. Error Visibility

**Never silently swallow generator exceptions. Log them loudly.**

```js
// NO — the failure is now invisible and permanent.
try{ value = generate(); }catch(e){}
try{ value = generate(); }catch(e){ value = null; }

// YES — degrade the UI, but say exactly what died and why.
try{
  value = generate();
}catch(err){
  console.error('[NewsDesk] rivalry spotlight failed for week ' + week, err);
  value = null;
}
```

Rules:

- Every `catch` gets a `console.error` (a real failure) or `console.warn` (an
  expected-missing-data path), tagged with the subsystem in brackets —
  `[FSNIntel]`, `[NewsDesk]`, `[Standings]`, `[Matchups]`, `[FSNBridge]` — plus
  enough context (week, team, key) to identify the case, and the `err` object
  itself. Never log a message without the error.
- `catch(e){}` with an empty body is only acceptable for genuinely optional
  browser APIs that throw by design (`localStorage` in private mode,
  `history.replaceState` in embedded browsers). Nothing else.
- A caught exception must not leave the reader with a bare "hit a snag" screen
  where a real fallback is possible. Degrade to a specific, honest empty state.
- Never widen a `try` to cover code that should not fail. `memo()` wraps the
  generator call, not the cache-key construction, so a scoping bug surfaces
  instead of being cached as `null` forever.

---

## Verifying a change

`index.html` has no build step and no test suite, so verification is manual and
non-negotiable for anything touching the script blocks:

1. **Scope scan** — parse each block and confirm every identifier resolves to a
   block-local declaration, a global from block 1, or a browser builtin. Nothing
   unresolved. This catches the entire class of bug rule 1 exists to prevent.
2. **Headless render** — load the file in Chromium (pre-installed at
   `/opt/pw-browsers/`), seed `LeagueData.setEspnData()` with a synthetic
   league, call `window.__fsnRender()`, click through all six screens, and
   assert: zero page errors, zero `[FSN*]` console errors, and no "hit a snag"
   text in any rendered panel.
3. **Read your own diff** for rule-2 violations before committing.

## Git

- Never commit directly to `main` from a session; branch, then merge.
- Delete feature branches once merged — stale `claude/*` branches accumulate.
- Vercel deploys `main` to production automatically. A green build means the
  static file was served, **not** that the app renders. Rendering bugs in this
  codebase are always runtime, never build-time. Confirm the deploy is READY,
  then confirm the render separately.
