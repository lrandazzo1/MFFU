# Deployment & Routing — Fantasy Sports Network

Production runs on **Vercel** using **two projects that share this one repository**.
Each project points at a different **Root Directory**, which is how the marketing
landing page and the core app get split across subdomains cleanly.

| Project (Vercel)     | Root Directory | Domains                                                        | What it serves                                   |
| -------------------- | -------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `fsn-landing`        | `landing/`     | `fantasysportsnetwork.app` (apex) + `www.fantasysportsnetwork.app` | Self-contained marketing landing page            |
| `fsn-app`            | `.` (repo root)| `app.fantasysportsnetwork.app`                                | Full MFFU app (`index.html`, `api/*`, Supabase)  |

Both projects deploy from the **same Git branch**. A push updates both; each build
only sees files under its own Root Directory, so the two never step on each other.

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
schema, or the 800 KB app bundle. It ships nothing but the marketing page.

## 2. App project (`app.fantasysportsnetwork.app`)

- **Root Directory:** `.` (repository root) — **do not** point it at `landing/`.
- **Framework Preset:** Other. `index.html` is served statically and the files in
  `api/` deploy automatically as Node serverless functions (ESPN proxy, Sleeper,
  league sync, league history).
- **Environment variables:** keep the Supabase env vars on **this** project only
  (see `SUPABASE_SETUP.md`). The landing project needs none.
- **Do not set `ESPN_S2` / `ESPN_SWID`.** `/api/espn` no longer reads them. The relay
  is unauthenticated and CORS-open, so a deployment-wide ESPN session would let any
  caller who omits cookies read every league the owner's account belongs to. Callers
  now supply their own cookies, or the league's saved credentials are used for that
  league only. If those vars are still set on the project, delete them — the route
  logs a warning once per cold start while they remain.
- **Domain:** `app.fantasysportsnetwork.app`.

The app deploys exactly as it does today — no root `vercel.json` was added, so its
working configuration is untouched.

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
> `app.` to `fsn-app`; a domain can only belong to one Vercel project at a time.

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
