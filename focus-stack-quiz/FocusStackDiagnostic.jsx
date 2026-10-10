'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/* ────────────────────────────────────────────────────────────────────────────
   The Focus Stack Diagnostic — Shuttrdown / Unscroll
   Four questions → email gate → personalised result.

   Drop-in: <FocusStackDiagnostic onSubmit={fn} protocolHref="/protocol" />
   Tailwind only, no component library, no external state. See README.md.
──────────────────────────────────────────────────────────────────────────── */

/* ── The math ───────────────────────────────────────────────────────────────
   hours/day × 365 days × YEARS_REMAINING ÷ HOURS_PER_YEAR = years of life.
   Both constants are assumptions, not findings — change them in one place.
   They are shown to the reader in the footnote so the number stays honest. */
const HOURS_PER_YEAR = 8760;
const YEARS_REMAINING = 50;

export function yearsLost(hoursPerDay, yearsRemaining = YEARS_REMAINING) {
  return (hoursPerDay * 365 * yearsRemaining) / HOURS_PER_YEAR;
}

/* ── Question 1: usage band → representative hours ────────────────────────── */
const USAGE_BANDS = [
  { id: 'light', label: '~2 hours', hours: 2, note: 'Well under average' },
  { id: 'typical', label: '3–4 hours', hours: 3.5, note: 'The global average' },
  { id: 'heavy', label: '5–6 hours', hours: 5.5, note: 'Above average' },
  { id: 'severe', label: '7+ hours', hours: 7.5, note: 'Top decile' },
];

/* ── Questions 2–4 ──────────────────────────────────────────────────────── */
const QUESTIONS = [
  {
    key: 'window',
    title: 'When do you do your worst scrolling?',
    caption: 'Pick the window that costs you the most.',
    options: [
      { id: 'morning', label: 'Morning', note: 'In bed, right after waking up' },
      { id: 'deepwork', label: 'Deep work', note: 'Mid-day slumps and task gaps' },
      { id: 'latenight', label: 'Late night', note: 'Bedtime doomscrolling' },
      { id: 'allday', label: 'All day', note: 'Unstructured, no clear pattern' },
    ],
  },
  {
    key: 'failed',
    title: 'What have you already tried that failed?',
    caption: 'No wrong answer — this is how we pick what to skip.',
    options: [
      { id: 'blockers', label: 'App blockers', note: 'Opal, Freedom, Screen Time limits' },
      { id: 'distance', label: 'Physical distance', note: 'Another room, a lockbox, a drawer' },
      { id: 'deleting', label: 'Deleting the apps', note: 'Then re-downloading within the week' },
      { id: 'willpower', label: 'Nothing yet', note: 'Running on willpower alone' },
    ],
  },
  {
    key: 'friction',
    title: 'What is your biggest friction point?',
    caption: 'The moment the reach actually happens.',
    options: [
      { id: 'quickcheck', label: 'The quick check', note: 'A notification turns into 30 minutes' },
      { id: 'anxiety', label: 'The morning grab', note: 'Phone in hand within 5 minutes of waking' },
      { id: 'switching', label: 'Context-switching', note: 'Never a clean hour of work' },
    ],
  },
];

const TOTAL_STEPS = QUESTIONS.length + 2; // 3 questions + usage + email gate

