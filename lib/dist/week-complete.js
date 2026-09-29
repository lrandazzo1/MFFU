"use strict";
/**
 * IS A WEEK'S BOX SCORE CLOSED?
 *
 * One question, asked of the NFL scoreboard: has every game of a given regular
 * season week finished? The scheduled Tuesday podcast run is not allowed to
 * narrate a week until the answer is yes, because the recap it builds reads the
 * article pipeline's evaluated stat lines and those are only true once the
 * Sunday slate and the Monday night game are in the books.
 *
 * ---- WHY THE NFL SCOREBOARD AND NOT THE FANTASY LEAGUE PAYLOAD ----
 *
 * Completion is a property of the NFL week, not of any one league, so asking it
 * once per run rather than once per league is both cheaper and more consistent:
 * every league in the sweep gets the same answer for the same week. The fantasy
 * endpoint would also answer, but only per league, only behind that league's
 * credentials, and it leaves `winner` on UNDECIDED for hours after the whistle
 * while stat corrections settle — which is exactly the state this gate must
 * treat as finished.
 *
 * The host is `site.api.espn.com`, already on the schedule feed's allowlist and
 * already fetched by the push dispatcher, and the URL is built by that feed's
 * own `scoreboardUrl()` so there is one place that knows the query shape.
 *
 * ---- WHAT IT DELIBERATELY DOES NOT DO ----
 *
 * It does not guess. A week the scoreboard reports no games for is `complete:
 * false` with `games: 0`, not "probably finished": "I cannot see this week" and
 * "this week is over" need different answers from the caller, and defaulting the
 * unknown to complete is how a scheduled run narrates a week that has not been
 * played. The client half of this gate — `weekBoxScoresComplete()` in
 * index.html — refuses the same way for the same reason.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseWeekCompletion = parseWeekCompletion;
exports.nflWeekCompletion = nflWeekCompletion;
const FETCH_TIMEOUT_MS = 8000;
/**
 * Pure. Counts the games in a scoreboard document and how many have finished.
 *
 * ESPN carries the status in two places and has shipped both as the only one:
 * on the event itself, and on the event's first competition. A game counts as
 * finished when either says `completed`, or when either reports the `post`
 * state — a game that has been played and is awaiting its final stat pass is
 * over for the purposes of a recap.
 */
function parseWeekCompletion(payload) {
    const doc = payload && typeof payload === 'object' ? payload : {};
    const events = Array.isArray(doc.events) ? doc.events : [];
    let completed = 0;
    for (const event of events) {
        if (eventFinished(event))
            completed += 1;
    }
    return { games: events.length, completed };
}
function eventFinished(event) {
    if (!event || typeof event !== 'object')
        return false;
    const competitions = Array.isArray(event.competitions) ? event.competitions : [];
    const statuses = [event.status, ...competitions.map((c) => c && c.status)];
    for (const status of statuses) {
        const type = status && status.type;
        if (type && type.completed === true)
            return true;
        const state = String((type && (type.state || type.name)) || '').toUpperCase();
        if (state === 'POST' || state.includes('FINAL'))
            return true;
    }
    return false;
}
/**
 * One scoreboard read for one week.
 *
 * Throws on a transport or shape failure rather than reporting an incomplete
 * week, because the caller's two outcomes are "do not generate yet" (a real
 * open week, which is an ordinary skip) and "this run could not tell" (which is
 * a fault worth seeing in the logs). Collapsing the second into the first would
 * make a broken feed look like a season of permanently unfinished weeks.
 */
async function nflWeekCompletion(input) {
    const season = Number(input.season);
    const week = Number(input.week);
    const doFetch = input.fetchImpl || globalThis.fetch;
    if (typeof doFetch !== 'function')
        throw new Error('NO_FETCH_AVAILABLE');
    const scheduleFeed = require('../notifications/schedule-feed');
    const url = scheduleFeed.scoreboardUrl({ season, week, seasonType: 2 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs || FETCH_TIMEOUT_MS);
    let response;
    try {
        response = await doFetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (!response || !response.ok) {
        throw new Error('WEEK_STATUS_HTTP_' + String(response && response.status));
    }
    const body = await response.text();
    let payload;
    try {
        payload = JSON.parse(body);
    }
    catch (err) {
        /* The parse error travels with the throw rather than being swallowed: the
           caller logs this object, and "the feed answered HTML" and "the feed
           answered truncated JSON" are different problems. */
        throw Object.assign(new Error('WEEK_STATUS_BODY_NOT_JSON'), { cause: err });
    }
    const counts = parseWeekCompletion(payload);
    return {
        season,
        week,
        games: counts.games,
        completed: counts.completed,
        complete: counts.games > 0 && counts.completed === counts.games,
        source: url,
    };
}
