import { ElevenLabsClient } from 'elevenlabs';
import { createClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'node:crypto';
import { buildNewsPodcastScript, readNewsPayload } from './podcast-news-script';
import { buildPodcastAudio } from './build-podcast-audio';

type Line = { host: 'DAN' | 'STU' | 'MARK' | 'SULLY'; text: string };
type Request = { method?: string; headers: Record<string, string | undefined>; body?: unknown };
type Response = { status(code: number): Response; json(data: unknown): void; setHeader(key: string, value: string): void; end(data?: Buffer): void };

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const BUCKET = 'podcast-episodes';
/**
 * Dialogue turns one episode may carry.
 *
 * Was 6, which fit the original single-block recap. The four-segment script in
 * `lib/podcast-script.ts` is a cold open, two turns per segment and a sign-off
 * — ten turns — so a cap of 6 rejected every scheduled episode with the generic
 * "Invalid episode request" and no way to tell which of that condition's nine
 * clauses had failed.
 *
 * It is still a hard ceiling, not a formality: every turn is one ElevenLabs
 * call, so this is the per-request spend bound. 16 leaves room for a fifth
 * segment without leaving room for a runaway payload, and the 24000-character
 * body limit below still applies on top of it.
 */
export const MAX_EPISODE_LINES = 16;
// Audio is a live-season feature. Update this anchor at the start of each NFL
// season; keeping it explicit prevents an archive view from ever reaching the
// database claim or an external voice provider.
export const CURRENT_SEASON = 2026;
export const HISTORICAL_SEASON_ERROR = 'Audio recaps are only available for the current season.';
const DEFAULT_DAN_VOICE_ID = 'T9EcMlwa9Tz1Qri0md9E';
const DEFAULT_STU_VOICE_ID = 'gzpdkRXvSsVFesfPP5i7';
const ALLOWED_ORIGINS = new Set([
  'https://app.fantasysportsnetwork.app',
  'https://fantasysportsnetwork.app',
  'https://www.fantasysportsnetwork.app',
  'capacitor://localhost',
  'http://localhost',
  'https://localhost',
]);

// The API key is read only in the serverless function, never in the static app.
export async function generateHostAudio(text: string, voiceId: string) {
  const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
  return elevenlabs.generate({
    voice: voiceId,
    text,
    model_id: 'eleven_flash_v2_5',
    output_format: 'mp3_44100_128',
    voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.35 },
  });
}

// Previous app builds may still send MARK/SULLY while clients update. Route
// those aliases to Dan/Stu without requiring the old environment names.
export function podcastHost(host: string): 'DAN' | 'STU' | null {
  if (host === 'DAN' || host === 'MARK') return 'DAN';
  if (host === 'STU' || host === 'SULLY') return 'STU';
  return null;
}

export function podcastVoiceIds() {
  const configured = (current: string | undefined, legacy: string | undefined, fallback: string) =>
    String(current || '').trim() || String(legacy || '').trim() || fallback;
  return {
    DAN: configured(process.env.ELEVENLABS_DAN_VOICE_ID, process.env.ELEVENLABS_MARK_VOICE_ID, DEFAULT_DAN_VOICE_ID),
    STU: configured(process.env.ELEVENLABS_STU_VOICE_ID, process.env.ELEVENLABS_SULLY_VOICE_ID, DEFAULT_STU_VOICE_ID),
  };
}

// Compatibility export for callers that only need the final bytes. Both
// generation paths use buildPodcastAudio to obtain sample-based markers too.
export function stitchPodcastMp3(segments: Buffer[]): Buffer {
  return buildPodcastAudio(segments).audio;
}

function podcastDb() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error('Podcast storage is not configured');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } });
}

