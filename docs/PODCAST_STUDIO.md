# FSN Podcast Studio

The Studio tab builds a short weekly script from the league's existing News Desk
headlines. Dan and Stu are synthesized with ElevenLabs Flash v2.5. Audio,
script, and story cards are stored in IndexedDB on the current device; the
shared league archive and deterministic News Desk generators are unchanged.

Set these server-side variables in the Vercel project before enabling audio:

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_DAN_VOICE_ID` (optional; defaults to `T9EcMlwa9Tz1Qri0md9E`, Dee Rawls)
- `ELEVENLABS_STU_VOICE_ID` (optional; defaults to `gzpdkRXvSsVFesfPP5i7`, Jim Tolliver)
- Existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for league token verification

Voice resolution checks the new variable first, then the legacy
`ELEVENLABS_MARK_VOICE_ID` or `ELEVENLABS_SULLY_VOICE_ID`, then the supplied
default voice ID. The API key remains required. Older clients sending MARK and
SULLY tags are accepted and routed to Dan and Stu's resolved voices.

The public endpoint is `POST /api/generate-podcast`. The route rewrites into
the existing admin function slot and dispatches to `lib/generate-podcast.ts`.
This keeps the deployment at the project's twelve-function limit. The browser
sends an `x-league-token` for a saved or invited ESPN league. Requests without a
matching token cannot consume ElevenLabs credits. Generation is limited to six
short dialogue lines and has a five-minute in-memory cooldown per league token.
The cooldown is a best-effort guard within a warm function instance, not a
durable quota across instances. Add a persistent usage ledger before broadly
distributing paid audio generation to large leagues.

Saved audio is deleted by Setup's **Erase Stored Data & Disconnect** action.
The Studio currently uses scripted narration of existing league headlines: Dan
leads with the reported board, and Stu adds color without inventing a result.
There is no LLM system prompt in this pipeline. Episodes are device-local and do not
sync across league members.
