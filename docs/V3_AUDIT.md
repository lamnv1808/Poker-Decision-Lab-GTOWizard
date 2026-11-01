# V3 audit — starting point and design

Audit of the code as of `main@b2d8112` (V1+V2 trainer data deployed, 52,483 real hands imported).

## What exists

| Area | State |
|---|---|
| Rules engine (`packages/core/src/engine`) | Authoritative: blinds, antes (each / BB ante), side pots, cover cap, uncalled returns, forfeit, run-outs. Pure; `applyAction`, `dealNextStreet`, `legalActions`, `computePots`. |
| Hidden information | `publicState(state, viewer)` strips other players' cards and showdown scores. Scenario runs rebuild state by replaying stored steps server-side. |
| Ratings | Glicko-2 (`glicko2-v1`), keys `overall` + 10 skills. Updated only by `track === 'strategy'` attempts in rated mode with a reliable source (SOLVER_VERIFIED 1, COACH_REVIEWED 0.75); familiarity weights 1/0.5/0.25/0. |
| Tracks | `strategy` (push/fold solver quiz, postflop solver quiz, verified real-hand annotations), `fundamentals` (math lab, pot-odds on real hands, MATH_VERIFIED "assumed-range model" scenarios), `replay` (unreviewed real hands, never graded). |
| Exploratory content | 10 HEURISTIC scenarios — reliability 0, never rated. |
| Dashboard | `strengths` and `weaknesses` are both "top 3 of reliable skills" sorted opposite ways → with ≤ 5 reliable skills the same skill appears in both lists. Fundamentals performance is not reflected in any rating. |
| Train page | Five fixed cards + review queue. No Mixed session, no full-hand play. |
| Play as Hero | Scripted decision trees (scenarios) that stop at `end` nodes; no play-to-showdown, Villain actions come from the script. |

## Gaps against the V3 spec

1. **Unified competency** — no Fundamentals subrating, no overall proficiency combining both, no coverage/confidence, duplicate strongest/weakest.
2. **Mixed Training** — none.
3. **Full-hand Hero simulator** — none: needs a seeded deal (Hero, Villains, 5 board cards fixed server-side), a Villain response engine, play to a terminal state, per-decision feedback, review timeline, branch/replay/compare, resume.
4. **UX** — no fixed board slots, progress indicator, decision counter, stack/pot tracker, math panel in a hand.

## Design decisions

- **Simulator lives in core** (`packages/core/src/sim`) and only uses the engine — no new rules code. The full deal (all hole cards + the 5 board cards) is derived from a server-held seed; clients only ever receive `publicState` plus cards already dealt. Hands are persisted as `seed + config + hero steps` and rebuilt deterministically (same as scenario runs), which gives resume, replay and branching for free.
- **Villain policies are heuristic and labelled so.** Archetypes (Nit, TAG reg, LAG, Calling station, Maniac) map hand strength (preflop: equity vs a random hand from the existing 169×169 table; postflop: made-hand category + draws) and pot odds to fold/call/raise frequencies. When the spot is an exact heads-up push/fold subgame covered by our solver, Villain uses the **solver frequencies** and the decision is labelled `SOLVER_VERIFIED`.
- **Grading is honest.** Hero decisions are graded:
  - against solver push/fold EV when the spot is exactly that subgame → strategy track, may change Elo in rated mode;
  - otherwise with the Fundamentals math: required equity from the winnable pot vs Hero's equity against the **Villain archetype's modelled range** ("assumed-range model") → fundamentals track, never Elo. No GTO frequency is shown where none was computed.
- **Unified rating** — Strategy = existing `overall` Glicko (unchanged, so no reset). New `fundamentals` Glicko key updated by graded fundamentals attempts (familiarity-weighted). Overall proficiency = confidence-weighted blend with coverage; below thresholds the UI says "Not enough evidence". Migration is versioned (`RatingModel` row per user) and back-fills `fundamentals` from historical attempts deterministically, leaving strategy ratings untouched.
- **Mixed Training** — a `TrainingSession(kind='mixed')` with a stored config; the server picks the next item type by weakness, due reviews and focus; every item is answered through its existing endpoint carrying the `sessionId`, so each attempt is recorded once.
