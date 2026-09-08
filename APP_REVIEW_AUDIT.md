# FSN — End-to-End App Review & Content Audit

Audit date: 2026-09-08 · Branch: `claude/app-review-content-audit-30spf8`
Baseline: `main` @ `b3290da`

Scope: app content and navigation, App Review / metadata compliance, consistency
across the three surfaces (Capacitor iOS binary, web app, `fsn-landing`), and the
notification / cron / Supabase data path.

Everything below was checked against the code rather than against the docs. Where
a claim is marked **verified**, there is a mechanical check behind it in
`npm run verify`, or a file and line reference here.

---

## Stack note — what this repo actually is

The request described a "React Native/Capacitor app" with `Linking.openURL`, and
`rosters` / `league management` screens. The actual shape is different, and the
audit was run against the real thing:

| Assumed | Actual |
|---|---|
| React Native | **No React Native.** `index.html` is a ~16.5k-line static single-file app. Capacitor 6 wraps that same file into the iOS binary (`npm run build:ios` → `www/` → `cap sync`). |
| `Linking.openURL` | `window.FSNLinks.openExternal()` (`index.html:4172`) — Capacitor Browser plugin natively, `window.open` on web. Same role, different API. |
| Rosters / league-management screens | Six screens: `home`, `matchups`, `news`, `analytics`, `recordbook`, `setup`. League management and settings both live in **Setup**; there is no separate rosters tab. |

---

## Fixed in this branch

### 1. Landing page advertised a model the app has never shipped

`landing/index.html:452` sold the Analytics engine as:

> Six mathematical models — strength of schedule, luck index, **playoff odds** and more

The Season Stats tab renders exactly six models (`analyticsModel('01'…'06')`,
`index.html:19820-19825`):

| # | Model |
|---|---|
| 01 | Adjusted Expected Wins (Luck Δ) |
| 02 | Lineup Efficiency & Bench Blunders |
| 03 | Scoring Consistency CV |
| 04 | Schedule Hardship |
| 05 | Heartbreak / Blowout Index |
| 06 | Waiver Wire Gem Finder ROI |

"Six" is right, and *strength of schedule* → 04 and *luck index* → 01 both
resolve. **Playoff odds does not exist anywhere in the app** — `grep -c "playoff
odds" index.html` returns 0. It is also, specifically, a *probability* metric:
the exact class of feature removed from the matchup board and onboarding in
`b26061a`. The marketing copy was the one surface that removal did not reach.

A reviewer reads the page the support URL points at, so a feature promised there
and absent from the binary is **Guideline 2.3.1 (inaccurate metadata)**.

Fixed by naming a model that ships (`lineup efficiency`).

### 2. Regression guard for both halves of that drift

New `scripts/landing-claims-check.mjs`, wired into `npm run verify` as
`check:claims`. Nothing previously linked the landing project's copy to
`index.html` — they deploy separately, so the claim could drift indefinitely
without any check going red.

It asserts:

- the model **count** claimed on the landing page equals the number of
  `analyticsModel(...)` calls in `index.html` (so adding or removing a model
  moves both sides, and a hand-kept list cannot rot);
- every model **named** in that claim resolves to a shipped model;
- the landing page advertises **no probability metric** (`win probability`,
  `playoff odds`, `championship/title odds`, `playoff chances`);
- win probability stays confined **by location** to the two places allowed to
  hold it — the block defining `window.FSNIntel` (the model itself) and the
  block defining `window.NewsDesk` (article prose). Any other script block, and
  the static markup where the onboarding slides live, must not mention it;
- no orphaned `.mu-winprob` / `.mu-wp-` / `.ftu-m-prob` CSS survives.

Each assertion was **negative-tested**: restoring `playoff odds` fails it on two
axes, and re-adding a `winProbability()` call to the UI block, an `.mu-winprob`
rule, and a `.ftu-m-prob` onboarding element fails it on three more. `index.html`
was restored byte-identical afterwards (`git diff HEAD -- index.html` empty).

---

## Findings NOT fixed here — they need your decision

### A. Yahoo disconnect leaves a live refresh token in Supabase forever

**This is the highest-severity finding in the audit.**

`POST /api/auth/yahoo?action=disconnect` (`api/auth/yahoo.js:411-426`) deletes the
row in `yahoo_oauth_sessions` and clears the session cookie. It does **not**
touch `yahoo_oauth_tokens`, which holds the AES-256-GCM envelopes for the user's
Yahoo **access and refresh tokens**, keyed by `yahoo_user_id`.

That table is only ever written or read — never deleted, anywhere in the
codebase:

```
api/auth/yahoo.js:237   .from('yahoo_oauth_tokens').upsert(...)
api/auth/yahoo.js:295   .from('yahoo_oauth_tokens').update(...)
api/auth/yahoo.js:312   .from('yahoo_oauth_tokens').select(...)
```

`grep -rn "yahoo_oauth_tokens" api/ lib/ | grep -i delete` → nothing.

