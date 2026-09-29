/**
 * THE ~60 SECOND NEWS-PAYLOAD RECAP.
 *
 * A second podcast script format, built to answer three complaints about the
 * four-segment one in `lib/podcast-script.ts`: it made a live ESPN call, it
 * lacked depth, and it read the same every week.
 *
 * ---- NO EXTERNAL CALL ----
 *
 * The only input is a payload that already exists locally: one `blog_articles`
 * row for the league, season and week — `tracked_players` (the eight evaluated
 * stat lines the Tuesday article cron already computed and stored), plus that
 * row's `headline` and `match_impact_summary`. Nothing here fetches anything.
 * The box score was read once, by the article pipeline, hours earlier.
 *
 * ---- WHERE THE DEPTH COMES FROM ----
 *
 * Not from new copy. `lib/article-generator.ts` already owns an archetype
 * matrix that reads a performance in context rather than reciting its total:
 * `archetypeFor()` weighs the outcome flag against the deficit the player's
 * team was carrying when he kicked off, the finishing margin, and whether it
 * happened under the lights. So Jaxon Smith-Njigba at 47.5 is not "beat his
 * projection by 28" — his team was 42.5 down before he played and won by 20,
 * which is PRIMETIME_COMEBACK or SINGLE_HANDED_OVERHAUL, and the sentence says
 * so. Nine archetypes, and the flag contract behind them refuses to call a
 * player decisive in a matchup his team lost.
 *
 * ---- WHY IT STOPS READING THE SAME EVERY WEEK ----
 *
 * Each archetype carries TWO phrasings, and `rotateVariants()` seeds the first
 * appearance from the player id and the week, then strictly alternates, so two
 * performances of the same archetype never read alike. Eighteen body shapes in
 * all. The intro and the sign-off draw from their own pools on a
 * league+season+week seed, so the scaffolding moves week to week too — which
 * the fixed single template per slot never did.
 *
 * Determinism is unchanged and non-negotiable: no `Math.random()`, no
 * `Date.now()`, no network, no model. The same payload always produces the same
 * script, which is what lets an episode be regenerated and come out identical.
 */

import type { TrackedPlayer } from './article-math';
import { archetypeFor, boardRows, decisiveRows, sentenceFor } from './article-generator';
import type { PodcastLine } from './podcast-script';

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

/** One `blog_articles` row, as the podcast needs to see it. */
export interface NewsPayload {
  league_id: string;
  season: number;
  week: number;
  /** The article's own headline, when it has one. */
  headline?: string | null;
  /** Its one-sentence impact line. */
  match_impact_summary?: string | null;
  /** The evaluated starters. This is the stats file. */
  tracked_players: TrackedPlayer[];
  /** Cosmetic only; carried through for the episode record. */
  league_name?: string | null;
}

export type NewsMovementKey = 'intro' | 'body' | 'outro';

export interface NewsMovement {
  key: NewsMovementKey;
  /** Seconds this movement is budgeted for. */
  seconds: number;
  words: number;
}

export interface NewsPodcastScript {
  title: string;
  season: number;
  week: number;
  lines: PodcastLine[];
  stories: string[];
  movements: NewsMovement[];
  words: number;
  characters: number;
  /** At SPEECH_WORDS_PER_SECOND. Indicative, not a promise about the MP3. */
  estimatedSeconds: number;
  /** How many performances the body actually narrated. */
  performances: number;
}

