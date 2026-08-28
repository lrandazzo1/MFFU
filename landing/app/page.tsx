import Image from 'next/image';
import { FeatureCarousel } from '@/components/FeatureCarousel';

const APP_BASE_URL = (process.env.NEXT_PUBLIC_FSN_APP_URL || 'https://mffu.vercel.app').replace(/\/+$/, '');

type Provider = 'espn' | 'sleeper';

function appSetupUrl(provider: Provider) {
  return `${APP_BASE_URL}/?screen=setup&provider=${provider}&from=landing`;
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="7" ry="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5 5v6c0 1.65 3.13 3 7 3s7-1.35 7-3V5M5 11v6c0 1.65 3.13 3 7 3s7-1.35 7-3v-6" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 15.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <path d="m4 10.5 3.4 3.4L16 5.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const proof = [
  'Multi-year league history',
  'Automated weekly coverage',
  'Franchise-level records',
  'Advanced season analytics',
];

const steps = [
  {
    number: '01',
    title: 'Choose your league source',
    body: 'Connect ESPN or Sleeper and jump straight into the FSN setup flow. Start with the league you already run — no rebuild, spreadsheet cleanup, or manual record entry.',
  },
  {
    number: '02',
    title: 'Import the history',
    body: 'Enter your League ID for a direct sync, or drop in an exported archive JSON when you want to preserve a deeper historical record.',
  },
  {
    number: '03',
    title: 'Verify your seasons',
    body: 'FSN maps teams, completed seasons, standings, matchup results, and franchise continuity so the record book reflects the league you actually remember.',
  },
  {
    number: '04',
    title: 'Launch your network',
    body: 'The News Desk, Record Book, franchise dossiers, rankings, matchup coverage, and analytics populate from the same league archive.',
  },
];

