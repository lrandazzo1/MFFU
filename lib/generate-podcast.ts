import { ElevenLabsClient } from 'elevenlabs';
import { createClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'node:crypto';

type Line = { host: 'DAN' | 'STU' | 'MARK' | 'SULLY'; text: string };
type Request = { method?: string; headers: Record<string, string | undefined>; body?: unknown };
type Response = { status(code: number): Response; json(data: unknown): void; setHeader(key: string, value: string): void; end(data?: Buffer): void };

const cooldowns = new Map<string, number>();
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
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

// ElevenLabs returns a complete MP3 for every speaker turn. Keeping the ID3
// and Xing/Info duration header from the first turn makes a browser report
// that turn's length (often 0:09) for the entire concatenated episode.
export function stitchPodcastMp3(segments: Buffer[]): Buffer {
  const audio = segments.map((segment) => {
    let offset = 0;
    while (segment.toString('ascii', offset, offset + 3) === 'ID3' && offset + 10 <= segment.length) {
      const size = ((segment[offset + 6] & 0x7f) << 21) | ((segment[offset + 7] & 0x7f) << 14) |
        ((segment[offset + 8] & 0x7f) << 7) | (segment[offset + 9] & 0x7f);
      offset += 10 + size + (segment[offset + 5] & 0x10 ? 10 : 0);
    }
    // The requested mp3_44100_128 format is MPEG-1 Layer III, 44.1 kHz,
    // 128 kbps. Find its first frame after any encoder padding.
    while (offset + 4 <= segment.length) {
      const header = segment.readUInt32BE(offset);
      if (((header & 0xfffe0c00) >>> 0) === 0xfffa0000 && ((header >>> 12) & 15) === 9) break;
      offset++;
    }
    if (offset + 4 > segment.length) throw new Error('ElevenLabs returned an unsupported MP3 segment');
    const firstFrameLength = Math.floor(144000 * 128 / 44100) + ((segment[offset + 2] >>> 1) & 1);
    const firstFrame = segment.subarray(offset, offset + firstFrameLength);
    if (firstFrame.includes(Buffer.from('Xing')) || firstFrame.includes(Buffer.from('Info')) ||
        firstFrame.includes(Buffer.from('VBRI'))) offset += firstFrameLength;
    let end = segment.length;
    if (segment.toString('ascii', end - 128, end - 125) === 'TAG') end -= 128;
    if (end <= offset) throw new Error('ElevenLabs returned an empty MP3 segment');
    return segment.subarray(offset, end);
  });
  return Buffer.concat(audio);
}

async function authorizedLeague(leagueId: string, token: string): Promise<boolean> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('League authorization is not configured');
  const client = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await client.from('leagues').select('share_token')
    .eq('league_id', leagueId).not('share_token', 'is', null).limit(50);
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'Origin not allowed' });
  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: 'Podcast audio is not configured yet' });
  }

  let body: unknown;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (err) {
    console.warn('[Podcast] Invalid JSON body', err);
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const leagueId = String(payload.leagueId || '');
  const token = String(req.headers['x-league-token'] || '');
  const lines = payload.lines;
  if (!/^\d{1,20}$/.test(leagueId) || !TOKEN_RE.test(token) ||
      !Array.isArray(lines) || lines.length < 2 || lines.length > 6 ||
      !lines.every((line: Line) => line && podcastHost(line.host) &&
        typeof line.text === 'string' && line.text.length >= 5 && line.text.length <= 450) ||
      JSON.stringify(payload).length > 4000) {
    return res.status(400).json({ error: 'Invalid episode request or missing league access' });
  }
  try {
    if (!await authorizedLeague(leagueId, token)) {
      return res.status(403).json({ error: 'Save or join this league with a valid invite before generating audio' });
    }
    const cooldownKey = leagueId + ':' + token;
    const now = Date.now();
    if ((cooldowns.get(cooldownKey) || 0) > now) {
      return res.status(429).json({ error: 'An episode was just generated. Try again in a few minutes.' });
    }
    cooldowns.set(cooldownKey, now + 5 * 60 * 1000);
    // Keep each speaker turn intact until its standalone duration metadata is
    // removed; only then join the frames into one seekable episode.
    const segments: Buffer[] = [];
    const voices = podcastVoiceIds();
    for (const line of lines as Line[]) {
      const voiceId = voices[podcastHost(line.host)!];
      const stream = await generateHostAudio(line.text, voiceId);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      segments.push(Buffer.concat(chunks));
    }
    const audio = stitchPodcastMp3(segments);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(audio.length));
    return res.status(200).end(audio);
  } catch (err) {
    if (TOKEN_RE.test(token) && /^\d{1,20}$/.test(leagueId)) cooldowns.delete(leagueId + ':' + token);
    console.error('[Podcast] ElevenLabs generation or league validation failed', err);
    return res.status(502).json({ error: 'Episode generation failed. Please try again.' });
  }
}
