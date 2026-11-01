# 60-day program — Phase 1: Personal Poker Improvement Engine

Branch `feature/60d`, local commits only (not pushed, not deployed). Every number below was measured on a full local copy of production data (owner account: 52,523 hands, 78,704 accepted decisions, played 2026-08-26 → 2026-10-31).

## What was built

| Step | What it does | Where |
|---|---|---|
| D1 Decision context | Every real decision gets position, street, action context (unopened/vsOpen/vs3bet/…/vsBet/vsRaise/vsAllIn), Hero action, effective stack + bucket, players in hand, SPR, bet size vs pot, required equity (winnable pot), PKO/regular, hand class, and the push/fold solver verdict when the spot is an exact heads-up push/fold subgame. Backfill: 78,704 decisions, 0 failures, ~55 s. | `core/realhands/context.ts`, `server/realhands/import.ts` |
| D2 Leak engine v2 | Three evidence classes, never mixed: **solver** (verified chip-EV push/fold mistakes; aggressive mistakes in PKO = inconclusive), **pattern** (90% Wilson interval vs a heuristic band, n ≥ 30, flagged only when the whole interval is outside the band — a suspicion, never a proof), **descriptive** (no verdict). Patterns never claim EV. | `core/leaks/engine.ts`, `GET /api/leaks/real` |
| D3 Mistake memory | One `LeakMemory` row per leak (real solver/pattern + training tracker), never deleted. Status from data: pattern *improving* = last 30 days of play inside the band (n ≥ 30), *resolved* = full sample inside; solver *improving*/*resolved* only when a clean recent run would be unlikely (≤ 10% / ≤ 1%) at the old mistake rate. Snapshots on every real change; refresh is idempotent and runs lazily when data changes. | `server/leakMemory.ts`, `GET /api/memory`, `POST /api/memory/refresh` |
| D4 Today plan | 5/10/20-minute plan: priority = severity × confidence × recurrence × learning (each factor shown); ~60% top leaks, ~25% due reviews, ~15% new; max 2 focus leaks per drill family; no 3 identical items in a row. Solver leaks → GTO push/fold quiz filtered to the same role/stack band; every real-hand leak replays the user's own example hands. Served as a Mixed session; at session end each drilled leak is scheduled (SM-2, `ReviewItem` type `leak`) from graded answers only. | `core/plan/daily.ts`, `server/daily.ts`, `server/mixed.ts` |
| Hand review | Replaying an own exact push/fold spot now shows the solver chip-EV verdict for the learner's answer (correct / small loss / verified mistake / inconclusive-bounty / outside model). Informational, never rated. | `core/gto/audit.ts`, `realhands/routes.ts` |
| D5 Improvement 7/30/60 | Real play (windowed by when hands were played, anchored at the last hand) and training (anchored now) are reported separately. Each metric compares the window with the equal window before it; better/worse only when a two-proportion test (Fisher exact for rare events) gives p < 0.10; < 20 spots in either window = "too few". For patterns, better = closer to the band. | `core/plan/trend.ts`, `server/improvement.ts`, `GET /api/improvement` |
| D6 UI | **Today** page (`/today`, nav + dashboard button) and **My Leaks** memory + improvement panels on `/leaks`; daily results in the Mixed summary. EN/VI, desktop + mobile (no horizontal overflow at Pixel 7). | `web/pages/Today.tsx`, `web/pages/LeakMemory.tsx` |

Schema changes are additive only (new columns on `RealDecision`, new tables `LeakMemory`, `LeakSnapshot`, `LeakMemoryState`). No paid APIs or dependencies.

## Results on the real data copy

Memory after one refresh (1.7 s): 9 leaks.

| Leak | Evidence | Status | Detail |
|---|---|---|---|
| BB call vs shove 10.5–15 BB too tight | solver | active | 5 verified / 74 spots, −12.55 BB chip EV; last 30 days 0/24 — not yet enough to call it improving (P(0 \| 6.8%) = 18%) |
| SB shove 10.5–15 BB too tight | solver | active | 5 / 164, −7.52 BB |
| BB call 6.5–10 BB too tight | solver | active | 5 / 168, −7.47 BB |
| BB call ≤ 6 BB too tight | solver | active | 4 / 72, −6.95 BB |
| SB shove ≤ 6 BB too tight | solver | active | 5 / 119, −6.56 BB |
| SB shove 6.5–10 BB too tight | solver | active (low confidence) | 1 / 350, −6.00 BB |
| UTG open frequency (25BB+) | pattern | active | 29.5% (90% CI 28.3–30.7%, n 3,965) vs band 10–24% |
| HJ open frequency | pattern | active | 38.6% (CI 37.1–40.1%, n 2,906) vs 17–34% |
| UTG1 open frequency | pattern | active | 27.4% (CI 25.2–29.7%, n 1,072) vs 11–25% |

All verified push/fold mistakes are **folds that lose chips** (too tight); no aggressive mistake survived the PKO rule.

Improvement (real play, anchored 2026-10-31): push/fold verified mistakes 7/364 (30 d) vs 16/556 before — *no clear change* (p = 0.36); UTG1 opens 35.6% vs 22.7% — *worse* (p = 0.0002); UTG and HJ — no clear change. Training: no training attempts on this copy yet, so every training metric reads "too few".

Today plan (10 min): focus = the two highest-priority solver leaks, 10 items (own-hand replays + filtered push/fold quiz + new material). Plan build 63 ms.

## Tests

core 210 · server 86 · web 10 · e2e 9 (7 desktop + 2 mobile), typecheck clean. New tests cover: context fixtures, leak engine, planner (budget, ordering, variety, determinism, no leaks), priority, period statistics (normal CDF, Fisher reference values, small samples), push/fold replay verdict (PKO, outside model), memory lifecycle (detect → idempotent refresh → resolved, kept), isolation between users, daily session following the plan and scheduling leak reviews exactly once, improvement endpoint, Today/My Leaks e2e incl. VI and mobile overflow.

## Honest limits

- Pattern bands are heuristics from common MTT practice, not solver output; table size and field vary. They flag *suspicions* to study, and the UI says so.
- Postflop real-hand decisions have no solver verdicts (no postflop solver for arbitrary real spots); postflop patterns stay within band on this data.
- Own-hand replays are reflection unless a verified annotation exists; only graded answers move a leak's review schedule.
- Training-side improvement needs a few weeks of daily use before any period comparison is meaningful.

## Not done (needs approval or later phases)

- Nothing pushed or deployed. Production still runs `main` = backup + invite-only.
- Neon migration on hold; the Render free DB expires 2026-12-01.
- Deletion of the 12 `@test.dev` production accounts; automated weekly backups.
- Push/Fold Audit page still reads the empty legacy table (fix: use `RealDecision.pfAudit`).
