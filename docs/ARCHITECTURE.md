# Poker Decision Lab — Architecture

Modular monolith in one npm workspace (`poker-decision-lab/`), independent of the HSK flashcard app that shares this repository.

```
packages/core   Pure TypeScript domain (no I/O). Used by server AND browser.
  cards/        card model, 7-card evaluator, range notation, exact/seeded equity
  engine/       THE authoritative NLHE rules engine + sizing helpers
  math/         closed-form formulas (pot odds, MDF, bluff ratios, SPR, EV), ICM, bounty model
  scenario/     Zod scenario schema, decision-tree runtime, EV models, grading, question grading, validator
  rating/       Glicko-2 + rating service (reliability, familiarity, practice/rated)
  srs/          SM-2 spaced repetition, mastery estimate
  leaks/        leak taxonomy, Wilson-bound evidence ranking
  quiz/         deterministic Math Lab generators (seeded)
  hh/           GGPoker parser (pluggable HandHistoryParser), engine reconstruction, review spots
  content/      curriculum (18 modules) + 44 authored scenarios
apps/server     Express 5 + Prisma/PostgreSQL + Zod. Cookie sessions. Serves the built SPA.
apps/web        React 19 + Vite + Tailwind 4 + Zustand + React Router + Recharts. EN/VI.
```

## Key design decisions

| Decision | Why |
|---|---|
| One rules engine (`core/engine`) drives Hero runs, Villain replays, hand-history reconstruction and the client UI | No divergent betting logic; every pot/stack shown is engine-derived |
| Scenarios never author pots or stacks — only actions | Inconsistent game states are impossible by construction |
| Server-authoritative runs rebuilt by deterministic replay of recorded steps | Hidden info (villain cards, grades, explanations, model ranges) never leaves the server before submission; build step fails if answer text reaches the bundle |
| Three information classes kept separate: exact math, solver-backed, heuristic | Grading never fabricates EV; `frequency`/`ev` fields are rejected unless `SOLVER_VERIFIED` with a cited reference |
| "Math-verified" EVs are computed by models with explicit, displayed assumptions (stated villain ranges, no future betting) | Honest precision: exact on rivers/all-ins; preflop equity by seeded Monte Carlo with reported standard error |
| Own email/password auth (scrypt, opaque session tokens hashed in DB, httpOnly cookie) instead of Supabase Auth | No external credentials were available; self-contained and portable to any managed Postgres. Swappable behind `auth.ts` |
| Glicko-2 per skill + overall, opponent = scenario difficulty | Confidence-aware (RD shown as ±95%), reproducible; rating history stores before/after/weight/method version |
| Immutable attempts, idempotent on `(userId, clientAttemptId)`; rating history unique on `(attemptId, skill)` | Retries can never double-apply ratings |

## Grading

* EV path (model or solver EVs for the compared options): `EV loss = best EV − chosen EV`, graded with configurable thresholds
  (BB: 0.05 / 0.2 / 0.5 / 1.0 / 2.5; ICM: % of prize pool 0.02 / 0.08 / 0.2 / 0.4 / 1.0). Mixed spots: equal-EV options are all "excellent".
* Rubric path (no validated EV): authored concept grade; **no EV figure is displayed**.
* Off-tree actions: not graded; the hand stops with an explicit limitation message.
* Ratings change only in rated mode, only for `MATH_VERIFIED`/`SOLVER_VERIFIED`/`COACH_REVIEWED` content, with familiarity weights 1 → 0.5 → 0.25 → 0.

## Data model (PostgreSQL, `apps/server/prisma/schema.prisma`)

* Identity: `User`, `Session`, `UserPreference`
* Content (versioned, immutable once published): `Scenario` → `ScenarioVersion` (definition JSON, content hash, validation report) → `DecisionNode` → `StrategyOption`; `SourceMetadata`; `SkillCategory`
* Training: `TrainingSession`, `ScenarioRun` (recorded steps), `DecisionAttempt` (immutable, grading method version)
* Ratings: `Rating` (current per skill), `RatingHistory` (one row per attempt × skill)
* Learning: `LeakObservation`, `ReviewItem` (SM-2 state + mastery), `Bookmark`, `UserNote`
* Imports: `ImportedFile`, `Tournament`, `HandHistory` (raw + parsed, private by default), `HandAction`, `ImportError`

Every user-owned row carries `userId`; every query filters by the session user (tested).

## Key technical risks & mitigations

| Risk | Mitigation |
|---|---|
| Presenting heuristics as solver truth | Source classes enforced by validator; heuristic content is practice-only and labeled everywhere |
| Monte Carlo noise in preflop EVs | Fixed seeds (deterministic), 150k samples, std. error reported and checked against grading thresholds |
| Model assumptions (stated ranges) differ from real opponents | Assumptions shown in every deep analysis; exploit text explains how answers change |
| Hand-history format drift | Parser is pluggable, every hand is replayed on the engine and pot-checked; failures are stored, never dropped |
| Rating farming | Practice/rated split, familiarity discount, unvalidated content never rates |
| Answer leakage to the client | Server-side runs + `scripts/check-bundle.ts` build guard |
| Small content set | Validator workflow makes adding scenarios safe; 44 validated scenarios at MVP |
