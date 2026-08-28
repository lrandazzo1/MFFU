'use client';

import { FormEvent, useEffect, useState } from 'react';

type Provider = 'espn' | 'sleeper';

export function WaitlistCta({ provider, className }: { provider: Provider; className: string }) {
  const label = provider === 'espn' ? 'Join ESPN Waitlist' : 'Join Sleeper Waitlist';

  function chooseProvider() {
    window.dispatchEvent(new CustomEvent('fsn:waitlist-provider', { detail: provider }));
  }

  return (
    <a href="#waitlist" className={className} onClick={chooseProvider}>
      {label}
      <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
        <path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  );
}

export function WaitlistForm() {
  const [provider, setProvider] = useState<Provider>('espn');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const choose = (event: Event) => {
      const detail = (event as CustomEvent<Provider>).detail;
      if (detail === 'espn' || detail === 'sleeper') setProvider(detail);
    };
    window.addEventListener('fsn:waitlist-provider', choose);
    return () => window.removeEventListener('fsn:waitlist-provider', choose);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim()) return;
    setStatus('loading');
    setMessage('');

    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), provider, source: 'landing' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not join the waitlist.');
      setStatus('success');
      setMessage("You're on the list. We'll email you when FSN is ready.");
      setEmail('');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not join the waitlist.');
    }
  }

  return (
    <form onSubmit={submit} className="mt-8">
      <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-black/20 p-1.5" aria-label="Fantasy platform">
        {(['espn', 'sleeper'] as Provider[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setProvider(option)}
            className={`rounded-lg px-4 py-3 text-xs font-black uppercase tracking-[0.12em] transition ${
              provider === option
                ? 'bg-cyan-300 text-[#031119] shadow-[0_0_20px_rgba(0,229,255,.12)]'
                : 'text-white/45 hover:bg-white/[0.05] hover:text-white/75'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor="waitlist-email" className="sr-only">Email address</label>
        <input
          id="waitlist-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          className="min-h-12 min-w-0 flex-1 rounded-xl border border-white/15 bg-black/30 px-4 text-sm text-white outline-none transition placeholder:text-white/25 focus:border-cyan-200/60 focus:ring-2 focus:ring-cyan-200/15"
        />
        <button type="submit" disabled={status === 'loading'} className="primary-button shrink-0 disabled:cursor-wait disabled:opacity-60">
          {status === 'loading' ? 'Joining…' : 'Get Early Access'}
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-2 text-[11px] font-bold uppercase tracking-[0.1em] sm:flex-row sm:items-center sm:justify-between">
        <span className="text-white/35">Free at launch · No spam · Just launch updates</span>
        {message && <span className={status === 'success' ? 'text-emerald-200' : 'text-rose-200'}>{message}</span>}
      </div>
    </form>
  );
}