async function authorizedLeague(client: ReturnType<typeof podcastDb>, leagueId: string, token: string, season: number): Promise<boolean> {
  const { data, error } = await client.from('leagues').select('share_token')
    .eq('league_id', leagueId).eq('season_year', season).not('share_token', 'is', null).limit(1);
  if (error) throw error;
  return (data || []).some(row => {
    const expected = String(row.share_token || '');
    if (expected.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  });
}

export default async function handler(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');
  const origin = String(req.headers.origin || '');
  if (ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-league-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'GET or POST required' });
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'Origin not allowed' });

  let body: unknown;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (err) {
    console.warn('[Podcast] Invalid JSON body', err);
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const query = (req as Request & { query?: Record<string, string> }).query || {};
  const leagueId = String(payload.leagueId || '');
  const token = String(req.headers['x-league-token'] || '');
  const id = req.method === 'GET' ? String(query.leagueId || '') : leagueId;
  const season = Number(req.method === 'GET' ? query.season : payload.season);
  const week = Number(req.method === 'GET' ? query.week : payload.week);
  const lines = payload.lines as Line[];
  // Keep this before auth, Supabase reads/claims, prompt assembly, and all
  // ElevenLabs work. A historical request is rejected even with valid access.
  if (Number.isInteger(season) && season < CURRENT_SEASON) {
    return res.status(400).json({ error: HISTORICAL_SEASON_ERROR });
  }
  /* ---- `lines` IS NOW OPTIONAL ON A POST ----
     A client that sends them is authoring the script itself, which is what the
     Studio button used to do with its own four-line News Desk narration. A
     client that omits them is asking THIS route to build the script, and it
     builds the same ~60 second news recap the Tuesday cron builds, from the
     same lib/podcast-news-script.ts and the same blog_articles payload.
     That is the only way the two paths can be identical rather than merely
     similar: one generator, called from both places. A browser port would be a
     third copy of the archetype matrix and its eighteen phrasings.
     The `lines` path is kept because clients already in the wild send them. */
  const authored = Array.isArray(lines);
  if (!/^\d{1,20}$/.test(id) || !TOKEN_RE.test(token) ||
      !Number.isInteger(season) || season < 1990 || season > 2100 ||
      !Number.isInteger(week) || week < 1 || week > 18 ||
      (req.method === 'POST' && (JSON.stringify(payload).length > 24000 ||
        (authored && (lines.length < 2 || lines.length > MAX_EPISODE_LINES ||
          !lines.every(line => line && podcastHost(line.host) &&
            typeof line.text === 'string' && line.text.length >= 5 && line.text.length <= 450)))))) {
    return res.status(400).json({ error: 'Invalid episode request or missing league access' });
  }
  try {
    const client = podcastDb();
    if (!await authorizedLeague(client, id, token, season)) {
      return res.status(403).json({ error: 'Save or join this league with a valid invite before generating audio' });
    }
    const selector = () => client.from('podcast_episodes').select('status,episode,audio_url,created_at')
      .eq('league_id', id).eq('season', season).eq('week', week).maybeSingle();
    const reply = async (row: { status: string; episode: unknown; audio_url: string | null; created_at?: string } | null) => {
      if (!row) return res.status(200).json({ status: 'missing' });
      if (row.status === 'ready') return res.status(200).json({ status: 'ready', episode: row.episode, audioUrl: row.audio_url });
      if (row.status === 'generating') {
        // Vercel invocations cannot run for ten minutes. A crashed invocation
        // must stop polling, but must never silently start a second TTS bill.
        if (row.created_at && Date.now() - Date.parse(row.created_at) > 10 * 60 * 1000) {
          const stale = await client.from('podcast_episodes').update({ status:'failed',
            updated_at:new Date().toISOString() }).eq('league_id', id).eq('season', season)
            .eq('week', week).eq('status', 'generating');
          if (stale.error) throw stale.error;
          return res.status(409).json({ status:'failed', error:'Episode generation needs administrator review.' });
        }
        res.setHeader('Retry-After', '4');
        return res.status(202).json({ status: 'generating' });
      }
      return res.status(409).json({ status: 'failed', error: 'Episode generation needs administrator review.' });
    };
    const existing = await selector();
    if (existing.error) throw existing.error;
    if (existing.data || req.method === 'GET') return reply(existing.data);
    if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: 'Podcast audio is not configured yet' });

    /* ---- THE SCRIPT, BUILT BEFORE THE CLAIM ----
       Either the client's own lines, or — when it sent none — the same ~60
       second news recap the Tuesday cron builds, from the same generator and
       the same blog_articles payload. No box score is fetched here either: the
       payload is the article pipeline's stored output.

       This runs BEFORE the `generating` claim is inserted, and it must stay
       there. A league whose weekly article has not published yet has nothing to
       narrate, and answering 422 from inside the claim would leave a
       `generating` row nobody clears: the inner catch only fires on a throw, so
       an early return would strand the claim until the ten-minute staleness
       sweep flipped it to `failed` and locked the week for good. Nothing is
       claimed until there is a script to record. */
    let episodeLines: Line[] = lines;
    let scriptTitle = String(payload.title || `Week ${week} Recap`).slice(0, 180);
    let scriptStories: unknown[] = Array.isArray(payload.stories) ? payload.stories.slice(0, 10) : [];
    if (!authored) {
      const news = await readNewsPayload(client, id, season, week);
      if (!news) {
        return res.status(422).json({
          error: 'No news payload for week ' + week + ' yet. The weekly article for this league ' +
            'has not published, so there are no stat lines to narrate.',
        });
      }
      const built = buildNewsPodcastScript(news);
      episodeLines = built.lines as Line[];
      scriptTitle = built.title;
      scriptStories = built.stories;
      console.log('[Podcast] Authored a news script for ' + id + '/' + season + '/w' + week + ': ' +
        built.words + ' words, ~' + built.estimatedSeconds + 's, ' + built.lines.length + ' turns.');
    }

    // The database primary key is the cross-instance mutex. An insert loser
    // observes the winner's generating/ready status and never calls ElevenLabs.
    const claim = await client.from('podcast_episodes').insert({
      league_id: id, season, week, status: 'generating',
    });
    if (claim.error) {
      if (claim.error.code !== '23505') throw claim.error;
      const winner = await selector();
      if (winner.error) throw winner.error;
      return reply(winner.data);
    }
    try {
      const segments: Buffer[] = [];
      const voices = podcastVoiceIds();
      for (const line of episodeLines) {
        const voiceId = voices[podcastHost(line.host)!];
        const stream = await generateHostAudio(line.text, voiceId);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        segments.push(Buffer.concat(chunks));
      }
      const { audio, markers } = buildPodcastAudio(segments);
      const path = `${id}/${season}/${week}.mp3`;
      const uploaded = await client.storage.from(BUCKET).upload(path, audio,
        { contentType: 'audio/mpeg', upsert: false });
      if (uploaded.error) throw uploaded.error;
      const audioUrl = client.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      const episode = { title: scriptTitle,
        lines: episodeLines, stories: scriptStories,
        visuals: Array.isArray(payload.visuals) ? payload.visuals.slice(0, 10) : [], markers,
        week, year: season, leagueId: id, createdAt: Date.now() };
      const saved = await client.from('podcast_episodes').update({
        status: 'ready', episode, audio_url: audioUrl, updated_at: new Date().toISOString(),
      }).eq('league_id', id).eq('season', season).eq('week', week).eq('status', 'generating').select('status').single();
      if (saved.error) throw saved.error;
      return res.status(200).json({ status: 'ready', episode, audioUrl });
    } catch (err) {
      // A failed claim stays in the table. Retrying automatically after an
      // ambiguous provider/storage failure could bill for a second episode.
      const failed = await client.from('podcast_episodes').update({ status: 'failed',
        updated_at: new Date().toISOString() }).eq('league_id', id).eq('season', season)
        .eq('week', week).eq('status', 'generating');
      if (failed.error) console.error('[Podcast] Could not record failed claim', failed.error);
      throw err;
    }
  } catch (err) {
    console.error('[Podcast] Episode lookup or generation failed', err);
    return res.status(502).json({ error: 'Episode service failed. Please check status or contact support.' });
  }
}
