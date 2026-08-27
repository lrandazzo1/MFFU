/* Secure serverless OpenAI proxy for current-season FSN news. */
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

  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return res.status(503).json({ error: 'Backend AI is not configured' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!prompt && (!messages || !messages.length)) {
    return res.status(400).json({ error: 'Missing prompt or messages' });
  }

  const requestBody = {
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'gpt-4o-mini',
    temperature: Number.isFinite(body.temperature) ? body.temperature : 0.88,
    response_format: body.response_format || { type: 'json_object' },
    messages: messages || [
      { role: 'system', content: typeof body.system === 'string' ? body.system : 'Return valid JSON only.' },
      { role: 'user', content: prompt },
    ],
  };

  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
    const text = await upstream.text();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    return res.status(upstream.status).send(text);
  } catch (error) {
    console.error('[api/ai-news] upstream request failed', error);
    return res.status(502).json({ error: 'OpenAI upstream request failed' });
  }
};
