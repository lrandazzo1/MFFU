# FSN standalone landing deployment

This directory is a self-contained Vercel project. Its UI and serverless waitlist
endpoint deploy together, independently of the MFFU application at the repository root.

## Production project

- Vercel project: `fsn-landing`
- Git repository: `lrandazzo1/MFFU`
- Production branch: `fsn-landing-production`
- Root Directory: `landing`
- Framework Preset: Other
- Build Command: leave empty
- Output Directory: `.`
- Install Command: leave automatic
- Domains: `fantasysportsnetwork.app` and `www.fantasysportsnetwork.app`

The browser submits to the relative URL `/api/waitlist`, so the landing site does
not depend on `app.fantasysportsnetwork.app` or any API in the core application.

## Server-only environment variables

Add these only to the `fsn-landing` Vercel project for Production (and Preview if
preview submissions should work):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (Secret)
- `RESEND_API_KEY` (Secret)
- `WAITLIST_FROM_EMAIL` (optional; defaults to
  `Fantasy Sports Network <hello@fantasysportsnetwork.app>`)

Never prefix these with `NEXT_PUBLIC_` or place them in `index.html`. Verify
`fantasysportsnetwork.app` in Resend before production mail is sent.

Run `supabase/waitlist.sql` once in the Supabase SQL Editor. The table has RLS
enabled and intentionally has no browser policies; writes go through the service-role
serverless function only.

## Keep the core app stable

Leave the MFFU Vercel project's Production Branch on
`claude/league-content-master-patch-w9vg0l` (commit `571b60bd58909249e25b99d1c002f4bf54eeb939`)
and its Root Directory at the repository root. Do not point that project at this
branch or at `landing`.

## Verification

After the first production deployment, use a new plus-address so the welcome email
path is exercised rather than treated as a duplicate:

```bash
curl -i -X POST https://www.fantasysportsnetwork.app/api/waitlist \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://www.fantasysportsnetwork.app' \
  --data '{"email":"you+fsn-test@example.com","platform":"espn","source":"deployment-check"}'
```

Expect HTTP 200 with `"ok":true`, `"duplicate":false`, and
`"email_sent":true`. Then confirm the row in Supabase and delivery in Resend Logs.
An OPTIONS preflight from an approved origin should return HTTP 204; an unrelated
cross-origin browser request should return HTTP 403.
