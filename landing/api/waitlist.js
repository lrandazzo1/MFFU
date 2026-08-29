/* ============================================================
   FSN LANDING WAITLIST — /api/waitlist

   POST { email, platform?, source?, league_id?, swid? }

   Stores a pre-launch signup in public.waitlist_signups via the
   Supabase service-role key. Called cross-origin from the marketing
   landing page (www / apex) so CORS is handled for the FSN origins.
   Duplicate emails are upserted (idempotent), never an error.

   On the FIRST signup for an email, sends an instant welcome email
   through Resend (RESEND_API_KEY) thanking them, flagging the Sept 4th
   drop, and explaining how to find their ESPN SWID / League ID ahead of
   time. Email delivery is best-effort: it never fails the signup, and
   repeat submissions for the same email are not re-emailed.
============================================================ */

const { createClient } = require('@supabase/supabase-js');

const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_ORIGINS = [
  'https://fantasysportsnetwork.app',
  'https://www.fantasysportsnetwork.app',
  'https://app.fantasysportsnetwork.app',
];

const LAUNCH_LABEL = 'around September 4th';

let supabaseClient;

function isAllowedOrigin(req, origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  // Same-origin requests from Vercel previews or a future custom domain are
  // safe without opening this public endpoint to arbitrary browser origins.
  try {
    const forwardedHost = String(
      (req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || ''
    ).split(',')[0].trim().toLowerCase();
    return Boolean(forwardedHost) && new URL(origin).host.toLowerCase() === forwardedHost;
  } catch (_) {
    return false;
  }
}

function applyHeaders(res, req) {
  const origin = String((req && req.headers && req.headers.origin) || '');
  const allowed = isAllowedOrigin(req, origin);

  if (origin && allowed) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return allowed;
}

function getSupabase() {
  const rawUrl = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!rawUrl || !key) return null;

  let url;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return null;
    // SUPABASE_URL must be the project origin. Normalize accidental values such
    // as https://project.supabase.co/rest/v1 back to the origin because the SDK
    // appends /rest/v1 itself.
    url = parsed.origin;
    if (parsed.pathname && parsed.pathname !== '/') {
      console.warn('[waitlist] normalized SUPABASE_URL path to project origin');
    }
  } catch (_) {
    return null;
  }

  if (!supabaseClient) {
    supabaseClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'X-Client-Info': 'fsn-landing-vercel-waitlist' } },
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

// League IDs are short numeric-ish strings (ESPN & Sleeper). Keep only the
// characters those platforms use so a stray paste can't smuggle anything in.
function cleanLeagueId(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const cleaned = s.replace(/[^0-9A-Za-z]/g, '').slice(0, 32);
  return cleaned || null;
}

// ESPN SWID cookie, e.g. {AB12CD34-...}. Normalize to the braced form ESPN
// expects (matching api/espn.js) so it's ready to use at launch.
function cleanSwid(value) {
  let s = String(value || '').trim();
  if (!s) return null;
  s = s.slice(0, 80);
  if (s[0] !== '{') s = '{' + s.replace(/^\{|\}$/g, '') + '}';
  return s;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------- Transactional welcome email (Resend) ----------
   Best-effort: only runs when RESEND_API_KEY is configured, and any
   failure is swallowed so it never blocks or fails the signup. */
function welcomeEmailHtml(email, hasCreds) {
  const credsBlock = hasCreds
    ? `<p style="margin:0 0 16px;color:#c7cdd8;font-size:15px;line-height:1.6">
         Nice — you already dropped your league details, so your desk will be
         ready to light up the moment we go live. Nothing else to do.
       </p>`
    : `<p style="margin:0 0 8px;color:#c7cdd8;font-size:15px;line-height:1.6">
         Want a head start? Grab these two things now and you'll be watching
         your league on launch day in under a minute:
       </p>
       <ul style="margin:0 0 16px;padding-left:20px;color:#c7cdd8;font-size:15px;line-height:1.7">
         <li><b style="color:#fff">Your League ID</b> — it's the number in your
             league's URL. On ESPN: <code style="color:#00e0ff">.../leagues/<b>123456</b></code>.
             On Sleeper: open your league and copy the long number in the address bar.</li>
         <li><b style="color:#fff">Your ESPN SWID</b> (private ESPN leagues only) —
             in a browser signed in to ESPN, open Developer Tools →
             <b>Application → Cookies → espn.com</b>, and copy the value of the
             <code style="color:#00e0ff">SWID</code> cookie (it looks like
             <code style="color:#00e0ff">{AB12CD34-...}</code>). Grab
             <code style="color:#00e0ff">espn_s2</code> the same way while you're there.</li>
       </ul>
       <p style="margin:0 0 16px;color:#7c8698;font-size:13px;line-height:1.6">
         Sleeper and public ESPN leagues don't need the SWID — just the League ID.
       </p>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#080a0e;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 22px">
    <div style="font-size:22px;font-weight:800;letter-spacing:.02em;color:#fff;margin-bottom:24px">
      <span style="background:#00e0ff;color:#080a0e;padding:3px 9px;border-radius:6px">FSN</span>
      &nbsp;FANTASY <span style="color:#00e0ff">SPORTS NETWORK</span>
    </div>
    <div style="background:#12161f;border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:28px 26px">
      <h1 style="margin:0 0 12px;font-size:24px;line-height:1.15;color:#fff">You're on the list ✅</h1>
      <p style="margin:0 0 16px;color:#c7cdd8;font-size:15px;line-height:1.6">
        Thanks for joining the Fantasy Sports Network waitlist. FSN turns your
        ESPN or Sleeper league into a full broadcast desk — live scores, weekly
        matchups, breaking news, rivalries and 20 years of all-time records.
      </p>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#ffc400">
        <b>Launch drops ${LAUNCH_LABEL}</b> — and it's free for the entire 2026 season.
        We'll email you the moment it's live.
      </p>
      ${credsBlock}
      <p style="margin:0;color:#7c8698;font-size:13px;line-height:1.6">
        See you at kickoff.<br>— The FSN desk
      </p>
    </div>
    <p style="margin:18px 0 0;color:#5b6473;font-size:12px;line-height:1.5;text-align:center">
      You received this because ${escapeHtml(email)} joined the FSN waitlist.
      One email at launch, no spam.
    </p>
  </div>
</body></html>`;
}

function welcomeEmailText(hasCreds) {
  const creds = hasCreds
    ? `You already added your league details, so your desk will be ready the moment we go live.`
    : `Want a head start? Grab these now:

- Your League ID — the number in your league's URL. ESPN: .../leagues/123456. Sleeper: the long number in the address bar.
- Your ESPN SWID (private ESPN leagues only) — in a browser signed in to ESPN, open Developer Tools > Application > Cookies > espn.com and copy the SWID cookie value (looks like {AB12CD34-...}). Grab espn_s2 the same way. Sleeper and public ESPN leagues just need the League ID.`;

  return `You're on the list.

Thanks for joining the Fantasy Sports Network waitlist. FSN turns your ESPN or Sleeper league into a full broadcast desk.

Launch drops ${LAUNCH_LABEL} — free for the entire 2026 season. We'll email you the moment it's live.

${creds}

See you at kickoff.
— The FSN desk`;
}

async function sendWelcomeEmail(email, hasCreds) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) return false;
  const from = String(process.env.WAITLIST_FROM_EMAIL || '').trim()
    || 'Fantasy Sports Network <hello@fantasysportsnetwork.app>';

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: "You're on the FSN waitlist — launch drops " + LAUNCH_LABEL,
        html: welcomeEmailHtml(email, hasCreds),
        text: welcomeEmailText(hasCreds),
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(function () { return ''; });
      console.error('[waitlist] welcome email failed', resp.status, detail.slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[waitlist] welcome email error', err && err.message);
    return false;
  }
}

