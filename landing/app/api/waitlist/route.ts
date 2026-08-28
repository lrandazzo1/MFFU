import { NextResponse } from 'next/server';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  let payload: { email?: string; provider?: string; source?: string } = {};
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const email = String(payload.email || '').trim().toLowerCase();
  const provider = payload.provider === 'sleeper' ? 'sleeper' : 'espn';
  const source = String(payload.source || 'landing').slice(0, 64);

  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[waitlist] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return NextResponse.json({ error: 'Waitlist signup is temporarily unavailable.' }, { status: 503 });
  }

  const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/waitlist?on_conflict=email`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ email, provider, source, updated_at: new Date().toISOString() }),
    cache: 'no-store',
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('[waitlist] Supabase insert failed', response.status, detail);
    return NextResponse.json({ error: 'Could not join the waitlist. Try again.' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
