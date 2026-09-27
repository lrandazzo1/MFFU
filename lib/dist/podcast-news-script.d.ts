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
import type { PodcastLine } from './podcast-script';
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
 */
export declare function readNewsPayload(db: any, leagueId: string, season: number, week: number): Promise<NewsPayload | null>;
/** ~60 seconds of synthesized speech. 140-160 words is the brief; the
 *  characters follow from it rather than being steered separately. */
export declare const WORD_MIN = 140;
export declare const WORD_MAX = 160;
/** ElevenLabs Flash v2.5 at default settings lands near here for this copy.
 *  Used only to report an estimate, never to pad or trim toward a clock. */
export declare const SPEECH_WORDS_PER_SECOND = 2.5;
/** How far outside the window is not worth a log line. Eight words is about
 *  three seconds of speech. */
export declare const WORD_GRACE = 8;
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
export declare function speakable(markdown: string): string;
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
export declare function weekSeed(leagueId: unknown, season: unknown, week: unknown): number;
/**
 * The performances the body narrates, most decisive first.
 *
 * `decisiveRows()` first — the ones that actually turned a matchup — and only
 * then the wider board, so a week with three game-winners never spends a turn
 * on garbage-time padding. Order inside each group is the math's own news
 * ranking, so it is deterministic for a league-week.
 */
export declare function bodyRows(tracked: TrackedPlayer[], limit: number): TrackedPlayer[];
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
export declare function newsVariants(rows: TrackedPlayer[], seed: number): Array<0 | 1>;
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
export declare function buildNewsPodcastScript(payload: NewsPayload): NewsPodcastScript;
