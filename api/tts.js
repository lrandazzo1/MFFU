/* Secure serverless ElevenLabs proxy for the FSN Studio Show.
   The browser never sees ELEVENLABS_API_KEY — every synthesis request is
   relayed through this function using the eleven_flash_v2_5 model. */

/* Custom FSN announcer voices, hardcoded server-side. The two studio hosts
   map to these fixed ElevenLabs voice IDs; a caller may pass a `speaker`
   role (anchor/host or analyst) instead of a raw voice ID. */
const VOICES = {
  anchor:  'gzpdkRXvSsVFesfPP5i7', // Jim Tolliver — Lead Anchor
  host:    'gzpdkRXvSsVFesfPP5i7', // alias for the anchor chair
  analyst: 'T9EcMlwa9Tz1Qri0md9E', // Dee Rawls — Chief Analyst
};
const DEFAULT_VOICE = VOICES.anchor;
const VOICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/* Resolve the target voice: an explicit named speaker wins, then a validated
   raw voice ID, otherwise the anchor. */
function resolveVoiceId(body) {
  const speaker = String(body.speaker || '').trim().toLowerCase();
  if (speaker && VOICES[speaker]) return VOICES[speaker];
  const requested = String(body.voiceId || '').trim();
  if (VOICE_ID_RE.test(requested)) return requested;
  return DEFAULT_VOICE;
}

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = String(process.env.ELEVENLABS_API_KEY || '').trim();
  if (!apiKey) return res.status(503).json({ error: 'Backend voice AI is not configured' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const text = String(body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Missing text' });
  if (text.length > 5000) return res.status(413).json({ error: 'Text exceeds 5000 characters' });

  const voiceId = resolveVoiceId(body);
  const modelId = typeof body.model_id === 'string' && body.model_id.trim()
    ? body.model_id.trim()
    : 'eleven_flash_v2_5';

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: body.voice_settings || { stability: 0.45, similarity_boost: 0.75 },
        }),
      }
    );

    if (!upstream.ok) {
      const errorText = await upstream.text();
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
      return res.status(upstream.status).send(errorText);
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(audio.length));
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    return res.status(200).send(audio);
  } catch (error) {
    console.error('[api/tts] upstream request failed', error);
    return res.status(502).json({ error: 'ElevenLabs upstream request failed' });
  }
};