async function handler(req, res) {
  const startedAt = Date.now();
  const requestId = String((req.headers && req.headers['x-vercel-id']) || '');
  const corsAllowed = applyHeaders(res, req);
  if (!corsAllowed) return res.status(403).json({ error: 'Origin not allowed.' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log(JSON.stringify({
    level: 'info',
    message: 'waitlist request started',
    route: '/api/waitlist',
    request_id: requestId,
  }));

  const missingEnv = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'RESEND_API_KEY',
  ].filter(function (name) { return !String(process.env[name] || '').trim(); });
  if (missingEnv.length) {
    console.error('[waitlist] missing environment variables:', missingEnv.join(', '));
    return res.status(503).json({ error: 'Waitlist service is temporarily unavailable.' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: 'Waitlist service is temporarily unavailable.' });
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

  const leagueId = cleanLeagueId(body && (body.league_id != null ? body.league_id : body.leagueId));
  const swid = cleanSwid(body && body.swid);

  const row = {
    email,
    platform: cleanShort(body && body.platform, 24),
    source: cleanShort(body && body.source, 120) || 'landing',
    user_agent: cleanShort(req.headers['user-agent'], 500),
  };
  // Only overwrite the optional pre-collection columns when the visitor
  // actually supplied them, so a later bare signup can't wipe earlier details.
  if (leagueId) row.league_id = leagueId;
  if (swid) row.espn_swid = swid;

  // Detect first-time signups so we only send one welcome email per address.
  let isNew = true;
  try {
    const { data: existing, error: lookupError } = await supabase
      .from('waitlist_signups')
      .select('email')
      .eq('email', email)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) isNew = false;
  } catch (err) {
    // If the pre-check fails we err toward not spamming: treat as existing.
    isNew = false;
    console.error(JSON.stringify({
      level: 'error',
      message: 'waitlist lookup failed',
      route: '/api/waitlist',
      request_id: requestId,
      error: err && err.message,
      code: err && err.code,
      details: err && err.details,
      hint: err && err.hint,
    }));
  }

  try {
    // Upsert on the email primary key so repeat signups are idempotent.
    const { error } = await supabase
      .from('waitlist_signups')
      .upsert(row, { onConflict: 'email' });
    if (error) throw error;
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'waitlist Supabase upsert failed',
      route: '/api/waitlist',
      request_id: requestId,
      error: err && err.message,
      code: err && err.code,
      details: err && err.details,
      hint: err && err.hint,
      duration_ms: Date.now() - startedAt,
    }));
    return res.status(502).json({ error: 'Could not save your signup. Please try again.' });
  }

  // Send once for first-time signups. Storage remains the source of truth if
  // Resend has a transient outage; the response reports delivery accurately.
  const emailSent = isNew
    ? await sendWelcomeEmail(email, Boolean(leagueId || swid))
    : false;

  console.log(JSON.stringify({
    level: 'info',
    message: 'waitlist request completed',
    route: '/api/waitlist',
    request_id: requestId,
    duplicate: !isNew,
    email_sent: emailSent,
    duration_ms: Date.now() - startedAt,
  }));

  return res.status(200).json({
    ok: true,
    email,
    duplicate: !isNew,
    email_sent: emailSent,
  });
}

module.exports = handler;
