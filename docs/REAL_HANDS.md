# Trainer data V1 + V2: modes, audit and workflow

## Learning modes (scores are never mixed)

| Mode | Content | Answer source | Scoring |
|---|---|---|---|
| **Fundamentals** | Pot odds at real decisions; Math Lab; 23 *assumed-range model* scenarios | Exact arithmetic / EVs under explicitly stated ranges | Accuracy only. **Never** moves strategy Elo. Labelled "Assumed-range model", never "solver-verified" |
| **Real Hand Replay** | 78,704 accepted real decisions | None — the observed action is historical behaviour | Not graded, no Elo. Reasoning, confidence and response time recorded |
| **Reviewed Strategy** | Real decisions with a **verified** annotation; GTO Quiz (own push/fold solver, postflop-solver flops) | Human review, calculation or solver — source, method, assumptions, scope and confidence recorded | EV loss vs best supported action with explicit tolerance; mixed solver actions accepted. Elo only in rated mode, only on held-out assessment hands |

## V2 audit (Poker_Real_Hand_Source_v2)

Every hand was rebuilt on this project's rules engine and every supplied record compared with it. Nothing is repaired; disagreements are quarantined with a reason (`GET /api/real/coverage`, `docs/v2-audit-report.json`).

| Records | Accepted | Quarantined | Reasons |
|---|---|---|---|
| Hands | 52,483 | 40 | 37 unsupported (Omaha/Flipout), 2 inconsistent GG blind sequences, 1 pot total mismatch |
| Decisions | 78,704 | 117 | 59 from quarantined hands; **58 wrong supplied call amounts** (short all-in big blind: supplier ignored that the full blind was still the bet) |
| Pot-odds quizzes | 11,347 (2,998 terminal, 8,349 assume no future betting) | 939 | **920 supplied answers used the whole pot when Hero calls all-in for less** (e.g. 19.3% supplied vs 34.8% correct); 15 third player all-in; 6 underlying decision invalid |

Checks: card uniqueness, board progression (each street repeats the previous board), seats/button/blinds, action order and legality (engine), stack ledger, raise-to vs increment, uncalled bet returns vs history, main/side pots and Hero eligibility, short all-in reopening, folded/all-in players acting, chip conservation, total pot and per-player collected amounts. Notes (not errors): 58 histories record a fold by an all-in player (treated as forfeit); 5 split pots give the odd chip to a different winner.

Engine/parser fixes found by the audit: GG prints `shows` twice for all-ins (merged); Hero may show one card; required equity everywhere now uses the pot Hero can actually win.

Real-hand regression fixtures (`packages/core/test/fixtures/real-anon.txt`, anonymised: names, IDs, dates replaced): multiway side pots, short all-in that does not reopen, uncalled return, short big blind, all-in-for-less pot odds, Hero shows one card, duplicated shows, forfeit fold, heads-up postflop call.

## Leakage rules

The question payload contains only the table as Hero saw it: current board, own cards, history so far, legal actions. Never: future cards, opponent cards, observed action, review tags (`hero_all_in`…), outcome, raw history. The observed action and the rest of the hand are returned only after an answer is submitted (and labelled historical). Raw histories never leave the server; the build fails if scenario answers reach the client bundle.

## Splits and anti-farming

Tournaments are ordered by start time; the latest 20% are held out (**assessment**: 12,849 decisions), the rest are **training** (65,855). A tournament — and therefore every decision of a hand — is in exactly one split. Strategy Elo updates only on assessment decisions, in rated mode, with a verified EV annotation; repeated exposure of the same hand family is discounted (1 → 0.5 → 0.25 → 0).

## Annotation workflow

Review queue filters: street, stack depth, pot, multiway, amount faced/invested, tournament format, annotation status, quarantined records. Each annotation stores: decision ID, version, information available, assumed ranges + justification, chip EV / ICM / bounty assumptions, missing information, evaluated actions and sizes, recommendation, explanation (VI required, EN optional), confidence, scope, source (calculation / human / solver) and solver metadata. All annotations start as **draft**; AI- or system-generated ones are never auto-verified. Verifying creates no edit — a newer version retires the older one; attempts keep the annotation version that graded them and metrics report each standard separately. Frequencies are only accepted from a solver; qualitative annotations show a recommendation but no grade.

**Status:** 1,097 *draft* solver annotations were generated automatically for exact heads-up push/fold spots (this project's equilibrium; scope and rounding stated). **0 are verified** — they await human review, so no real decision is strategy-graded yet.

## Curriculum topics

Computed only from information available at the decision: calling vs initiating a shove, top pair/overpair vs strong action, turn changes the board, draws and dirty outs, value betting, bluffing, multiway/bounty, "they block each other's aces". Topics are review prompts, not mistake labels. Low confidence or verified mistakes schedule the *concept* (SM-2), and the next exercise picks a different hand testing the same concept.

## Import (server-side only)

```bash
cd apps/server
npx tsx scripts/v2-audit.ts <real-hand-source dir> <out dir>          # audit report only
npx tsx scripts/import-v2.ts <user email> <real-hand-source dir>       # ~60 s for 52k hands, idempotent
```

## V1 (Poker_Scenario_Source_v1)

Not received — only the V2 package was uploaded. The app's existing 23 assumed-range scenarios already follow the V1 rules (supplied range and response policy shown, "Assumed-range model" label, Fundamentals scoring). V1 import is pending the file and its CLAUDE_README/audit.