So after a reader taps **LOG OUT**, the app tells them "Yahoo account
disconnected from this browser" (`index.html:22785`) while a still-valid Yahoo
refresh token remains stored server-side indefinitely, with no in-app path to
remove it. Three separate problems:

1. **Guideline 5.1.1(v)** — connecting Yahoo creates a persistent server-side
   credential record. Apple requires account *deletion*, not just sign-out.
2. **Guideline 5.1.1(i)** — see finding B: this storage is undisclosed.
3. **Security** — encryption at rest does not help here; the retained credential
   is live at Yahoo until the user revokes it from Yahoo's own settings, which
   the app never tells them to do.

**Not fixed here on purpose.** CLAUDE.md rule 2 puts Supabase wiring and the
`api/` serverless handlers off-limits unless the request names the file and the
behaviour, and instructs me to stop and say so rather than edit through it. The
request did not name them.

Remedies, in preference order:
- **Delete the token row on disconnect.** Add a `yahoo_oauth_tokens` delete
  keyed by the `yahoo_user_id` behind the session, inside the existing
  `disconnect()`. `yahoo_oauth_sessions` already cascades on that FK.
- Additionally call Yahoo's token-revocation endpoint so the credential dies at
  the source rather than just in your database.
- At minimum, disclose the storage and its retention (finding B) and offer a
  documented deletion request path.

### B. The privacy policy does not disclose Yahoo token storage at all

`landing/privacy.html` is written, by its own header comment, "against what the
code actually does." It currently omits an entire data category.

- §2 covers on-device storage (League ID, ESPN cookies, archive cache, prefs).
- §3.1 covers relay reads and says the relay "keeps no copy."
- §3.2 covers League Cloud writes.
- §5 "How long we keep things" lists device storage, League Cloud records,
  notification registrations, waitlist emails.

**None of them mention `yahoo_oauth_tokens`.** A stored third-party OAuth
access + refresh token is exactly the kind of collection Guideline 5.1.1(i) and
the App Privacy nutrition label expect to see declared, and §5's retention list
is incomplete without it.

Not fixed here because the correct wording depends on which remedy you pick in
finding A — documenting indefinite retention would enshrine the behaviour you
most likely want to change instead. The page also carries its own "REVIEW BEFORE
LAUNCH … have counsel review the wording" note.

### C. Live ESPN reads can fall back to third-party CORS proxies in production

Two fetch paths share `CORS_PROXIES` (`index.html:4680` — `api.allorigins.win`,
`corsproxy.io`, `thingproxy.freeboard.io`), and they are guarded differently:

- **Archive hydration** (`index.html:5303`) is gated behind
  `isStaticLocalPreview()`, which explicitly returns false for native shells and
  matches only `localhost` / loopback / LAN hosts. The comment above it
  (`4690-4707`) documents the reasoning at length: in a shipped shell the relay
  "is both reachable AND the only transport that can carry the league's ESPN
  session. Its failure is the answer, not the cue to go looking for a worse one."
- **Live league reads** (`fetchLeagueData`, `index.html:22433`) carry **no such
  gate**. The only guard is `credState.attempted`, i.e. private leagues.

Net effect: for a **public** league on production web or in the iOS binary, any
transport-level failure of `/api/espn` retries the read through three
third-party proxies. Private-league credentials are correctly refused on both
paths (`22426-22431`), so this is not a credential leak — but it does route the
user's League ID and IP to services that appear nowhere in the privacy policy's
third-party table (§4).

Recommend applying the same `isStaticLocalPreview()` gate to the live path so
both behave alike. Left unshipped because it changes live data-path behaviour
in a way I cannot exercise here (the proxies only engage on transport failure),
and which fallback a public league should get is a product call.

### D. No iOS privacy manifest (`PrivacyInfo.xcprivacy`)

The workflow injects `MinimumOSVersion` and `ITSAppUsesNonExemptEncryption` into
the generated project on every run, but nothing adds a privacy manifest to the
app target. Apple has required required-reason API declarations since May 2024
and answers omissions with **ITMS-91053 (Missing API declaration)** by email
after an otherwise-green upload.

Capacitor 6's own pods ship their manifests, which covers the SDK's usage, so
this may well pass — but it is unverifiable from here and the failure arrives
after the fact. Worth adding a manifest step alongside the two that already
exist in `.github/workflows/ios-build.yml`, and confirming against a real
upload.

### E. Legal pages carry unresolved pre-launch notes

Both `landing/terms.html` and `landing/privacy.html` contain explicit
`REVIEW BEFORE LAUNCH` comments flagging:

- the governing-law clause in Terms §12, deliberately left generic;
- whether `legal@fantasysportsnetwork.app` and `privacy@fantasysportsnetwork.app`
  are mailboxes anyone actually reads.

App Review does exercise the contact path. These are business decisions, not
code — but they are launch blockers, so they are listed here.

### F. Minor — a few `catch` blocks swallow without logging

CLAUDE.md rule 3 requires every `catch` to log. A handful do not. The most
notable, since it sits on the fallback path in finding C:

