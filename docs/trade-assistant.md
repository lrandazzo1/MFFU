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

## In-app AI GM Beta: linked two-team trades

`lib/ai-gm.js` uses one validator for the 2-Team board and each leg of a
3-Team route. Step 1 must stand alone. Step 2 is valued against the actual
roster after Step 1. Either failed leg rejects the whole route. Each leg can
send and receive one or two players; retained broker assets and additional
original players appear in the final roster ledger. Unequal packages must fit
the roster capacity without an unmodeled drop.

Both sides must meet market-value and roster checks. The dated
`lib/data/trade-market-2026.json` snapshot uses [FantasyCalc redraft trade
values](https://fantasycalc.com/trade-value-chart) for 12-team, 1QB PPR in 2026.
`npm run refresh:trade-market` validates and replaces it; scoring does not
make a network request or use weekly points as prices. Missing chart identities
can use ESPN draft rank on the same market scale, with that source disclosed.
Missing prices or unsupported season/scoring formats fail closed. An explicit
market override can supply a different format.

Package totals must match within 15%. Top-ten RB/WR assets, the chart's top-two
QBs, Josh Allen, Lamar Jackson and Saquon Barkley receive elite protection.
Elite involvement always requires a multi-player package, even for elite-for-
elite exchanges. A non-elite return must include two meaningful assets, each
at least 20% of the elite asset's value and within the top 100 market ranks,
and total at least 110% of its value. Cheap filler cannot bypass the rule.
Rice, Cook and Jones cannot serve as an elite singleton return, regardless of
chart or projection overrides.

Positional holes and depth drive route ranking. A neutral or negative delta
qualifies only when the roster sends viable surplus to fill an understaffed
starter position. Ordinary backup depth alone cannot excuse a loss. The loss
cap is the smaller of 1.5 points and 2% of the lineup. No deal may reduce
existing viable coverage below the required starter count. Viability requires
at least 75% of the league median projection and an available injury status.
These are market and roster heuristics, not guaranteed manager acceptance.

Cards show every player in Step 1, Step 2 and Final Roster Impact, each leg's
market totals and your isolated delta, plus why each partner agrees. Negative
deltas use loss styling. All managers should agree before submitting either
trade, particularly when the independently valid first leg has a small loss.
The headers report actual evaluated packages and displayed routes.

`npm run check:aigm` covers isolated leg rejection, actual bridge ownership,
market/elite packaging, scarcity and loss caps, package ledgers, deterministic
ordering, handler access controls, and mobile card rendering.
