'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/* ────────────────────────────────────────────────────────────────────────────
   The Focus Stack Diagnostic — Shuttrdown / Unscroll
   Light theme. Four questions (two of them multi-select), an email gate, and
   an inline reveal: submitting expands the result in place, no navigation.

   <FocusStackDiagnostic onSubmit={fn} tools={myAffiliateLinks} />

   Tailwind only. The accent is written as an arbitrary hex so the component
   drops into any project without touching tailwind.config.
──────────────────────────────────────────────────────────────────────────── */

/* ── The math ───────────────────────────────────────────────────────────────
   hours/day × 365 × YEARS_REMAINING ÷ HOURS_PER_YEAR = years of life.
   Both constants are assumptions, not findings — change them in one place.
   They are shown to the reader in the footnote so the number stays honest. */
const HOURS_PER_YEAR = 8760;
const YEARS_REMAINING = 50;

export function yearsLost(hoursPerDay, yearsRemaining = YEARS_REMAINING) {
  return (hoursPerDay * 365 * yearsRemaining) / HOURS_PER_YEAR;
}

/* ── Affiliate slots ────────────────────────────────────────────────────────
   Every recommended object is an entry here, so the links live in one place
   and nothing in the copy hard-codes a URL. Pass a `tools` prop to override
   any subset — ids you leave out keep these defaults.

   `affiliate: true` renders the row with a disclosure marker. Keep the copy
   objective: say what the thing does and when it is the wrong choice. */
export const DEFAULT_TOOLS = {
  alarmClock: {
    name: 'A standalone alarm clock',
    href: '#', // [PLACEHOLDER: affiliate link]
    affiliate: true,
    note: 'Any dumb clock works. The point is that the phone loses its last excuse to sleep beside you.',
  },
  lockbox: {
    name: 'A timed lockbox',
    href: '#', // [PLACEHOLDER: affiliate link]
    affiliate: true,
    note: 'Useful for a fixed window you choose in advance. Useless if you are the kind of person who moves the box.',
  },
  deskTimer: {
    name: 'A physical timer',
    href: '#', // [PLACEHOLDER: affiliate link]
    affiliate: true,
    note: 'A visible countdown beats an app timer because it does not live on the device you are avoiding.',
  },
  eInkReader: {
    name: 'An e-ink reader',
    href: '#', // [PLACEHOLDER: affiliate link]
    affiliate: true,
    note: 'Only worth it if the thing you reach for is reading. It replaces a habit; it does not remove one.',
  },
  appBlocker: {
    name: 'A scheduled app blocker',
    href: '#', // [PLACEHOLDER: affiliate link — Opal, Freedom, One Sec]
    affiliate: true,
    note: 'Set it once on a schedule. Blockers you can snooze on impulse stop working within two weeks.',
  },
  screenTime: {
    name: 'Screen Time / Digital Wellbeing',
    href: 'https://support.apple.com/en-us/HT208982',
    affiliate: false,
    note: 'Free, already on your phone, and enough for most people. Start here before you pay for anything.',
  },
  greyscale: {
    name: 'Greyscale on an accessibility shortcut',
    href: 'https://support.apple.com/en-us/HT210984',
    affiliate: false,
    note: 'Triple-click to drain the colour. Costs nothing and takes about four minutes to set up.',
  },
};

/* ── Question 1: usage band → representative hours ────────────────────────── */
const USAGE_BANDS = [
  { id: 'light', label: '~2 hours', hours: 2, note: 'Well under average' },
  { id: 'typical', label: '3–4 hours', hours: 3.5, note: 'The global average' },
  { id: 'heavy', label: '5–6 hours', hours: 5.5, note: 'Above average' },
  { id: 'severe', label: '7+ hours', hours: 7.5, note: 'Top decile' },
];

