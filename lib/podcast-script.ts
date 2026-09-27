/**
 * THE FOUR-SEGMENT WEEKLY RECAP SCRIPT.
 *
 * Dan and Stu's weekly episode, built from two branches of data the app
 * already computes:
 *
 *   Segment 1  FSN Index Movers     lib/fsn-index.ts, this week's board against
 *                                   last week's
 *   Segment 2  Big Performers       lib/article-math.ts tracked starters — the
 *                                   editorial branch's own outcome flags
 *   Segment 3  Matchup of the Week   lib/article-generator.ts preview matchups
 *   Segment 4  Waiver Lookout       starter shortfalls against projection, the
 *                                   evidence for who has to shop
 *
 * ---- WHAT THIS IS NOT ----
 *
 * Not an LLM prompt. There is no model in this pipeline and none is being
 * added: every sentence below is a template filled from numbers the math
 * modules already stand behind, which is what lets the episode be regenerated
 * and come out the same. Determinism, as elsewhere in the repo: no
 * `Math.random()`, no `Date.now()`, no network, no model call. The same inputs
 * always produce the same script.
 *
 * Not a change to the News Desk. The deterministic article generators in
 * index.html block 4 are untouched; this is a new generator alongside them, and
 * the existing client `studioDraft()` path still works exactly as it did.
 *
 * ---- THE CLAIM DISCIPLINE ----
 *
 * Every segment degrades to an honest empty state rather than reaching. A week
 * with one finalized game has no index movement, so segment 1 says so instead
 * of inventing a climb; a matchup nobody has finished is described as in
 * progress, never as a result. `buildWeeklyPodcastScript` returns which
 * segments carried real material in `segments[].populated`, so a caller can
 * refuse to spend money on an episode that is mostly empty rooms.
 */

import type { FsnIndexRow, FsnIndexMover } from './fsn-index';
import { fsnIndexMovers } from './fsn-index';
import type { TrackedPlayer } from './article-math';
import type { PreviewMatchup, PreviewSide } from './article-generator';

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

export type PodcastHostTag = 'DAN' | 'STU';

export interface PodcastLine {
  host: PodcastHostTag;
  text: string;
}

export type PodcastSegmentKey = 'index_movers' | 'big_performers' | 'matchup_of_week' | 'waiver_lookout';

export interface PodcastSegment {
  key: PodcastSegmentKey;
  /** On-air name, also the reel card kicker. */
  title: string;
  lines: PodcastLine[];
  /** One headline for the Story Reel card and the episode's `stories` array. */
  headline: string;
  /** False when the data could not support the segment and it fell back to an
   *  honest "nothing to report" read. */
  populated: boolean;
}

export interface WeeklyPodcastScript {
  title: string;
  week: number;
  season: number;
  lines: PodcastLine[];
  stories: string[];
  segments: PodcastSegment[];
  /** How many of the four segments carried real material. */
  populatedSegments: number;
}