/**
 * The week's news payload, straight out of `blog_articles`.
 *
 * This is the whole point of the 'news' format: no live box-score fetch. The
 * Tuesday article cron already read ESPN for this league-week, ran the outcome
 * math, and stored the evaluated starters in `tracked_players` alongside the
 * headline and the impact line. Reading that row is one Supabase select in
 * place of one external API call, and it cannot disagree with the article the
 * league is also reading, because it IS the article's data.
 *
 * Returns null when no row exists — a league whose article has not published
 * yet has no payload, which is an ordinary skip rather than a failure.
 *
 * ---- WHICH ROW, WHEN THERE IS MORE THAN ONE ----
 *
 * A league-week holds up to THREE `blog_articles` rows — the Friday TNF
 * preview, the Monday sweat and the Tuesday verdict — and this read used to
 * take `.limit(1)` with no ordering, which in PostgREST means whichever row
 * the planner reaches first. That is not a tie-break, it is a coin toss, and
 * in the 2026 week 3 data it landed wrong for every league that had more than
 * one row: 57155288 and 405485320 resolved to the FRIDAY PREVIEW, and
 * 1824782664, 2068379125 and 46795714 to the Monday sweat. The Tuesday recap
 * was narrating Friday's "17 starters still to play" as though the week were
 * over, and 1915228840's run failed outright with "narrated nothing" because
 * a preview's tracked starters have no resolved outcomes to narrate.
 *
 * So the row is CHOSEN, in the order a recap wants it:
 *
 *   tuesday_verdict      the Monday night final — the week complete. This is
 *                        the row the Tuesday schedule is built around; the
 *                        podcast run is sequenced after the article cron that
 *                        writes it for exactly this reason.
 *   monday_sweat         the Sunday slate, with Monday night still out. A
 *                        recap missing one game beats no recap.
 *   anything else        last, and the Friday preview is the case that means:
 *                        a week that has not been played. Narratable only
 *                        because refusing would leave a league with nothing,
 *                        and logged when it happens.
 *
 * Ties inside a bucket go to the most recently published row, so the choice is
 * deterministic and never depends on physical row order.
 */

/** Recap preference, lowest number first. An unknown or missing type sorts
 *  with the preview: it is not a row this pipeline knows to be a recap. */
const NEWS_ARTICLE_PREFERENCE: Record<string, number> = {
  tuesday_verdict: 0,
  monday_sweat: 1,
  friday_tnf_preview: 2,
};
const NEWS_ARTICLE_FALLBACK_RANK = 2;

export function preferredNewsArticle<T extends { article_type?: string | null; published_at?: string | null }>(
  rows: T[],
): T | null {
  const rank = (row: T): number => {
    const type = String((row && row.article_type) || '').trim();
    const known = NEWS_ARTICLE_PREFERENCE[type];
    return known == null ? NEWS_ARTICLE_FALLBACK_RANK : known;
  };
  const published = (row: T): number => {
    const value = Date.parse(String((row && row.published_at) || ''));
    return Number.isFinite(value) ? value : 0;
  };
  const ordered = (rows || []).filter(Boolean).slice().sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return published(b) - published(a);
  });
  return ordered[0] || null;
}

export async function readNewsPayload(
  db: any,
  leagueId: string,
  season: number,
  week: number,
): Promise<NewsPayload | null> {
  const result = await db
    .from('blog_articles')
    .select('league_id,season,week,article_type,published_at,headline,title,match_impact_summary,tracked_players')
    .eq('league_id', leagueId)
    .eq('season', season)
    .eq('week', week);
  if (result.error) throw result.error;
  const rows: any[] = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
  const row: any = preferredNewsArticle<any>(rows);
  if (!row) return null;
  const chosenType = String(row.article_type || '').trim();
  if (rows.length > 1) {
    console.info('[Podcast] league ' + leagueId + ' week ' + week + ' has ' + rows.length +
      ' article rows; narrating the ' + (chosenType || 'untyped') + ' one.');
  }
  if (chosenType && NEWS_ARTICLE_PREFERENCE[chosenType] === NEWS_ARTICLE_PREFERENCE.friday_tnf_preview) {
    console.warn('[Podcast] league ' + leagueId + ' week ' + week + ' has no recap article to ' +
      'narrate, only the ' + chosenType + '. The episode will describe a week that has not ' +
      'finished being played.');
  }
  const tracked = Array.isArray(row.tracked_players) ? row.tracked_players : [];
  if (!tracked.length) {
    console.warn('[Podcast] the blog_articles row for league ' + leagueId + ' week ' + week +
      ' carries no tracked_players, so there is nothing to narrate.');
    return null;
  }
  return {
    league_id: String(row.league_id),
    season: Number(row.season),
    week: Number(row.week),
    headline: row.headline || row.title || null,
    match_impact_summary: row.match_impact_summary || null,
    tracked_players: tracked,
  };
}