/* ── The questions. `multi: true` renders checkboxes and stores an array. ── */
const QUESTIONS = [
  {
    key: 'windows',
    multi: true,
    title: 'When do you do your worst scrolling?',
    caption: 'Select every window that costs you.',
    options: [
      { id: 'morning', label: 'Morning', note: 'In bed, right after waking up' },
      { id: 'deepwork', label: 'Deep work', note: 'Mid-day slumps and task gaps' },
      { id: 'latenight', label: 'Late night', note: 'Bedtime doomscrolling' },
      { id: 'allday', label: 'All day', note: 'Unstructured, no clear pattern' },
    ],
  },
  {
    key: 'failed',
    multi: true,
    title: 'What have you already tried that failed?',
    caption: 'Select all of them — this is how we decide what to skip.',
    options: [
      { id: 'blockers', label: 'App blockers', note: 'Opal, Freedom, Screen Time limits' },
      { id: 'distance', label: 'Physical distance', note: 'Another room, a lockbox, a drawer' },
      { id: 'deleting', label: 'Deleting the apps', note: 'Then re-downloading within the week' },
      { id: 'willpower', label: 'Nothing yet', note: 'Running on willpower alone' },
    ],
  },
  {
    key: 'friction',
    multi: false,
    title: 'What is your biggest friction point?',
    caption: 'The one moment the reach actually happens.',
    options: [
      { id: 'quickcheck', label: 'The quick check', note: 'A notification turns into 30 minutes' },
      { id: 'anxiety', label: 'The morning grab', note: 'Phone in hand within 5 minutes of waking' },
      { id: 'switching', label: 'Context-switching', note: 'Never a clean hour of work' },
    ],
  },
];

const TOTAL_STEPS = QUESTIONS.length + 2; // usage + 3 questions + gate

/* ── Archetypes ─────────────────────────────────────────────────────────── */
const ARCHETYPES = {
  morning: {
    name: 'The Morning Scroller',
    thesis:
      'Your day is lost before it starts. The first 20 minutes after waking set your attentional baseline, and you are handing them to an algorithm that has had all night to prepare.',
    analog: ['alarmClock'],
    software: ['screenTime'],
    softwareHow: 'Schedule a Sleep Focus that ends 45 minutes after your alarm, not at it.',
    experiment: 'Seven mornings where the phone is not touched until you are dressed.',
  },
  deepwork: {
    name: 'The Context Switcher',
    thesis:
      'You do not have an attention problem, you have a recovery problem. Every pickup costs you roughly 23 minutes of re-immersion, which is why your good hours never feel good.',
    analog: ['deskTimer'],
    software: ['appBlocker'],
    softwareHow: 'One notification sweep: everything off except calls and calendar.',
    experiment: 'Two 50-minute blocks a day where the phone is in another room entirely.',
  },
  latenight: {
    name: 'The Doomscroller',
    thesis:
      'The late loop is the hardest to break because it is not seeking pleasure, it is avoiding the end of the day. Bedtime scrolling is procrastinating sleep, and it compounds into the morning.',
    analog: ['alarmClock', 'eInkReader'],
    software: ['screenTime'],
    softwareHow: 'A hard downtime at 22:00 with the passcode handed to someone else for a week.',
    experiment: 'Decide tomorrow before you sleep, so the phone has no job at midnight.',
  },
  allday: {
    name: 'The Ambient Drifter',
    thesis:
      'There is no single trap to disarm because the phone has absorbed every gap in your day: the queue, the lift, the walk, the pause between two tasks. The fix is not restriction, it is replacement.',
    analog: ['eInkReader'],
    software: ['greyscale'],
    softwareHow: 'Greyscale on a shortcut, so colour becomes a deliberate choice.',
    experiment: 'Name the three gaps you reach in, and pre-decide what fills each one.',
  },
};

/* Priority when several windows are selected. "All day" always wins: picking
   it alongside anything else is itself the diagnosis. */
const WINDOW_PRIORITY = ['allday', 'morning', 'latenight', 'deepwork'];

function pickArchetype(windows) {
  if (!windows || windows.length === 0) return null;
  if (windows.length >= 3) return ARCHETYPES.allday;
  for (const id of WINDOW_PRIORITY) if (windows.includes(id)) return ARCHETYPES[id];
  return ARCHETYPES[windows[0]];
}

const WINDOW_LABELS = {
  morning: 'mornings',
  deepwork: 'the work day',
  latenight: 'late nights',
  allday: 'the whole day',
};

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

/* ── Helpers ────────────────────────────────────────────────────────────── */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ACCENT = '#B4411F';

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

/** Counts up once, then holds. Renders the final value immediately when motion
 *  is reduced, so the number on screen is never wrong. */
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

