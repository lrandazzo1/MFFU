# FSN Marketing Landing Page

Self-contained Next.js + Tailwind landing page for Fantasy Sports Network.

## Repository layout

- `/landing` — public marketing site
- `/` — core MFFU application (`index.html`, API routes, Supabase integration)

The two surfaces should be deployed as **separate Vercel projects from the same GitHub repository**.

## Local development

```bash
cd landing
npm install
npm run dev
```

The landing page will be available locally at `http://localhost:3000` while the root MFFU app can continue to be run/deployed independently.

## Production deployment architecture

### Marketing project

Create a Vercel project connected to `lrandazzo1/MFFU` with:

- Root Directory: `landing`
- Framework: Next.js
- Production branch: `main`
- Domains: `fantasysportsnetwork.app` and `www.fantasysportsnetwork.app`

Use one of the two domains as canonical and redirect the other to it in Vercel Project Settings.

### Core app project

Keep a second Vercel project connected to the same repository with:

- Root Directory: repository root (`.` / blank Root Directory)
- Production branch: `main`
- Domain: `app.fantasysportsnetwork.app`

This preserves the full MFFU application for testing and daily use while the public site remains isolated in `landing/`.

## Landing → app CTAs

The landing page defaults to:

- ESPN: `https://app.fantasysportsnetwork.app/?screen=setup&provider=espn&from=landing`
- Sleeper: `https://app.fantasysportsnetwork.app/?screen=setup&provider=sleeper&from=landing`

Set `NEXT_PUBLIC_FSN_APP_URL` on the marketing Vercel project if the app hostname changes.

The hero also clearly displays that FSN is **100% free**.