/* ── Archetypes, keyed by the answer to Q2 ──────────────────────────────── */
const ARCHETYPES = {
  morning: {
    name: 'The Morning Scroller',
    thesis:
      'Your day is lost before it starts. The first 20 minutes after waking set your attentional baseline, and you are handing them to an algorithm that has had all night to prepare.',
    analog: 'A $12 alarm clock, and the charger moved to the kitchen tonight.',
    software: 'Schedule a Sleep Focus that ends 45 minutes after your alarm, not at it.',
    experiment: 'Seven mornings where the phone is not touched until you are dressed.',
  },
  deepwork: {
    name: 'The Context Switcher',
    thesis:
      'You do not have an attention problem, you have a recovery problem. Every pickup costs you roughly 23 minutes of re-immersion, which is why your good hours never feel good.',
    analog: 'A physical timer on the desk and the phone face-down in a drawer, not a pocket.',
    software: 'One notification sweep: everything off except calls and calendar.',
    experiment: 'Two 50-minute blocks a day where the phone is in another room entirely.',
  },
  latenight: {
    name: 'The Doomscroller',
    thesis:
      'The late loop is the hardest to break because it is not seeking pleasure, it is avoiding the end of the day. Bedtime scrolling is procrastinating sleep, and it compounds into the morning.',
    analog: 'A paper book on the pillow and the phone charging outside the bedroom.',
    software: 'A hard downtime at 22:00 with the passcode handed to someone else for a week.',
    experiment: 'Decide tomorrow before you sleep, so the phone has no job at midnight.',
  },
  allday: {
    name: 'The Ambient Drifter',
    thesis:
      'There is no single trap to disarm because the phone has absorbed every gap in your day: the queue, the lift, the walk, the pause between two tasks. The fix is not restriction, it is replacement.',
    analog: 'One object you carry instead — a notebook, a Kindle, a camera, headphones with no feed.',
    software: 'Greyscale on a shortcut, so colour becomes a deliberate choice.',
    experiment: 'Name the three gaps you reach in, and pre-decide what fills each one.',
  },
};

/* What already failed changes the framing, not the plan. */
const FAILURE_NOTES = {
  blockers:
    'Blockers failed because they punish the symptom. You defeated them the same way twice, which is exactly when friction stops working.',
  distance:
    'Distance failed because it had no replacement attached. An empty twenty minutes is worse than a scrolled one, so the phone came back.',
  deleting:
    'Deleting failed because the reflex is not loyal to the app. It moved next door within four days, probably to something you do not even enjoy.',
  willpower:
    'Willpower has not failed yet because it has not been tested against a system that runs continuous experiments on you. Start with structure, not resolve.',
};

const FRICTION_FIRST_MOVE = {
  quickcheck: 'Kill the badge, not the app. Unread counts manufacture a debt your brain insists on paying.',
  anxiety: 'Put something in your hands before the phone is an option. The reach needs a competitor, not a rule.',
  switching: 'Batch the phone into two windows. Nothing ruins an hour like a device that can interrupt it.',
};

