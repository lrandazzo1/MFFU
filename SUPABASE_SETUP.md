# MFFU Supabase league storage

1. Create a Supabase project and run [`supabase/schema.sql`](supabase/schema.sql) in its SQL Editor. The table is `public.leagues`, keyed by `(league_id, season_year)`.
2. Add these server-only environment variables to Vercel:
   - `SUPABASE_URL` — your Supabase project URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — the service-role key; mark it as a secret.
   - `LEAGUE_COOKIE_ENCRYPTION_KEY` — a stable 32-byte encryption key, base64 or 64-character hex. Generate a base64 value with `openssl rand -base64 32` and mark it as a secret.
3. Redeploy so Vercel installs `@supabase/supabase-js` from `package.json` and exposes `/api/league`.
4. In MFFU Setup, enter a League ID and private-league cookies. **Save League Data Now** verifies that the ESPN account can read the league, then upserts the archive and encrypted cookies. Any authenticated league member can perform this sync.

`GET /api/league?league_id=123&season_year=2026` returns the shared history and a `has_cookies` flag. It never returns raw ESPN credentials. `/api/espn` can use the encrypted stored credentials server-side when the browser has no local copy, so league members only need the League ID.

The frontend caches the last successful record in `localStorage`. If Supabase or the route is temporarily unavailable, the app applies that cache and continues using its existing local ESPN credential fallback.

## Pre-launch waitlist

`supabase/schema.sql` also creates `public.waitlist_signups` (run the same script — it's idempotent). The `POST /api/waitlist` route writes signups there with the service-role key; browsers never touch the table directly.

- **Body:** `{ "email": "you@email.com", "platform": "espn" | "sleeper" | "", "source": "landing" }`
- **Behavior:** validates the email, upserts on the `email` primary key (repeat signups are idempotent), and returns `{ ok: true }`. Duplicate emails are not an error.
- **Env vars:** reuses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the **app** project — no new variables.
- **CORS:** allows the `fantasysportsnetwork.app`, `www.`, and `app.` origins, so the marketing landing page (served from the apex/www domain) can submit to `https://app.fantasysportsnetwork.app/api/waitlist`.

View signups in Supabase: **Table Editor → `waitlist_signups`**, or `select email, platform, created_at from public.waitlist_signups order by created_at desc;`.