```
index.html:22440   }catch(e){ /* try the next proxy */ }
```

Others are in the News Desk block (`13111`, `13117`, `13191`) — deliberate
degrade-to-default paths, but silent ones. Left alone: they are inside block 4,
where rule 2 puts the deterministic generators off-limits, and adding logging
there is a change I would rather you approve than slip into an audit branch.

---

## Verified clean

Everything here was actively checked and needed no change.

**Win probability removal is complete and correctly scoped.** Removed from the
matchup board and the onboarding walkthrough in `b26061a`, along with all
`.mu-winprob` / `.ftu-m-prob` styling — no dead CSS, no dead JS, no leftover
state. It survives only as `FSNIntel.winProbability()` (the model) and in News
Desk pre-game preview prose (`13326`, `13339`, `14954-14955`, `15045`), all of
which sit inside block 4 — deterministic article generators that CLAUDE.md rule 2
puts off-limits, and which the removal commit documented as a deliberate
retention. `landing/screenshots/matchups.png` was inspected directly: it shows a
projected board with per-game margins and no probability bar, and its nav matches
the app's six tabs. Now pinned by `check:claims`.

**iOS validation.** `MinimumOSVersion` is enforced twice — raised in the Podfile
and `project.pbxproj` before compile (`scripts/ios-min-os.mjs`, floor 15.0), then
read back out of the *built* `Info.plist` and failed on if it regressed. The iOS
26 SDK is pinned via `xcode-version: '26'` with a fail-fast SDK check ahead of
the 40-minute archive (ITMS-90725), and export compliance is declared in the
plist so builds do not stall in TestFlight as "Missing Compliance". This is in
better shape than most shipping projects.

**Legal links.** `npm run check:links` passes across all four shells: both URLs
resolve 200 through `cleanUrls`, the anchors keep `target=_blank rel=noopener`,
native taps open the Capacitor in-app browser (never `window.open`, which would
replace the running app), a blocked popup degrades to normal navigation rather
than dead-ending, and `javascript:` / `data:` / empty URLs are refused *and
logged*.

**Placeholder text.** No `lorem ipsum`, `TODO`, `FIXME`, `coming soon` or `TBD`
anywhere in `index.html`. Every `placeholder` hit is a legitimate input hint or
the deliberate News Desk empty-state card (`newsPlaceholderCard`, `25939`),
which degrades honestly and logs why (`25964`, `26027`).

**Empty and unavailable states.** The app consistently marks missing data
`Unavailable` with a note rather than filling it with a zero — the pattern is
explicit in the code (`16168`: "stays marked unavailable instead of being filled
with a placeholder"). Cold boot holds the FSN bumper until the league mounts so
the "NO SIGNAL / OPEN SETUP" card never flashes at a returning reader, proven
frame-by-frame by `check:boot`, including on a failed restore.

**Navigation and render integrity.** `check:render` walks all six screens plus
the walkthrough with zero page errors, zero `[FSN*]` console errors and no "hit a
snag" text. `check:switch` proves the league-switch curtain stays up until the
incoming league has painted, including under overlapping switches.

**Cross-platform relay resolution.** `check:apibase` pins that root-relative
`/api/…` paths stay relative on http(s) origins but are rewritten onto the
deployed project inside a native shell — the bug where the packaged binary
reported a live relay as undeployed.

**Notifications / cron.** Solid, and mechanically asserted by
`npm run audit:notifications`:
- `CRON_SECRET` compared with `crypto.timingSafeEqual`, accepted as either
  `Bearer` or `x-cron-secret`, and **fails closed** when unset rather than
  defaulting open (`api/notifications-dispatch.js:95-110`).
- One cron/day (`vercel.json`, `0 16 * * *`), matching the Hobby-plan cap.
- The schedule pull is rate-limited on **last attempt, not last success**
  (`MIN_PULL_INTERVAL_MS = 20h`), so an upstream outage cannot become a retry
  storm; a stale cached row is served and the staleness reported.
- At-most-once delivery: the ledger row is inserted *before* the provider call,
  so a duplicate insert violates the composite PK and a manual invocation
  overlapping the cron cannot double-send.
- **No Vercel build loop is possible**: the pull writes one Supabase cache row
  and touches no repository, webhook or deployment.

**Local data erasure.** `eraseLocalDataAndDisconnect()` (`23889`) is reachable
from Setup, confirms first, snapshots keys before removing (so it cannot leave
half the matching keys behind), logs what it erased, and reloads from a bare
pathname so an invite token in the URL cannot immediately re-save the League ID
it just cleared. Note its honest caveat — "Shared cloud records are not
affected" — which is finding A's other half.

---

## Verification

`npm run verify` — clean, exit 0, before and after the change:

```
check:scope · test:triggers · audit:notifications · check:render
check:switch · check:boot · check:apibase · check:links · check:claims
```

`index.html` is untouched by this branch. The change is one line of landing copy,
one new check script, and its two `package.json` entries.
