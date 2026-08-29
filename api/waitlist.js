/* ============================================================
   MFFU WAITLIST — /api/waitlist

   POST { email, platform?, source? }

   Stores a pre-launch signup in public.waitlist_signups via the
   Supabase service-role key. Called cross-origin from the marketing
   landing page (www / apex) so CORS is handled for the FSN origins.
   Duplicate emails are upserted (idempotent), never an error.
============================================================ */

const { createClient } = require('@supabase/supabase-js');

const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_ORIGINS = [
  'https://fantasysportsnetwork.app',
  'https://www.fantasysportsnetwork.app',
  'https://app.fantasysportsnetwork.app',
];

let supabaseClient;

function applyHeaders(res, req) {
  const origin = String((req && req.headers && req.headers.origin) || '');
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function getSupabase() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  if (!supabaseClient) {
    supabaseClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'X-Client-Info': 'mffu-vercel-waitlist' } },
    });
  }
  return supabaseClient;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') {
    if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    return req.body;
  }
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body, 'utf8') > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    return req.body ? JSON.parse(req.body) : {};
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  // Deliberately permissive but bounded; the UI validates too.
  if (email.length > 254) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function cleanShort(value, max) {
  const s = String(value || '').trim();
  return s ? s.slice(0, max) : null;
}

async function handler(req, res) {
  applyHeaders(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: 'Waitlist storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    const tooLarge = err && err.message === 'PAYLOAD_TOO_LARGE';
    return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'Request body too large.' : 'Invalid JSON body.' });
  }

  const email = cleanEmail(body && body.email);
  if (!email) return res.status(400).json({ error: 'A valid email address is required.' });

  const row = {
    email,
    platform: cleanShort(body && body.platform, 24),
    source: cleanShort(body && body.source, 120) || 'landing',
    user_agent: cleanShort(req.headers['user-agent'], 500),
  };

  try {
    // Upsert on the email primary key so repeat signups are idempotent.
    const { error } = await supabase
      .from('waitlist_signups')
      .upsert(row, { onConflict: 'email' });
    if (error) throw error;
  } catch (err) {
    return res.status(502).json({ error: 'Could not save your signup. Please try again.' });
  }

  return res.status(200).json({ ok: true, email });
}

module.exports = handler;
