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
- **Environment variables:** keep the existing Supabase / ESPN owner-credential env
  vars on **this** project only (see `SUPABASE_SETUP.md`). The landing project needs none.
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

## 4. How the landing CTAs reach the app

The landing page's **Connect ESPN** / **Connect Sleeper** buttons link to:

```
https://app.fantasysportsnetwork.app/?goto=setup&platform=espn
https://app.fantasysportsnetwork.app/?goto=setup&platform=sleeper
```

The core app reads those query params on boot (`applyDeepLink()` in `index.html`):
`platform` preselects the ESPN or Sleeper provider, `goto=setup` jumps straight to the
Setup / connect screen, and the query string is then cleaned from the URL. With no
params the app boots to Home exactly as before — the behavior is purely additive.

---

## 5. Keeping the two environments partitioned

- **Landing** = everything under `landing/` (self-contained: one `index.html`, its own
  `vercel.json`). No app code, no API routes, no secrets.
- **App** = repository root (`index.html`, `league-media-studio.html`, `api/`,
  `supabase/`, `package.json`).
- The only coupling is the outbound links above. Neither build imports from the other,
  so a change on one side cannot break the other.
