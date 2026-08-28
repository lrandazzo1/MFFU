# FSN Marketing Landing Page

Self-contained Next.js + Tailwind landing page for Fantasy Sports Network.

## Local development

```bash
cd landing
npm install
npm run dev
```

## Deployment

Deploy the `landing/` directory as its own Vercel project (Root Directory: `landing`). This keeps the existing single-file MFFU application untouched while the marketing site can be developed and deployed independently.

The landing page uses three real FSN mobile screenshots from the product UI and focuses only on league onboarding, historical depth, the News Desk, franchise dossiers, and analytics.

## App CTA routing

The ESPN and Sleeper CTA buttons link directly into the main FSN/MFFU setup entry point. By default they target the production app at `https://mffu.vercel.app` and pass the intended setup screen and provider:

- ESPN: `?screen=setup&provider=espn&from=landing`
- Sleeper: `?screen=setup&provider=sleeper&from=landing`

If the production app URL changes, set `NEXT_PUBLIC_FSN_APP_URL` in the landing-page Vercel project. The landing page will use that value without requiring a code change.
