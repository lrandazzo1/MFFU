/**
 * FSN blog article pipeline: box score in, published `blog_articles` row out.
 *
 * The order is fixed and the math leads:
 *
 *   1. fetch the league's box score JSON for the week
 *   2. run `article-math.ts` to assign strict outcome flags
 *   3. compose title / excerpt / markdown against those flags
 *   4. refuse to publish copy the flags do not support
 *   5. write the record to Supabase
 *
 * Step 4 is the reason the module exists. A language model asked to write
 * about fantasy football will call anyone who scored 30 a hero; the flags are
 * the only thing standing between that instinct and a permanent, indexed page
 * claiming a player won a matchup his team lost.
 *
 * Additive by construction: nothing here reads or rewrites the News Desk
 * generators, the historical pipelines, the leagues table, or the existing
 * file-based `landing/content/blog` ingestion. It owns exactly one new table.
 */

import {
  calculatePlayerOutcomeFlags,
  featuredTrackedPlayers,
  type GameSlot,
  type KickoffIndex,
  type OutcomeFlag,
  type TrackedPlayer,
} from './article-math';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type ArticleDay = 'mon' | 'tue' | 'fri';

export type ArticleType = 'monday_sweat' | 'tuesday_verdict' | 'friday_tnf_preview';

export interface GenerateInput {
  league_id: string;
  season: number;
  week: number;
  day: ArticleDay;
}

/** What gets persisted. Mirrors `supabase/blog_articles.sql` column for column. */
export interface BlogArticleRecord {
  league_id: string;
  slug: string;

  /* The three tiers a card reads in order, plus its meta line. Written
     alongside the legacy `title` / `content_markdown` below, never instead of
     them: the static blog build and any client older than the three-tier
     layout read those, and the table declares both NOT NULL. */
  headline: string;
  match_impact_summary: string;
  content: string;
  category: string;
  author: string;

  title: string;
  excerpt: string;
  content_markdown: string;
  article_type: ArticleType;
  season: number;
  week: number;
  /** Trimmed to the four contract fields the schema promises, plus the
   *  evidence a reader can check the flag against. */
  tracked_players: TrackedPlayer[];
  published_at: string;
}

export interface ComposeRequest {
  system_prompt: string;
  user_prompt: string;
  league_id: string;
  season: number;
  week: number;
  day: ArticleDay;
  article_type: ArticleType;
  tracked_players: TrackedPlayer[];
  /** Every starter the math evaluated, not just the featured rows that get
   *  persisted. A preview is a story about MATCHUPS, and the eight featured
   *  rows are scattered across six of them, so a head to head cannot be
   *  reconstructed from `tracked_players` alone. Optional: a composer written
   *  before this field falls back to the featured rows. */
  all_players?: TrackedPlayer[];
  /** The publication clock, in epoch milliseconds.
   *
   *  A preview covers a week that has usually already started: the Thursday
   *  night game is played the evening before the Friday run. Without a clock a
   *  composer cannot tell a projection apart from a result, so it is passed in
   *  rather than read from `Date.now()` inside the composer. Injected for the
   *  same reason `GenerateDependencies.now` is: a given box score plus a given
   *  clock must always compose the same article. */
  now?: number;
}

export interface ArticleDraft {
  title: string;
  excerpt: string;
  content_markdown: string;
  /** Tier 2: the one line callout under the headline. Optional so a composer
   *  written before the three-tier layout still satisfies the type; the
   *  pipeline derives one from the math when a composer omits it, and never
   *  from the composer's prose. */
  match_impact_summary?: string;
  /** The editorial shelf. Defaults to the one this article type belongs to. */
  category?: string;
  /** The byline. Defaults to the desk. */
  author?: string;
}

export type Composer = (request: ComposeRequest) => ArticleDraft | Promise<ArticleDraft>;

export interface GenerateDependencies {
  /** Supabase client. Defaults to a service-role client from the environment. */
  db?: any;
  /** Box score source. Defaults to the ESPN read boundary in `api/espn`. */
  fetchBoxScores?: (input: GenerateInput & { req?: any }) => Promise<any>;
  /** Kickoff times by NFL team for this week. Defaults to the public NFL
   *  scoreboard, the same feed the push dispatcher reads. Without it the math
   *  cannot place a starter's points in time and reports no outcome flags. */
  fetchKickoffs?: (input: { season: number; week: number }) => Promise<KickoffIndex>;
  /** Copy writer. Defaults to the deterministic local composer below, so the
   *  pipeline runs end to end with no model credentials configured. */
  compose?: Composer;
  /** Incoming HTTP request, forwarded to the default ESPN reader for its
   *  cookie / share-token boundary. */
  req?: any;
  /** Publication clock. Injected so tests get a fixed `published_at`. */
  now?: () => number;
}

export interface GenerateResult {
  record: BlogArticleRecord;
  tracked_players: TrackedPlayer[];
  /** Every starter the math looked at, not just the featured ones. */
  evaluated: number;
  stored: boolean;
  /** How many NFL teams the kickoff index covered. Zero means the scoreboard
   *  could not be read and every margin in this article is unresolved, which
   *  is worth seeing in a cron summary rather than inferring from the copy. */
  kickoffs: number;
}

/* ------------------------------------------------------------------ *
 * Contract constants
 * ------------------------------------------------------------------ */

export const ARTICLE_TYPE_BY_DAY: Record<ArticleDay, ArticleType> = {
  mon: 'monday_sweat',
  tue: 'tuesday_verdict',
  fri: 'friday_tnf_preview',
};

const DAY_SLUG: Record<ArticleDay, string> = {
  mon: 'monday-sweat',
  tue: 'tuesday-verdict',
  fri: 'friday-tnf-preview',
};

/**
 * The framing rule, verbatim. It is handed to the model as a system
 * instruction AND enforced after the fact by `assertOutcomeLanguage`, because
 * an instruction a model can ignore is not a guarantee.
 */
export const OUTCOME_FRAMING_RULE =
  "NEVER call a player a hero or game-saver unless outcome_flag == 'GAME_WINNER'. " +
  "Frame 'VALIANT_LOSS' as a wasted monster game, and 'GARBAGE_TIME_BLOWOUT' as unneeded stat-padding.";

/** House copy rule inherited from `scripts/build-blog.mjs`: em dashes never
 *  ship. Clauses break on periods, commas, or colons. */
const BANNED_CHARS = /[—―]/;

/** Language that asserts a player personally delivered the win. Permitted only
 *  when the math says GAME_WINNER. */
const HERO_TERMS =
  /\b(?:heroe?s?|heroic(?:s|ally)?|game[-\s]?sav(?:er|ing|iour|ior)|sav(?:ed|es|ing) (?:the )?(?:day|week|season|matchup)|bail(?:ed|s) (?:out|them out)|single[-\s]?handedly|rescued|won it (?:alone|by himself)|carried them to (?:a|the) (?:win|victory))\b/i;

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const fail = (message: string, status = 400): Error =>
  Object.assign(new Error(message), { status });

export function normalizeInput(input: GenerateInput): GenerateInput {
  const league_id = (input && input.league_id == null ? '' : String(input.league_id)).trim();
  const season = Number(input && input.season);
  const week = Number(input && input.week);
  const day = String(input && input.day) as ArticleDay;

  if (!league_id || league_id.length > 64 || !/^[A-Za-z0-9._-]+$/.test(league_id)) {
    throw fail('Invalid league_id for blog article generation');
  }
  if (!Number.isInteger(season) || season < 1990 || season > 2100) {
    throw fail('Invalid season for blog article generation');
  }
  if (!Number.isInteger(week) || week < 1 || week > 18) {
    throw fail('Invalid week for blog article generation');
  }
  if (!Object.prototype.hasOwnProperty.call(ARTICLE_TYPE_BY_DAY, day)) {
    throw fail("Invalid day for blog article generation (expected 'mon', 'tue' or 'fri')");
  }
  return { league_id, season, week, day };
}

/** Deterministic and unique: one article per league, season, week and day. A
 *  re-run overwrites its own row instead of stacking duplicates. */
export function articleSlug(input: GenerateInput): string {
  const { league_id, season, week, day } = normalizeInput(input);
  return `${season}-week-${week}-${DAY_SLUG[day]}-${league_id.toLowerCase()}`;
}

/* ------------------------------------------------------------------ *
 * Prompting
 * ------------------------------------------------------------------ */

const FLAG_GUIDANCE: Record<OutcomeFlag, string> = {
  GAME_WINNER:
    'He actually won the matchup: his team trailed before his game and led after it, by no more than he scored. ' +
    'This is the only flag that earns hero language.',
  GARBAGE_TIME_BLOWOUT:
    'The matchup was already decided by more than 20 points before he played and finished that way. ' +
    'Frame the performance as unneeded stat-padding.',
  VALIANT_LOSS:
    'He scored more than 20 and his team still lost. Frame it as a wasted monster game.',
  DUD_COST_WIN:
    'His team led before he played, lost by the end, and he finished more than 5 points under his projection. ' +
    'Frame it as a dud that cost a win in hand.',
};

export function buildSystemPrompt(articleType: ArticleType): string {
  return [
    'You write the Fantasy Sports Network league blog. You are given fantasy box score facts that have',
    'already been resolved by a math layer. Those facts are the truth of the article and you may not',
    'contradict, soften, or embellish them.',
    '',
    OUTCOME_FRAMING_RULE,
    '',
    'Rules:',
    '- Every claim about who won, lost, or decided a matchup must come from outcome_flag, entering_margin',
    '  and final_margin. Never infer a swing from a raw point total.',
    '- A player with outcome_flag null did nothing decisive. Report his number and move on.',
    '- Cite real numbers from the facts. Do not invent stats, injuries, or quotes.',
    '- No em dashes. Break clauses with periods, commas, or colons.',
    `- Article type: ${articleType}.`,
    ...(articleType === 'friday_tnf_preview'
      ? [
          '- This preview covers a week that is usually already underway. Points on the board outrank every',
          '  projection: report what was scored as a result, report a projection as a projection, and never',
          '  present one as the other.',
          '- Write matchup storylines. Never list starters and projections one line per player.',
          '- A margin mid week is the CURRENT margin, not a final one. Do not call a matchup decided until',
          '  every starter on both sides has played.',
        ]
      : []),
  ].join('\n');
}

