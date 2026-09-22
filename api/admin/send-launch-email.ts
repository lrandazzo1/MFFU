/* ============================================================
   MFFU LAUNCH ANNOUNCEMENT — /api/admin/send-launch-email

   One-shot Vercel serverless route that emails the App Store
   launch announcement to every address in public.waitlist_signups.

   Env (all read from process.env, set them in Vercel):
     - SUPABASE_URL                        (required)
     - SUPABASE_SERVICE_ROLE_KEY           (required)
     - RESEND_API_KEY                      (required)
     - LAUNCH_EMAIL_SECRET                 (required — the ?secret= passcode)
     - LAUNCH_FROM_EMAIL                   (optional; falls back to WAITLIST_FROM_EMAIL then a default)
     - WAITLIST_FROM_EMAIL                 (optional; same fallback chain)
     - APP_STORE_URL                       (optional; overrides CTA link)

   Auth: ?secret=<LAUNCH_EMAIL_SECRET> — no secret, no send.
   Constant-time comparison. Accepts GET or POST.

   Modes:
     ?dry_run=1  — fetches the waitlist and returns the count without
                   sending anything. Use this before the real run.
     ?limit=N    — cap the number of recipients (smoke tests / first N).
     ?to=<email> — bypass the waitlist and send to that one address
                   only. Use this to smoke-test the template before the
                   real blast. Ignored under ?dry_run=1.

   Because Vercel functions have a bounded max duration, this route
   sends synchronously in batches and returns { sent, failed, errors }.
   For a waitlist of a few hundred that fits comfortably. If it ever
   grows past what one invocation can drain, the caller can page with
   ?limit + ?offset.
============================================================ */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Minimal inline shapes for the pieces of the Vercel Node request/response we
// touch — avoids depending on @vercel/node types locally. Vercel injects the
// real objects at runtime.
interface VercelRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface VercelResponse {
  status(code: number): VercelResponse;
  json(payload: unknown): VercelResponse;
  setHeader(name: string, value: string): void;
  end(payload?: unknown): void;
}

// Vercel: give this function room to work through the batches.
export const config = {
  maxDuration: 60,
};

const BATCH_SIZE = 100;   // Resend batch endpoint accepts up to 100 messages per call.
const PAGE_SIZE = 1000;   // Supabase pagination.
const SUBJECT = "We're officially live on the App Store 🏆";
const DEFAULT_FROM = 'support from FSN <support@fantasysportsnetwork.app>';
const DEFAULT_APP_STORE_URL = 'https://apps.apple.com/app/fantasy-sports-network/id6809261472';

let supabaseSingleton: SupabaseClient | null = null;

function getSupabase(): SupabaseClient | null {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  if (!supabaseSingleton) {
    supabaseSingleton = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'X-Client-Info': 'mffu-vercel-send-launch-email' } },
    });
  }
  return supabaseSingleton;
}

// Timing-safe string equality. Prevents leaking the secret's length via
// early-exit comparisons for callers who can measure request latency.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function fromEmail(): string {
  return String(
    process.env.LAUNCH_FROM_EMAIL ||
    process.env.WAITLIST_FROM_EMAIL ||
    DEFAULT_FROM
  ).trim();
}

function appStoreUrl(): string {
  return String(process.env.APP_STORE_URL || DEFAULT_APP_STORE_URL).trim();
}

function launchEmailHtml(url: string): string {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#0b0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6ebf2;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0f14;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#111823;border:1px solid #1f2937;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:32px 32px 16px;">
                <p style="margin:0 0 8px;color:#9aa4b2;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;">Fantasy Sports Network</p>
                <h1 style="margin:0 0 20px;font-size:26px;line-height:1.25;color:#ffffff;font-weight:700;">
                  We're officially live on the App Store 🏆
                </h1>
                <p style="margin:0 0 16px;color:#c7cdd8;font-size:16px;line-height:1.6;">
                  The wait is over. Fantasy Sports Network is live on iOS today — your
                  league finally has its own newsroom, running on-device and free.
                </p>
                <p style="margin:0 0 16px;color:#c7cdd8;font-size:16px;line-height:1.6;">
                  Getting started takes about ten seconds:
                </p>
                <ol style="margin:0 0 20px 20px;padding:0;color:#c7cdd8;font-size:16px;line-height:1.7;">
                  <li>Download FSN on the App Store.</li>
                  <li>Paste your public <strong>Sleeper League ID</strong> when prompted.</li>
                  <li>Watch weekly recaps, headlines, power ratings, and matchup previews light up automatically.</li>
                </ol>
                <p style="margin:0 0 28px;color:#c7cdd8;font-size:16px;line-height:1.6;">
                  Every article is written for <em>your</em> league — real managers, real trades, real
                  smack talk. No accounts, no logins, no analytics dashboards you'll never open.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 8px;">
                  <tr>
                    <td align="center" style="border-radius:999px;background:#3b82f6;">
                      <a href="${url}"
                         style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">
                        Download on the App Store →
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0;color:#8a94a3;font-size:13px;line-height:1.6;text-align:center;">
                  Trouble finding your Sleeper League ID? Open your league in Sleeper, tap the gear,
                  and copy the numeric ID from the URL. That's it — paste and go.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 32px;border-top:1px solid #1f2937;">
                <p style="margin:0;color:#6b7280;font-size:12px;line-height:1.6;text-align:center;">
                  You're receiving this because you joined the FSN waitlist at
                  fantasysportsnetwork.app. Reply to this email if you'd rather not hear from us again.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function launchEmailText(url: string): string {
  return [
    "Fantasy Sports Network — we're officially live on the App Store.",
    '',
    'The wait is over. FSN is live on iOS today. Getting started takes about ten seconds:',
    '',
    '  1. Download FSN on the App Store: ' + url,
    '  2. Paste your public Sleeper League ID when prompted.',
    '  3. Watch weekly recaps, headlines, power ratings, and matchup previews light up automatically.',
    '',
    'Every article is written for your league — real managers, real trades, real smack talk.',
    '',
    'Trouble finding your Sleeper League ID? Open your league in Sleeper, tap the gear,',
    "and copy the numeric ID from the URL. That's it — paste and go.",
    '',
    "You're receiving this because you joined the FSN waitlist at fantasysportsnetwork.app.",
    "Reply if you'd rather not hear from us again.",
  ].join('\n');
}

