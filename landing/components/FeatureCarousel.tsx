'use client';

import Image from 'next/image';
import { useEffect, useMemo, useState } from 'react';

type Feature = {
  kicker: string;
  title: string;
  description: string;
  bullets: string[];
  image: string;
  imageAlt: string;
  accent: 'cyan' | 'gold' | 'rose';
};

const features: Feature[] = [
  {
    kicker: '01 · News Desk',
    title: 'Automated League Journalism',
    description:
      'Give every matchup a pulse. FSN turns your league data into a weekly editorial desk with previews, debriefs, state-of-the-league coverage, and power rankings.',
    bullets: [
      'Pre-game matchup previews',
      'Post-game debriefs and storylines',
      'Weekly power rankings and league-wide context',
    ],
    image: '/screens/news-desk.webp',
    imageAlt: 'FSN News Desk showing a State of the League article and weekly timeline',
    accent: 'gold',
  },
  {
    kicker: '02 · Record Book',
    title: 'Franchise Dossiers & All-Time Records',
    description:
      'Every owner gets a permanent franchise identity — not just a current-season record. Surface years of wins, titles, luck, scoring, and playoff history in one clean dossier.',
    bullets: [
      'Career PPG, win percentage, and playoff rate',
      'Luck differential and lifetime scoring totals',
      'Year-by-year finishes and best/worst seasons',
    ],
    image: '/screens/franchise-dossier.webp',
    imageAlt: 'FSN franchise dossier with lifetime vital stats, career PPG, playoff rate, and finish history',
    accent: 'cyan',
  },
  {
    kicker: '03 · Analytics',
    title: 'Advanced Analytics Engine',
    description:
      'Go beyond raw points. FSN translates the weekly schedule into context-rich metrics that show who is actually strong, who is lucky, and who has been crushed by the schedule.',
    bullets: [
      'Adjusted expected wins',
      'Scoring consistency and lineup efficiency',
      'Schedule hardship and heartbreak tracking',
    ],
    image: '/screens/analytics.webp',
    imageAlt: 'FSN season analytics view showing adjusted expected wins',
    accent: 'cyan',
  },
];

const accentClasses: Record<Feature['accent'], string> = {
  cyan: 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100',
  gold: 'border-amber-300/40 bg-amber-300/10 text-amber-100',
  rose: 'border-rose-300/40 bg-rose-300/10 text-rose-100',
};

export function FeatureCarousel() {
  const [active, setActive] = useState(0);
  const current = features[active];
  const total = features.length;

  const progress = useMemo(() => `${String(active + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, [active, total]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setActive((value) => (value + 1) % total);
    }, 7000);

    return () => window.clearInterval(timer);
  }, [total]);

  const previous = () => setActive((value) => (value - 1 + total) % total);
  const next = () => setActive((value) => (value + 1) % total);

  return (
    <div className="neon-card shadow-cyan">
      <div className="grid min-h-[620px] lg:grid-cols-[1.08fr_0.92fr]">
        <div className="relative z-10 flex flex-col justify-between p-6 sm:p-8 lg:p-10">
          <div>
            <div className="mb-8 flex items-center justify-between gap-4">
              <span className={`rounded-full border px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.17em] ${accentClasses[current.accent]}`}>
                {current.kicker}
              </span>
              <span className="font-mono text-xs tracking-[0.18em] text-white/40">{progress}</span>
            </div>

            <div className="max-w-2xl">
              <h3 className="text-3xl font-black uppercase leading-[0.96] tracking-[-0.04em] sm:text-5xl">
                {current.title}
              </h3>
              <p className="mt-6 max-w-xl text-base leading-7 text-[#9ba9bb] sm:text-lg">
                {current.description}
              </p>
            </div>

            <div className="mt-8 grid gap-3">
              {current.bullets.map((bullet, index) => (
                <div key={bullet} className="flex items-start gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
                  <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-cyan-300/25 bg-cyan-300/[0.08] text-[10px] font-black text-cyan-200">
                    {index + 1}
                  </div>
                  <p className="text-sm font-semibold leading-6 text-white/85">{bullet}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-10 flex items-center justify-between gap-4 border-t border-white/[0.07] pt-6">
            <div className="flex gap-2" aria-label="Choose a feature">
              {features.map((feature, index) => (
                <button
                  key={feature.title}
                  type="button"
                  aria-label={`Show ${feature.title}`}
                  aria-pressed={index === active}
                  onClick={() => setActive(index)}
                  className={`h-1.5 rounded-full transition-all ${index === active ? 'w-12 bg-cyan-300' : 'w-5 bg-white/20 hover:bg-white/40'}`}
                />
              ))}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={previous}
                aria-label="Previous feature"
                className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-white/[0.035] text-lg text-white transition hover:border-cyan-200/40 hover:text-cyan-200"
              >
                ←
              </button>
              <button
                type="button"
                onClick={next}
                aria-label="Next feature"
                className="grid h-11 w-11 place-items-center rounded-xl border border-cyan-300/30 bg-cyan-300/[0.08] text-lg text-cyan-100 transition hover:bg-cyan-300/[0.14]"
              >
                →
              </button>
            </div>
          </div>
        </div>

        <div className="relative min-h-[540px] overflow-hidden border-t border-white/[0.07] bg-[#050a12] p-8 lg:min-h-0 lg:border-l lg:border-t-0">
          <div className="absolute inset-0 bg-grid-fade bg-[size:34px_34px] [mask-image:linear-gradient(to_bottom,black,transparent_88%)]" />
          <div className="absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-300/[0.09] blur-3xl" />
          <div className="relative z-10 mx-auto flex h-full max-w-sm items-center justify-center">
            <div key={current.image} className="phone-shot w-[235px] animate-[fadeIn_.35s_ease-out] sm:w-[255px]">
              <Image
                src={current.image}
                alt={current.imageAlt}
                width={237}
                height={512}
                className="h-auto w-full"
                priority={active === 0}
              />
            </div>
          </div>
          <div className="absolute bottom-5 left-6 right-6 z-10 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-white/35">
            <span>Real FSN interface</span>
            <span>Mobile first</span>
          </div>
        </div>
      </div>
    </div>
  );
}