export function buildUserPrompt(request: Omit<ComposeRequest, 'system_prompt' | 'user_prompt'>): string {
  const lines = [
    `League ${request.league_id}, ${request.season} season, week ${request.week}.`,
    `Article type: ${request.article_type}.`,
    '',
    'Resolved facts, one line per tracked player:',
  ];
  /* Only stated when a clock came with the request. Derived from points alone
     the state is a guess, and a guess in a facts block is worse than a gap. */
  const clocked = Number.isFinite(Number(request.now));
  for (const row of request.tracked_players) {
    lines.push(
      `- ${row.player_name} (${row.owner_team}, vs ${row.opponent_team || 'bye'}, ${row.slot}): ` +
        `${row.player_points} pts` +
        (row.projected_points == null ? '' : ` on a ${row.projected_points} projection`) +
        `, entering_margin ${row.entering_margin == null ? 'unknown' : row.entering_margin}` +
        `, final_margin ${row.final_margin == null ? 'unknown' : row.final_margin}` +
        `, outcome_flag ${row.outcome_flag == null ? 'null' : row.outcome_flag}` +
        (clocked ? `, game ${liveStateOf(row, request.now)}` : '') +
        (row.unresolved_reason ? ` (unresolved: ${row.unresolved_reason})` : ''),
    );
  }
  const flags = new Set(request.tracked_players.map((row) => row.outcome_flag).filter(Boolean) as OutcomeFlag[]);
  if (flags.size) {
    lines.push('', 'Framing required by the flags present:');
    for (const flag of flags) lines.push(`- ${flag}: ${FLAG_GUIDANCE[flag]}`);
  }
  /* A preview is about matchups, so the model is handed the same head to head
     state the local composer works from rather than being left to reassemble
     it out of a ranked list of starters. */
  if (request.article_type === 'friday_tnf_preview') {
    const slate = request.all_players && request.all_players.length
      ? request.all_players
      : request.tracked_players;
    const matchups = orderPreviewMatchups(previewMatchups(slate, request.now));
    if (matchups.length) {
      lines.push('', 'Matchup state, one line per head to head:');
      for (const m of matchups) {
        lines.push(
          `- ${m.a.team} vs ${m.b.team}: ` +
            `projected ${m.a.projected == null ? 'unknown' : num2(m.a.projected)} to ` +
            `${m.b.projected == null ? 'unknown' : num2(m.b.projected)}` +
            `, scored so far ${num2(m.a.scored)} to ${num2(m.b.scored)}` +
            `, margin now ${m.margin == null ? 'unresolved' : num2(m.margin)}` +
            `, ${m.remaining} ${m.remaining === 1 ? 'starter' : 'starters'} still to play`,
        );
      }
      lines.push(
        '',
        'Lead with what has already happened. Build the article out of these matchups, not out of the',
        'player list above, and never write a line of the form "player starts for team on a projection".',
      );
    }
  }

  lines.push('', 'Return a title, a one sentence excerpt, and the article body in markdown.');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * The guardrail
 * ------------------------------------------------------------------ */

/**
 * Reject a draft whose copy overclaims. Checked sentence by sentence so the
 * test is about the player being praised, not about the article containing the
 * word "hero" somewhere.
 *
 * Throws rather than editing: silently rewriting a model's sentence produces
 * copy nobody reviewed, and a thrown error means the row is never written.
 */
export function assertOutcomeLanguage(draft: ArticleDraft, tracked: TrackedPlayer[]): void {
  const winners = tracked.filter((row) => row.outcome_flag === 'GAME_WINNER');
  const winnerNames = winners.map((row) => row.player_name).filter(Boolean);

  /* The impact summary is copy like any other and is checked with the rest of
     it. A callout is the most prominent line on the card after the headline,
     so it is the last place an unbacked hero claim should be able to slip
     through. */
  const prose = `${draft.title}. ${draft.excerpt}. ${draft.match_impact_summary || ''}. ${draft.content_markdown}`;
  if (BANNED_CHARS.test(prose)) {
    throw fail('Blog article copy contains a banned em dash', 422);
  }

  const sentences = prose.split(/(?<=[.!?:])\s+|\n+/);
  for (const sentence of sentences) {
    if (!HERO_TERMS.test(sentence)) continue;
    const credited = winnerNames.some((name) => sentence.includes(name));
    if (!credited) {
      throw fail(
        'Blog article copy calls a player a hero or game-saver without a GAME_WINNER flag: ' +
          JSON.stringify(sentence.trim().slice(0, 200)),
        422,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Default composer
 *
 * Deterministic: no model, no clock, no randomness. Its job is to keep the
 * pipeline honest and runnable without credentials, and to be the reference
 * for what compliant framing reads like.
 * ------------------------------------------------------------------ */

/**
 * What the Friday article calls itself.
 *
 * "Friday Night Preview" was wrong twice over. The Friday run happens the
 * MORNING AFTER Thursday night, so by the time it publishes the TNF game has
 * been played and the article is a breakdown of it, not a preview of it. And
 * the NFL plays no Friday night games at all, so the name promised a slate
 * that does not exist.
 *
 * The label therefore follows the board rather than the calendar. Points on it
 * mean Thursday night has been played and the headline says so; an empty board
 * means nothing has kicked off yet and it really is a preview. The
 * `friday_tnf_preview` article_type is untouched: it is a stored enum with a
 * CHECK constraint on it in `supabase/blog_articles.sql`, three read routes
 * mapping it, and every published row keyed by it. Renaming a headline is not
 * a reason to migrate a column.
 */
const TNF_BREAKDOWN_LABEL = 'TNF Breakdown';
const TNF_PREVIEW_LABEL = 'Thursday Night Preview';

const TITLE_BY_TYPE: Record<ArticleType, string> = {
  monday_sweat: 'Monday Sweat',
  tuesday_verdict: 'Tuesday Verdict',
  /* The default. `composePreview` picks between this and TNF_PREVIEW_LABEL on
     whether anything has actually been played. */
  friday_tnf_preview: TNF_BREAKDOWN_LABEL,
};

const pts = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(2));

/** "an 8 point projection", not "a 8 point projection". English reads the
 *  number, so the article is chosen from how the figure is spoken: 8, 11, and
 *  18 take "an", everything else takes "a". */
function article(value: number): string {
  const spoken = pts(value);
  return /^(?:8|11|18)(?:\.|$)/.test(spoken) ? 'an' : 'a';
}

/* Bold markdown for the three things a reader scans a bullet for: who, which
   team, and the number. `lbMarkdown()` in index.html renders `**x**` as
   <strong>, and its pattern is `\*\*([^*]+)\*\*`, so a value containing an
   asterisk simply would not embolden rather than corrupting the line. */
const b = (value: string | number): string => `**${value}**`;

/* ------------------------------------------------------------------ *
 * The archetype matrix
 *
 * A bullet used to be one sentence per flag: four shapes for the whole
 * league, every week, so a board of four game-winners printed the same
 * sentence four times with the nouns swapped. The matrix splits each flag by
 * the numbers that actually distinguish one performance from another, and
 * gives every case two phrasings.
 *
 * The triggers are evaluated TOP TO BOTTOM and the first match wins, so the
 * order below is the specification: a prime-time comeback is a comeback
 * first, a razor-thin win outranks a rout, and the general swing is what is
 * left when nothing more specific is true.
 *
 * Everything here is still derived from the flag and the margins. No
 * archetype claims more than `assertOutcomeLanguage` allows, and the three
 * that credit a player with winning a matchup all require the GAME_WINNER
 * flag to have been assigned by the math.
 * ------------------------------------------------------------------ */

export type Archetype =
  | 'PRIMETIME_COMEBACK'
  | 'RAZOR_THIN_COMEBACK'
  | 'SINGLE_HANDED_OVERHAUL'
  | 'HEAVYWEIGHT_BLOWOUT'
  | 'WASTED_ERUPTION'
  | 'HEARTBREAK_LOSS'
  | 'NECESSARY_INSURANCE'
  | 'STRAIGHT_COMEBACK'
  | 'GENERAL_SWING';

/** Two decimals, always. The matrix quotes deficits and margins against each
 *  other constantly, and "trailed by 4 and finished 58.86 clear" reads as two
 *  different kinds of number. */
const num2 = (value: number): string => Number(value).toFixed(2);

/** The prime-time windows. A comeback completed here is the one every league
 *  chat is still arguing about on Tuesday. */
const PRIMETIME: GameSlot[] = ['SNF', 'MNF'];

/** How far behind the player's team was when his game kicked off, as a
 *  positive number. Zero when they were level or ahead. */
function deficitOf(row: TrackedPlayer): number {
  const entering = Number(row.entering_margin);
  return Number.isFinite(entering) && entering < 0 ? Math.abs(entering) : 0;
}

/** The finishing margin as a positive number, whichever side it fell. */
function marginOf(row: TrackedPlayer): number {
  const final = Number(row.final_margin);
  return Number.isFinite(final) ? Math.abs(final) : 0;
}

/**
 * The first archetype whose trigger the row satisfies.
 *
 * Note that PRIMETIME_COMEBACK requires the GAME_WINNER flag and not merely
 * "trailed, then won". Its copy credits the player with erasing the deficit,
 * and only the flag establishes that his own points covered it. Without that
 * check a team could come back on somebody else's points and this would hand
 * the credit to whoever happened to play last, which is the exact overclaim
 * the outcome contract exists to prevent.
 */
export function archetypeFor(row: TrackedPlayer): Archetype {
  const flag = row.outcome_flag;
  const deficit = deficitOf(row);
  const margin = marginOf(row);
  const points = Number(row.player_points) || 0;
  const primetime = PRIMETIME.includes(row.slot);

  // 1. A comeback finished under the lights.
  if (flag === 'GAME_WINNER' && primetime && deficit > 0 && margin > 0) return 'PRIMETIME_COMEBACK';
  // 2. A comeback that came down to a field goal.
  if (flag === 'GAME_WINNER' && margin <= 3) return 'RAZOR_THIN_COMEBACK';
  // 3. A comeback that overshot the deficit by half again or more.
  if (flag === 'GAME_WINNER' && deficit > 0 && points >= deficit * 1.5) return 'SINGLE_HANDED_OVERHAUL';
  // 4. Padding that turned a win into a demolition.
  if (flag === 'GARBAGE_TIME_BLOWOUT' && margin >= 25) return 'HEAVYWEIGHT_BLOWOUT';
  // 5. A huge number in a loss.
  if (flag === 'VALIANT_LOSS' && points >= 35) return 'WASTED_ERUPTION';
  // 6. A loss by a field goal or less.
  if (flag === 'VALIANT_LOSS' && margin <= 3) return 'HEARTBREAK_LOSS';
  // 7. Padding that kept a win comfortable rather than embarrassing.
  if (flag === 'GARBAGE_TIME_BLOWOUT' && margin >= 5 && margin < 25) return 'NECESSARY_INSURANCE';
  /* 8. Any other comeback. The most common game-winner there is: not in prime
     time, not down to a field goal, not an overshoot. It used to fall to the
     general swing and read "notched 47.50 pts, shifting the final tally",
     which describes a non-event while the headline calls it a result that
     turned and the callout names him the decisive man.

     `deficit > 0` is required even though GAME_WINNER already implies a
     negative entering margin: the copy says "erased a deficit", and a row
     carrying the flag with no deficit recorded would print "erased a 0.00
     deficit". Such a row is math-inconsistent rather than ordinary, so it
     falls through to the general swing rather than claiming a comeback. */
  if (flag === 'GAME_WINNER' && deficit > 0) return 'STRAIGHT_COMEBACK';
  return 'GENERAL_SWING';
}

interface Phrasing {
  player: string;
  team: string;
  opponent: string;
  points: string;
  deficit: string;
  margin: string;
}

type Template = (p: Phrasing) => string;

/* Two phrasings per archetype. Strictly no em dashes: `assertOutcomeLanguage`
   throws on one and scripts/build-blog.mjs rejects the whole file, so clauses
   are broken with colons, commas and periods, which is what that check's own
   failure message prescribes. */
const TEMPLATES: Record<Archetype, [Template, Template]> = {
  PRIMETIME_COMEBACK: [
    (p) => `${p.player} slammed the door on ${p.opponent} in prime time, dropping ${p.points} to erase a ` +
      `${p.deficit} deficit and steal a ${p.margin} point win for ${p.team}.`,
    (p) => `Trailing by ${p.deficit} in the final window, ${p.team} rode a ${p.points} masterpiece from ` +
      `${p.player} to snatch a ${p.margin} victory.`,
  ],
  RAZOR_THIN_COMEBACK: [
    (p) => `${p.player} delivered a heart-stopping finish for ${p.team}, putting up ${p.points} to overcome ` +
      `a ${p.deficit} deficit by a razor-thin ${p.margin}.`,
    (p) => `In a wire-to-wire thriller, ${p.player} provided the decisive ${p.points} needed for ${p.team} ` +
      `to escape with a ${p.margin} win over ${p.opponent}.`,
  ],
  SINGLE_HANDED_OVERHAUL: [
    (p) => `${p.player} did not just cover the ${p.deficit} deficit for ${p.team}: their ${p.points} ` +
      `explosion blew the matchup wide open for a ${p.margin} victory.`,
    (p) => `${p.team} needed ${p.deficit} points to survive; ${p.player} dropped ${p.points}, turning a ` +
      `close chase into a ${p.margin} rout.`,
  ],
  HEAVYWEIGHT_BLOWOUT: [
    (p) => `Pouring salt in the wound, ${p.player} tacked on ${p.points} for ${p.team}, extending an already ` +
      `comfortable lead into a ${p.margin} demolition of ${p.opponent}.`,
    (p) => `${p.team} already had it wrapped up, but ${p.player} padded the score with ${p.points} to cement ` +
      `a massive ${p.margin} blowout.`,
  ],
  WASTED_ERUPTION: [
    (p) => `${p.player} erupted for ${p.points} for ${p.team}, but a lack of roster support led to a brutal ` +
      `${p.margin} defeat.`,
    (p) => `A career-day performance wasted: ${p.player} dropped ${p.points}, but ${p.team} still came up ` +
      `${p.margin} short.`,
  ],
  HEARTBREAK_LOSS: [
    (p) => `${p.player} rallied ${p.team} with ${p.points}, but they ran out of time, falling short by just ` +
      `${p.margin}.`,
    (p) => `Despite a valiant ${p.points} effort from ${p.player}, ${p.team} ended up on the wrong side of a ` +
      `${p.margin} heartbreaker.`,
  ],
  NECESSARY_INSURANCE: [
    (p) => `${p.player} provided the knockout blow for ${p.team}, scoring ${p.points} to lock down a safe ` +
      `${p.margin} win.`,
    (p) => `Securing the perimeter, ${p.player} added ${p.points} to ensure ${p.team} kept ${p.opponent} at ` +
      `bay by ${p.margin}.`,
  ],
  STRAIGHT_COMEBACK: [
    (p) => `${p.player} erased a ${p.deficit} deficit with ${p.points} to secure a ${p.margin} point win ` +
      `for ${p.team}.`,
    (p) => `${p.team} were ${p.deficit} down when ${p.player} took the field; his ${p.points} flipped the ` +
      `matchup into a ${p.margin} win over ${p.opponent}.`,
  ],
  GENERAL_SWING: [
    (p) => `${p.player} notched ${p.points} for ${p.team}, shifting the final tally to a ${p.margin} finish.`,
    (p) => `A key contribution from ${p.player} (${p.points}) helped shape ${p.team}'s ${p.margin} outcome.`,
  ],
};

/**
 * Which of the two phrasings this row gets:
 * `(player id + week + rotation index) % 2`.
 *
 * Deterministic, which the whole pipeline requires: a reader who reloads must
 * get the same article. The player id keeps a given player from reading the
 * same way regardless of where he lands, and the week stops him reading
 * identically every week of the season.
 *
 * This is the SEED for an archetype's first appearance. `rotateVariants()`
 * below alternates from it, because adding an index to this sum cannot
 * guarantee anything on its own: see the note there.
 *
 * `player_id` is an ESPN numeric id in practice, but `article-math.ts` falls
 * back to the player's NAME when a payload carries no id, so a non-numeric id
 * is hashed rather than dropped. Coercing it to 0 would hand every unnamed
 * row variant A.
 */
export function templateVariant(row: TrackedPlayer, week: number, occurrence = 0): 0 | 1 {
  const raw = String(row.player_id == null ? '' : row.player_id);
  const digits = raw.replace(/\D/g, '');
  let key: number;
  if (digits) {
    key = Number(digits.slice(-9));
  } else {
    key = 0;
    for (let i = 0; i < raw.length; i++) key = (key * 31 + raw.charCodeAt(i)) % 1000000007;
  }
  const sum = key + (Number(week) || 0) + (Number(occurrence) || 0);
  return (((sum % 2) + 2) % 2) === 0 ? 0 : 1;
}

/**
 * The phrasing to use for every row of a board, guaranteeing that two bullets
 * of the same archetype never read the same way.
 *
 * ---- WHY THIS IS NOT JUST `(id + week + index) % 2` ----
 *
 * The only repetition a reader notices is two bullets of the SAME archetype
 * reading alike; two different archetypes are different sentences whichever
 * variant they draw. Adding an index to the per-row sum cannot guarantee that
 * pair differs, because a difference in id parity simply cancels it. Both
 * shapes of index were measured against a real week 2 board of four
 * game-winners:
 *
 *   board position      CeeDee Lamb (row 1) and Dak Prescott (row 3) are two
 *                       apart, so their indices share a parity and their odd
 *                       ids share one too: both flipped together, both stayed
 *                       identical. 3 distinct shapes of 4.
 *   archetype occurrence  fixed that pair, and broke the other one: Davante
 *                       Adams (even id, occurrence 0) and Patrick Mahomes
 *                       (odd id, occurrence 1) cancelled to the same variant.
 *                       Still 3 of 4.
 *
 * So the id seeds each archetype's FIRST appearance and the rest alternate
 * strictly from there. Consecutive appearances then differ by construction
 * rather than by arithmetic luck, while the seed keeps the choice varying by
 * player and by week. 4 of 4 on the same board.
 */
export function rotateVariants(board: TrackedPlayer[], week: number): Array<0 | 1> {
  const seeds: Partial<Record<Archetype, 0 | 1>> = {};
  const seen: Partial<Record<Archetype, number>> = {};
  return board.map((row) => {
    const archetype = archetypeFor(row);
    if (seeds[archetype] === undefined) seeds[archetype] = templateVariant(row, week);
    const occurrence = seen[archetype] || 0;
    seen[archetype] = occurrence + 1;
    return (((seeds[archetype] as number) + occurrence) % 2) === 0 ? 0 : 1;
  });
}

/**
 * One row, framed by its archetype.
 *
 * Every entity is emboldened: the player, both fantasy teams, the points (with
 * "pts"), and the deficit and margin as two-decimal figures. `lbMarkdown()` in
 * index.html renders `**x**` as <strong>, and its pattern is
 * `\*\*([^*]+)\*\*`, so a value containing an asterisk simply would not
 * embolden rather than corrupting the line.
 *
 * Exported because it IS the framing contract: `OUTCOME_FRAMING_RULE` tells a
 * model what compliant copy reads like, and this is the executable version of
 * the same thing.
 */
export function sentenceFor(
  row: TrackedPlayer,
  week = 0,
  variant: 0 | 1 = templateVariant(row, week),
): string {
  const archetype = archetypeFor(row);
  const phrasing: Phrasing = {
    player: b(row.player_name),
    team: b(row.owner_team),
    opponent: b(row.opponent_team || 'their opponent'),
    points: b(num2(Number(row.player_points) || 0) + ' pts'),
    deficit: b(num2(deficitOf(row))),
    margin: b(num2(marginOf(row))),
  };
  return TEMPLATES[archetype][variant](phrasing);
}

/* ------------------------------------------------------------------ *
 * Which performances make the board
 * ------------------------------------------------------------------ */

/** At most this many bullets under "What the math says". A recap that lists
 *  every starter is a table, not a story, and the eight-row version buried the
 *  one result that actually turned. */
const MAX_BOARD_ROWS = 4;

/**
 * The bullets, in the order they earn their place.
 *
 *   GAME_WINNER   a matchup was won by this performance
 *   DUD_COST_WIN  a matchup in hand was thrown away by one
 *   VALIANT_LOSS  a big score that changed nothing
 *
 * GARBAGE_TIME_BLOWOUT comes LAST, so it fills a remaining slot rather than
 * competing for one. The old single blowout sentence was cut from the board
 * for being filler: one bland line repeated as many times as the week had
 * blowouts. The archetype matrix gives that flag two distinct readings
 * (HEAVYWEIGHT_BLOWOUT and NECESSARY_INSURANCE) chosen on the finishing
 * margin, so it is worth a bullet again when nothing more decisive is
 * competing for it, and the four-row cap still stops a week of padding from
 * taking the board over.
 *
 * Unflagged rows are dropped outright. "Notched 22 pts, shifting the final
 * tally to a 30 point finish" is a line about a player who did not decide
 * anything.
 *
 * Within a flag the math's own news ranking is preserved, so the board is
 * deterministic for a given league, season and week.
 */
const DECISIVE_PRIORITY: OutcomeFlag[] = ['GAME_WINNER', 'DUD_COST_WIN', 'VALIANT_LOSS'];
const BOARD_PRIORITY: OutcomeFlag[] = [...DECISIVE_PRIORITY, 'GARBAGE_TIME_BLOWOUT'];

/** The rows that actually turned a matchup. What the headline counts, and
 *  what the callout is allowed to choose from. */
export function decisiveRows(rows: TrackedPlayer[]): TrackedPlayer[] {
  return rows.filter((row) => row.outcome_flag != null &&
    DECISIVE_PRIORITY.includes(row.outcome_flag));
}

export function boardRows(rows: TrackedPlayer[], limit = MAX_BOARD_ROWS): TrackedPlayer[] {
  const out: TrackedPlayer[] = [];
  for (const flag of BOARD_PRIORITY) {
    for (const row of rows) {
      if (row.outcome_flag !== flag) continue;
      out.push(row);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Live week awareness
 *
 * A Friday preview that ignores Thursday night is a preview of a week that
 * has already started. The Thursday game is played the evening BEFORE the
 * Friday run, so by the time the article is written there are real points on
 * the board, and the old preview ignored every one of them: it printed the
 * pre-game projection for eight starters and called it a slate.
 *
 * Three windows are all a composer needs to tell a projection apart from a
 * result:
 *
 *   PENDING  his game has not kicked off. The projection is all there is.
 *   LIVE     his game is running. His points are real but not finished.
 *   FINAL    his game is over. His points are the number.
 *
 * The clock is INJECTED (`ComposeRequest.now`) and never read from `Date.now()`
 * inside the composer, so a given box score plus a given clock always compose
 * the same article and the self-tests can pin both.
 * ------------------------------------------------------------------ */

export type LiveState = 'PENDING' | 'LIVE' | 'FINAL' | 'UNKNOWN';

/** How long after kickoff a game is still treated as running. Four hours
 *  covers regulation, overtime, and the stat corrections that trail a game.
 *  Erring long is the safe direction: calling a finished game LIVE understates
 *  a number that is already settled, while calling a running game FINAL
 *  asserts a result that can still move. */
export const GAME_WINDOW_MS = 4 * 60 * 60 * 1000;

export function liveStateOf(row: TrackedPlayer, now?: number | null): LiveState {
  const kickoff = Number(row && row.kickoff);
  /* `Number(null)` is 0, not NaN, and 0 is a finite clock sitting in 1970 that
     reports every game in the season PENDING. An absent clock has to be
     rejected before it is coerced. */
  const clock = now == null ? Number.NaN : Number(now);
  if (Number.isFinite(clock) && Number.isFinite(kickoff) && kickoff > 0) {
    if (clock < kickoff) return 'PENDING';
    return clock < kickoff + GAME_WINDOW_MS ? 'LIVE' : 'FINAL';
  }
  /* No clock, or no kickoff on this row. A starter carrying points has
     demonstrably been on the field; one carrying none cannot be shown to have
     played. LIVE rather than FINAL, because nothing available here
     establishes that his game is over, and FINAL is the claim that costs. */
  if ((Number(row && row.player_points) || 0) > 0) return 'LIVE';
  return 'UNKNOWN';
}

/** Whether this starter's points are on the board yet. */
export function hasPlayed(row: TrackedPlayer, now?: number | null): boolean {
  const state = liveStateOf(row, now);
  return state === 'LIVE' || state === 'FINAL';
}

/** Fantasy scoring carries two decimals. Keep the sums there so a running
 *  total never arrives as 41.900000000000006. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** How the copy names a kickoff window. Each reads correctly both as "in X
 *  window" and as "when X window opened". */
const WINDOW_PHRASE: Record<GameSlot, string> = {
  TNF: 'the Thursday night',
  SUNDAY: 'the Sunday afternoon',
  SNF: 'the Sunday night',
  MNF: 'the Monday night',
  SPECIAL: 'the special',
  UNKNOWN: 'the opening',
};

/* ------------------------------------------------------------------ *
 * The matchup board
 *
 * The math hands back one row per starter. A preview is a story about the
 * twelve teams playing each other, so the rows are regrouped into the head to
 * head pairs they came from, and every number the copy quotes is a sum or a
 * margin off that pairing rather than a line item lifted from a list.
 * ------------------------------------------------------------------ */

export interface PreviewSide {
  team: string;
  starters: TrackedPlayer[];
  /** Starters whose games have begun, and those still to kick off. */
  played: TrackedPlayer[];
  pending: TrackedPlayer[];
  /** Sum of the projections the payload carried. Null when it carried none:
   *  zero would read as "projected to score nothing", which is a claim. */
  projected: number | null;
  /** Points already banked by the starters whose games have begun. */
  scored: number;
  /** This side's CURRENT matchup margin, summed off the board rather than read
   *  from the payload's side total. Positive is a lead, null before anyone has
   *  played. Mid week it is a running number, which is why nothing below calls
   *  it final.
   *
   *  ---- WHY NOT `final_margin` ----
   *
   *  `TrackedPlayer.final_margin` is `side.total - opponent.total`, and ESPN's
   *  fantasy endpoint reports both totals as 0 for a matchup period that has
   *  not closed. Every row of a real week 3 payload came back
   *  `final_margin: 0` while Bijan Robinson sat on 36.30 from Thursday night,
   *  so a preview that trusted it would have called every live matchup dead
   *  level. Starters are the only thing that scores in fantasy and the whole
   *  evaluated board is in hand, so the difference of the points already
   *  banked IS the margin, and it is built from per player numbers that the
   *  payload does get right. */
  margin: number | null;
}

export interface PreviewMatchup {
  matchup_id: string;
  a: PreviewSide;
  b: PreviewSide;
  /** True once either side has a starter on the board. */
  live: boolean;
  /** True only when a real clock reports every starter on both sides FINAL,
   *  AND both sides field a plausible lineup. Without a clock this stays
   *  false: "the board is in" is a result claim, and points alone cannot
   *  establish that a game is over. See `MIN_COMPLETE_ROSTER`. */
  complete: boolean;
  /** Starters yet to kick off, across both sides. */
  remaining: number;
  /** The current margin as a positive number. Null when nothing resolves one. */
  margin: number | null;
  /** The projected margin as a positive number. */
  projected_margin: number | null;
}

/**
 * Starters a side must field before this module will call its matchup
 * finished.
 *
 * "Every starter I was handed has played" is only "the matchup is over" when
 * the rows ARE the lineup. Hand the composer a thin set, as the featured eight
 * rows are, and a matchup whose Thursday players are done reads as a completed
 * board while eight more starters are still to play on Sunday: it published
 * "Choosin' Texas came out 6.60 pts to 1.00 pts, a 5.60 point result" off two
 * tight ends. The pipeline passes the whole evaluated board so this does not
 * arise in production, but a preview declaring a matchup decided is the one
 * claim that must not rest on the caller having passed enough rows.
 *
 * Five is below any real fantasy football lineup (a standard ESPN side starts
 * nine) and well above the handful a truncated set leaves behind, so it
 * separates the two cases without assuming a roster format.
 */
const MIN_COMPLETE_ROSTER = 5;

function buildPreviewSide(team: string, starters: TrackedPlayer[], now?: number | null): PreviewSide {
  const played: TrackedPlayer[] = [];
  const pending: TrackedPlayer[] = [];
  let projected: number | null = null;
  let scored = 0;

  for (const row of starters) {
    const projection = Number(row.projected_points);
    if (row.projected_points != null && Number.isFinite(projection)) {
      projected = (projected == null ? 0 : projected) + projection;
    }
    if (hasPlayed(row, now)) {
      played.push(row);
      scored += Number(row.player_points) || 0;
    } else {
      pending.push(row);
    }
  }

  return {
    team,
    starters,
    played,
    pending,
    projected: projected == null ? null : round2(projected),
    scored: round2(scored),
    /* Filled in by `previewMatchups`, which is the only place that can see
       both sides of the pairing. */
    margin: null,
  };
}

/**
 * The week's head to head pairings, built from the starter rows.
 *
 * A group that does not resolve to exactly two sides is skipped rather than
 * half told: one side is a bye or an unparsed half of a matchup, and more than
 * two means the payload grouped something this code does not understand.
 * Neither is a head to head, so neither gets a head to head story invented
 * for it.
 */
export function previewMatchups(rows: TrackedPlayer[], now?: number | null): PreviewMatchup[] {
  const order: string[] = [];
  const byMatchup = new Map<string, Map<string, TrackedPlayer[]>>();

  for (const row of rows || []) {
    const id = String(row && row.matchup_id == null ? '' : row.matchup_id).trim();
    const team = String(row && row.owner_team == null ? '' : row.owner_team).trim();
    if (!id || !team) continue;
    let sides = byMatchup.get(id);
    if (!sides) {
      sides = new Map();
      byMatchup.set(id, sides);
      order.push(id);
    }
    const bucket = sides.get(team);
    if (bucket) bucket.push(row);
    else sides.set(team, [row]);
  }

  const out: PreviewMatchup[] = [];
  for (const id of order) {
    const sides = Array.from((byMatchup.get(id) as Map<string, TrackedPlayer[]>).entries());
    if (sides.length !== 2) {
      console.warn(
        '[ArticleGenerator] matchup ' + id + ' resolved ' + sides.length +
          ' sides, so no preview storyline is built for it',
        new Error('PREVIEW_SIDE_COUNT'),
      );
      continue;
    }

    const a = buildPreviewSide(sides[0][0], sides[0][1], now);
    const b2 = buildPreviewSide(sides[1][0], sides[1][1], now);
    const live = a.played.length > 0 || b2.played.length > 0;
    const finished = (side: PreviewSide): boolean =>
      side.starters.length >= MIN_COMPLETE_ROSTER &&
      side.starters.every((row) => liveStateOf(row, now) === 'FINAL');

    /* Off the board, not out of the payload's side totals. See the note on
       `PreviewSide.margin`. Null until somebody has played: a matchup nobody
       has started is not level at nothing, it has no margin at all, and the
       copy for it is the projections. */
    a.margin = live ? round2(a.scored - b2.scored) : null;
    b2.margin = live ? round2(b2.scored - a.scored) : null;

    out.push({
      matchup_id: id,
      a,
      b: b2,
      live,
      complete: live && finished(a) && finished(b2),
      remaining: a.pending.length + b2.pending.length,
      margin: a.margin == null ? null : round2(Math.abs(a.margin)),
      projected_margin:
        a.projected == null || b2.projected == null ? null : round2(Math.abs(a.projected - b2.projected)),
    });
  }
  return out;
}

/**
 * The order the slate reads in: what is already happening, tightest first,
 * then what is still to come, tightest first.
 *
 * Deterministic throughout. Every tie falls through to the matchup id, so the
 * same box score and the same clock always order the board the same way.
 */
export function orderPreviewMatchups(matchups: PreviewMatchup[]): PreviewMatchup[] {
  const gap = (m: PreviewMatchup): number => {
    const value = m.live ? m.margin : m.projected_margin;
    return value == null ? Number.POSITIVE_INFINITY : value;
  };
  /* A matchup whose games have kicked off but whose starters have yet to score
     is level at nothing, which the margin sort would otherwise promote to the
     top of the article as the tightest thing on the board. */
  const onTheBoard = (m: PreviewMatchup): boolean => m.a.scored > 0 || m.b.scored > 0;

  return matchups.slice().sort((x, y) => {
    if (x.live !== y.live) return x.live ? -1 : 1;
    if (x.live && onTheBoard(x) !== onTheBoard(y)) return onTheBoard(x) ? -1 : 1;
    const delta = gap(x) - gap(y);
    if (delta !== 0) return delta;
    return x.matchup_id < y.matchup_id ? -1 : x.matchup_id > y.matchup_id ? 1 : 0;
  });
}

/** Whichever side is in front right now, first. */
function leaderFirst(m: PreviewMatchup): [PreviewSide, PreviewSide] {
  return round2(m.a.scored - m.b.scored) >= 0 ? [m.a, m.b] : [m.b, m.a];
}

export interface LeadSwing {
  team: string;
  /** How far behind this side was, as a positive number. */
  from: number;
  /** How far ahead it is now, as a positive number. */
  to: number;
  /** The kickoff window the lead changed hands in. */
  window: GameSlot;
}

/**
 * The last time this side's matchup lead actually changed hands.
 *
 * Built from margins the math already recorded. Every starter carries the
 * margin his side held when HIS game kicked off, so the distinct kickoffs on
 * one side, in order, plus the current margin, are that side's whole
 * trajectory through the week. A sign flip between two consecutive points on
 * it is a lead change.
 *
 * It is credited to the WINDOW it happened in and never to a player: several
 * starters kick off together and nothing here can say which of them did it.
 * Handing one man the credit is the exact overclaim the outcome contract
 * exists to prevent, and `assertOutcomeLanguage` would be right to throw on
 * it.
 *
 * Null when a margin is missing, when there is no trajectory to read, or when
 * the lead simply never changed. A preview never invents one: a side that led
 * from the first whistle has no swing to report, and saying so falsely is
 * worse than saying nothing.
 */
export function leadSwing(side: PreviewSide): LeadSwing | null {
  if (side.margin == null) return null;

  const stops: Array<{ margin: number; slot: GameSlot }> = [];
  const seen = new Set<number>();
  const chronological = side.played
    .slice()
    .sort((x, y) => (Number(x.kickoff) || 0) - (Number(y.kickoff) || 0));

  for (const row of chronological) {
    const kickoff = Number(row.kickoff);
    if (!Number.isFinite(kickoff) || seen.has(kickoff)) continue;
    /* One unreadable entering margin makes the whole trajectory a guess, so
       the swing is refused rather than approximated. */
    if (row.entering_margin == null) return null;
    seen.add(kickoff);
    stops.push({ margin: Number(row.entering_margin), slot: row.slot });
  }
  if (!stops.length) return null;
  stops.push({ margin: side.margin, slot: stops[stops.length - 1].slot });

  for (let i = stops.length - 2; i >= 0; i--) {
    const before = stops[i].margin;
    const after = stops[i + 1].margin;
    /* Strictly negative to strictly positive. A margin of exactly zero is
       level, and coming from level is not taking a lead off anybody. */
    if (before < 0 && after > 0) {
      return { team: side.team, from: round2(-before), to: round2(after), window: stops[i].slot };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Preview copy
 *
 * Same house rules as the recap matrix above: two phrasings per shape, no em
 * dashes, every entity emboldened, and nothing claimed that the numbers in
 * hand do not support. Nothing here reads an outcome flag: a flag computed
 * against a margin that is still moving is not a result, and a preview that
 * quoted one would be announcing a winner at halftime.
 * ------------------------------------------------------------------ */

/** At most this many matchups get a block. A preview that tells every story
 *  on the board tells none of them, and the remainder is counted in a line
 *  rather than dropped silently. */
const MAX_PREVIEW_MATCHUPS = 4;

/**
 * Which phrasing each block gets. Seeded from the first matchup id and the
 * week, then alternated strictly down the article, for the same reason
 * `rotateVariants` alternates: the only repetition a reader notices is two
 * neighbouring blocks reading alike, and arithmetic on a per-row key cannot
 * guarantee that neighbours differ.
 */
function previewVariants(matchups: PreviewMatchup[], week: number): Array<0 | 1> {
  let seed = (Number(week) || 0) % 2;
  if (matchups.length) {
    const key = String(matchups[0].matchup_id);
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 1000000007;
    seed = (hash + (Number(week) || 0)) % 2;
  }
  return matchups.map((_, index) => (((seed + index) % 2) === 0 ? 0 : 1));
}

const starterWord = (count: number): string => (count === 1 ? 'starter' : 'starters');

/** Where a matchup with points already on the board actually stands. */
function liveStanding(m: PreviewMatchup, variant: 0 | 1): string {
  const [lead, trail] = leaderFirst(m);
  const left = m.remaining;
  const margin = b(num2(m.margin == null ? 0 : m.margin));

  /* "Nothing left to kick off" and "nothing left to play" are not the same
     sentence. A matchup with no pending starters and no FINAL board is one
     whose last games are running right now, and printing "0 starters still to
     play" beside a score that is still moving reads as a final result. */
  const outstanding = left
    ? `${b(left)} ${starterWord(left)} still to play`
    : 'the last of the board still on the field';

  if (m.margin != null && m.margin < 0.01) {
    return variant === 0
      ? `${b(m.a.team)} and ${b(m.b.team)} are dead level, with ${outstanding}.`
      : `Nothing separates ${b(m.a.team)} and ${b(m.b.team)} so far, with ${outstanding}.`;
  }

  if (m.complete) {
    return variant === 0
      ? `${b(lead.team)} came out ${b(num2(lead.scored) + ' pts')} to ${b(num2(trail.scored) + ' pts')}, ` +
        `a ${margin} point result over ${b(trail.team)}.`
      : `Every starter is in: ${b(lead.team)} finished ${margin} clear of ${b(trail.team)}.`;
  }

  return variant === 0
    ? `${b(lead.team)} take a ${margin} point lead over ${b(trail.team)} into the rest of the week, with ` +
      `${outstanding}.`
    : `${b(lead.team)} hold a ${margin} point cushion over ${b(trail.team)}, with ${outstanding}.`;
}

/**
 * The biggest number on the board in this matchup so far.
 *
 * Null when nobody has scored yet, even though their games have started:
 * "tops the matchup at 0.00 pts" is a sentence about a player who has done
 * nothing, in a matchup where nothing has happened.
 */
function topScorer(m: PreviewMatchup): TrackedPlayer | null {
  const played = m.a.played.concat(m.b.played);
  if (!played.length) return null;
  const best = played.slice().sort((x, y) => {
    const delta = (Number(y.player_points) || 0) - (Number(x.player_points) || 0);
    if (delta !== 0) return delta;
    return x.player_id < y.player_id ? -1 : x.player_id > y.player_id ? 1 : 0;
  })[0];
  return (Number(best.player_points) || 0) > 0 ? best : null;
}

/**
 * What that performance actually was, measured against the projection it was
 * supposed to be.
 *
 * Deliberately short of any claim about the matchup: leading the scoring in a
 * week that is still running decides nothing, and this sentence sits beside
 * one that already states the margin.
 */
function scorerLine(row: TrackedPlayer, state: LiveState, variant: 0 | 1): string {
  const player = b(row.player_name);
  const team = b(row.owner_team);
  const points = b(num2(Number(row.player_points) || 0) + ' pts');
  const running = state === 'LIVE' ? ', and his game is still running' : '';
  const projection = row.projected_points == null ? null : Number(row.projected_points);

  if (projection == null || !Number.isFinite(projection)) {
    return variant === 0
      ? `${player} leads the board for ${team} with ${points}${running}.`
      : `The biggest number so far belongs to ${player}: ${points} for ${team}${running}.`;
  }

  const delta = round2((Number(row.player_points) || 0) - projection);
  if (delta >= 0) {
    return variant === 0
      ? `${player} did the damage for ${team}, banking ${points} against ${article(projection)} ` +
        `${b(num2(projection))} point projection${running}.`
      : `${team} got ${points} out of ${player}, ${b(num2(delta))} clear of his projection${running}.`;
  }
  return variant === 0
    ? `${player} still tops the matchup at ${points} for ${team}, though that is ${b(num2(-delta))} under ` +
      `his projection${running}.`
    : `${points} from ${player} leads the way for ${team}, and it landed ${b(num2(-delta))} short of his ` +
      `${b(num2(projection))} point projection${running}.`;
}

/* Deliberately tense neutral. The same sentence has to read correctly in a
   matchup that is still running and in one whose board is already in, and a
   preview composed on a Friday can be either. */
function swingLine(swing: LeadSwing, variant: 0 | 1): string {
  const window = WINDOW_PHRASE[swing.window] || WINDOW_PHRASE.UNKNOWN;
  return variant === 0
    ? `The lead changed hands in ${window} window: ${b(swing.team)} went from ${b(num2(swing.from))} ` +
      `down to ${b(num2(swing.to))} up.`
    : `${b(swing.team)} were ${b(num2(swing.from))} behind when ${window} window opened, and came out ` +
      `of it ${b(num2(swing.to))} ahead.`;
}

/** The biggest projection a side still has waiting. */
function topPending(side: PreviewSide): TrackedPlayer | null {
  const rows = side.pending.filter((row) => row.projected_points != null &&
    Number.isFinite(Number(row.projected_points)));
  if (!rows.length) return null;
  return rows.slice().sort((x, y) => {
    const delta = (Number(y.projected_points) || 0) - (Number(x.projected_points) || 0);
    if (delta !== 0) return delta;
    return x.player_id < y.player_id ? -1 : x.player_id > y.player_id ? 1 : 0;
  })[0];
}

/** The names each side still has to come, as stakes rather than as a list. */
function toComeLine(m: PreviewMatchup, variant: 0 | 1): string {
  const left = topPending(m.a);
  const right = topPending(m.b);
  if (!left && !right) return '';

  if (left && right) {
    return variant === 0
      ? `${b(m.a.team)} still have ${b(left.player_name)} at ${b(num2(Number(left.projected_points)))} ` +
        `projected, ${b(m.b.team)} answer with ${b(right.player_name)} at ` +
        `${b(num2(Number(right.projected_points)))}.`
      : `The biggest names left are ${b(left.player_name)} for ${b(m.a.team)} and ` +
        `${b(right.player_name)} for ${b(m.b.team)}, projected for ` +
        `${b(num2(Number(left.projected_points)))} and ${b(num2(Number(right.projected_points)))}.`;
  }

  const only = (left || right) as TrackedPlayer;
  return `${b(only.owner_team)} still have ${b(only.player_name)} to come at ` +
    `${b(num2(Number(only.projected_points)))} projected.`;
}

/** A matchup nobody has played yet, framed on the gap rather than the roster. */
function projectedStanding(m: PreviewMatchup, variant: 0 | 1): string {
  if (m.projected_margin == null) {
    return variant === 0
      ? `${b(m.a.team)} meet ${b(m.b.team)} with no projections posted, so this one gets read off the ` +
        'lineups alone.'
      : `No projection separates ${b(m.a.team)} and ${b(m.b.team)} yet. The lineups are the only tell.`;
  }

  const favourite = (m.a.projected as number) >= (m.b.projected as number) ? m.a : m.b;
  const underdog = favourite === m.a ? m.b : m.a;
  const gap = b(num2(m.projected_margin));

  if (m.projected_margin <= 10) {
    return variant === 0
      ? `${b(m.a.team)} and ${b(m.b.team)} project within ${gap}, close enough that one lineup call ` +
        'settles it.'
      : `There is ${gap} between ${b(m.a.team)} and ${b(m.b.team)} on the projections, which is nothing ` +
        'at all across a full slate.';
  }
  return variant === 0
    ? `The projections give ${b(favourite.team)} ${gap} on ${b(underdog.team)}, a gap ${b(underdog.team)} ` +
      'have to find somewhere in the lineup.'
    : `${b(favourite.team)} are ${gap} up on ${b(underdog.team)} before a snap, which is the kind of lead ` +
      'that lasts right until it does not.';
}

/**
 * One matchup, told as a story.
 *
 * A live block leads with the standing, then the number that produced it, then
 * either the lead change it came out of or what is still to come. A block
 * nobody has played yet leads with the gap and names the two performances the
 * gap rests on.
 */
export function previewBlock(m: PreviewMatchup, variant: 0 | 1, now?: number | null): string[] {
  const sentences: string[] = [];

  if (m.live) {
    sentences.push(liveStanding(m, variant));
    const top = topScorer(m);
    if (top) sentences.push(scorerLine(top, liveStateOf(top, now), variant));
    const swing = leadSwing(leaderFirst(m)[0]);
    if (swing) sentences.push(swingLine(swing, variant));
    if (!m.complete) {
      const toCome = toComeLine(m, variant);
      if (toCome) sentences.push(toCome);
    }
  } else {
    sentences.push(projectedStanding(m, variant));
    const toCome = toComeLine(m, variant);
    if (toCome) sentences.push(toCome);
  }

  return [`### ${m.a.team} vs ${m.b.team}`, '', sentences.join(' ')];
}

/* The editorial shelf each article type belongs to. The read route resolves
   the same mapping for rows written before the column existed, so the two must
   agree; they are the same three strings in both places. */
export const CATEGORY_BY_TYPE: Record<ArticleType, string> = {
  monday_sweat: 'Matchup Recap',
  tuesday_verdict: 'Matchup Recap',
  friday_tnf_preview: 'Matchup Preview',
};

export const DEFAULT_AUTHOR = 'FSN News Desk';

/**
 * Tier 2: what one performance meant to one matchup, in a single line.
 *
 * Derived from the flag and nothing else, exactly like the body sentences. The
 * grammar is fixed per flag, so the callout can never say more than the math
 * supports: only GAME_WINNER gets "just enough", and a big score in a loss is
 * "not enough" rather than anything warmer.
 */
export function impactSummary(
  rows: TrackedPlayer[],
  articleType: ArticleType,
  options: { now?: number | null; slate?: TrackedPlayer[] } = {},
): string {
  /* A preview callout used to name the single biggest projection on the slate,
     which is the one number in a live week guaranteed to be out of date: it
     read "Team start Player on a 19.94 point projection" on a Friday when that
     player had already scored. The callout now states where a matchup actually
     is, and only falls back to the projections when nothing has been played. */
  if (articleType === 'friday_tnf_preview') {
    const slate = options.slate && options.slate.length ? options.slate : rows;
    const matchups = orderPreviewMatchups(previewMatchups(slate, options.now));
    if (!matchups.length) return 'Lineups are locked and no matchup pairing resolved yet.';

    const live = matchups.filter((m) => m.live);
    if (live.length) {
      const m = live[0];
      const [lead, trail] = leaderFirst(m);
      /* `complete`, never the pending count. A matchup with nobody left to
         kick off but games still running is not a finished one, and the
         callout is the most prominent line on the card. */
      const outstanding = m.remaining
        ? `with ${m.remaining} ${starterWord(m.remaining)} still to play`
        : 'with the last of the board still on the field';

      if (m.margin == null || m.margin < 0.01) {
        return m.complete
          ? `${lead.team} and ${trail.team} finished level.`
          : `${lead.team} and ${trail.team} are level ${outstanding}.`;
      }
      return m.complete
        ? `${lead.team} came out ${num2(m.margin)} clear of ${trail.team}.`
        : `${lead.team} lead ${trail.team} by ${num2(m.margin)} ${outstanding}.`;
    }

    const next = matchups[0];
    if (next.projected_margin == null) {
      return `${next.a.team} meet ${next.b.team} with no projections posted.`;
    }
    return `${next.a.team} and ${next.b.team} project within ${num2(next.projected_margin)}, the closest ` +
      'matchup on the board.';
  }

  /* Which flagged performance IS the week, when several are.

     `featuredTrackedPlayers` ranks rows by news weight for the body, and
     taking its first flagged row put a wasted 74 ahead of the player who
     actually swung a matchup. The callout is the one line a reader takes away,
     so the order it picks by is stated here rather than inherited:

       GAME_WINNER   a matchup was won by this performance
       DUD_COST_WIN  a matchup in hand was thrown away by one
       VALIANT_LOSS  a big score that changed nothing

     GARBAGE_TIME_BLOWOUT is not a candidate: padding in a game decided before
     the player kicked off is the least meaningful thing the math can flag, and
     it is the one thing a prominent callout should never be. The board does
     print it, last and only if a slot is spare.

     Within a flag the math's own ranking breaks the tie, so the choice stays
     deterministic for a given league, season and week.

     DECISIVE_PRIORITY, not BOARD_PRIORITY: the board may carry a blowout
     bullet for colour once nothing decisive is left to print, but the callout
     is the single most prominent line on the card and must never announce
     that a game already decided stayed decided. A week whose only flag is a
     blowout therefore gets no callout, and the headline that says no swings
     is not contradicted by one. */
  let row: TrackedPlayer | undefined;
  for (const flag of DECISIVE_PRIORITY) {
    row = rows.find((candidate) => candidate.outcome_flag === flag);
    if (row) break;
  }
  /* Nothing decisive means nothing to call out. An invented callout would be
     the exact overclaim this module exists to prevent. */
  if (!row) return '';

  const scored = `${row.player_name} scored ${pts(row.player_points)} points`;
  switch (row.outcome_flag) {
    case 'GAME_WINNER':
      return `${scored}, just enough for ${row.owner_team}.`;
    case 'VALIANT_LOSS':
      return `${scored}, not enough for ${row.owner_team}.`;
    case 'GARBAGE_TIME_BLOWOUT':
      return `${scored}, which did not affect the blowout for ${row.owner_team}.`;
    case 'DUD_COST_WIN':
      return `${scored}, well under projection, and ${row.owner_team} lost a game they led.`;
    default:
      return '';
  }
}

/**
 * The preview, as a board of matchup storylines.
 *
 * Replaces a list of "[Player] starts for [Team] on a [X.XX] point
 * projection". That shape had two problems and the second is the bad one:
 * it read as a spreadsheet next to the Tuesday recap, and on a Friday it
 * quoted pre-game projections for players who had already finished playing on
 * Thursday night. Points on the board now lead, and a projection is only ever
 * reported for a game that has not started.
 */
function composePreview(
  request: ComposeRequest,
  slate: TrackedPlayer[],
): ArticleDraft {
  const now = request.now;
  const matchups = orderPreviewMatchups(previewMatchups(slate, now));
  const live = matchups.filter((m) => m.live);
  const settled = matchups.length > 0 && matchups.every((m) => m.complete);
  const matchupWord = (count: number): string => (count === 1 ? 'Matchup' : 'Matchups');

  /* The slate is checked as well as the matchups, so a week whose rows did not
     pair into a head to head is still named correctly: a starter carrying
     points has played whether or not his matchup resolved. */
  const played = live.length > 0 || slate.some((row) => hasPlayed(row, now));
  const heading = `${played ? TNF_BREAKDOWN_LABEL : TNF_PREVIEW_LABEL}: Week ${request.week}`;

  /* "On The Board" against "On The Clock" is the whole distinction, and the
     label above has already said which one applies, so the played headline
     does not also need the word "Already". */
  const title = !matchups.length
    ? `${heading}, Lineups Are Locked`
    : settled
      ? `${heading}, The Board Is In`
      : live.length
        ? `${heading}, ${live.length} ${matchupWord(live.length)} On The Board`
        : `${heading}, ${matchups.length} ${matchupWord(matchups.length)} On The Clock`;

  const excerpt = !matchups.length
    ? `Week ${request.week} lineups are locked, but the box score did not pair a single matchup up.`
    : settled
      ? `Week ${request.week} is scored out. Where every matchup finished, and the performances that ` +
        'got it there.'
      : live.length
        ? `Week ${request.week} is already moving. Where every matchup actually stands, and what is ` +
          'still to come.'
        : `Week ${request.week} before a snap: the matchups the projections say are close, and the ` +
          'calls that settle them.';

  const body: string[] = [`# ${title}`, '', excerpt, ''];

  if (!matchups.length) {
    /* Warned rather than errored: a week with no pairable matchup is a thin
       payload, not a broken pipeline, and the article still publishes. */
    console.warn(
      '[ArticleGenerator] no head to head matchups resolved for the week ' + request.week +
        ' preview, so it publishes without a matchup board',
      new Error('NO_PREVIEW_MATCHUPS'),
    );
    body.push(
      `${slate.length} ${slate.length === 1 ? 'starter is' : 'starters are'} set for week ` +
        `${request.week}, but no head to head pairing resolved out of this week's box score, so no ` +
        'matchup story is claimed here.',
    );
  } else {
    const featured = matchups.slice(0, MAX_PREVIEW_MATCHUPS);
    const variants = previewVariants(featured, request.week);
    const blocks = featured.map((m, index) => ({ m, variant: variants[index] }));

    const started = blocks.filter((block) => block.m.live);
    const upcoming = blocks.filter((block) => !block.m.live);

    if (started.length) {
      body.push('## Where the week stands', '');
      for (const block of started) body.push(...previewBlock(block.m, block.variant, now), '');
    }
    if (upcoming.length) {
      body.push(started.length ? '## Still on the clock' : '## The board', '');
      for (const block of upcoming) body.push(...previewBlock(block.m, block.variant, now), '');
    }

    const rest = matchups.length - blocks.length;
    if (rest > 0) {
      body.push(
        `${rest} further ${rest === 1 ? 'matchup rounds' : 'matchups round'} out the week ` +
          `${request.week} board.`,
      );
    }
  }

  return {
    title,
    excerpt,
    /* Block separators leave double blanks behind. `lbMarkdown()` treats any
       run of blank lines the same, but the stored markdown is read by people
       too. */
    content_markdown: body.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n',
    match_impact_summary: impactSummary(request.tracked_players, request.article_type, { now, slate }),
    category: CATEGORY_BY_TYPE[request.article_type],
    author: DEFAULT_AUTHOR,
  };
}

export const defaultComposer: Composer = (request) => {
  const preview = request.article_type === 'friday_tnf_preview';
  const rows = request.tracked_players;

  /* The whole evaluated board when the pipeline handed it over, the featured
     rows when a caller built the request without it. A preview is a story
     about matchups, and eight featured rows scattered across six of them
     cannot tell one. */
  const slate = request.all_players && request.all_players.length ? request.all_players : rows;
  /* The preview names itself off the board, so it builds its own heading. */
  if (preview) return composePreview(request, slate);

  const heading = `${TITLE_BY_TYPE[request.article_type]}: Week ${request.week}`;

  /* A starter whose game has not kicked off cannot have tacked anything on.
     The flags come from the margins around his kickoff, so a recap composed
     while the week is still open can flag a man who has not played: a Thursday
     night clock flagged four of Harbor Watch's starters GARBAGE_TIME_BLOWOUT
     because the matchup was already 25 clear, and the board printed "padded
     the score with 0.00 pts" for a player who was not going to be on a field
     until Sunday.

     Filtered only when a clock came with the request. Without one, `hasPlayed`
     falls back to "carries points", which would drop a genuine DUD_COST_WIN:
     the man who put up nothing and cost his team a game it led is exactly the
     story that flag exists for, and he is indistinguishable by points alone
     from a man who has not started. So a caller that supplies no clock keeps
     the behaviour it always had. */
  const onTheField = Number.isFinite(Number(request.now))
    ? rows.filter((row) => hasPlayed(row, request.now))
    : rows;
  const board = boardRows(onTheField);
  /* The headline counts the results that TURNED something, which is what
     "Results That Turned" claims. That is the board minus any blowout bullet
     it printed to fill a spare slot: a blowout is a thing that happened, not
     a thing that turned, and a week with nothing decisive still reads "No
     Swings To Report" even when the board shows one. */
  const decisive = decisiveRows(board);

  const title = decisive.length
    ? `${heading}, ${decisive.length} ${decisive.length === 1 ? 'Result' : 'Results'} That Turned`
    : `${heading}, No Swings To Report`;

  const excerpt = decisive.length
    ? `The week ${request.week} performances the math says actually moved a matchup.`
    : `Week ${request.week} scored out the way it projected. Here is the board anyway.`;

  const body: string[] = [`# ${title}`, '', excerpt, ''];

  if (!rows.length) {
    body.push('No lineups were available for this week yet.');
  } else {
    body.push('## What the math says', '');
    if (!board.length) {
      /* An empty board used to print this heading with nothing under it, which
         is a rendering bug wearing an article's clothes. Nothing decisive
         happened is a real answer, so it gets said. */
      body.push(
        `Nothing in week ${request.week} turned a matchup. Every starter the math could place against ` +
          'the scoreboard either landed where his projection had him, or landed in a game that was ' +
          'never close enough for it to matter.',
      );
    } else {
      /* The top few that actually decided something, not every starter. */
      /* Each archetype counts its own appearances, so a second overhaul in the
         same article never repeats the first one's phrasing. */
      const variants = rotateVariants(board, request.week);
      board.forEach((row, i) => body.push(`- ${sentenceFor(row, request.week, variants[i])}`));
    }
    const unresolved = rows.filter((row) => row.unresolved_reason);
    if (unresolved.length) {
      body.push(
        '',
        '## Not called',
        '',
        `${unresolved.length} ${unresolved.length === 1 ? 'lineup spot' : 'lineup spots'} could not be ` +
          'placed in time against the scoreboard, so no swing is claimed for them.',
      );
    }
  }

  return {
    title,
    excerpt,
    content_markdown: body.join('\n') + '\n',
    /* The existing three fields are byte for byte what they were before the
       three-tier layout: a published article's copy does not change because a
       new column was added beside it. */
    match_impact_summary: impactSummary(rows, request.article_type, { now: request.now, slate }),
    category: CATEGORY_BY_TYPE[request.article_type],
    author: DEFAULT_AUTHOR,
  };
};

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

/** Service-role client. Browsers never hold this key: the article pipeline is
 *  a server-side job, same boundary as `/api/league` and the transaction wire. */
export function database(): any {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw fail('Blog article storage is not configured', 503);
  }
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url: any, options: any) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) }) },
  });
}

/** Reuse the existing ESPN cookie / share-token boundary without an HTTP round
 *  trip, exactly as `lib/transaction-wire/providers.js` does. */
async function defaultFetchBoxScores(input: GenerateInput & { req?: any }): Promise<any> {
  /* TWO levels up, not one. This is a runtime `require`, not an import, so
     TypeScript copies the string through untouched and Node resolves it
     relative to the EMITTED file in `lib/dist/`, not to this source file in
     `lib/`. `'../api/espn'` reads correctly here and resolves to
     `lib/api/espn` at runtime, which does not exist: it threw on every
     scheduled run before a single box score was fetched. The self-test now
     resolves every relative require in `lib/dist` from `lib/dist`. */
  const espn = require('../../api/espn');
  const url =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${input.season}` +
    `/segments/0/leagues/${input.league_id}?scoringPeriodId=${input.week}` +
    '&view=mMatchupScore&view=mBoxscore&view=mRoster&view=mTeam';

  let status = 200;
  let body: any;
  const response = {
    setHeader() {},
    status(value: number) { status = value; return this; },
    json(value: any) { body = value; return this; },
    send(value: any) { body = value; return this; },
    end() { return this; },
  };
  await espn(
    { method: 'GET', headers: (input.req && input.req.headers) || {}, query: { url }, url: '/api/espn' },
    response,
  );
  if (status < 200 || status >= 300 || !body || typeof body !== 'object') {
    throw fail('ESPN box score read failed (HTTP ' + status + ')', [400, 401, 403, 404, 429].includes(status) ? status : 502);
  }
  return body;
}

/* The columns added by the three-tier block of `supabase/blog_articles.sql`.
   A database that has not run it yet rejects the write with PostgREST's
   "column does not exist"; the retry below drops exactly these and publishes
   the story in the legacy columns rather than losing a morning's run to a
   pending migration. */
const TIER_COLUMNS = ['headline', 'match_impact_summary', 'content', 'category', 'author'];
const UNDEFINED_COLUMN = '42703';

function isMissingColumn(err: any): boolean {
  if (!err) return false;
  if (String(err.code || '') === UNDEFINED_COLUMN) return true;
  return /column .* does not exist/i.test(String(err.message || ''));
}

function withoutTierColumns(record: BlogArticleRecord): Record<string, unknown> {
  const legacy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!TIER_COLUMNS.includes(key)) legacy[key] = value;
  }
  return legacy;
}

/**
 * Kickoff times for the week, from the public NFL scoreboard.
 *
 * The ESPN fantasy league endpoint carries none, so without this every starter
 * resolves to `kickoff: null` and the math refuses every margin. It is a
 * public, credential-free read of a host the app already talks to, and one
 * request covers every league in the run.
 *
 * Required at the module boundary, tolerated at the call site: a failure here
 * degrades the article to the unresolved margins it had before this existed
 * rather than failing the whole league, which is why the caller catches.
 */
async function defaultFetchKickoffs(input: { season: number; week: number }): Promise<KickoffIndex> {
  /* Two levels up from the EMITTED file in lib/dist, same as the api/espn
     require above: this string is copied through untouched and resolved at
     runtime relative to lib/dist, not to this source file. */
  const scheduleFeed = require('../notifications/schedule-feed');
  return scheduleFeed.pullKickoffs({ season: input.season, week: input.week });
}

async function store(db: any, record: BlogArticleRecord): Promise<BlogArticleRecord> {
  const write = (row: any) => db
    .from('blog_articles')
    .upsert(row, { onConflict: 'slug' })
    .select()
    .single();

  let result = await write(record);
  if (result.error && isMissingColumn(result.error)) {
    console.warn(
      '[ArticleGenerator] the three-tier columns are not on this database yet; storing "' +
        record.slug + '" in the legacy columns. Run supabase/blog_articles.sql.',
      result.error,
    );
    result = await write(withoutTierColumns(record));
  }
  if (result.error) throw result.error;
  if (!result.data) throw fail('Blog article write returned no row', 502);
  return result.data as BlogArticleRecord;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Generate one league blog article for a day and publish it.
 *
 * Throws on a bad input, an unreadable box score, copy that overclaims, or a
 * failed write. Nothing is swallowed: a caller that gets a resolved promise
 * has a row in `blog_articles`.
 */
export async function generateAndPublishBlogArticle(
  input: GenerateInput,
  dependencies: GenerateDependencies = {},
): Promise<GenerateResult> {
  const scope = normalizeInput(input);
  const articleType = ARTICLE_TYPE_BY_DAY[scope.day];
  const label = `${scope.league_id}/${scope.season}/w${scope.week}/${scope.day}`;

  let boxScores: any;
  try {
    const fetchBoxScores = dependencies.fetchBoxScores || defaultFetchBoxScores;
    boxScores = await fetchBoxScores({ ...scope, req: dependencies.req });
  } catch (err) {
    console.error('[ArticleGenerator] box score fetch failed for ' + label, err);
    throw err;
  }

  /* The kickoff index is what lets the math place a starter's points in time.
     A failure is logged and the run continues: the article then carries the
     unresolved margins it would have had anyway, which is strictly better than
     publishing nothing for the league. */
  let kickoffs: KickoffIndex = {};
  try {
    kickoffs = await (dependencies.fetchKickoffs || defaultFetchKickoffs)({
      season: scope.season,
      week: scope.week,
    }) || {};
  } catch (err) {
    console.error(
      '[ArticleGenerator] the NFL scoreboard could not be read for ' + label +
        '; every margin in this article will be unresolved and no outcome flag will be assigned',
      err,
    );
    kickoffs = {};
  }

  const evaluated = calculatePlayerOutcomeFlags(boxScores, { week: scope.week, kickoffs });
  const tracked = featuredTrackedPlayers(evaluated);
  if (!tracked.length) {
    console.error(
      '[ArticleGenerator] no startable lineups resolved for ' + label,
      new Error('NO_TRACKED_PLAYERS'),
    );
    throw fail('No lineups were available for this league week', 404);
  }

  /* Resolved BEFORE composition rather than after it. A preview has to tell a
     projection apart from a result, which takes a clock, and the row's
     `published_at` has to be the same instant the copy was written against. */
  const now = dependencies.now ? dependencies.now() : Date.now();

  const request: ComposeRequest = {
    system_prompt: buildSystemPrompt(articleType),
    user_prompt: '',
    league_id: scope.league_id,
    season: scope.season,
    week: scope.week,
    day: scope.day,
    article_type: articleType,
    tracked_players: tracked,
    /* The featured rows are what gets persisted and what the outcome contract
       is checked against. The full board is composition material only: it is
       the only thing that can reconstruct a head to head. */
    all_players: evaluated,
    now,
  };
  request.user_prompt = buildUserPrompt(request);

  let draft: ArticleDraft;
  try {
    draft = await (dependencies.compose || defaultComposer)(request);
  } catch (err) {
    console.error('[ArticleGenerator] composition failed for ' + label, err);
    throw err;
  }
  if (!draft || !String(draft.title || '').trim() || !String(draft.content_markdown || '').trim()) {
    throw fail('Blog article composer returned an empty draft', 502);
  }

  // The flags are the contract. Copy that contradicts them never reaches the
  // table, whether a model or the local composer wrote it.
  assertOutcomeLanguage(draft, tracked);

  const headline = String(draft.title).trim();
  const content = String(draft.content_markdown);
  const record: BlogArticleRecord = {
    league_id: scope.league_id,
    slug: articleSlug(scope),

    /* Tier 1, 2, 3 and the meta line. A composer that supplies no summary,
       category or author gets the deterministic ones derived from the flags
       and the article type, so every row carries a full three tiers whichever
       writer produced it. */
    headline,
    match_impact_summary: String(draft.match_impact_summary || '').trim() ||
      impactSummary(tracked, articleType, { now, slate: evaluated }),
    content,
    category: String(draft.category || '').trim() || CATEGORY_BY_TYPE[articleType],
    author: String(draft.author || '').trim() || DEFAULT_AUTHOR,

    /* The legacy columns, in lockstep. */
    title: headline,
    excerpt: String(draft.excerpt || '').trim(),
    content_markdown: content,
    article_type: articleType,
    season: scope.season,
    week: scope.week,
    tracked_players: tracked,
    published_at: new Date(now).toISOString(),
  };

  const db = dependencies.db || database();
  try {
    const saved = await store(db, record);
    return {
      record: saved,
      tracked_players: tracked,
      evaluated: evaluated.length,
      stored: true,
      kickoffs: Object.keys(kickoffs).length,
    };
  } catch (err) {
    console.error('[ArticleGenerator] blog_articles write failed for ' + label, err);
    throw err;
  }
}

/* CommonJS consumers (`api/*.js` routes are CJS) get the same surface. */
