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
}

export interface ArticleDraft {
  title: string;
  excerpt: string;
  content_markdown: string;
}

export type Composer = (request: ComposeRequest) => ArticleDraft | Promise<ArticleDraft>;

export interface GenerateDependencies {
  /** Supabase client. Defaults to a service-role client from the environment. */
  db?: any;
  /** Box score source. Defaults to the ESPN read boundary in `api/espn`. */
  fetchBoxScores?: (input: GenerateInput & { req?: any }) => Promise<any>;
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
  ].join('\n');
}

export function buildUserPrompt(request: Omit<ComposeRequest, 'system_prompt' | 'user_prompt'>): string {
  const lines = [
    `League ${request.league_id}, ${request.season} season, week ${request.week}.`,
    `Article type: ${request.article_type}.`,
    '',
    'Resolved facts, one line per tracked player:',
  ];
  for (const row of request.tracked_players) {
    lines.push(
      `- ${row.player_name} (${row.owner_team}, vs ${row.opponent_team || 'bye'}, ${row.slot}): ` +
        `${row.player_points} pts` +
        (row.projected_points == null ? '' : ` on a ${row.projected_points} projection`) +
        `, entering_margin ${row.entering_margin == null ? 'unknown' : row.entering_margin}` +
        `, final_margin ${row.final_margin == null ? 'unknown' : row.final_margin}` +
        `, outcome_flag ${row.outcome_flag == null ? 'null' : row.outcome_flag}` +
        (row.unresolved_reason ? ` (unresolved: ${row.unresolved_reason})` : ''),
    );
  }
  const flags = new Set(request.tracked_players.map((row) => row.outcome_flag).filter(Boolean) as OutcomeFlag[]);
  if (flags.size) {
    lines.push('', 'Framing required by the flags present:');
    for (const flag of flags) lines.push(`- ${flag}: ${FLAG_GUIDANCE[flag]}`);
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

  const prose = `${draft.title}. ${draft.excerpt}. ${draft.content_markdown}`;
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

const TITLE_BY_TYPE: Record<ArticleType, string> = {
  monday_sweat: 'Monday Sweat',
  tuesday_verdict: 'Tuesday Verdict',
  friday_tnf_preview: 'Friday Night Preview',
};

const pts = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(2));

/** "an 8 point projection", not "a 8 point projection". English reads the
 *  number, so the article is chosen from how the figure is spoken: 8, 11, and
 *  18 take "an", everything else takes "a". */
function article(value: number): string {
  const spoken = pts(value);
  return /^(?:8|11|18)(?:\.|$)/.test(spoken) ? 'an' : 'a';
}

function sentenceFor(row: TrackedPlayer): string {
  const margin = row.final_margin;
  const gap = margin == null ? null : pts(Math.abs(margin));
  switch (row.outcome_flag) {
    case 'GAME_WINNER':
      return `${row.player_name} won the matchup for ${row.owner_team}. They trailed by ` +
        `${pts(Math.abs(row.entering_margin as number))} before his game and finished ${gap} clear, and his ` +
        `${pts(row.player_points)} covered the whole deficit.`;
    case 'GARBAGE_TIME_BLOWOUT':
      return `${row.player_name} put up ${pts(row.player_points)} for ${row.owner_team} in a game that was ` +
        `already gone: the lead was ${pts(row.entering_margin as number)} before he played and ${gap} after. ` +
        `Unneeded stat-padding, nothing more.`;
    case 'VALIANT_LOSS':
      return `${row.player_name} went for ${pts(row.player_points)} and ${row.owner_team} lost anyway, by ` +
        `${gap}. A monster game, wasted.`;
    case 'DUD_COST_WIN':
      return `${row.owner_team} led by ${pts(row.entering_margin as number)} before ${row.player_name} played, ` +
        `then lost by ${gap}. He finished on ${pts(row.player_points)} against ` +
        `${article(row.projected_points as number)} ${pts(row.projected_points as number)} point projection, ` +
        `and that gap is the matchup.`;
    default:
      return `${row.player_name} finished on ${pts(row.player_points)} for ${row.owner_team}` +
        (row.final_margin == null
          ? '.'
          : row.final_margin > 0
            ? `, who won by ${gap}.`
            : row.final_margin < 0
              ? `, who lost by ${gap}.`
              : ', in a tie.');
  }
}

function previewSentence(row: TrackedPlayer): string {
  return `${row.player_name} starts for ${row.owner_team}` +
    (row.projected_points == null
      ? '.'
      : ` on ${article(row.projected_points)} ${pts(row.projected_points)} point projection.`);
}

export const defaultComposer: Composer = (request) => {
  const preview = request.article_type === 'friday_tnf_preview';
  const heading = `${TITLE_BY_TYPE[request.article_type]}: Week ${request.week}`;
  const rows = request.tracked_players;
  const decisive = rows.filter((row) => row.outcome_flag);

  const title = preview
    ? `${heading}, ${rows.length} Lineups On The Clock`
    : decisive.length
      ? `${heading}, ${decisive.length} ${decisive.length === 1 ? 'Result' : 'Results'} That Turned`
      : `${heading}, No Swings To Report`;

  const excerpt = preview
    ? `What week ${request.week} looks like before kickoff, straight off the projections.`
    : decisive.length
      ? `The week ${request.week} performances the math says actually moved a matchup.`
      : `Week ${request.week} scored out the way it projected. Here is the board anyway.`;

  const body: string[] = [`# ${title}`, '', excerpt, ''];

  if (!rows.length) {
    body.push('No lineups were available for this week yet.');
  } else if (preview) {
    body.push('## On the slate', '');
    for (const row of rows) body.push(`- ${previewSentence(row)}`);
  } else {
    body.push('## What the math says', '');
    for (const row of rows) body.push(`- ${sentenceFor(row)}`);
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

  return { title, excerpt, content_markdown: body.join('\n') + '\n' };
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
  const espn = require('../api/espn');
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

async function store(db: any, record: BlogArticleRecord): Promise<BlogArticleRecord> {
  const result = await db
    .from('blog_articles')
    .upsert(record, { onConflict: 'slug' })
    .select()
    .single();
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

  const evaluated = calculatePlayerOutcomeFlags(boxScores, { week: scope.week });
  const tracked = featuredTrackedPlayers(evaluated);
  if (!tracked.length) {
    console.error(
      '[ArticleGenerator] no startable lineups resolved for ' + label,
      new Error('NO_TRACKED_PLAYERS'),
    );
    throw fail('No lineups were available for this league week', 404);
  }

  const request: ComposeRequest = {
    system_prompt: buildSystemPrompt(articleType),
    user_prompt: '',
    league_id: scope.league_id,
    season: scope.season,
    week: scope.week,
    day: scope.day,
    article_type: articleType,
    tracked_players: tracked,
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

  const now = dependencies.now ? dependencies.now() : Date.now();
  const record: BlogArticleRecord = {
    league_id: scope.league_id,
    slug: articleSlug(scope),
    title: String(draft.title).trim(),
    excerpt: String(draft.excerpt || '').trim(),
    content_markdown: String(draft.content_markdown),
    article_type: articleType,
    season: scope.season,
    week: scope.week,
    tracked_players: tracked,
    published_at: new Date(now).toISOString(),
  };

  const db = dependencies.db || database();
  try {
    const saved = await store(db, record);
    return { record: saved, tracked_players: tracked, evaluated: evaluated.length, stored: true };
  } catch (err) {
    console.error('[ArticleGenerator] blog_articles write failed for ' + label, err);
    throw err;
  }
}

/* CommonJS consumers (`api/*.js` routes are CJS) get the same surface. */
