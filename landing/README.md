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

## Early-access waitlist

The public landing page does **not** send visitors into the unfinished FSN app. All ESPN and Sleeper CTAs scroll to the early-access email capture instead. The selected platform is carried into the form so launch interest can be segmented by ESPN vs. Sleeper.

Submissions POST to `/api/waitlist` and are stored in Supabase.

1. Run `SUPABASE_WAITLIST.sql` in the same Supabase project used by MFFU.
2. Add the server-only variables `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the landing-page Vercel project.
3. Redeploy the landing project.

The waitlist table has RLS enabled and no public insert policy. Only the server-side API route writes with the service-role key.
