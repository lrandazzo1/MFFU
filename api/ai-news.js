/* Secure serverless Anthropic (Claude) proxy for current-season FSN news.
   The browser never sees ANTHROPIC_API_KEY — every generation request is
   relayed through this function. A fast, low-cost Claude model handles the
   dynamic weekly news and preview generation. */

/* Claude 3.5 Haiku (`claude-3-5-haiku`) reached retirement, so the fast,
   low-cost default is Haiku 4.5 — the current generation of the same tier. */
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_TOKENS = 1024;
const ANTHROPIC_VERSION = '2023-06-01';

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/* Accept either a clean {system, messages:[{role:'user'|'assistant'}]} body
   or a legacy OpenAI-style messages array where the system prompt rides along
   as a {role:'system'} entry. Anthropic takes `system` as a top-level string
   and only user/assistant turns in `messages`, so normalize to that shape. */
function normalizeRequest(body) {
  let system = typeof body.system === 'string' ? body.system : '';
  const messages = [];

  if (Array.isArray(body.messages) && body.messages.length) {
    body.messages.forEach((m) => {
      if (!m || typeof m !== 'object') return;
      const content = typeof m.content === 'string' ? m.content : '';
      if (!content) return;
      if (m.role === 'system') {
        system = system ? system + '\n\n' + content : content;
      } else if (m.role === 'assistant') {
        messages.push({ role: 'assistant', content });
      } else {
        messages.push({ role: 'user', content });
      }
    });
  } else if (typeof body.prompt === 'string' && body.prompt.trim()) {
    messages.push({ role: 'user', content: body.prompt.trim() });
  }

  return { system, messages };
}

module.exports = async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) return res.status(503).json({ error: 'Backend AI is not configured' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { system, messages } = normalizeRequest(body);
  if (!messages.length) {
    return res.status(400).json({ error: 'Missing prompt or messages' });
  }

  const requestBody = {
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : DEFAULT_MODEL,
    max_tokens: Number.isFinite(body.max_tokens) ? body.max_tokens : DEFAULT_MAX_TOKENS,
    temperature: Number.isFinite(body.temperature) ? body.temperature : 0.88,
    messages,
  };
  if (system) requestBody.system = system;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(requestBody),
    });
    const text = await upstream.text();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    return res.status(upstream.status).send(text);
  } catch (error) {
    console.error('[api/ai-news] upstream request failed', error);
    return res.status(502).json({ error: 'Anthropic upstream request failed' });
  }
};
