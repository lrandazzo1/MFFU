// app/api/subscribe/route.js — example App Router handler the quiz posts to.
// Swap the TODO for your provider (ConvertKit, Beehiiv, Loops, Resend, …).

export const runtime = 'edge';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) {
    return Response.json({ error: 'Invalid email' }, { status: 400 });
  }

  // Everything below `email` is quiz context — useful for segmentation.
  const payload = {
    email,
    optIn: Boolean(body?.optIn),
    hoursPerDay: Number(body?.answers?.hoursPerDay) || null,
    band: body?.answers?.band ?? null,
    window: body?.answers?.window ?? null,
    failed: body?.answers?.failed ?? null,
    friction: body?.answers?.friction ?? null,
    yearsLost: Number(body?.result?.yearsLost) || null,
    archetype: body?.result?.archetype ?? null,
    source: 'focus-stack-diagnostic',
  };

  // TODO: forward to your list provider. Example shape for a generic API:
  //
  // const res = await fetch('https://api.provider.com/v1/subscribers', {
  //   method: 'POST',
  //   headers: {
  //     'Content-Type': 'application/json',
  //     Authorization: `Bearer ${process.env.LIST_API_KEY}`,
  //   },
  //   body: JSON.stringify({ email: payload.email, fields: payload }),
  // });
  // if (!res.ok) {
  //   return Response.json({ error: 'Upstream rejected' }, { status: 502 });
  // }

  return Response.json({ ok: true });
}