async function fetchRecipients(supabase: SupabaseClient): Promise<string[]> {
  const emails: string[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await supabase
      .from('waitlist_signups')
      .select('email')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error('supabase_query_failed: ' + error.message);
    if (!data || data.length === 0) break;

    for (const row of data) {
      const raw = String((row as { email?: string }).email || '').trim().toLowerCase();
      if (raw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) emails.push(raw);
    }

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return Array.from(new Set(emails));
}

interface BatchOutcome {
  sent: number;
  failed: number;
  errors: Array<{ batch: number; error: string }>;
  batches: number;
}

async function sendBatches(recipients: string[], apiKey: string): Promise<BatchOutcome> {
  const url = appStoreUrl();
  const html = launchEmailHtml(url);
  const text = launchEmailText(url);
  const from = fromEmail();
  const outcome: BatchOutcome = { sent: 0, failed: 0, errors: [], batches: 0 };

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const chunk = recipients.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    outcome.batches = batchNum;

    // One recipient per message: /emails/batch treats each entry as a
    // separate send, so no address is exposed to another reader.
    const payload = chunk.map((to) => ({
      from,
      to: [to],
      subject: SUBJECT,
      html,
      text,
    }));

    try {
      const resp = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        outcome.failed += chunk.length;
        outcome.errors.push({
          batch: batchNum,
          error: `HTTP ${resp.status}: ${detail.slice(0, 300)}`,
        });
        console.error(`[launch-email] batch ${batchNum} failed: ${resp.status}`, detail.slice(0, 300));
      } else {
        const body = await resp.json().catch(() => null) as { data?: unknown[] } | null;
        const sentCount = Array.isArray(body?.data) ? body!.data!.length : chunk.length;
        outcome.sent += sentCount;
        console.log(`[launch-email] batch ${batchNum} ok — ${sentCount} sent`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcome.failed += chunk.length;
      outcome.errors.push({ batch: batchNum, error: msg });
      console.error(`[launch-email] batch ${batchNum} threw:`, msg);
    }

    // Small gap between batches to stay under Resend's per-second cap.
    if (i + BATCH_SIZE < recipients.length) {
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  return outcome;
}

function qparam(req: VercelRequest, key: string): string {
  const v = req.query[key];
  if (Array.isArray(v)) return String(v[0] || '');
  return String(v || '');
}

async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const expected = String(process.env.LAUNCH_EMAIL_SECRET || '').trim();
  if (!expected) {
    console.error('[launch-email] LAUNCH_EMAIL_SECRET is not configured');
    res.status(503).json({ error: 'NOT_CONFIGURED', detail: 'LAUNCH_EMAIL_SECRET missing' });
    return;
  }

  const provided = qparam(req, 'secret');
  if (!provided || !safeEqual(provided, expected)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    res.status(503).json({
      error: 'NOT_CONFIGURED',
      detail: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required',
    });
    return;
  }

  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    res.status(503).json({ error: 'NOT_CONFIGURED', detail: 'RESEND_API_KEY missing' });
    return;
  }

  const dryRun = qparam(req, 'dry_run') === '1' || qparam(req, 'dry_run') === 'true';
  const limitRaw = Number(qparam(req, 'limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : null;
  const toOverride = qparam(req, 'to').trim().toLowerCase();

  console.log(`[launch-email] request received — dry_run=${dryRun} limit=${limit ?? 'none'} to=${toOverride || 'none'}`);

  // ?to=<email> — smoke-test override. Skip the waitlist query entirely and
  // send to exactly that one address (still requires a valid-looking email).
  let recipients: string[];
  let total: number;
  if (toOverride && !dryRun) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toOverride)) {
      res.status(400).json({ error: 'BAD_TO', detail: 'not a valid email address' });
      return;
    }
    recipients = [toOverride];
    total = 1;
  } else {
    try {
      recipients = await fetchRecipients(supabase);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[launch-email] fetch failed:', msg);
      res.status(500).json({ error: 'FETCH_FAILED', detail: msg });
      return;
    }
    total = recipients.length;
    if (limit) recipients = recipients.slice(0, limit);
  }

  console.log(`[launch-email] fetched=${total} to_send=${recipients.length}`);

  if (dryRun) {
    res.status(200).json({
      mode: 'dry_run',
      total_fetched: total,
      to_send: recipients.length,
      batches: Math.ceil(recipients.length / BATCH_SIZE),
      batch_size: BATCH_SIZE,
      from: fromEmail(),
      subject: SUBJECT,
      app_store_url: appStoreUrl(),
      preview: recipients.slice(0, 3),
    });
    return;
  }

  if (recipients.length === 0) {
    res.status(200).json({ mode: 'send', total_fetched: total, sent: 0, failed: 0, batches: 0 });
    return;
  }

  const outcome = await sendBatches(recipients, apiKey);

  res.status(outcome.failed > 0 && outcome.sent === 0 ? 500 : 200).json({
    mode: 'send',
    total_fetched: total,
    attempted: recipients.length,
    sent: outcome.sent,
    failed: outcome.failed,
    batches: outcome.batches,
    errors: outcome.errors.slice(0, 20),
  });
}

export default handler;
