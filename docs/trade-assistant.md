# AI GM Trade Assistant

A private, offline-capable trade analyser for an ESPN fantasy football league.
It reads every roster in the league, rebuilds each team's optimal starting
lineup against that league's own slot rules, and proposes packages that raise
both teams' projected scores — with a ready-to-send DM for each one.

```bash
npm run check:trade                     # offline self-test, no network
npm run trade                           # league 57155288, current week
node scripts/trade-assistant.mjs --help
```

## Why it is a script and not an endpoint

`api/` is at **12 of the 12** Serverless Functions this deployment plan allows
(`npm run check:functions`). A thirteenth file does not fail the build — it
fails the *deploy* at `patchBuild` with
`exceeded_serverless_functions_per_deployment` and takes production down with
it. This is a private GM aid rather than a reader-facing feature, so it lives
in `scripts/` and costs the deployment nothing.

If it ever needs to be served, it goes behind an `?action=` rewrite on an
existing route — the pattern `/api/notifications-register`,
`/api/transaction-wire-dispatch`, `/api/auth/yahoo/callback` and
`/api/blog/articles/publish` already use.

## Credentials

```bash
export ESPN_SWID='{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}'
export ESPN_S2='AEB...'
```

Both or neither. ESPN authenticates on the **pair**, and half a credential
pairs one account's `SWID` with another's `espn_s2` — a refusal that reads
exactly like an expired session. The script says so rather than letting you
guess, and reads anonymously (which works for a public league) when neither is
set. Values are sanitised through `lib/espn-cookies.js`, the same module
`api/espn.js` and `api/league.js` use, so a paste wrapped in quotes, braces or
a DevTools soft line-wrap still works.

With `ESPN_SWID` set and no `--team`, the script matches that SWID against each
team's owner member ids — an exact match, not a name guess.

**Network:** the read goes to `lm-api-reads.fantasy.espn.com`. A sandboxed or
restricted environment must have that host allowed or the fetch returns 403.

## Options