/* ------------------------------------------------------------------ *
 * The budget
 * ------------------------------------------------------------------ */

/** ~60 seconds of synthesized speech. 140-160 words is the brief; the
 *  characters follow from it rather than being steered separately. */
export const WORD_MIN = 140;
export const WORD_MAX = 160;
/** ElevenLabs Flash v2.5 at default settings lands near here for this copy.
 *  Used only to report an estimate, never to pad or trim toward a clock. */
export const SPEECH_WORDS_PER_SECOND = 2.5;
/** How far outside the window is not worth a log line. Eight words is about
 *  three seconds of speech. */
export const WORD_GRACE = 8;

/** Intro 10s, body 35s, outro 15s. */
const MOVEMENT_SECONDS: Record<NewsMovementKey, number> = { intro: 10, body: 35, outro: 15 };

/** The endpoint refuses a turn over 450 characters. */
const MAX_LINE = 440;

/* ------------------------------------------------------------------ *
 * Speech shaping
 * ------------------------------------------------------------------ */

const words = (text: string): number => String(text || '').trim().split(/\s+/).filter(Boolean).length;

/**
 * A blog sentence, made speakable.
 *
 * `sentenceFor()` is written for markdown: every entity is wrapped in `**` and
 * every figure carries two decimals, because the blog renders bold and a reader
 * scans numbers. Spoken, both are wrong — a voice model reads the asterisks,
 * and "forty seven point five zero" is not how anyone says 47.5. So the bold
 * comes off and a figure keeps at most one decimal, trailing zero dropped.
 *
 * Numbers only, and only where a decimal actually follows digits, so a team
 * called "2022 MVP Season" is left exactly as its manager typed it.
 */