/* ── Small helpers ──────────────────────────────────────────────────────── */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = (e) => setReduced(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Counts up to `value` once, then holds. Renders the final value immediately
 *  when motion is reduced, so the number is never inaccurate on screen. */
function CountUp({ value, decimals = 1, duration = 900 }) {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(reduced ? value : 0);
  const raf = useRef(0);

  useEffect(() => {
    if (reduced) { setShown(value); return; }
    let start = null;
    const tick = (ts) => {
      if (start === null) start = ts;
      const t = Math.min(1, (ts - start) / duration);
      setShown(value * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration, reduced]);

  return <>{shown.toFixed(decimals)}</>;
}

/* A step wrapper that fades/slides in on mount. Keyed by step in the parent. */
function Step({ children }) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div
      className={
        'transition-all duration-300 ease-out motion-reduce:transition-none ' +
        (entered ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0')
      }
    >
      {children}
    </div>
  );
}

function OptionCard({ name, option, checked, onChange }) {
  return (
    <label className="block cursor-pointer">
      <input
        type="radio"
        name={name}
        value={option.id}
        checked={checked}
        onChange={() => onChange(option.id)}
        className="peer sr-only"
      />
      <div
        className="h-full rounded-xl border border-white/10 bg-white/[0.03] p-4 transition
                   hover:border-white/25 hover:bg-white/[0.06]
                   peer-checked:border-emerald-400/60 peer-checked:bg-emerald-400/10
                   peer-checked:[&_.fsd-dot]:border-emerald-400 peer-checked:[&_.fsd-dot]:bg-emerald-400
                   peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-400/70 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-zinc-950"
      >
        <div className="flex items-start justify-between gap-3">
          <span className="text-[15px] font-medium text-zinc-100">{option.label}</span>
          <span
            aria-hidden="true"
            className="fsd-dot mt-[3px] h-4 w-4 shrink-0 rounded-full border border-white/25 transition"
          />
        </div>
        {option.note ? <p className="mt-1.5 text-[13px] leading-snug text-zinc-400">{option.note}</p> : null}
      </div>
    </label>
  );
}

/* ── The component ──────────────────────────────────────────────────────── */
export default function FocusStackDiagnostic({
  onSubmit,
  endpoint = '/api/subscribe',
  protocolHref = '#protocol',
  yearsRemaining = YEARS_REMAINING,
  className = '',
}) {
  const [step, setStep] = useState(0); // 0..3 questions, 4 gate, 5 result
  const [hours, setHours] = useState(null);
  const [band, setBand] = useState(null);
  const [answers, setAnswers] = useState({ window: null, failed: null, friction: null });
  const [email, setEmail] = useState('');
  const [optIn, setOptIn] = useState(true);
  const [status, setStatus] = useState('idle'); // idle | loading | error
  const [error, setError] = useState('');
  const headingRef = useRef(null);

  const years = useMemo(() => (hours ? yearsLost(hours, yearsRemaining) : 0), [hours, yearsRemaining]);
  const archetype = answers.window ? ARCHETYPES[answers.window] : null;
  const isResult = step === TOTAL_STEPS;

  /* Move focus to the new step's heading so keyboard and screen-reader users
     are not stranded after each transition. Skipped on first paint, so landing
     on the page does not yank the viewport down to the quiz. */
  const firstPaint = useRef(true);
  useEffect(() => {
    if (firstPaint.current) { firstPaint.current = false; return; }
    headingRef.current?.focus();
  }, [step]);

  const canAdvance =
    step === 0 ? hours !== null :
    step <= QUESTIONS.length ? Boolean(answers[QUESTIONS[step - 1].key]) :
    true;

  function pick(key, id) {
    setAnswers((a) => ({ ...a, [key]: id }));
  }

  async function defaultSubmit(payload) {
    if (!endpoint) return new Promise((r) => setTimeout(r, 500)); // demo mode
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('That did not go through. Try again in a moment.');
    return res.json().catch(() => ({}));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const value = email.trim();
    if (!EMAIL_RE.test(value)) {
      setError('That email looks incomplete.');
      return;
    }
    setError('');
    setStatus('loading');
    const payload = {
      email: value,
      optIn,
      answers: { hoursPerDay: hours, band, ...answers },
      result: { yearsLost: Number(years.toFixed(2)), archetype: archetype?.name },
    };
    try {
      await (onSubmit ? onSubmit(payload) : defaultSubmit(payload));
      setStatus('idle');
      setStep(TOTAL_STEPS);
    } catch (err) {
      setStatus('error');
      setError(err?.message || 'Something went wrong. Try again.');
    }
  }

  const stepNumber = Math.min(step + 1, TOTAL_STEPS);
  const progress = isResult ? 100 : (step / TOTAL_STEPS) * 100;

  return (
    <section
      className={
        'mx-auto w-full max-w-xl rounded-2xl border border-white/10 bg-zinc-900/60 p-5 text-zinc-100 shadow-2xl shadow-black/40 backdrop-blur sm:p-8 ' +
        className
      }
      aria-label="The Focus Stack Diagnostic"
    >
      {/* ── Header + progress ─────────────────────────────────────────────── */}
      <header className="mb-7">
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
            The Focus Stack Diagnostic
          </p>
          <p className="text-[11px] tabular-nums text-zinc-500">
            {isResult ? 'Complete' : `Step ${stepNumber} of ${TOTAL_STEPS}`}
          </p>
        </div>
        <div
          className="mt-3 h-[3px] w-full overflow-hidden rounded-full bg-white/10"
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Quiz progress"
        >
          <div
            className="h-full rounded-full bg-emerald-400 transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${progress}%` }}
          />
        </div>
      </header>

      {/* ── Step 1: usage ─────────────────────────────────────────────────── */}
      {step === 0 && (
        <Step key="s0">
          <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none sm:text-[28px]">
            How many hours a day do you average on your phone?
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            Screen Time lives in Settings if you want the real number. Most people guess low.
          </p>

          <fieldset className="mt-6">
            <legend className="sr-only">Daily phone hours</legend>
            <div className="grid grid-cols-2 gap-3">
              {USAGE_BANDS.map((b) => (
                <OptionCard
                  key={b.id}
                  name="usage"
                  option={{ id: b.id, label: b.label, note: b.note }}
                  checked={band === b.id}
                  onChange={() => { setBand(b.id); setHours(b.hours); }}
                />
              ))}
            </div>
          </fieldset>

          {/* Fine-tune: the live number is what makes the stat feel personal. */}
          {hours !== null && (
            <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <div className="flex items-baseline justify-between">
                <label htmlFor="fsd-hours" className="text-[13px] text-zinc-400">
                  Fine-tune
                </label>
                <output htmlFor="fsd-hours" className="text-[15px] font-medium tabular-nums text-zinc-100">
                  {hours.toFixed(1)} hrs / day
                </output>
              </div>
              <input
                id="fsd-hours"
                type="range"
                min={1}
                max={12}
                step={0.5}
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
                className="mt-3 w-full accent-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              />
              <p className="mt-3 text-[13px] text-zinc-500">
                That is{' '}
                <span className="tabular-nums text-zinc-300">{(hours * 7).toFixed(0)} hours</span> a week —
                about <span className="tabular-nums text-zinc-300">{((hours * 365) / 24).toFixed(0)} days</span> a year.
              </p>
            </div>
          )}
        </Step>
      )}

      {/* ── Steps 2–4: the questions ──────────────────────────────────────── */}
      {step >= 1 && step <= QUESTIONS.length && (() => {
        const q = QUESTIONS[step - 1];
        return (
          <Step key={q.key}>
            <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none sm:text-[28px]">
              {q.title}
            </h2>
            <p className="mt-2 text-sm text-zinc-400">{q.caption}</p>
            <fieldset className="mt-6">
              <legend className="sr-only">{q.title}</legend>
              <div className={'grid gap-3 ' + (q.options.length > 3 ? 'sm:grid-cols-2' : '')}>
                {q.options.map((o) => (
                  <OptionCard
                    key={o.id}
                    name={q.key}
                    option={o}
                    checked={answers[q.key] === o.id}
                    onChange={(id) => pick(q.key, id)}
                  />
                ))}
              </div>
            </fieldset>
          </Step>
        );
      })()}

      {/* ── Step 5: the gate ──────────────────────────────────────────────── */}
      {step === TOTAL_STEPS - 1 && (
        <Step key="gate">
          <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none sm:text-[28px]">
            Your Custom Focus Stack is Ready.
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-zinc-400">
            Enter your email to unlock your personalised protocol, see your lifetime screen
            impact, and get Unscroll No. 01 delivered straight to your inbox.
          </p>

          <form className="mt-6" onSubmit={handleSubmit} noValidate>
            <label htmlFor="fsd-email" className="sr-only">Email address</label>
            <input
              id="fsd-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (error) setError(''); }}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'fsd-email-error' : undefined}
              className="w-full rounded-xl border border-white/15 bg-zinc-950/60 px-4 py-4 text-[16px] text-zinc-100
                         placeholder:text-zinc-600 focus:border-emerald-400/60 focus:outline-none focus:ring-2 focus:ring-emerald-400/40"
            />

            <label className="mt-4 flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={optIn}
                onChange={(e) => setOptIn(e.target.checked)}
                className="mt-[3px] h-4 w-4 shrink-0 rounded border-white/25 bg-zinc-950 accent-emerald-400
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70"
              />
              <span className="text-[13px] leading-relaxed text-zinc-400">
                Send me the weekly Unscroll dispatch (science, tools, and open R&amp;D logs).
                Unsubscribe anytime.
              </span>
            </label>

            {error ? (
              <p id="fsd-email-error" role="alert" className="mt-3 text-[13px] text-rose-400">{error}</p>
            ) : null}

            <button
              type="submit"
              disabled={status === 'loading'}
              className="mt-5 w-full rounded-xl bg-emerald-400 px-5 py-4 text-[15px] font-semibold text-zinc-950
                         transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
            >
              {status === 'loading' ? 'Building your stack…' : 'Reveal My Lifetime Impact & Custom Stack'}
            </button>

            <p className="mt-3 text-center text-[12px] text-zinc-500">
              No spam. One click to leave. We sell no hardware and take no app sponsorships.
            </p>
          </form>
        </Step>
      )}

      {/* ── Result ────────────────────────────────────────────────────────── */}
      {isResult && archetype && (
        <Step key="result">
          <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] p-5 sm:p-6">
            <p className="text-[11px] uppercase tracking-[0.2em] text-emerald-300/80">Lifetime impact</p>
            <p className="mt-3 text-[15px] leading-relaxed text-zinc-300">
              At <span className="tabular-nums text-zinc-100">{hours.toFixed(1)}</span> hours a day, you are
              projected to spend
            </p>
            <p className="mt-2 font-semibold tracking-tight text-emerald-300">
              <span className="text-[56px] leading-none tabular-nums sm:text-[72px]">
                <CountUp value={years} />
              </span>
              <span className="ml-2 text-2xl">years</span>
            </p>
            <p className="mt-2 text-[15px] text-zinc-300">of your life staring at a screen.</p>
            <p className="mt-4 text-[12px] leading-relaxed text-zinc-500">
              Assumes {yearsRemaining} years remaining and today's average holding.
              {' '}{(hours * 7).toFixed(0)} hours a week, {((hours * 365) / 24).toFixed(0)} days a year.
            </p>
          </div>

          <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-5 sm:p-6">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Your archetype</p>
            <h3 className="mt-2 text-2xl font-semibold tracking-tight">{archetype.name}</h3>
            <p className="mt-3 text-[15px] leading-relaxed text-zinc-400">{archetype.thesis}</p>
            {answers.failed ? (
              <p className="mt-4 border-l-2 border-emerald-400/50 pl-4 text-[14px] leading-relaxed text-zinc-400">
                {FAILURE_NOTES[answers.failed]}
              </p>
            ) : null}
          </div>

          <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-5 sm:p-6">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Your focus stack</p>
            <dl className="mt-4 space-y-4">
              <div>
                <dt className="text-[12px] uppercase tracking-[0.14em] text-emerald-300/80">Analog</dt>
                <dd className="mt-1 text-[15px] leading-relaxed text-zinc-300">{archetype.analog}</dd>
              </div>
              <div>
                <dt className="text-[12px] uppercase tracking-[0.14em] text-emerald-300/80">Software</dt>
                <dd className="mt-1 text-[15px] leading-relaxed text-zinc-300">{archetype.software}</dd>
              </div>
              <div>
                <dt className="text-[12px] uppercase tracking-[0.14em] text-emerald-300/80">First move</dt>
                <dd className="mt-1 text-[15px] leading-relaxed text-zinc-300">
                  {answers.friction ? FRICTION_FIRST_MOVE[answers.friction] : archetype.experiment}
                </dd>
              </div>
              <div>
                <dt className="text-[12px] uppercase tracking-[0.14em] text-emerald-300/80">This week</dt>
                <dd className="mt-1 text-[15px] leading-relaxed text-zinc-300">{archetype.experiment}</dd>
              </div>
            </dl>
          </div>

          <a
            href={protocolHref}
            className="mt-6 block w-full rounded-xl bg-emerald-400 px-5 py-4 text-center text-[15px] font-semibold text-zinc-950
                       transition hover:bg-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          >
            View my full protocol &amp; tool stack
          </a>
          <p className="mt-3 text-center text-[12px] text-zinc-500">
            Issue No. 01 is on its way to {email}.
          </p>
        </Step>
      )}

      {/* ── Navigation ────────────────────────────────────────────────────── */}
      {!isResult && step !== TOTAL_STEPS - 1 && (
        <div className="mt-7 flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            className="rounded-lg px-3 py-2 text-[13px] text-zinc-400 transition hover:text-zinc-100
                       disabled:invisible focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70"
          >
            ← Back
          </button>
          <button
            type="button"
            onClick={() => setStep((s) => s + 1)}
            disabled={!canAdvance}
            className="rounded-xl bg-zinc-100 px-6 py-3 text-[14px] font-semibold text-zinc-950 transition
                       hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-100/25 disabled:text-zinc-400
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          >
            Continue
          </button>
        </div>
      )}

      {step === TOTAL_STEPS - 1 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setStep((s) => s - 1)}
            className="rounded-lg px-3 py-2 text-[13px] text-zinc-400 transition hover:text-zinc-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70"
          >
            ← Back
          </button>
        </div>
      )}
    </section>
  );
}