export default function Home() {
  const espnSetupUrl = appSetupUrl('espn');
  const sleeperSetupUrl = appSetupUrl('sleeper');

  return (
    <main>
      <header className="shell flex h-20 items-center justify-between border-b border-white/[0.06]">
        <a href="#top" className="flex items-center gap-3" aria-label="FSN home">
          <div className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-300/35 bg-cyan-300/[0.07] text-xs font-black tracking-[-0.04em] text-cyan-200">FSN</div>
          <div>
            <div className="text-sm font-black uppercase tracking-[0.17em]">Fantasy Sports Network</div>
            <div className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.18em] text-white/35">League Command Center</div>
          </div>
        </a>

        <a href="#import-history" className="hidden text-xs font-black uppercase tracking-[0.15em] text-white/60 transition hover:text-cyan-200 sm:inline-flex">
          Import your history →
        </a>
      </header>

      <section id="top" className="relative overflow-hidden pt-14 sm:pt-20 lg:pt-24">
        <div className="absolute left-1/2 top-0 -z-10 h-[36rem] w-[62rem] -translate-x-1/2 rounded-full bg-cyan-300/[0.055] blur-3xl" />
        <div className="shell grid items-center gap-14 pb-24 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10 lg:pb-32">
          <div className="max-w-3xl">
            <span className="eyebrow">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-200 shadow-[0_0_10px_rgba(140,245,255,.8)]" />
              Your league already has a history. Use it.
            </span>

            <h1 className="mt-7 text-[clamp(3.1rem,7vw,6.7rem)] font-black uppercase leading-[0.82] tracking-[-0.065em] text-white">
              Turn Your Fantasy League Into A <span className="text-cyan-200">Professional Sports Network.</span>
            </h1>

            <p className="mt-7 max-w-2xl text-base leading-7 text-[#95a3b5] sm:text-xl sm:leading-8">
              Instantly sync years of historical data, custom beat writer articles, power rankings, and deep franchise dossiers — all built from the league you already care about.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <a href={espnSetupUrl} className="primary-button">
                Connect ESPN <ArrowIcon />
              </a>
              <a href={sleeperSetupUrl} className="secondary-button">
                Connect Sleeper <ArrowIcon />
              </a>
            </div>

            <div className="mt-4 flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.14em] text-white/55">
              <span className="rounded-full border border-emerald-300/30 bg-emerald-300/[0.08] px-2.5 py-1 text-emerald-200">100% Free</span>
              <span>FSN is completely free to use.</span>
            </div>

            <div className="mt-8 flex flex-wrap gap-x-5 gap-y-3 border-t border-white/[0.07] pt-6">
              {proof.map((item) => (
                <div key={item} className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.09em] text-white/55">
                  <span className="grid h-5 w-5 place-items-center rounded-full border border-cyan-300/25 bg-cyan-300/[0.06] text-cyan-200">
                    <CheckIcon />
                  </span>
                  {item}
                </div>
              ))}
            </div>
          </div>

          <div className="relative mx-auto h-[610px] w-full max-w-[560px] sm:h-[650px]">
            <div className="absolute left-1/2 top-1/2 h-80 w-80 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-300/10 bg-cyan-300/[0.055] blur-2xl" />
            <div className="phone-shot absolute left-1/2 top-3 z-20 w-[218px] -translate-x-1/2 rotate-[1.5deg] sm:w-[238px]">
              <Image src="/screens/news-desk.webp" alt="FSN News Desk interface" width={237} height={512} priority className="h-auto w-full" />
            </div>
            <div className="phone-shot absolute bottom-8 left-[2%] z-10 w-[176px] -rotate-[8deg] opacity-80 sm:left-[5%] sm:w-[195px]">
              <Image src="/screens/franchise-dossier.webp" alt="FSN franchise dossier interface" width={237} height={512} className="h-auto w-full" />
            </div>
            <div className="phone-shot absolute bottom-5 right-[2%] z-10 w-[176px] rotate-[8deg] opacity-80 sm:right-[5%] sm:w-[195px]">
              <Image src="/screens/analytics.webp" alt="FSN advanced analytics interface" width={237} height={512} className="h-auto w-full" />
            </div>
            <div className="absolute bottom-0 left-1/2 z-30 -translate-x-1/2 rounded-full border border-white/10 bg-[#07101b]/90 px-4 py-2 text-[10px] font-black uppercase tracking-[0.18em] text-white/50 backdrop-blur">
              One archive. Every season.
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-white/[0.06] bg-white/[0.015] py-20 sm:py-24">
        <div className="shell">
          <div className="mb-10 flex flex-col justify-between gap-6 md:flex-row md:items-end">
            <div>
              <span className="eyebrow">Why FSN?</span>
              <h2 className="mt-5 max-w-3xl text-4xl font-black uppercase leading-[0.95] tracking-[-0.045em] sm:text-6xl">
                Your league data should feel like a living sports universe.
              </h2>
            </div>
            <p className="max-w-md text-sm leading-6 text-[#8f9daf] sm:text-base">
              FSN takes the raw history commissioners already have and turns it into coverage, identity, and context your league can actually use every week.
            </p>
          </div>

          <FeatureCarousel />
        </div>
      </section>

      <section id="import-history" className="py-24 sm:py-32">
        <div className="shell">
          <div className="mx-auto max-w-3xl text-center">
            <span className="eyebrow">How to import your history</span>
            <h2 className="mt-5 text-4xl font-black uppercase leading-[0.95] tracking-[-0.045em] sm:text-6xl">
              From league ID to full record book in four steps.
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-[#95a3b5] sm:text-lg">
              No hand-entered champions. No spreadsheet archaeology. Bring the archive in once and let the entire FSN experience build from it.
            </p>
          </div>

          <div className="relative mt-14 grid gap-4 lg:grid-cols-4">
            <div className="absolute left-[12%] right-[12%] top-8 hidden h-px bg-gradient-to-r from-transparent via-cyan-300/25 to-transparent lg:block" />
            {steps.map((step) => (
              <article key={step.number} className="neon-card relative z-10 p-6">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-300/30 bg-cyan-300/[0.08] font-mono text-xs font-black tracking-[0.18em] text-cyan-200">
                  {step.number}
                </div>
                <h3 className="mt-6 text-xl font-black uppercase leading-5 tracking-[-0.02em]">{step.title}</h3>
                <p className="mt-4 text-sm leading-6 text-[#8f9daf]">{step.body}</p>
              </article>
            ))}
          </div>

          <div className="mt-12 grid gap-5 lg:grid-cols-2">
            <article id="import-espn" className="neon-card p-6 sm:p-8">
              <div className="flex items-center gap-3 text-cyan-200">
                <div className="grid h-11 w-11 place-items-center rounded-xl border border-cyan-300/25 bg-cyan-300/[0.07]"><DatabaseIcon /></div>
                <div>
                  <div className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-200/65">Fastest path</div>
                  <h3 className="mt-1 text-2xl font-black uppercase tracking-[-0.03em] text-white">Connect with a League ID</h3>
                </div>
              </div>
              <p className="mt-5 max-w-xl text-sm leading-6 text-[#92a0b2]">
                Enter the ESPN league ID or Sleeper league identifier. FSN fetches available current and historical seasons, maps team identities, and builds the archive automatically.
              </p>
              <div className="mt-6 rounded-2xl border border-white/[0.07] bg-black/20 p-4 font-mono text-xs text-white/55">
                <span className="text-cyan-200">LEAGUE ID</span> 12345678 <span className="mx-2 text-white/20">→</span> SYNC HISTORY
              </div>
            </article>

            <article id="import-sleeper" className="neon-card p-6 sm:p-8">
              <div className="flex items-center gap-3 text-amber-200">
                <div className="grid h-11 w-11 place-items-center rounded-xl border border-amber-300/25 bg-amber-300/[0.07]"><UploadIcon /></div>
                <div>
                  <div className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-200/65">Deep archive path</div>
                  <h3 className="mt-1 text-2xl font-black uppercase tracking-[-0.03em] text-white">Drop an Archive JSON</h3>
                </div>
              </div>
              <p className="mt-5 max-w-xl text-sm leading-6 text-[#92a0b2]">
                Already exported your league history? Drop the JSON archive into FSN to preserve completed seasons, standings, matchups, and historical franchise records in one pass.
              </p>
              <div className="mt-6 rounded-2xl border border-dashed border-amber-200/20 bg-black/20 p-4 text-center text-xs font-black uppercase tracking-[0.14em] text-white/45">
                Drop archive.json here
              </div>
            </article>
          </div>

          <div className="mt-12 overflow-hidden rounded-3xl border border-cyan-300/20 bg-gradient-to-r from-cyan-300/[0.08] via-white/[0.025] to-amber-300/[0.06] p-7 sm:p-10">
            <div className="flex flex-col items-start justify-between gap-7 lg:flex-row lg:items-center">
              <div>
                <div className="text-xs font-black uppercase tracking-[0.2em] text-cyan-200">The payoff</div>
                <h3 className="mt-3 max-w-3xl text-3xl font-black uppercase leading-[0.96] tracking-[-0.04em] sm:text-5xl">
                  Import once. Give the league a permanent memory.
                </h3>
                <p className="mt-4 max-w-2xl text-sm leading-6 text-[#95a3b5] sm:text-base">
                  Every future week sits on top of the same historical foundation — so rivalries, droughts, records, playoff scars, and franchise legacies never disappear between seasons.
                </p>
                <div className="mt-4 text-[11px] font-black uppercase tracking-[0.14em] text-emerald-200">Completely free to use.</div>
              </div>
              <div className="flex w-full shrink-0 flex-col gap-3 sm:w-auto sm:flex-row lg:flex-col xl:flex-row">
                <a href={espnSetupUrl} className="primary-button">Connect ESPN <ArrowIcon /></a>
                <a href={sleeperSetupUrl} className="secondary-button">Connect Sleeper <ArrowIcon /></a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/[0.06] py-8">
        <div className="shell flex flex-col gap-4 text-xs font-bold uppercase tracking-[0.13em] text-white/35 sm:flex-row sm:items-center sm:justify-between">
          <span>FSN · Fantasy Sports Network</span>
          <span>Built for league history, weekly coverage, and franchise legacy.</span>
        </div>
      </footer>
    </main>
  );
}
