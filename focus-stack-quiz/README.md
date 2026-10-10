# The Focus Stack Diagnostic

A five-step lead-capture quiz for Shuttrdown / Unscroll. Four questions, an
email gate, then a personalised result. React + Tailwind, client-side state
only, no dependencies beyond React.

```
FocusStackDiagnostic.jsx     the component
app/api/subscribe/route.js   example Next.js route handler it posts to
```

## Use

```jsx
import FocusStackDiagnostic from '@/components/FocusStackDiagnostic';

export default function Page() {
  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-16">
      <FocusStackDiagnostic protocolHref="/protocol" />
    </main>
  );
}
```

It is a `'use client'` component — it holds state and reads
`prefers-reduced-motion`, so it cannot be a server component. The dark styling
is self-contained (`bg-zinc-900/60` on a card); put it on a `zinc-950` page and
it sits correctly without a `dark:` class anywhere.

### Props

| Prop | Default | What it does |
|---|---|---|
| `onSubmit` | — | `async (payload) => {}`. Throw to show an inline error. Overrides `endpoint`. |
| `endpoint` | `/api/subscribe` | Where the default submit POSTs. Pass `null` for demo mode (resolves after 500 ms, no network). |
| `protocolHref` | `#protocol` | The result CTA — your protocol page or affiliate stack. |
| `yearsRemaining` | `50` | Lifespan assumption in the headline stat. |
| `className` | `''` | Appended to the card's classes. |

The payload:

```json
{
  "email": "you@example.com",
  "optIn": true,
  "answers": { "hoursPerDay": 5.5, "band": "heavy", "window": "morning",
               "failed": "blockers", "friction": "anxiety" },
  "result": { "yearsLost": 11.46, "archetype": "The Morning Scroller" }
}
```

## The math

```
years = hoursPerDay × 365 × yearsRemaining ÷ 8760
```

Exported as `yearsLost(hoursPerDay, yearsRemaining)` if you want the same
number elsewhere on the page. At 5.5 h/day over 50 years that is 11.5 years.

Both constants are assumptions, not findings, and the result footnote says so
on screen. That matters for a brand whose pitch is "we do not oversell" — a
stat the reader can check is more persuasive than one they cannot.

## How the result is personalised

- **Q2 (when)** picks the archetype: Morning Scroller, Context Switcher,
  Doomscroller, Ambient Drifter. Each carries a thesis, an analog fix, a
  software fix, and a week-one experiment.
- **Q3 (what failed)** adds a line explaining *why* it failed — the single
  highest-trust moment in the flow, because it tells the reader something
  about themselves they did not type in.
- **Q4 (friction)** sets the "first move" — the one thing to do today.

All copy lives in the `ARCHETYPES`, `FAILURE_NOTES` and `FRICTION_FIRST_MOVE`
maps at the top of the file. Editing it needs no knowledge of the component.

## CRO notes

- **The gate sits after the work, before the payoff.** Four questions of
  invested effort, then the ask. Sunk cost does the selling.
- **The fine-tune slider on Q1** exists so the number in the result is *theirs*
  rather than a bucket. Personal numbers convert better than accurate ones.
- **The opt-in is pre-checked** as specified. Legal note: pre-ticked consent is
  not valid under GDPR/UK GDPR, so if you have EU/UK subscribers, ship it
  unchecked there or treat the email itself as the consent and the checkbox as
  a preference. Your call, but it is a real exposure.
- **Progress is visible from step 1** — completion rates fall when people
  cannot see the end.

## Accessibility

Real `fieldset`/`legend` and radio inputs, so arrow keys move between options
natively. Focus moves to each step's heading on transition (but not on first
paint). The progress bar is a `role="progressbar"` with live values. Errors use
`role="alert"` and `aria-describedby`. Transitions and the count-up respect
`prefers-reduced-motion` — the final number renders immediately rather than
animating, so it is never wrong on screen.
