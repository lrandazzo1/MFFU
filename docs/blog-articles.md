# FSN league blog articles

The foundation for AI-written league stories on the public blog. Three pieces:
a Supabase table, a math layer that decides what a performance meant, and a
pipeline service that composes copy against that math and publishes it.

It is additive. It reads box scores and writes one new table. It does not touch
`index.html`, the News Desk generators (block 4), the historical pipelines, the
`leagues` table, or the existing file-based `landing/content/blog` ingestion.

## Pieces

| File | Role |
|---|---|
| `supabase/blog_articles.sql` | The `public.blog_articles` table, indexes, RLS, trigger. |
| `lib/article-math.ts` | `calculatePlayerOutcomeFlags()` — margins and strict outcome flags. |
| `lib/article-generator.ts` | `generateAndPublishBlogArticle()` — fetch, classify, compose, guard, write. |
| `lib/article-selftest.js` | `npm run test:articles`. Runs against the compiled output. |

The two modules are TypeScript, compiled to `lib/dist/` by
`npm run build:articles` (`tsconfig.articles.json`). The compiled output is
committed because `vercel.json` sets an empty `buildCommand`: the deploy serves
the repository as-is, so a `.js` route requiring `lib/dist/article-generator`
must find it already there. `npm run test:articles` rebuilds first, so a stale
`lib/dist` fails the test run rather than the deploy.

## The math

Margins are always stated from the perspective of the team that started the
player. Positive is a lead, negative is a deficit.

- `entering_margin` — the matchup margin **before this player's NFL game kicked
  off**, computed from the points of starters on both sides whose own games had
  already kicked off. Bench and IR are excluded: their points are never on the
  board.
- `final_margin` — the finished matchup margin.

If any starter in the matchup is missing a kickoff time, `entering_margin` is
returned as `null` with `unresolved_reason: 'MISSING_KICKOFF_DATA'` and no flag
is assigned. Points that cannot be placed in time would silently manufacture a
deficit that never existed, so partial data is refused rather than approximated.

### The flags

| Flag | Condition |
|---|---|
| `GAME_WINNER` | `entering_margin < 0` and `final_margin > 0` and `player_points >= abs(entering_margin)` |
| `GARBAGE_TIME_BLOWOUT` | `entering_margin > 20` and `final_margin > 20` |
| `VALIANT_LOSS` | `final_margin < 0` and `player_points > 20` |
| `DUD_COST_WIN` | `entering_margin > 0` and `final_margin < 0` and `player_points < projected_points - 5` |

Evaluated in that order. A row matching nothing gets `outcome_flag: null`,
which means "nothing decisive happened" and is a real answer, never upgraded
into a story.

## The guardrail

The framing rule is handed to the model as a system instruction
(`OUTCOME_FRAMING_RULE`, quoted verbatim in `buildSystemPrompt`) **and**
enforced afterwards by `assertOutcomeLanguage`, sentence by sentence. Hero and
game-saver language is allowed only in a sentence that names a player the math
flagged `GAME_WINNER`. Em dashes are rejected too, matching the copy contract in
`scripts/build-blog.mjs`.

A violation throws. Nothing is rewritten in place (that would publish copy
nobody reviewed) and nothing is written to the table.

`defaultComposer` is a deterministic, model-free writer used when no composer is
injected. It keeps the pipeline runnable without model credentials and is the
reference for what compliant framing reads like: a `VALIANT_LOSS` is "a monster
game, wasted", a `GARBAGE_TIME_BLOWOUT` is "unneeded stat-padding".

## Calling it

```js
const { generateAndPublishBlogArticle } = require('../lib/dist/article-generator');

await generateAndPublishBlogArticle(
  { league_id: '123456', season: 2026, week: 2, day: 'tue' },
  { req },            // forwarded to the ESPN read boundary in api/espn
);
```

`day` maps to `article_type`: `mon` → `monday_sweat`, `tue` →
`tuesday_verdict`, `fri` → `friday_tnf_preview`.

Injectable dependencies: `db` (Supabase client), `fetchBoxScores`, `compose`
(a model-backed writer), `req`, `now`. Defaults are a service-role client from
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, the `api/espn` boundary, the local
composer, and the system clock.

The slug is deterministic — `<season>-week-<n>-<day-slug>-<league_id>` — and the
write is an upsert on it, so re-running a day overwrites its own row instead of
stacking duplicates.

## Failure behaviour

Every failure is logged with its subsystem tag (`[ArticleMath]`,
`[ArticleGenerator]`), the scope that failed, and the error object, then
rethrown. Nothing is swallowed: a resolved promise means there is a row in
`blog_articles`. A bad scope is rejected before any fetch or write happens.