| Flag | Meaning |
|---|---|
| `--league=ID` | ESPN league id (default `57155288`) |
| `--season=YYYY` | season (default `2026`) |
| `--week=N` | scoring period to project (default: the league's current week) |
| `--team=ID\|NAME\|OWNER` | which roster is mine (default: matched from `ESPN_SWID`) |
| `--limit=N` | how many offers to print (default 3) |
| `--pool=N` | tradeable players considered per side, 3–16 (default 10) |
| `--min-partner-gain=X` | pts/week the other team must gain (default 0.5) |
| `--json` | machine-readable output instead of the report |
| `--out=FILE` | also write the output to a file |
| `--fixture=FILE` | analyse a saved payload instead of fetching |
| `--dump=FILE` | save the fetched ESPN payload |
| `--self-test` | offline determinism and lineup-math checks |

`--dump` then `--fixture` is the way to work on a plane, or to re-run last
week's board against this week's logic.

## How the numbers are produced

**Optimal lineup.** Assigning players to lineup slots is a *transversal
matroid*: a set of players is startable together exactly when it has a perfect
matching into the slots. So the greedy algorithm on that matroid — walk players
in descending projection, keep each one whose addition leaves the set still
matchable (Kuhn's augmenting path) — returns the maximum-weight basis, which is
the true optimal lineup.

The usual shortcut, filling the most-constrained slot first, is only optimal
when the eligibility sets nest. They do not: `RB/WR` (slot 3) and `WR/TE` (slot
5) overlap without either containing the other, and a league running both would
be mis-scored. The exact matching costs nothing at this size.

Eligibility comes from each player's own ESPN `eligibleSlots`, falling back to a
position table only when a payload omits it.

**Projections.** ESPN's own weekly forecast (`statSourceId` 1, `statSplitTypeId`
1) for the exact target week. The week match is exact because a player card
carries every week of the season and a loose match lets week 3 answer a week 11
question. Fallbacks, most specific first: the season forecast spread over 17
games, then the player's actual per-game average, then `null` — never a
fabricated number.

**Need.** *Upgrade headroom*: plug a median league starter at that position into
the roster, re-solve the lineup, keep the gain. A position already above the
league's middle gains nothing and is not a need, however thin it looks.

This replaced a measure that ranked positions by what the lineup would lose if
the weakest starter there vanished — which names the *elite QB with no backup*
as the biggest deficit and the replacement-level RB2 as fine, exactly backwards.
The self-test asserts the corrected behaviour on a fixture built to expose it.

**Surplus.** Points the lineup loses if the best bench player at that position
disappeared. `0.0` means he is neither starting nor one injury from starting —
which is precisely what you trade away.

**Offers.** Every package of one or two players from each side is applied to
both rosters and both optimal lineups are re-solved. A package survives only if
it raises both. No trade-value chart that goes stale in a week; the lineup
either scores more on Sunday or it does not. Offers are ranked by your own gain,
spread one-per-manager before repeating a partner, and drawn from skill
positions only (kickers and defenses are not traded and would swamp the search
with noise).

**Injury designations** are reported on every offer but not re-penalised —
ESPN's weekly forecast already discounts a player who will not play, and
subtracting twice would quietly hide real deals.

## Determinism

No `Math.random()`, no `Date.now()`, no network call and no model call in any
scoring, matchmaking or copy path. Every tie is broken on player id, so the same
payload yields byte-identical output every run. That is what makes
`--self-test` meaningful, and what lets you diff this week's board against last
week's to see what actually changed.

The self-test asserts it directly: it runs the full report twice and compares,
and it greps the scoring section of its own source for clock and randomness
calls.

## What the self-test covers

`npm run check:trade` — offline, no network, ~0.3s:

- optimal lineup math, including the non-nested `RB/WR` + `WR/TE` case
- an unfillable slot scoring zero rather than crashing
- eligibility fallback for payloads without `eligibleSlots`
- exact-week projection reading, and each fallback in the chain
- the lineup template being read from the league's own settings
- team and ESPN owner resolution from the payload
- the RB hole — not the elite QB — being named as the deficit
- both gain floors, offer ranking, `--min-partner-gain`, partner spread
- **pitch coherence**: no pitch calls one position both a surplus and a hole
- **pitch accuracy**: no starter is described to a rival as bench depth
- byte-identical output across two runs

The last two exist because the first draft of the pitch generator wrote its copy
from the package's positions instead of the roster's facts, and produced a DM
calling RB both "where I am long" and "where my lineup has the hole" — in
consecutive sentences.

## Scope

This tool only reads. It sends nothing to ESPN, posts nothing, and writes
nothing outside the file you name with `--out` or `--dump`. Copy a pitch into
ESPN chat or a DM yourself.

## In-app AI GM Beta: three-team roster fit

`lib/ai-gm.js` powers the in-app desk. Its three-team search prioritizes
positional holes and usable depth before weekly points. A team can accept a
neutral or negative delta only when it receives a useful starter or its first
viable backup and sends a player from positional surplus. A viable player has
at least 75% of the league's median projection at that position. No deal can
reduce existing viable coverage below the league's required starter count.
Weekly losses are capped at the smaller of 2 points and 5% of the lineup.

Every one-for-one exchange, including the intermediate player held after
Step 1, must pass tier protection. Tiers use ESPN draft pedigree, season
forecast, established production and starter usage; weekly projections are a
fallback when season data is absent. Elite assets require elite or comparable
high-value returns. Streamers cannot become a bridge to an elite asset.
These are conservative roster heuristics, not a promise of manager acceptance.

Both card types show Step 1 with Team A, Step 2 with Team B, and Final Roster
Impact, with a reason for each manager. A negative intermediate delta still
requires agreement from all three managers before submission. The 2-Team
header reports the actual total packages evaluated, rather than the count of
positive packages. The 3-Team header reports the number of displayed routes.

`npm run check:aigm` covers neutral and negative depth trades, loss limits,
elite protection, exhaustive search agreement, deterministic ordering,
handler access controls, and mobile card rendering.
