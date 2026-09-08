# Deployment & Routing — Fantasy Sports Network

Production runs on **Vercel** using **two projects that share this one repository**.
Each project points at a different **Root Directory**, which is how the marketing
landing page and the core app get split across subdomains cleanly.

| Project (Vercel)     | Root Directory | Domains                                                        | What it serves                                   |
| -------------------- | -------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `fsn-landing`        | `landing/`     | `fantasysportsnetwork.app` (apex) + `www.fantasysportsnetwork.app` | Self-contained marketing landing page            |
| `mffu`               | `.` (repo root)| `app.fantasysportsnetwork.app`                                | Full MFFU app (`index.html`, `api/*`, Supabase)  |

Both projects deploy from the **same Git branch**. A push updates both; each build
only sees files under its own Root Directory, so the two never step on each other.

> **CLI / manual deploys → `mffu`.** The repo commits `.vercel/project.json` pinned
> to the `mffu` app project (`prj_FkDMDUvEuLmiaLjf0itXlt6DovbH`, org
> `team_w7XqlLVEOovfydsrYOHIZ050`). This guarantees `vercel deploy` and MCP/CLI-driven
> deploys land on the app project instead of `fsn-landing`. `.gitignore` keeps the rest
> of `.vercel/` (local cache) out of git while tracking only this link file.

---

## 1. Landing project (`fantasysportsnetwork.app` / `www`)

- **Root Directory:** `landing`
- **Framework Preset:** Other (static)
- **Build Command / Output:** none — it's a static `index.html`. `landing/vercel.json`
  pins `framework: null`, `outputDirectory: "."`, and `cleanUrls: true`.
- **Domains:** add both `fantasysportsnetwork.app` and `www.fantasysportsnetwork.app`.
  In the Vercel domain settings, set the **apex to redirect to `www`** (or vice-versa —
  pick one canonical host; `www` is configured as canonical here).

Because Root Directory is `landing/`, this project **cannot see** `api/`, the Supabase
schema, or the 800 KB app bundle. It ships nothing but the marketing page and the two
legal pages below.

### Legal pages (`/terms`, `/privacy`)

`landing/terms.html` and `landing/privacy.html` are served at `/terms` and `/privacy`
because `landing/vercel.json` sets `cleanUrls: true`. **These two paths are load-bearing:**
the Privacy & Data card in the app's Setup screen links straight at
`https://www.fantasysportsnetwork.app/{terms,privacy}`, and App Store Guideline 5.1.1
requires those links to resolve. They live on the **landing** project, not the app project
— the app links across to `www`, it does not serve the policies itself.

`npm run check:links` pins the whole path: that the anchors exist in `index.html`, that
they point at these URLs, that a file backs each URL, and that each page renders. A
renamed or deleted file fails the check rather than shipping a dead legal link.

## 2. App project (`app.fantasysportsnetwork.app`)

- **Root Directory:** `.` (repository root) — **do not** point it at `landing/`.
- **Framework Preset:** Other. `index.html` is served statically and the files in
  `api/` deploy automatically as Node serverless functions (ESPN proxy, Sleeper,
  league sync, league history).
- **Environment variables:** keep the existing Supabase / ESPN owner-credential env
  vars on **this** project only (see `SUPABASE_SETUP.md`). The landing project needs none.
- **Domain:** `app.fantasysportsnetwork.app`.

The root `vercel.json` states the no-build shape explicitly — `framework: null`,
an empty `buildCommand`, `outputDirectory: "."` — so Vercel's auto-detection does
not pick up `npm run build` (which is the *iOS* staging step and writes to the
gitignored `www/`) and then fail with `STATIC_BUILD_NO_OUT_DIR`. It deliberately
declares **no** `functions`, `routes`, or `rewrites` block: `api/*.js` are
zero-config Node serverless functions, and adding routing config is what would
break them.

Verified against production (`app.fantasysportsnetwork.app`):

