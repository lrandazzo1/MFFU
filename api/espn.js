
const ALLOWED_ESPN_HOSTS = new Set([
  'lm-api-reads.fantasy.espn.com',
  'fantasy.espn.com',
  'site.api.espn.com',
]);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const raw = Array.isArray(req.query && req.query.url)
    ? req.query.url[0]
    : req.query && req.query.url;
  if (!raw) return res.status(400).json({ error: 'Missing url query parameter' });

  let target;
  try {
    target = new URL(String(raw));
  } catch (error) {
    return res.status(400).json({ error: 'Invalid ESPN URL' });
  }

  if (target.protocol !== 'https:' || !ALLOWED_ESPN_HOSTS.has(target.hostname)) {
    return res.status(400).json({ error: 'Unsupported ESPN host' });
  }

  try {
    const upstream = await fetch(target.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'MFFU-FSN/1.0',
      },
      redirect: 'follow',
    });
    const body = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    return res.status(upstream.status).send(body);
  } catch (error) {
    console.error('[api/espn] upstream request failed', error);
    return res.status(502).json({ error: 'ESPN upstream request failed' });
  }
};
