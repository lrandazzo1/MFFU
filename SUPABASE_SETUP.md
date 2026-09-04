# MFFU Supabase league storage

1. Create a Supabase project and run [`supabase/schema.sql`](supabase/schema.sql) in its SQL Editor. The table is `public.leagues`, keyed by `(league_id, season_year)`.
2. Add these server-only environment variables to Vercel:
   - `SUPABASE_URL` — your Supabase project URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — the service-role key; mark it as a secret.
   - `LEAGUE_COOKIE_ENCRYPTION_KEY` — a stable 32-byte encryption key, base64 or 64-character hex. Generate a base64 value with `openssl rand -base64 32` and mark it as a secret.
3. Redeploy so Vercel installs `@supabase/supabase-js` from `package.json` and exposes `/api/league`.
4. In MFFU Setup, enter a League ID and private-league cookies. **Save League Data Now** verifies that the ESPN account can read the league, then upserts the archive and encrypted cookies. Any authenticated league member can perform this sync.
5. Press **Share** in the League Cloud card to copy the league's invite link. Send it to your league-mates — it is what lets them in (see below).

## Per-league share secret

The numeric ESPN League ID is public: it is in every league URL. It therefore authorises nothing. Each league gets a `share_token` — 32 random bytes, base64url — minted by `/api/league` on the first save ESPN confirms came from a league member, and reused by every later save for that league.

**Existing projects must run the `alter table public.leagues add column if not exists share_token text;` line in [`supabase/schema.sql`](supabase/schema.sql).** Re-running the whole file is safe; every statement is idempotent.

Reads now require one of two things:

- `GET /api/league?league_id=123&season_year=2026` needs a matching `share_token` (as the `x-league-token` header or a `?token=` parameter) **or** the caller's own `espn_s2` / `SWID`, which ESPN must confirm belong to a member of that league. Anything else is a `401` with `code: "SHARE_TOKEN_REQUIRED"`. The response carries `has_cookies` and, for an authorised caller, the `share_token` itself. It never returns raw ESPN credentials.
- `/api/espn` will replay a league's encrypted stored cookies only for a request carrying that league's share token. Without it the read still goes out **anonymously**, so a public league is never blocked behind a token it does not need; if ESPN then refuses, the caller gets a `401` explaining they need the full invite link.

The invite link is `https://<your-app>/?id=<leagueId>&token=<shareToken>`. Opening it stores the token in that browser (keyed per league), fills in the League ID, and strips the token from the address bar so it does not linger in history, bookmarks, or a `Referer` header. Treat the link like a password: anyone holding it can read the league's shared archive and use its saved ESPN access.

Rows saved before this column existed have no token. They stay readable by an ESPN-verified member, their stored cookies are never lent to anyone, and the next member save mints the league's token.

The frontend caches the last successful record in `localStorage`. If Supabase or the route is temporarily unavailable, the app applies that cache and continues using its existing local ESPN credential fallback.

## Pre-launch waitlist

`supabase/schema.sql` also creates `public.waitlist_signups` (run the same script — it's idempotent). The `POST /api/waitlist` route writes signups there with the service-role key; browsers never touch the table directly.

- **Body:** `{ "email": "you@email.com", "platform": "espn" | "sleeper" | "", "source": "landing", "league_id"?: "123456", "swid"?: "{AB12CD34-…}" }`
- **Behavior:** validates the email, upserts on the `email` primary key (repeat signups are idempotent), and returns `{ ok: true }`. Duplicate emails are not an error.
- **Optional pre-collection:** `league_id` and `swid` are optional. When present they're sanitized (league IDs to alphanumerics, the SWID normalized to the braced `{…}` form ESPN expects) and stored in the `league_id` / `espn_swid` columns. A later bare signup never wipes previously-saved details.
- **Env vars:** reuses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the **app** project. For the welcome email add `RESEND_API_KEY` (and optionally `WAITLIST_FROM_EMAIL`, e.g. `Fantasy Sports Network <hello@fantasysportsnetwork.app>` — the from address must be a verified Resend sender/domain). If `RESEND_API_KEY` is unset the route still saves signups and just skips the email.
- **CORS:** allows the `fantasysportsnetwork.app`, `www.`, and `app.` origins, so the marketing landing page (served from the apex/www domain) can submit to `https://app.fantasysportsnetwork.app/api/waitlist`.

View signups in Supabase: **Table Editor → `waitlist_signups`**, or `select email, platform, league_id, created_at from public.waitlist_signups order by created_at desc;`.

## Yahoo Fantasy Sports OAuth

1. In the Yahoo Developer Network, create a web application with **Fantasy Sports — Read** permission. Set its callback URL to the exact production callback route, for example `https://app.fantasysportsnetwork.app/api/auth/yahoo?action=callback`.
2. Run [`supabase/yahoo_oauth.sql`](supabase/yahoo_oauth.sql) in the Supabase SQL Editor. It creates the private `yahoo_oauth_tokens` and `yahoo_oauth_sessions` tables with RLS enabled and no browser policies.
3. Add these server-only Vercel environment variables:
   - `YAHOO_CLIENT_ID` — the Yahoo app Client ID.
   - `YAHOO_CLIENT_SECRET` — the Yahoo app Client Secret.
   - `YAHOO_REDIRECT_URI` — the exact callback URL registered with Yahoo, including `?action=callback` when used there.
   - `YAHOO_TOKEN_ENCRYPTION_KEY` — a stable 32-byte key, base64 or 64-character hex. Generate a base64 value with `openssl rand -base64 32`.
4. Redeploy. The Setup screen's **Yahoo** tab sends the browser through `/api/auth/yahoo`; the callback stores AES-256-GCM token envelopes in Supabase and gives the browser only an opaque HttpOnly session cookie.

`/api/yahoo` is an allowlisted authenticated proxy for league metadata, standings, teams, and weekly scoreboards. It always sends `Cache-Control: no-store` and refreshes Yahoo's short-lived access token server-side when its stored expiry is near. OAuth tokens are never returned to client JavaScript.

## Welcome email

On the **first** signup for an address, the route sends a transactional welcome email via [Resend](https://resend.com): it thanks them, flags the ~Sept 4th drop (free for the 2026 season), and explains how to find their ESPN SWID / League ID ahead of launch. Delivery is best-effort — a Resend failure is logged but never fails the signup, and repeat submissions for the same email are not re-emailed.