| Request | Response |
| --- | --- |
| `GET /api/espn` (no `url`) | `400` `application/json` — `{"error":"Missing url query parameter"}` |
| `GET /api/league` (no `league_id`) | `400` `application/json` — `{"error":"A valid numeric league_id is required."}` |
| `GET /api/auth/yahoo?action=status` | `200` `application/json` — `{"connected":false,...}` |
| `GET /api/espn.js` | routed to the **function**, not served as source text |

All of them carry `content-type: application/json`, so the routes are recognised
correctly — a 404 or an HTML body from the app is a *client-side URL* problem, not
a Vercel one. See §6.

---

## 3. DNS (at your registrar)

Point the domain's nameservers/records at Vercel (Vercel shows the exact target
values per domain in each project's **Settings → Domains**):

| Record | Host  | Points to                    | Used by         |
| ------ | ----- | ---------------------------- | --------------- |
| A      | `@`   | `76.76.21.21` (Vercel apex)  | landing (apex)  |
| CNAME  | `www` | `cname.vercel-dns.com`       | landing (www)   |
| CNAME  | `app` | `cname.vercel-dns.com`       | app             |

> Always use the exact values Vercel displays for your account — the apex IP and CNAME
> target can differ. Assign `fantasysportsnetwork.app` + `www` to `fsn-landing` and
> `app.` to `mffu`; a domain can only belong to one Vercel project at a time.

---

## 4. Pre-launch waitlist (landing → app API → Supabase)

While the app is in development the landing CTAs open a **waitlist modal** instead of
linking into the app. The modal's email form posts to a serverless function on the
**app** project:

```
POST https://app.fantasysportsnetwork.app/api/waitlist
{ "email": "you@email.com", "platform": "espn" | "sleeper" | "", "source": "landing",
  "league_id"?: "123456", "swid"?: "{AB12CD34-…}" }
```

- The endpoint is set as `WAITLIST_ENDPOINT` in `landing/index.html`.
- `api/waitlist.js` validates the email and upserts it into `public.waitlist_signups`
  (see `SUPABASE_SETUP.md`), reusing the app project's existing `SUPABASE_URL` /
  `SUPABASE_SERVICE_ROLE_KEY` env vars.
- **Optional pre-collection:** the modal has a collapsed "Commissioner? Add your league now"
  section with optional **League ID** and **ESPN SWID** inputs; when filled they're posted
  as `league_id` / `swid` and saved to the `league_id` / `espn_swid` columns.
- **Welcome email:** on a first-time signup the route sends an instant confirmation via
  Resend. Add `RESEND_API_KEY` (and optionally `WAITLIST_FROM_EMAIL`) to the **app**
  project; without the key the route still saves signups and skips the email.
- It's cross-origin (landing is on `www`/apex, the API on `app`), so the function
  returns CORS headers (`Access-Control-Allow-Origin` reflecting the caller, plus
  `Allow-Methods`, `Allow-Headers` and a preflight `Max-Age`) for all three FSN origins.