export function speakable(markdown: string): string {
  return String(markdown || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(\d+)\.(\d{1,2})\b/g, (_whole, whole: string, frac: string) => {
      const value = Number(whole + '.' + frac);
      if (!Number.isFinite(value)) return whole + '.' + frac;
      const rounded = Math.round(value * 10) / 10;
      return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    })
    /* "pts" is a reading abbreviation. A voice model either spells it out or
       guesses; say the word. */
    .replace(/\bpts\b/g, 'points')
    .replace(/\bpt\b/g, 'point')
    /* "a 18.1 victory" is correct on the page and wrong in the mouth. The
       indefinite article has to agree with how the NUMBER is spoken, and the
       numbers whose English begins with a vowel are the eights, the elevens and
       the eighteens. The blog templates hardcode "a" because they are read, not
       heard. */
    .replace(/\ba (?=(?:8|11|18)(?:[\d.,]|\b))/g, 'an ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fit(text: string): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_LINE) return clean;
  const cut = clean.slice(0, MAX_LINE);
  const boundary = cut.lastIndexOf(' ');
  return (boundary > 120 ? cut.slice(0, boundary) : cut).replace(/[\s,;:]+$/, '') + '.';
}

const line = (host: 'DAN' | 'STU', text: string): PodcastLine => ({ host, text: fit(text) });

/**
 * A stable seed for the pools and the variant choice.
 *
 * ---- WHY THIS IS FNV-1a PLUS AN AVALANCHE, NOT h = h * 31 + c ----
 *
 * Every consumer of this seed takes it modulo a small number, so what actually
 * gets used is the seed's LOW BITS. A plain polynomial hash makes those bits a
 * near-linear function of the last characters: "…:2026:2" and "…:2026:4" differ
 * by 2 in the final byte and therefore by 2 in the hash, so bit 0 is identical
 * and every variant drawn from it is identical. Weeks two apart produced
 * byte-identical episode bodies — measured, not theorised, on the real week 2
 * payload.
 *
 * The murmur3 finalizer below spreads every input byte across all 32 bits, so
 * bit 0 depends on the whole string and adjacent weeks stop agreeing. Still a
 * pure function of league, season and week: the same week always reproduces the
 * same episode, which the determinism contract requires.
 */
export function weekSeed(leagueId: unknown, season: unknown, week: unknown): number {
  const s = String(leagueId) + ':' + String(season) + ':' + String(week);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/* ------------------------------------------------------------------ *
 * The pools
 * ------------------------------------------------------------------ */

interface Frame {
  week: number;
  /** Performances that turned a matchup. NOT a matchup count: two rows can
   *  belong to one matchup — the game-winner and the valiant loss on the other
   *  side of it — and calling six such rows "six matchups" overstates the week
   *  by exactly the overclaim the outcome contract exists to prevent. */
  decisive: number;
  /** Distinct matchups those decisive performances came from. */
  decisiveMatchups: number;
  /** Distinct matchups on the whole board. */
  matchups: number;
  league: string;
}

/** Dan opens and hands over. Each ends by giving Stu the floor, so the body's
 *  first turn has somewhere to come from. */
const INTROS: Array<(f: Frame) => string> = [
  (f) => `This is the FSN weekly recap, week ${f.week}${f.league}. I am Dan, Stu is across from me, and ` +
    `${f.decisiveMatchups === 1 ? 'one matchup' : f.decisiveMatchups + ' matchups'} turned on a single ` +
    `performance this week. Stu, pick one.`,
  (f) => `Week ${f.week} on the FSN desk${f.league}. ${f.decisive === 1 ? 'One performance' : f.decisive + ' performances'} ` +
    `decided a matchup, and Stu has been waiting all morning to talk about ${f.decisive === 1 ? 'it' : 'them'}.`,
  (f) => `Welcome in, week ${f.week}${f.league}. Dan and Stu, sixty seconds, and ` +
    `${f.decisiveMatchups === 1 ? 'one matchup' : f.decisiveMatchups + ' matchups'} that came down to one name. Stu, you first.`,
  (f) => `Week ${f.week} is in the books${f.league}. ${f.matchups} matchups on the board, ` +
    `${f.decisiveMatchups} of them settled by a single performance. Stu, where are we starting?`,
];

/** Stu closes. Deliberately short: the sign-off rides on the body's last turn. */
const OUTROS: Array<(f: Frame) => string> = [
  (f) => `That is week ${f.week} on the FSN desk. The board does not care how it felt, only how it finished.`,
  (f) => `Week ${f.week}, filed. Somebody in this league is already blaming a kicker for that.`,
  (f) => `That is your week ${f.week}. The numbers are the numbers, and the group chat will handle the rest.`,
  (f) => `Week ${f.week} done. We will see you on the next slate, when half of you will have forgotten this.`,
];

/* ------------------------------------------------------------------ *
 * The body
 * ------------------------------------------------------------------ */

/**
 * The performances the body narrates, most decisive first.
 *
 * `decisiveRows()` first — the ones that actually turned a matchup — and only
 * then the wider board, so a week with three game-winners never spends a turn
 * on garbage-time padding. Order inside each group is the math's own news
 * ranking, so it is deterministic for a league-week.
 */
export function bodyRows(tracked: TrackedPlayer[], limit: number): TrackedPlayer[] {
  const decisive = decisiveRows(tracked || []);
  if (decisive.length >= limit) return decisive.slice(0, limit);
  const rest = boardRows(tracked || [], limit * 2).filter((row) => !decisive.includes(row));
  return [...decisive, ...rest].slice(0, limit);
}

/**
 * The variant for each narrated row, seeded on the league-week HASH.
 *
 * ---- WHY NOT rotateVariants() DIRECTLY ----
 *
 * `rotateVariants()` seeds each archetype's first appearance from
 * `templateVariant(row, week)`, which is `(playerIdDigits + week + occurrence)
 * % 2`. Adding the week only moves the answer by the week's PARITY, so weeks 2
 * and 4 draw the same variant for every row — the body of the episode came out
 * byte-identical two weeks running, which is the "same thing every week"
 * complaint surviving the fix that was supposed to address it. Measured on the
 * real week 2 payload: weeks 2 and 4 produced the same five sentences in the
 * same order.
 *
 * Mixing the full seed in instead means consecutive weeks, and weeks two apart,
 * differ. What is kept from `rotateVariants` is the part that was right: an
 * archetype's occurrences alternate strictly from their seed, so two
 * performances of the same archetype in one episode never read alike.
 *
 * The honest ceiling: two phrasings per archetype is two phrasings. This stops
 * a short cycle, it does not manufacture variety that the copy does not have.
 */
export function newsVariants(rows: TrackedPlayer[], seed: number): Array<0 | 1> {
  const seeds: Record<string, 0 | 1> = {};
  const seen: Record<string, number> = {};
  return rows.map((row, i) => {
    const archetype = String(archetypeFor(row));
    if (seeds[archetype] === undefined) {
      /* A different bit per position, so two archetypes seeded in one episode
         do not both follow bit 0. */
      seeds[archetype] = ((seed >>> (i % 16)) & 1) === 0 ? 0 : 1;
    }
    const occurrence = seen[archetype] || 0;
    seen[archetype] = occurrence + 1;
    return ((seeds[archetype] + occurrence) % 2) === 0 ? 0 : 1;
  });
}

/** One narrated performance, speakable, with its archetype's chosen phrasing. */
function performanceLines(rows: TrackedPlayer[], week: number, seed: number): string[] {
  const variants = newsVariants(rows, seed);
  return rows.map((row, i) => speakable(sentenceFor(row, week, variants[i])));
}

/* ------------------------------------------------------------------ *
 * The script
 * ------------------------------------------------------------------ */

interface Draft {
  lines: PodcastLine[];
  stories: string[];
  performances: number;
  words: number;
}

/**
 * Four turns, strictly alternating so the stitched audio never plays one voice
 * twice in a row, and so synthesis costs four provider calls rather than eight:
 *
 *   1 DAN   intro, and hand over
 *   2 STU   the week's most decisive performance
 *   3 DAN   the next one
 *   4 STU   the last one, with the sign-off riding on the end
 *
 * The sign-off is folded rather than given a turn of its own for the same
 * reason it is in the four-segment script: a separate Stu turn after Stu's
 * body turn stitches into one continuous block of that voice.
 */
function draft(payload: NewsPayload, frame: Frame, count: number): Draft {
  const rows = bodyRows(payload.tracked_players || [], count);
  const seed = weekSeed(payload.league_id, payload.season, payload.week);
  const narrated = performanceLines(rows, frame.week, seed);
  const intro = INTROS[seed % INTROS.length](frame);
  const outro = OUTROS[(seed >>> 8) % OUTROS.length](frame);

  const lines: PodcastLine[] = [line('DAN', intro)];
  narrated.forEach((text, i) => {
    const host: 'DAN' | 'STU' = i % 2 === 0 ? 'STU' : 'DAN';
    const last = i === narrated.length - 1;
    /* The sign-off only rides along when the last narrated turn is Stu's;
       otherwise it would put Dan's voice on Stu's line. With an even number of
       performances the last turn is Dan's, so Stu takes the outro alone — and
       alternation still holds, because Dan spoke immediately before. */
    lines.push(line(host, last && host === 'STU' ? text + ' ' + outro : text));
  });
  if (!narrated.length || lines[lines.length - 1].host !== 'STU') lines.push(line('STU', outro));

  const total = lines.reduce((sum, l) => sum + words(l.text), 0);
  return { lines, stories: narrated.slice(), performances: narrated.length, words: total };
}

/**
 * Build the ~60 second recap from a local news payload.
 *
 * The performance count is chosen by measuring, not guessed: the candidate
 * counts are tried in preference order and the first whose word count lands in
 * the brief's 140-160 window wins. If none does — a week with one flagged
 * performance cannot be stretched to 140 words without inventing something —
 * the closest to the middle of the window is used and the shortfall is
 * reported in `words` rather than padded with filler.
 */
export function buildNewsPodcastScript(payload: NewsPayload): NewsPodcastScript {
  const week = Math.max(1, Number.parseInt(String(payload.week), 10) || 1);
  const season = Number.parseInt(String(payload.season), 10) || 0;
  const tracked = Array.isArray(payload.tracked_players) ? payload.tracked_players : [];
  const leagueName = String(payload.league_name || '').trim();

  const decisive = decisiveRows(tracked);
  const frame: Frame = {
    week,
    decisive: decisive.length,
    decisiveMatchups: new Set(decisive.map((row) => String(row && row.matchup_id))).size,
    matchups: new Set(tracked.map((row) => String(row && row.matchup_id))).size,
    league: leagueName ? ', ' + leagueName : '',
  };

  const candidates = [3, 4, 2, 5, 1];
  let chosen: Draft | null = null;
  let closest: Draft | null = null;
  for (const count of candidates) {
    const attempt = draft(payload, frame, count);
    if (!closest ||
        Math.abs(attempt.words - (WORD_MIN + WORD_MAX) / 2) <
        Math.abs(closest.words - (WORD_MIN + WORD_MAX) / 2)) closest = attempt;
    if (attempt.words >= WORD_MIN && attempt.words <= WORD_MAX) { chosen = attempt; break; }
    /* Asking for more performances than the week has cannot grow the script, so
       stop rather than re-measuring the same draft under a bigger cap. */
    if (attempt.performances < count) continue;
  }
  const built = chosen || (closest as Draft);

  /* A word or two past the window is a fraction of a second of audio and no
     operator needs telling. The performance count is an integer, so some
     payloads simply have no count that lands inside a 20-word window — warn
     only when the miss is big enough to hear. */
  if (!chosen && (built.words < WORD_MIN - WORD_GRACE || built.words > WORD_MAX + WORD_GRACE)) {
    console.warn('[Podcast] The week ' + week + ' news payload for league ' + String(payload.league_id) +
      ' produced ' + built.words + ' words (~' + Math.round(built.words / SPEECH_WORDS_PER_SECOND) +
      's), outside the ' + WORD_MIN + '-' + WORD_MAX + ' target, from ' + built.performances +
      ' narrated performance(s). Reported as built rather than padded with filler.');
  }

  const characters = built.lines.reduce((sum, l) => sum + l.text.length, 0);
  const introWords = words(built.lines[0].text);
  const outroWords = built.lines.length > 1 ? words(built.lines[built.lines.length - 1].text) : 0;

  return {
    title: 'WEEK ' + week + ' RECAP',
    season,
    week,
    lines: built.lines,
    stories: built.stories.length
      ? built.stories
      : [String(payload.headline || 'Week ' + week + ' had no decisive performance')],
    movements: [
      { key: 'intro', seconds: MOVEMENT_SECONDS.intro, words: introWords },
      { key: 'body', seconds: MOVEMENT_SECONDS.body, words: Math.max(0, built.words - introWords - outroWords) },
      { key: 'outro', seconds: MOVEMENT_SECONDS.outro, words: outroWords },
    ],
    words: built.words,
    characters,
    estimatedSeconds: Math.round(built.words / SPEECH_WORDS_PER_SECOND),
    performances: built.performances,
  };
}
