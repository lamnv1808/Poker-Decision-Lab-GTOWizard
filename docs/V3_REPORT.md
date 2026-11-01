# V3 report — Unified Elo, Mixed Training, Full-hand Hero Simulator

Branch `feature/v3` (local; **not pushed, not deployed**). Built on `main@b2d8112`, which is what is live, including the imported 52,483 real hands.

## Features

| Area | What shipped |
|---|---|
| **Full-hand Hero simulator** (`/play`) | Seeded deal. All five board cards are fixed server-side and dealt street by street, so future cards cannot leak. Hands play to a terminal state (fold or showdown) on the existing rules engine. The state is rebuilt deterministically from seed + Hero actions, which gives resume on any device, replay and branching. |
| **Villain response engine** | Five archetypes (Nit, TAG, LAG, Calling station, Maniac) defined as action probabilities. Each Villain's represented range is the exact Bayesian range under its model. In exact heads-up push/fold spots, Villains use **our push/fold solver frequencies**, labelled "solver". Everything else is labelled "heuristic". |
| **Honest grading** | Solver spot: graded by equilibrium EV on the **strategy** track, so it can move Elo in rated mode. A facing-bet call/fold that ends the betting: exact EV vs the model's range on the **fundamentals** track. Anything else: **not graded**, with only a price check (equity vs required equity) shown. No GTO frequencies are invented. |
| **Hero UX** | Five fixed board slots, street progress indicator, decision counter, stack/pot tracker, optional math panel (facts only, never the model equity), reasoning and confidence inputs, Guided vs Exam modes (Exam reveals feedback at the end), review timeline with Villain sources, showdown limited to hands that reached it, Branch Explorer (fold/check/call/min-raise/all-in alternatives), replay of the same deal, and a comparison of replays and branches. Replays and branches are never recorded. |
| **Unified competency** | The Strategy subrating is the existing `overall` Glicko, unchanged. A new **Fundamentals** subrating is moved by exact maths, real-hand pot-odds and model-EV decisions. Heuristic content is **exploratory** and never rated. Overall proficiency is an evidence-weighted blend with 95% interval, confidence and coverage. Without enough evidence it shows **"Not enough evidence"**. Strongest and weakest skills are disjoint and need at least two reliable skills. |
| **Rating migration** | `RatingModelState` (`unified-v1`) is applied per user on first use. It back-fills the Fundamentals subrating deterministically from immutable attempt history and is idempotent and concurrency-safe. **Strategy ratings are not reset or modified.** |
| **Mixed Training** (`/mixed`) | Configurable duration (5/10/20/30 min), difficulty (adaptive/easy/medium/hard), focus (full hands, push/fold, postflop GTO, maths and pot odds) and mode. Adaptive sampling uses recent error rate, due reviews and in-session balance, never serves the same type three times in a row, and resumes an unfinished hand. Each answer goes through its normal endpoint with the session id, so it is recorded once. A session bar shows time left, a count and Next. The summary shows per-type accuracy and EV loss, rating changes per track, biggest mistakes and a recommendation. |
| **Train page** | Order: Continue Training (resume hand or review queue), Mixed Training, Full-hand Hero, GTO Quiz, Read the Villain, Math Lab, Hand Review. The scripted-scenario Play as Hero is still available. |

## Database changes (all additive; no data rewritten)

1. `20261101084129_sim_hands`: new `SimHand` table.
2. `…_rating_model_state`: new `RatingModelState` table.
3. `…_training_session_config`: nullable `TrainingSession.config`.
4. `…_sim_hand_secure_deal`: nullable `SimHand.deal`. Cards are shuffled with a CSPRNG and stored server-side, so they can't be derived from the seed or the public config.

Behaviour change: real-hand pot-odds attempts are now recorded as `rated` and count toward **Fundamentals** only (never strategy Elo). Earlier pot-odds attempts are included in the back-fill.

## Key files

- **Core:** `packages/core/src/sim/{strength,villain,sim}.ts`, `packages/core/src/rating/unified.ts`, and `equityVsRandom` / `hasPushFoldSolution` in `gto/pushfold.ts`.
- **Server:** `apps/server/src/{sim,mixed}.ts`; `learning.ts` (Fundamentals updates + `ensureRatingModel`); `analytics.ts` (competency); `sessionId` added to the gto, postflop, mathlab and pot-odds routes.
- **Web:** `apps/web/src/pages/{HeroSim,Mixed}.tsx`; `Dashboard.tsx`, `Train.tsx` and `Layout.tsx` (nav + MixedBar); EN/VI strings in `i18n.ts`.
- **Docs:** `docs/V3_AUDIT.md`, this report.

## Tests

- **Core:** 171, including 9 simulator tests:
  - determinism;
  - terminal state and chip conservation over 120 random tables;
  - no leakage of future board cards or Villain cards;
  - illegal actions rejected;
  - archetype differences;
  - range contains the real hand;
  - solver Villain in push/fold spots;
  - solver grading;
  - model EV only when the call ends the betting.
  4 unified-rating tests.
- **Server:** 53. They cover:
  - simulator API: leakage, exam mode, idempotency, ownership, recording rules, branch/replay restrictions, `legal` only after the hand;
  - migration back-fill and no strategy change;
  - "Not enough evidence";
  - Mixed: focus, single counting, resume, ownership, time limit, variety.
- **Web unit:** 10 (i18n parity included).
- **e2e (Playwright):** 6 specs, including the new full-hand and Mixed flows. The mobile check shows no horizontal overflow.

## Limitations (disclosed)

- **Villains are heuristic models, not GTO.** Solver frequencies exist only for exact heads-up push/fold spots (our solver). Postflop full-hand play has no solver data, so those decisions are graded only when the call ends the betting, and then against the stated model.
- Model equity is a Monte Carlo estimate (≈2,500 samples). Differences within 2 standard errors are graded as "either".
- Strength for Villain policies is a hand-strength percentile plus a draw bonus, not equity vs a range.
- Branch Explorer offers fold/check/call/min-raise/all-in, not arbitrary sizes. Branching and replay are allowed only after the hand is over, so there is no probing of a live hand.
- Mixed Training does not include scripted scenarios or Real Hand Replay items yet.
- The 1,097 push/fold annotations stay **draft**. Nothing was auto-verified.

## Remaining work (suggested)

- Postflop solver coverage for full hands, by extending the 85-flop library to more pot types.
- Raise/size grading in the simulator once solver data exists.
- Scenario and real-replay items in Mixed Training.
- A per-street hand-strength view in review.

## Deploy instructions (when you decide to)

```bash
git checkout main && git merge --ff-only feature/v3 && git push origin main
```

Render auto-deploys `main`. The start command runs `prisma migrate deploy`, so the three additive migrations apply automatically. The Fundamentals back-fill runs per user on their first dashboard load or answer. Smoke test: `/api/health`, then open `/play`, `/mixed` and the dashboard.