/* One option. Radio when `multi` is false, checkbox (square) when true. */
function OptionCard({ name, option, checked, multi, onToggle }) {
  return (
    <label className="block cursor-pointer">
      <input
        type={multi ? 'checkbox' : 'radio'}
        name={name}
        value={option.id}
        checked={checked}
        onChange={() => onToggle(option.id)}
        className="peer sr-only"
      />
      <div
        className="h-full rounded-xl border border-zinc-200 bg-white p-4 transition
                   hover:border-zinc-300 hover:bg-zinc-50
                   peer-checked:border-[#B4411F] peer-checked:bg-[#B4411F]/[0.06]
                   peer-checked:[&_.fsd-mark]:border-[#B4411F] peer-checked:[&_.fsd-mark]:bg-[#B4411F]
                   peer-checked:[&_.fsd-tick]:opacity-100
                   peer-focus-visible:ring-2 peer-focus-visible:ring-[#B4411F]/60 peer-focus-visible:ring-offset-2"
      >
        <div className="flex items-start justify-between gap-3">
          <span className="text-[15px] font-medium text-zinc-900">{option.label}</span>
          <span
            aria-hidden="true"
            className={
              'fsd-mark mt-[3px] grid h-[18px] w-[18px] shrink-0 place-items-center border border-zinc-300 transition ' +
              (multi ? 'rounded-md' : 'rounded-full')
            }
          >
            <svg viewBox="0 0 10 8" className="fsd-tick h-[8px] w-[10px] opacity-0 transition-opacity" fill="none">
              <path d="M1 4l2.5 2.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
        {option.note ? <p className="mt-1.5 text-[13px] leading-snug text-zinc-500">{option.note}</p> : null}
      </div>
    </label>
  );
}

/* A recommended object, with the affiliate slot as an anchor. */
function ToolLink({ tool }) {
  if (!tool) return null;
  const external = tool.href && tool.href !== '#';
  return (
    <li className="border-t border-zinc-200 pt-3 first:border-t-0 first:pt-0">
      <a
        href={tool.href}
        {...(external
          ? { target: '_blank', rel: 'sponsored noopener noreferrer' }
          : { rel: 'sponsored noopener noreferrer' })}
        className="text-[15px] font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-4 transition hover:decoration-[#B4411F] hover:text-[#B4411F]"
      >
        {tool.name}
        {tool.affiliate ? <span className="ml-1.5 align-super text-[10px] text-zinc-400">affiliate</span> : null}
      </a>
      <p className="mt-1 text-[14px] leading-relaxed text-zinc-600">{tool.note}</p>
    </li>
  );
}

/* ── The component ──────────────────────────────────────────────────────── */
export default function FocusStackDiagnostic({
  onSubmit,
  endpoint = '/api/subscribe',
  tools: toolOverrides,
  gatedArticle,
  yearsRemaining = YEARS_REMAINING,
  className = '',
}) {
  const [step, setStep] = useState(0);
  const [band, setBand] = useState(null);
  const [hours, setHours] = useState(null);
  const [answers, setAnswers] = useState({ windows: [], failed: [], friction: null });
  const [email, setEmail] = useState('');
  const [optIn, setOptIn] = useState(true);
  const [status, setStatus] = useState('idle'); // idle | loading | error
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState(false);

  const headingRef = useRef(null);
  const revealRef = useRef(null);
  const firstPaint = useRef(true);
  const reduced = usePrefersReducedMotion();

  const tools = useMemo(() => ({ ...DEFAULT_TOOLS, ...(toolOverrides || {}) }), [toolOverrides]);
  const years = useMemo(() => (hours ? yearsLost(hours, yearsRemaining) : 0), [hours, yearsRemaining]);
  const archetype = useMemo(() => pickArchetype(answers.windows), [answers.windows]);

  useEffect(() => {
    if (firstPaint.current) { firstPaint.current = false; return; }
    headingRef.current?.focus();
  }, [step]);

  /* After the reveal opens, bring it into view without snatching the page. */
  useEffect(() => {
    if (!revealed) return;
    const id = setTimeout(() => {
      revealRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    }, 220);
    return () => clearTimeout(id);
  }, [revealed, reduced]);

  function toggle(key, id, multi) {
    setAnswers((a) => {
      if (!multi) return { ...a, [key]: id };
      const list = a[key];
      return { ...a, [key]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] };
    });
  }

  const canAdvance =
    step === 0 ? hours !== null :
    step <= QUESTIONS.length
      ? (QUESTIONS[step - 1].multi
          ? answers[QUESTIONS[step - 1].key].length > 0
          : Boolean(answers[QUESTIONS[step - 1].key]))
      : true;

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
    if (!EMAIL_RE.test(value)) { setError('That email looks incomplete.'); return; }
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
      setRevealed(true); // inline — the page never navigates
    } catch (err) {
      setStatus('error');
      setError(err?.message || 'Something went wrong. Try again.');
    }
  }

  const stepNumber = Math.min(step + 1, TOTAL_STEPS);
  const progress = revealed ? 100 : (step / TOTAL_STEPS) * 100;
  const analogTools = archetype ? archetype.analog.map((id) => tools[id]) : [];
  const softwareTools = archetype ? archetype.software.map((id) => tools[id]) : [];
  const showsAffiliate = [...analogTools, ...softwareTools].some((t) => t?.affiliate);

  return (
    <section
      className={
        'mx-auto w-full max-w-xl rounded-2xl border border-zinc-200 bg-white p-5 text-zinc-900 shadow-sm sm:p-8 ' +
        className
      }
      aria-label="The Focus Stack Diagnostic"
    >
      {/* ── Header + progress ─────────────────────────────────────────────── */}
      <header className="mb-7">
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">
            The Focus Stack Diagnostic
          </p>
          <p className="text-[11px] tabular-nums text-zinc-400">
            {revealed ? 'Complete' : `Step ${stepNumber} of ${TOTAL_STEPS}`}
          </p>
        </div>
        <div
          className="mt-3 h-[3px] w-full overflow-hidden rounded-full bg-zinc-100"
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Quiz progress"
        >
          <div
            className="h-full rounded-full bg-[#B4411F] transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${progress}%` }}
          />
        </div>
      </header>

      {/* ── Step 1: usage ─────────────────────────────────────────────────── */}
      {!revealed && step === 0 && (
        <Step key="s0">
          <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none sm:text-[28px]">
            How many hours a day do you average on your phone?
          </h2>
          <p className="mt-2 text-sm text-zinc-500">
            Screen Time lives in Settings if you want the real number. Most people guess low.
          </p>

          <fieldset className="mt-6">
            <legend className="sr-only">Daily phone hours</legend>
            <div className="grid grid-cols-2 gap-3">
              {USAGE_BANDS.map((b) => (
                <OptionCard
                  key={b.id}
                  name="usage"
                  option={b}
                  checked={band === b.id}
                  multi={false}
                  onToggle={() => { setBand(b.id); setHours(b.hours); }}
                />
              ))}
            </div>
          </fieldset>

          {hours !== null && (
            <div className="mt-6 rounded-xl border border-zinc-200 bg-stone-50 p-4">
              <div className="flex items-baseline justify-between">
                <label htmlFor="fsd-hours" className="text-[13px] text-zinc-500">Fine-tune</label>
                <output htmlFor="fsd-hours" className="text-[15px] font-medium tabular-nums text-zinc-900">
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
                className="mt-3 w-full accent-[#B4411F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B4411F]/60 focus-visible:ring-offset-2"
              />
              <p className="mt-3 text-[13px] text-zinc-500">
                That is <span className="tabular-nums text-zinc-700">{(hours * 7).toFixed(0)} hours</span> a week —
                about <span className="tabular-nums text-zinc-700">{((hours * 365) / 24).toFixed(0)} days</span> a year.
              </p>
            </div>
          )}
        </Step>
      )}

      {/* ── Steps 2–4 ─────────────────────────────────────────────────────── */}
      {!revealed && step >= 1 && step <= QUESTIONS.length && (() => {
        const q = QUESTIONS[step - 1];
        const selected = answers[q.key];
        return (
          <Step key={q.key}>
            <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none sm:text-[28px]">
              {q.title}
            </h2>
            <p className="mt-2 text-sm text-zinc-500">
              {q.caption}
              {q.multi ? <span className="ml-1 text-zinc-400">(Choose as many as apply.)</span> : null}
            </p>
            <fieldset className="mt-6">
              <legend className="sr-only">{q.title}</legend>
              <div className={'grid gap-3 ' + (q.options.length > 3 ? 'sm:grid-cols-2' : '')}>
                {q.options.map((o) => (
                  <OptionCard
                    key={o.id}
                    name={q.key}
                    option={o}
                    multi={q.multi}
                    checked={q.multi ? selected.includes(o.id) : selected === o.id}
                    onToggle={(id) => toggle(q.key, id, q.multi)}
                  />
                ))}
              </div>
            </fieldset>
          </Step>
        );
      })()}

      {/* ── Step 5: the gate ──────────────────────────────────────────────── */}
      {step === TOTAL_STEPS - 1 && !revealed && (
        <Step key="gate">
          <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none sm:text-[28px]">
            Your Custom Focus Stack is Ready.
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-zinc-600">
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
              className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-4 text-[16px] text-zinc-900
                         placeholder:text-zinc-400 focus:border-[#B4411F] focus:outline-none focus:ring-2 focus:ring-[#B4411F]/30"
            />

            <label className="mt-4 flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={optIn}
                onChange={(e) => setOptIn(e.target.checked)}
                className="mt-[3px] h-4 w-4 shrink-0 rounded border-zinc-300 accent-[#B4411F]
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B4411F]/60"
              />
              <span className="text-[13px] leading-relaxed text-zinc-600">
                Send me the weekly Unscroll dispatch (science, tools, and open R&amp;D logs).
                Unsubscribe anytime.
              </span>
            </label>

            {error ? (
              <p id="fsd-email-error" role="alert" className="mt-3 text-[13px] text-[#B4411F]">{error}</p>
            ) : null}

            <button
              type="submit"
              disabled={status === 'loading'}
              className="mt-5 w-full rounded-xl bg-zinc-900 px-5 py-4 text-[15px] font-semibold text-white
                         transition hover:bg-[#B4411F] disabled:cursor-not-allowed disabled:opacity-60
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B4411F] focus-visible:ring-offset-2"
            >
              {status === 'loading' ? 'Building your stack…' : 'Reveal My Lifetime Impact & Custom Stack'}
            </button>

            <p className="mt-3 text-center text-[12px] text-zinc-400">
              No spam. One click to leave. We sell no hardware and take no app sponsorships.
            </p>
          </form>
        </Step>
      )}

      {/* ── The inline reveal ─────────────────────────────────────────────────
           No navigation: the gate is replaced in place and everything below
           expands with a grid-rows transition, which animates to the content's
           natural height without a hard-coded max-height.
      ──────────────────────────────────────────────────────────────────────── */}
      {revealed && (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-[#B4411F]/25 bg-[#B4411F]/[0.06] px-4 py-3">
          <svg viewBox="0 0 12 10" aria-hidden="true" className="h-3 w-3.5 shrink-0" fill="none">
            <path d="M1 5l3.5 3.5L11 1.5" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="text-[13px] text-zinc-700">
            Unlocked. Issue No. 01 is on its way to <span className="font-medium text-zinc-900">{email.trim()}</span>.
          </p>
        </div>
      )}

      <div
        ref={revealRef}
        className={
          'grid transition-all duration-700 ease-out motion-reduce:transition-none ' +
          (revealed ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')
        }
        aria-hidden={!revealed}
      >
        <div className="overflow-hidden">
          {revealed && archetype && (
            <div>
              {/* Lifetime stat */}
              <div className="rounded-xl border border-[#B4411F]/20 bg-[#B4411F]/[0.05] p-5 sm:p-6">
                <p className="text-[11px] uppercase tracking-[0.2em] text-[#B4411F]">Lifetime impact</p>
                <p className="mt-3 text-[15px] leading-relaxed text-zinc-600">
                  At <span className="tabular-nums text-zinc-900">{hours.toFixed(1)}</span> hours a day, you are projected to spend
                </p>
                <p className="mt-2 font-semibold tracking-tight text-[#B4411F]">
                  <span className="text-[56px] leading-none tabular-nums sm:text-[72px]"><CountUp value={years} /></span>
                  <span className="ml-2 text-2xl">years</span>
                </p>
                <p className="mt-2 text-[15px] text-zinc-700">of your life staring at a screen.</p>
                <p className="mt-4 text-[12px] leading-relaxed text-zinc-500">
                  Assumes {yearsRemaining} years remaining and today's average holding.
                  {' '}{(hours * 7).toFixed(0)} hours a week, {((hours * 365) / 24).toFixed(0)} days a year.
                </p>
              </div>

              {/* Archetype */}
              <div className="mt-5 rounded-xl border border-zinc-200 bg-stone-50 p-5 sm:p-6">
                <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Your archetype</p>
                <h3 className="mt-2 text-2xl font-semibold tracking-tight">{archetype.name}</h3>
                {answers.windows.length > 1 ? (
                  <p className="mt-1 text-[13px] text-zinc-500">
                    You flagged {answers.windows.map((w) => WINDOW_LABELS[w]).join(', ')} — we built the stack
                    around the one that costs the most.
                  </p>
                ) : null}
                <p className="mt-3 text-[15px] leading-relaxed text-zinc-600">{archetype.thesis}</p>

                {answers.failed.length > 0 && (
                  <div className="mt-4 space-y-3 border-l-2 border-[#B4411F]/50 pl-4">
                    {answers.failed.map((id) => (
                      <p key={id} className="text-[14px] leading-relaxed text-zinc-600">{FAILURE_NOTES[id]}</p>
                    ))}
                  </div>
                )}
              </div>

              {/* The stack — every object is an anchor */}
              <div className="mt-5 rounded-xl border border-zinc-200 bg-white p-5 sm:p-6">
                <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Your focus stack</p>

                <p className="mt-4 text-[12px] uppercase tracking-[0.14em] text-[#B4411F]">Analog</p>
                <ul className="mt-2 space-y-3">
                  {analogTools.map((t, i) => <ToolLink key={t?.name || i} tool={t} />)}
                </ul>

                <p className="mt-6 text-[12px] uppercase tracking-[0.14em] text-[#B4411F]">Software</p>
                <ul className="mt-2 space-y-3">
                  {softwareTools.map((t, i) => <ToolLink key={t?.name || i} tool={t} />)}
                </ul>
                <p className="mt-2 text-[14px] leading-relaxed text-zinc-600">{archetype.softwareHow}</p>

                <p className="mt-6 text-[12px] uppercase tracking-[0.14em] text-[#B4411F]">First move</p>
                <p className="mt-2 text-[15px] leading-relaxed text-zinc-700">
                  {answers.friction ? FRICTION_FIRST_MOVE[answers.friction] : archetype.experiment}
                </p>

                <p className="mt-6 text-[12px] uppercase tracking-[0.14em] text-[#B4411F]">This week</p>
                <p className="mt-2 text-[15px] leading-relaxed text-zinc-700">{archetype.experiment}</p>

                {showsAffiliate ? (
                  <p className="mt-6 border-t border-zinc-200 pt-4 text-[12px] leading-relaxed text-zinc-500">
                    Links marked <span className="align-super text-[10px]">affiliate</span> earn us a commission.
                    They do not change what we recommend, and the free options above are listed first where a free
                    option is the better answer.
                    {/* [PLACEHOLDER: link your full disclosure page here.] */}
                  </p>
                ) : null}
              </div>

              {/* The rest of the article */}
              <div className="mt-5 border-t border-zinc-200 pt-6">
                {gatedArticle || (
                  <div className="space-y-4 text-[1.05rem] leading-relaxed text-zinc-700">
                    <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">The rest of the issue</p>
                    <p>
                      The standard advice — use less, be present, try harder — fails for a structural
                      reason. You are not competing against your own weakness. You are competing
                      against an adaptive system, running continuous experiments, with a feedback
                      loop measured in milliseconds and a budget measured in billions.
                    </p>
                    <p>
                      Which is why the stack above is ordered the way it is. The analog object comes
                      first because it is the only part the platforms cannot update around. The
                      software setting comes second because it is free and reversible. The
                      experiment comes last because a week of evidence about yourself beats a year
                      of resolutions.
                      {/* [PLACEHOLDER: drop the rest of the article here, or pass it as the
                          `gatedArticle` prop from the page so the copy lives with the content.] */}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Navigation ────────────────────────────────────────────────────── */}
      {!revealed && step !== TOTAL_STEPS - 1 && (
        <div className="mt-7 flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            className="rounded-lg px-3 py-2 text-[13px] text-zinc-500 transition hover:text-zinc-900
                       disabled:invisible focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B4411F]/60"
          >
            ← Back
          </button>
          <button
            type="button"
            onClick={() => setStep((s) => s + 1)}
            disabled={!canAdvance}
            className="rounded-xl bg-zinc-900 px-6 py-3 text-[14px] font-semibold text-white transition
                       hover:bg-[#B4411F] disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B4411F] focus-visible:ring-offset-2"
          >
            Continue
          </button>
        </div>
      )}

      {!revealed && step === TOTAL_STEPS - 1 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setStep((s) => s - 1)}
            className="rounded-lg px-3 py-2 text-[13px] text-zinc-500 transition hover:text-zinc-900
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B4411F]/60"
          >
            ← Back
          </button>
        </div>
      )}
    </section>
  );
}
