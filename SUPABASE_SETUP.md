# MFFU League Cloud setup

1. Create a Supabase project and run [`supabase/schema.sql`](supabase/schema.sql) in its SQL Editor.
2. Add these server-side environment variables to Vercel (or the host running the API routes):
   - `SUPABASE_URL` — the project URL, for example `https://abc.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` — the service-role key, marked as a secret
3. Redeploy, then open MFFU Setup and enter a League ID. The **League Cloud** status will report whether a shared record exists.
4. A commissioner must paste their own `espn_s2` and `SWID` cookies once before publishing. `/api/league-sync` uses them only to confirm that the SWID is marked `isLeagueManager` by ESPN. The cookies are never stored in Supabase.

Cloud reads are keyed by League ID, matching the requested member experience. They return only league settings and the shared historical archive. Personal preferences and ESPN/OpenAI/ElevenLabs credentials are excluded.