export interface BuildScriptInput {
  season: number;
  week: number;
  /** The FSN Index board through this week. */
  index: FsnIndexRow[];
  /** The board through the previous week, for movement. Empty in week 1. */
  previousIndex: FsnIndexRow[];
  /** Every evaluated starter for the week. */
  tracked: TrackedPlayer[];
  /** The week's matchups, already ordered by `orderPreviewMatchups`. */
  matchups: PreviewMatchup[];
  /** Optional league name for the cold open. */
  leagueName?: string;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/** Fantasy scoring carries two decimals; keep them out of speech. A voice
 *  model reading "112.40" says "one hundred twelve point four zero", so the
 *  script hands it one decimal and drops a trailing zero. */
function say(points: number): string {
  const rounded = Math.round(points * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function spots(count: number): string {
  const n = Math.abs(count);
  return n === 1 ? '1 spot' : n + ' spots';
}

/** Trim to the endpoint's per-line ceiling without cutting a word in half.
 *  `reserve` holds room for text the caller is going to add around this, so a
 *  fold can never truncate away the thing it was folding in. */
const MAX_LINE = 440;
function fit(text: string, reserve = 0): string {
  const budget = Math.max(80, MAX_LINE - reserve);
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= budget) return clean;
  const cut = clean.slice(0, budget);
  const boundary = cut.lastIndexOf(' ');
  return (boundary > 80 ? cut.slice(0, boundary) : cut).replace(/[\s,;:]+$/, '') + '.';
}

function line(host: PodcastHostTag, text: string): PodcastLine {
  return { host, text: fit(text) };
}

/* ------------------------------------------------------------------ *
 * Segment 1 — FSN Index Movers
 * ------------------------------------------------------------------ */

function moverPhrase(m: FsnIndexMover): string {
  const verb = m.direction === 'up' ? 'up' : 'down';
  return m.team.name + ' ' + verb + ' ' + spots(m.rankDelta) + ' to number ' + m.rank;
}

export function segmentIndexMovers(input: BuildScriptInput): PodcastSegment {
  const title = 'FSN Index Movers';
  const movers = fsnIndexMovers(input.previousIndex, input.index).filter((m) => m.rankDelta !== 0);
  const top = input.index[0];

  /* No previous board (week 1), or a board where nobody changed rank. Both are
     real and neither is a story, so say what the board DOES show. */
  if (!movers.length) {
    const headline = top
      ? top.team.name + ' leads the FSN Index at ' + say(top.index)
      : 'The FSN Index has no finalized week to rate yet';
    return {
      key: 'index_movers',
      title,
      headline,
      populated: false,
      lines: [
        line(
          'DAN',
          top
            ? 'Segment one, the FSN Index. Nobody changed places on the board this week, so the order stands: ' +
                top.team.name +
                ' holds number one at ' +
                say(top.index) +
                ' out of a hundred, on an all-play mark of ' +
                say(top.allPlay.pct) +
                ' percent.'
            : 'Segment one, the FSN Index. We have no finalized week to rate yet, so the board is empty and I am not going to pretend otherwise.',
        ),
        line(
          'STU',
          top
            ? 'A quiet week on the index is its own kind of statement, Dan. The teams at the top earned those seats and nobody took one off them.'
            : 'No board, no argument from me. We will have one the moment the league finalizes a week.',
        ),
      ],
    };
  }

  const lead = movers[0];
  /* The lead mover is named on its own, so it must not also appear in the list
     that follows it: "Delta up 2 spots to number 2. Up the board, Delta climbs
     2 spots to number 2" is what that reads like. */
  const rest = movers.slice(1);
  const up = rest.filter((m) => m.direction === 'up').slice(0, 2);
  const down = rest.filter((m) => m.direction === 'down').slice(0, 2);
  const headline =
    'FSN Index: ' + moverPhrase(lead) + (movers[1] ? ', ' + moverPhrase(movers[1]) : '');

  const climbers = up.length
    ? 'Also up the board, ' +
      up.map((m) => m.team.name + ' climbs ' + spots(m.rankDelta) + ' to number ' + m.rank).join(', and ') + '.'
    : 'Nobody else made a clean climb.';
  const fallers = down.length
    ? down.map((m) => m.team.name + ' slides ' + spots(m.rankDelta) + ' to number ' + m.rank).join(', and ')
    : 'nobody else took a real fall';

  return {
    key: 'index_movers',
    title,
    headline,
    populated: true,
    lines: [
      line(
        'DAN',
        'Segment one, FSN Index movers. The biggest swing on the board: ' +
          moverPhrase(lead) +
          ', an index move of ' +
          say(Math.abs(lead.indexDelta)) +
          ' points. ' +
          climbers,
      ),
      line(
        'STU',
        'And the other direction, Dan: ' +
          fallers +
          /* A faller's delta, because the sentence is about falling. Quoting
             the lead mover here put "you do not move 5 spots on one bad Sunday"
             immediately after naming a 5-spot CLIMB. */
          '. Remember what the index is measuring — all-play record, scoring, consistency and schedule. You do not move ' +
          spots(down.length ? down[0].rankDelta : lead.rankDelta) +
          ' on one bad Sunday unless the rest of it was already thin.',
      ),
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Segment 2 — Big Performers
 * ------------------------------------------------------------------ */

/** Over-projection first, then raw ceiling. A flagged row is a storyline the
 *  math already stands behind, so it leads regardless of total. */
function performerWeight(row: TrackedPlayer): number {
  const flagged = row.outcome_flag ? 1000 : 0;
  const over = row.projected_points == null ? 0 : row.player_points - row.projected_points;
  return flagged + row.player_points + Math.max(0, over);
}

function performerPhrase(row: TrackedPlayer): string {
  const base = row.player_name + ' put up ' + say(row.player_points) + ' for ' + row.owner_team;
  if (row.projected_points == null) return base;
  const over = row.player_points - row.projected_points;
  if (over >= 5) return base + ', beating his projection by ' + say(over);
  if (over <= -5) return base + ', short of his projection by ' + say(Math.abs(over));
  return base;
}

export function segmentBigPerformers(input: BuildScriptInput): PodcastSegment {
  const title = 'Big Performers';
  const board = (input.tracked || [])
    .filter((row) => Number.isFinite(row.player_points) && row.player_points > 0)
    .slice()
    .sort(
      (a, b) =>
        performerWeight(b) - performerWeight(a) ||
        (a.player_id < b.player_id ? -1 : a.player_id > b.player_id ? 1 : 0),
    );

  if (!board.length) {
    return {
      key: 'big_performers',
      title,
      headline: 'No scored starters in this week’s box score yet',
      populated: false,
      lines: [
        line(
          'DAN',
          'Segment two, big performers. The box score for this week has no scored starters in it yet, so there is nothing for me to read you.',
        ),
        line(
          'STU',
          'We will not invent a hero, Dan. When the points land, we will have the names.',
        ),
      ],
    };
  }

  const lead = board[0];
  const support = board.slice(1, 3);
  /* A winner the math attributes to this player, in the math's own words. */
  const decisive = board.find((row) => row.outcome_flag === 'GAME_WINNER');
  const valiant = board.find((row) => row.outcome_flag === 'VALIANT_LOSS');

  return {
    key: 'big_performers',
    title,
    headline: performerPhrase(lead),
    populated: true,
    lines: [
      line(
        'DAN',
        'Segment two, big performers. Top of the board: ' +
          performerPhrase(lead) +
          '.' +
          /* Raw numbers for the supporting names. performerPhrase() appends a
             projection clause, and three of those in one breath reads as
             "beating his projection by 5, beating his projection by 5, beating
             his projection by 5" whenever the deltas happen to match. The lead
             keeps its clause, where the comparison is the story. */
          (support.length
            ? ' Behind him, ' +
              support
                .map((row) => row.player_name + ' put up ' + say(row.player_points) + ' for ' + row.owner_team)
                .join(', and ') + '.'
            : ''),
      ),
      line(
        'STU',
        /* "and it finished by N" is a RESULT claim, and the matchup segment
           below refuses to make it on the same data: ESPN leaves both side
           totals at 0 until a period closes, which is why final_margin cannot
           carry an outcome mid-week. State the swing the math flagged instead.
           And no possessive - a voice model reads "Bandits's" as "Bandits-iz". */
        (decisive && decisive.final_margin != null
          ? 'The one that moved a result, Dan: ' +
            decisive.player_name +
            ' swung the ' +
            decisive.owner_team +
            ' matchup by ' +
            say(Math.abs(decisive.final_margin)) +
            '. '
          : '') +
          (valiant
            ? valiant.player_name +
              ' did everything asked of him and ' +
              valiant.owner_team +
              ' lost anyway, which is the cruellest line in this sport. '
            : '') +
          'Points are points, but the ones that move a result are the ones the group chat remembers.',
      ),
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Segment 3 — Matchup of the Week
 * ------------------------------------------------------------------ */

/**
 * The matchup worth the deep dive: the highest-stakes board.
 *
 * Stakes here is the combination the brief asks for — closest, and
 * highest-scoring — resolved deterministically. A matchup with a real margin
 * and real points on the board outranks one with neither, a tighter margin
 * outranks a looser one, and total points break the tie so a nail-biter
 * between two good teams beats a nail-biter between two bad ones.
 */
export function pickMatchupOfWeek(matchups: PreviewMatchup[]): PreviewMatchup | null {
  const scored = (matchups || []).filter((m) => m && m.live && (m.a.scored > 0 || m.b.scored > 0));
  if (!scored.length) return null;
  return scored.slice().sort((x, y) => {
    const xm = x.margin == null ? Number.POSITIVE_INFINITY : x.margin;
    const ym = y.margin == null ? Number.POSITIVE_INFINITY : y.margin;
    if (xm !== ym) return xm - ym;
    const xt = x.a.scored + x.b.scored;
    const yt = y.a.scored + y.b.scored;
    if (xt !== yt) return yt - xt;
    return x.matchup_id < y.matchup_id ? -1 : x.matchup_id > y.matchup_id ? 1 : 0;
  })[0];
}

function topStarter(side: PreviewSide): TrackedPlayer | null {
  const played = (side.played || []).filter((row) => Number.isFinite(row.player_points));
  if (!played.length) return null;
  return played.slice().sort(
    (a, b) =>
      b.player_points - a.player_points ||
      (a.player_id < b.player_id ? -1 : a.player_id > b.player_id ? 1 : 0),
  )[0];
}

export function segmentMatchupOfWeek(input: BuildScriptInput): PodcastSegment {
  const title = 'Matchup of the Week';
  const pick = pickMatchupOfWeek(input.matchups);

  if (!pick) {
    return {
      key: 'matchup_of_week',
      title,
      headline: 'No matchup has points on the board yet',
      populated: false,
      lines: [
        line(
          'DAN',
          'Segment three, matchup of the week. Nothing on this slate has points on the board yet, so there is no board to break down.',
        ),
        line('STU', 'Hold that one, Dan. A matchup with no points is not a story, it is a schedule.'),
      ],
    };
  }

  /* Leader first, so the copy never describes a trailing side as being ahead. */
  const [front, back] =
    (pick.a.margin || 0) >= (pick.b.margin || 0) ? [pick.a, pick.b] : [pick.b, pick.a];
  const margin = pick.margin == null ? null : pick.margin;
  const star = topStarter(front);
  const otherStar = topStarter(back);

  /* `complete` is the only thing allowed to make this a result. Anything else
     is described as still running, however lopsided the numbers look. */
  /* The three cases are genuinely different and collapsing them produced
     nonsense: with no kickoff clock every starter reads as played, so
     `remaining` is 0 while `complete` is still false, and the copy said
     "leads 92 to 90.6 with 0 starters still to play ... it is still a live
     matchup". Every starter being in is not the same as the platform having
     posted the result, and neither is the same as starters left to play. */
  const allIn = !pick.complete && pick.remaining === 0;
  const ahead = front.team + ' leads ' + say(front.scored) + ' to ' + say(back.scored);
  const standing = pick.complete
    ? front.team + ' took it ' + say(front.scored) + ' to ' + say(back.scored)
    : allIn
      ? ahead + ' with every starter in'
      : ahead + ' with ' + pick.remaining + ' starter' + (pick.remaining === 1 ? '' : 's') + ' still to play';

  return {
    key: 'matchup_of_week',
    title,
    headline: standing + (margin == null ? '' : ', a ' + say(margin) + ' point gap'),
    populated: true,
    lines: [
      line(
        'DAN',
        'Segment three, matchup of the week: ' +
          front.team +
          ' and ' +
          back.team +
          '. ' +
          standing +
          (margin == null ? '.' : ', a gap of ' + say(margin) + ' points.') +
          (star ? ' ' + star.player_name + ' led the way with ' + say(star.player_points) + '.' : ''),
      ),
      line(
        'STU',
        (otherStar
          ? otherStar.player_name +
            ' answered with ' +
            say(otherStar.player_points) +
            ' for ' +
            back.team +
            ', and it still was not enough to flip it. '
          : '') +
          (pick.complete
            ? 'That is the closest finished board on the slate, Dan, and closest is where the standings actually get decided.'
            : allIn
              ? 'Every starter is in and I still will not call it, Dan. Until the platform posts that one official, it is a lead and not a result.'
              : 'I am not calling that one, Dan. ' +
                pick.remaining +
                ' starter' +
                (pick.remaining === 1 ? '' : 's') +
                ' still to play means it is still a live matchup.'),
      ),
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Segment 4 — Waiver Lookout
 * ------------------------------------------------------------------ */

export interface WaiverNeed {
  team: string;
  player: string;
  shortfall: number;
  points: number;
  projected: number;
}

/**
 * Where each team needs help, evidenced by its own starters.
 *
 * ---- WHY SHORTFALLS AND NOT NAMED PICKUPS ----
 *
 * A recommendation to add a specific free agent needs a free-agent
 * availability feed, and there is none on this path: the ESPN read this
 * pipeline makes returns the league's own box scores, not who is unowned. So
 * this segment reports the holes the week actually exposed — the starters who
 * came in furthest under their own projection — and leaves the name of the
 * replacement to the manager. Inventing an available player would be the one
 * thing this whole pipeline is built not to do.
 *
 * Minimum shortfall so a starter who missed by a point is not called a hole.
 */
export const WAIVER_SHORTFALL_FLOOR = 6;

export function waiverNeeds(tracked: TrackedPlayer[], limit = 3): WaiverNeed[] {
  const needs: WaiverNeed[] = [];
  const seenTeams = new Set<string>();

  const candidates = (tracked || [])
    .filter((row) => row.projected_points != null && Number.isFinite(row.projected_points))
    .map((row) => ({
      row,
      shortfall: (row.projected_points as number) - row.player_points,
    }))
    .filter((entry) => entry.shortfall >= WAIVER_SHORTFALL_FLOOR)
    .sort(
      (a, b) =>
        b.shortfall - a.shortfall ||
        (a.row.player_id < b.row.player_id ? -1 : a.row.player_id > b.row.player_id ? 1 : 0),
    );

  /* One entry per team: four holes on one roster is one team's problem, and
     the segment is a league-wide lookout. */
  for (const entry of candidates) {
    if (seenTeams.has(entry.row.owner_team)) continue;
    seenTeams.add(entry.row.owner_team);
    needs.push({
      team: entry.row.owner_team,
      player: entry.row.player_name,
      shortfall: entry.shortfall,
      points: entry.row.player_points,
      projected: entry.row.projected_points as number,
    });
    if (needs.length >= limit) break;
  }
  return needs;
}

export function segmentWaiverLookout(input: BuildScriptInput): PodcastSegment {
  const title = 'Waiver Lookout';
  const needs = waiverNeeds(input.tracked);

  if (!needs.length) {
    return {
      key: 'waiver_lookout',
      title,
      headline: 'No starter missed projection badly enough to force a move',
      populated: false,
      lines: [
        line(
          'DAN',
          'Segment four, the waiver lookout. Nobody in this league had a starter miss badly enough to force a move, so the wire is quiet going into midweek.',
        ),
        line(
          'STU',
          'Enjoy it while it lasts, Dan. A quiet wire is a one week condition in this league.',
        ),
      ],
    };
  }

  const lead = needs[0];
  const rest = needs.slice(1);

  return {
    key: 'waiver_lookout',
    title,
    headline:
      'Waiver lookout: ' +
      needs.map((n) => n.team + ' needs an answer after ' + n.player).join(', '),
    populated: true,
    lines: [
      line(
        'DAN',
        'Segment four, the waiver lookout. The clearest hole on the board belongs to ' +
          lead.team +
          ': ' +
          lead.player +
          ' was projected for ' +
          say(lead.projected) +
          ' and returned ' +
          say(lead.points) +
          ', a miss of ' +
          say(lead.shortfall) +
          '.' +
          (rest.length
            ? ' Also shopping: ' +
              rest.map((n) => n.team + ', after ' + n.player + ' missed by ' + say(n.shortfall)).join(', and ') +
              '.'
            : ''),
      ),
      line(
        'STU',
        'That is where the claims go in, Dan. I am not telling you who is out there, because that is your league’s wire to read, not mine. But ' +
          lead.team +
          ' cannot start that spot again and expect a different number.',
      ),
    ],
  };
}

/* ------------------------------------------------------------------ *
 * The episode
 * ------------------------------------------------------------------ */

export const PODCAST_SEGMENT_ORDER: PodcastSegmentKey[] = [
  'index_movers',
  'big_performers',
  'matchup_of_week',
  'waiver_lookout',
];

/**
 * Build the week's four-segment episode.
 *
 * The line order is a cold open, the four segments in order, and a sign-off,
 * alternating Dan and Stu so the stitched audio never plays one voice twice in
 * a row. Callers hand `lines` straight to the synthesis path and `stories` to
 * the Story Reel.
 */
export function buildWeeklyPodcastScript(input: BuildScriptInput): WeeklyPodcastScript {
  const week = Math.max(1, Number.parseInt(String(input.week), 10) || 1);
  const season = Number.parseInt(String(input.season), 10) || 0;

  const segments: PodcastSegment[] = [
    segmentIndexMovers(input),
    segmentBigPerformers(input),
    segmentMatchupOfWeek(input),
    segmentWaiverLookout(input),
  ];

  const populatedSegments = segments.filter((s) => s.populated).length;
  const leagueName = String(input.leagueName || '').trim();

  const lines: PodcastLine[] = [];
  for (const segment of segments) lines.push(...segment.lines);

  /* ---- THE SHOW OPEN AND THE SIGN-OFF ARE FOLDED, NOT ADDED ----
     Each segment is a Dan turn then a Stu turn, so the whole episode already
     alternates. Giving the open a Dan turn of its own would put Dan
     immediately before Dan's segment-one line, and two consecutive turns by
     one host stitch into a single continuous block of that voice — the
     back-and-forth the two-host format exists for disappears at exactly the
     moment the listener starts. Same at the other end for Stu.

     So the open rides on the first turn and the sign-off on the last, which
     also removes two ElevenLabs calls from every episode. `fit` is given the
     added length as `reserve`, so trimming eats the segment body rather than
     the open or the sign-off. */
  const open =
    'FSN weekly recap, week ' + week + (leagueName ? ', ' + leagueName : '') + '. Dan and Stu, four segments.';
  const close = 'That is week ' + week + ' on the FSN desk. We will see you on the next slate.';

  const first = lines[0];
  lines[0] = { host: first.host, text: open + ' ' + fit(first.text, open.length + 1) };
  const lastIndex = lines.length - 1;
  const last = lines[lastIndex];
  lines[lastIndex] = { host: last.host, text: fit(last.text, close.length + 1) + ' ' + close };

  return {
    title: 'WEEK ' + week + ' RECAP',
    week,
    season,
    lines,
    stories: segments.map((s) => s.headline),
    segments,
    populatedSegments,
  };
}