- Because it lives under `api/`, it deploys **only** with the app project (the landing
  project's Root Directory is `landing/` and never sees it).

> When the app ships, flip the landing CTAs back to the app deep-links below and the
> `applyDeepLink()` handler already in `index.html` takes over — `platform` preselects
> the provider, `goto=setup` opens the connect screen, then the query string is cleaned:
>
> ```
> https://app.fantasysportsnetwork.app/?goto=setup&platform=espn
> https://app.fantasysportsnetwork.app/?goto=setup&platform=sleeper
> ```

---

## 5. Keeping the two environments partitioned

- **Landing** = everything under `landing/` (self-contained: one `index.html`, its own
  `vercel.json`). No app code, no API routes, no secrets.
- **App** = repository root (`index.html`, `league-media-studio.html`, `api/`
  including `api/waitlist.js`, `supabase/`, `package.json`).
- The only coupling is the outbound links / the waitlist API call above. Neither build
  imports from the other, so a change on one side cannot break the other.

---

## 6. API base URL in the native iOS app

`index.html` is one file shipped to two places, and they disagree about what a
root-relative URL means:

| Shell | How `index.html` is loaded | What `'/api/espn'` resolves to |
| --- | --- | --- |
| Web | served by the `mffu` Vercel project | `https://app.fantasysportsnetwork.app/api/espn` — the function |
| iOS | staged into `www/` by `npm run build:ios`, packaged into the app bundle, loaded by WKWebView over `capacitor://localhost` | `capacitor://localhost/api/espn` — **a file that is not in the bundle** |

In the native container that second row 404s with a non-JSON body, every relay
read dies at its `response.json()` seam, and the app tells the reader the
serverless function may not be deployed while the functions are live and healthy.

`window.FSNApi` (first script block in `index.html`) closes that gap:

- On an **http(s)** page — production, a preview deploy, `vercel dev`, plain
  localhost — `/api/…` paths are returned **unchanged**, so a preview deploy keeps
  talking to its own functions rather than reaching across to production.
- In a **native shell** — Capacitor reports a native platform, or the page
  protocol is not http(s) — they are rewritten onto
  `https://app.fantasysportsnetwork.app`.
- Nothing else is touched: `/sw.js`, already-absolute URLs (ESPN, the CORS
  proxies), and protocol-relative URLs pass straight through.

`FSNNet.fetch` applies it, so every call site in the app inherits it; the Yahoo
OAuth navigation and `notificationService.js` call `FSNApi.resolve` directly.

**Pointing a native build at a staging deployment:** set
`window.FSN_API_ORIGIN = 'https://<deployment>.vercel.app'` before the first
inline script block. It must be a bare `https` origin; anything else is rejected
with a `[FSNApi]` console error and the default is used.

**Why this needs no server change:** the routes the native app actually reaches
(`/api/espn`, `/api/league`, `/api/sleeper`, `/api/notifications-register`) all
answer with `Access-Control-Allow-Origin: *`, allowlist the app's custom headers
(`x-espn-s2`, `x-espn-swid`, `x-league-token`), and carry their credentials in
those headers rather than in cookies — so they work cross-origin as-is.

**Known limit — Yahoo login is web-only.** `/api/auth/yahoo` and `/api/yahoo` are
cookie-scoped and send no CORS headers at all, so a cross-origin call from the
app bundle cannot complete a session. The paths are resolved for correctness, but
enabling Yahoo in the native app needs those two handlers to send
`Access-Control-Allow-Origin` for the app's origin plus
`Access-Control-Allow-Credentials: true` (or an in-app browser flow), which is a
separate change to `api/`.

`npm run check:apibase` (in the `npm run verify` chain) pins all of the above.

---

## 7. Opening external links from the native app

The same one-file-two-shells problem applies to links that leave the app. On the web a
`target="_blank"` anchor opens a tab. Inside the iOS binary the page is loaded by WKWebView
over `capacitor://localhost`, where there is no tab to open and no browser chrome: the tap
either does nothing, or the destination is loaded into the same webview and **replaces the
running app with no way back**. `server.allowNavigation` cannot prevent that second outcome
— `*.fantasysportsnetwork.app` has to stay on the list for the Yahoo OAuth start.

`window.FSNLinks.openExternal(url)` (first script block in `index.html`) is the seam:

- **Native** → Capacitor's `Browser` plugin, an in-app Safari view controller with a Done
  button that returns the reader to the app. This is why `@capacitor/browser` is a
  dependency; `npx cap sync ios` links it, so it needs no extra step beyond the normal
  build loop in `ios/HANDOFF.md`.
- **Web** → `window.open(url, '_blank', 'noopener,noreferrer')`.
- **Neither available** (a binary built before the plugin was added, or a blocked popup) →
  returns `false` and the caller lets the anchor's own navigation stand, so the behaviour
  is never worse than the plain link.

Only `http(s)` URLs are ever handed to an opener. `npm run check:links` exercises all four
shells.

---

## 8. Universal Links (share cards → the app)

A share card's brief carries a link back to the exact story it is about:

```
https://app.fantasysportsnetwork.app/?id=<league>&season=<year>&week=<n>&story=<article id>&ref=share-card
```

Tapped on an iPhone with the app installed, iOS opens the **app** on that article.
Tapped anywhere else it is an ordinary https link to the same app on the web, which
reads the same query string at boot. One link, both outcomes, no interstitial. The
franchise dossier's copy-link button mints the same shape with `&owner=<ownerId>`.

Deliberately **no share token** rides in these links. An invite link (`?id=…&token=…`,
§4 of `SUPABASE_SETUP.md`) authorises a new device to read a league's archive; a story
link gets pasted into group chats and screenshotted, so it names only public coordinates.
A recipient who is not in the league lands on Setup.

### What has to be true on the hosting side

iOS verifies ownership by fetching, **over https, with no redirect**, from each claimed
host:

```
https://<host>/.well-known/apple-app-site-association
```

Both Vercel projects therefore ship a copy, and the two must stay byte-identical:

| File | Project | Serves |
| --- | --- | --- |
| `.well-known/apple-app-site-association` | `mffu` | `app.fantasysportsnetwork.app` |
| `landing/.well-known/apple-app-site-association` | `fsn-landing` | apex + `www` |

Three things that each silently break the association:

1. **Content type.** The file has no extension, so Vercel would serve it as
   `application/octet-stream`. Both `vercel.json` files carry a `headers` rule pinning it
   to `application/json`. This is a `headers` block, *not* `routes` — the warning in §2
   about routing config is specifically about the legacy `routes` key, which disables
   filesystem handling and the zero-config `api/` functions with it.
2. **The apex redirect.** §1 sets the apex to redirect to `www`. iOS does not follow
   redirects when fetching an AASA, so `applinks:fantasysportsnetwork.app` in the
   entitlement only works if the apex answers that path with a `200` directly. If the
   redirect is host-wide, either exclude `/.well-known/*` from it in the Vercel domain
   settings, or drop the apex from `ios/App.entitlements` and share only `www`/`app` links.
   Check it with `curl -sI https://fantasysportsnetwork.app/.well-known/apple-app-site-association`.
3. **The Apple Team ID.** The AASA's `appIDs` are `<TeamID>.app.fantasysportsnetwork`, and
   the repo ships `TEAMID` as a placeholder because the value is not derivable from the
   source. Replace it in **both** files before the first App Store submission.

### Verifying

```bash
npm run check:applinks    # entitlement ⇄ both AASA files ⇄ FSNDeepLink.HOSTS ⇄ vercel.json
npm run check:deeplinks   # the app really opens the story / dossier a link names
```

`check:applinks` fails on any disagreement between the four places this is configured and
warns while the Team ID is a placeholder; `FSN_REQUIRE_APPLINKS=1` turns that warning into
a failure for a release run. Both run in `npm run verify`, and CI runs `check:applinks`
alongside `scripts/ios-associated-domains.mjs`.

After deploying, Apple's CDN caches the association: `https://app-site-association.cdn-apple.com/a/v1/app.fantasysportsnetwork.app`
shows what devices will actually see, and a fresh install (or a device with developer mode
and `AASA` diagnostics on) is the only way to confirm the final hop.

### The app side

- `window.FSNDeepLink` (first script block in `index.html`) is the grammar: it parses a
  URL into a route and builds a link from one, and it refuses any host outside the three
  associated domains.
- The **universal link router** (block 6, next to `applyDeepLink`) acts on a route. On the
  web the URL is in the address bar. Inside the binary the page is loaded from
  `capacitor://localhost` and has no query string at all, so `@capacitor/app` is the only
  way a link reaches it — `getLaunchUrl()` on a cold start, `appUrlOpen` while running. A
  binary synced before that dependency existed logs an `[FSNDeepLink]` warning and brings
  the app to the front without routing; re-running the build loop in `ios/HANDOFF.md` is
  the fix.
- A story link names an article by an id derived from the league's own box scores, so its
  target does not exist until the league is hydrated. The router holds the route, retries
  on every league-data publish, and gives up out loud after 45s rather than doing nothing.
