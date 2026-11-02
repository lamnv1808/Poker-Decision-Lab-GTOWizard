# Phase 1 final release & decision-quality overhaul — report for owner approval (2026-11-02)

Branch `feature/60d`, local commits up to `ed099bd` (+ this report). **Not pushed, not deployed, nothing deleted.**
Production still runs `main` = `969cd94`.

**Recommendation: NOT READY — RELEASE BLOCKED** on one owner action (Gate A: a private backup repository with
an owner-held key and one green weekly-backup run). Every other gate passes. When the run is green, the release
is ready for your explicit deployment approval (the procedure is in section 12).

## 1. Implementation summary

| Part | Delivered |
|---|---|
| A Backup | Weekly `pg_dump` workflow (private repo only; refuses public), GPG AES-256, decrypt round-trip, full isolated restore + integrity report + server smoke test every run, 35-day artifacts, optional private S3-compatible bucket with upload verification, failure issue + e-mail; owner restore drill documented; admin download off by default in production; sandbox-keyed backup declared non-recoverable and destroyed |
| B UI | "Show Math" removed from gameplay (calculations kept for feedback); reasons collapsed below the action buttons; feedback shown first and scrolled into view; bet chips and dealer button kept inside 320 px screens |
| C Grading | Three tiers on every decision (solver / model / limited). Tier 2 = exact EV of every legal action and bet size against this table's opponent model; sizing compared (33/50/75/100/150 % pot, all-in, your size); "equally good" sizes within tolerance; grades Excellent/Good/Acceptable/Inaccuracy/Mistake/Blunder |
| D Reasoning | Optional everywhere; structured reasons checked against the spot's facts (supported / contradicted / not checked); decision and reasoning judged separately; free text is a private note, never graded; no external language model (no paid API, no data leaves the server) |
| E Reveal | Finished simulated hands reveal every opponent automatically; never-dealt cards shown only as a labelled hypothetical runout; real-hand replays show the actual outcome right after answering (board and shown cards from the hand history only) |
| F Coaching/stats | Feedback hierarchy (grade → recommended → why → your sizing → EV difference only when verified → source); details on demand (action table with the model's fold/call/raise reactions, assumptions); Progress by evidence tier, by action chosen, and confidence calibration; tiers never pooled |

## 2. Files / modules changed (this overhaul)

core: `sim/evaluate.ts` (new, Tier 2), `sim/coach.ts` (new, explanations + reasoning checks), `sim/sim.ts`
(tiers, feedback cache, Tier 3 facts), engine untouched. server: `sim.ts` (reasons, tier recording, reveal,
cache), `realhands/routes.ts` (optional reasoning, tiers, reason checks), `learning.ts` (`model` track, never
rated), `analytics.ts` (by tier/action, calibration), `leakMemory.ts` (concurrency fix). web:
`components/DecisionFeedback.tsx`, `components/ReasonPicker.tsx` (new), `PokerTable.tsx`, `pages/HeroSim.tsx`,
`pages/Replay.tsx`, `pages/Progress.tsx`, `i18n.ts`. ops/docs: `ops/backup/weekly-backup.yml`, `docs/BACKUP.md`,
`docs/release/test-account-deletion-manifest.json`. No database migration in this overhaul (Phase 1's four
additive migrations are unchanged).

## 3. Before / after UX

| Before | After |
|---|---|
| "Not graded" on most decisions | Grade + tier, or "Assessment limited — <what is missing>" with verified facts |
| Show Math toggle + panel in the playing view | Removed; maths appears in the feedback where it explains the answer |
| Free-text "Why?" required in Replay, never evaluated | Optional reason chips checked against the spot; optional private note |
| Feedback below the next action panel (off-screen on phones) | Feedback first, auto-scrolled into view |
| "Reveal runout" / "Reveal cards" buttons | Automatic reveal; hypothetical runout separate and labelled |
| Replay: "What happened" button | Actual outcome shown automatically, board on the table |
| Bet chips hidden under seats at 320 px | Chips and dealer button inside the table at 320–430 px |
| EV per action as a row of chips | Action comparison table: EV, opponent's fold/call/raise %, your choice, equally-good marks |

## 4. Decision grading methodology

* **Tier 1 — solver verified**: an exact solved spot matches (heads-up push/fold equilibrium with the stack and
  dead money on the solved grid and robust to rounding; the postflop library's solved flop trees). EV loss vs the
  best action, frequencies; may move the Strategy rating in rated mode.
* **Tier 2 — model-based**: the simulator's opponent really plays its archetype model, so after its actions its
  range is the exact Bayesian posterior of that model. Where no further Hero decision would have to be modelled —
  the river heads-up (one opponent reaction, then at most a call/fold that is chosen optimally at range level), and
  calls that end the betting all-in — the EV of every legal action and size is computed exactly by enumerating
  every opponent combo (and every turn/river runout; preflop all-ins use the hand-class equity table, confidence
  medium). Labelled "exploitative EV vs this opponent, not GTO", chip EV only, never moves a rating.
* **Tier 3 — limited evidence**: everything else (most preflop opens, flop/turn bets, multiway pots, real-hand
  decisions without a verified annotation). States what is missing; shows only exact facts (pot odds, equity vs the
  model's range with the caveat that raw equity does not rank actions). No recommendation is invented.
* Grades: EV loss thresholds 0.05 / 0.2 / 0.5 / 1.0 / 2.5 BB → Excellent / Good / Acceptable / Inaccuracy /
  Mistake / Blunder; in Tier 2 any action within max(0.05 BB, 1 % of the pot) of the best is "equally good"
  (no single size is asserted when several are within tolerance). Equity above the price is never by itself a grade.
* Real hands: opponents' ranges are unknown, so Tier 2 is not used there; push/fold spots get the Tier 1 verdict,
  verified annotations their EV grade, everything else Tier 3. The hand's result never enters the grade.

## 5. Solver vs model coverage (measured)

400 random simulated hands played with a simple check/call/bet policy (896 Hero decisions):

| Street | Solver | Model | Limited |
|---|---|---|---|
| Preflop | 23 | 19 | 388 |
| Flop | 0 | 9 | 191 |
| Turn | 0 | 7 | 142 |
| River | 0 | 98 | 19 (multiway) |
| Total | 23 (2.6 %) | 133 (14.8 %) | 740 (82.6 %) |

Solved-flop tables (the "solver flop" mode) add Tier 1 flop decisions. Honest limit: preflop opens and flop/turn
bets remain Tier 3 — grading them would need modelling Hero's later decisions, which the release does not fake.

## 6. EV validation evidence

* Hand-calculated fixtures: river call vs a 1:3 set/air range = 0.75 × 600 − 200 = 2.5 BB (exact); a chopped board
  = +1 BB; preflop all-in call = eq × 40 − 19 BB with the class table; spots needing later decisions return Tier 3.
* Independent simulation: every option (check, five sizes, all-in; fold, call, raises with antes in the pot) played
  to the end 6,000 times with the real engine paying the pots and the model's sampled reactions — simulated means
  agree with the analytic EVs within 4 standard errors.
* Push/fold maths (from the previous gate): published equities, hand-derived formulas, best-response property on all
  189 grid points; 18 verified real-hand mistakes after the robustness rule; 1,097/1,097 verdicts re-derived from raw text.
* Engine property test: 1,500 random hands (2–9 players, uneven stacks, antes, random sizes incl. short all-ins):
  chips conserved after every action, final stacks sum to the starting chips, no duplicate cards, pots = total
  committed, >100 showdowns and >20 side-pot hands exercised.

## 7. Statistics validation evidence

UTG1 recalculated independently in SQL (78/219 = 35.6 % vs 154/677 = 22.7 %; increase in every stratum);
cluster-robust test by tournament p = 0.0007, BH q = 0.0021 → "further from the heuristic band" (behavioural change,
not a verified error). Push/fold 30-day: no clear change (p = 0.23). Training statistics: tiers counted separately,
Tier 2 grades recorded on a `model` track with `ratingApplied = false` (tested), replays/branches never recorded
(tested), duplicate submissions idempotent (tested), outcomes never used in grading (results only after the answer).

## 8. Data integrity results (revalidated on the current code)

* Backup `2026-11-02T01:54Z` restored again into a fresh database: **VERIFIED 30/30 tables**, digest `18c35749184bfa86`.
* Migrations applied on that copy (4 additive); integrity report before/after: 0 violations; fingerprints of hand
  raw text, decision identity, annotations, users, attempts, rating history **identical**; only the 3 new tables added.
* Context backfill v3: 78,704 decisions, 0 failed, 84 s locally; push/fold audit unchanged (18 verified, 7 near threshold).
* Rollback: `main` (969cd94) on the migrated copy: login 200, dashboard, real hands, history, review queue, GTO audit,
  reading a hand created by the new code, creating sessions/hands — all 200/201.
* Test-account deletion rehearsal: 12/12 `@test.dev`, manifest hash `9b4ca2e62dfe0cb5` (unchanged since the first
  dry run), rows removed = manifest exactly, integrity ok, history fingerprints unchanged, owner intact.

## 9. Mobile QA

* Automated on Chromium with iPhone viewports (320, 375, 390, 430 px; touch, iPhone user agent): full simulated
  hands × 3 per width — no horizontal overflow, no bet chip under a seat, feedback in view after every action,
  automatic reveal, no reveal/maths buttons; repeated runs green.
* e2e (Pixel 7 project): full hand at 320 and 375 px incl. Vietnamese; Today/My Leaks fit; table and action bar fit.
* Staging journeys on the restored production copy: **60/60** checks (desktop 1366 + iPhone 375/393/430): owner login,
  Today, My Leaks, Progress, Push/Fold Audit (18 verified, 52,483 hands), History, Hand Review, daily session,
  own push/fold replay with solver verdict + tier + reason checks + automatic outcome, three simulated hands with
  tiered feedback and reveal and no "Not graded", GTO quiz, owner invite, Vietnamese, no 5xx.
  The first run found a real 500 (two simultaneous leak-memory refreshes) — fixed, with a regression test that fails
  without the fix.
* Limit: real Safari/WebKit is not available here; iPhone checks are Chromium with iPhone viewport/UA.

## 10. Automated tests

core 242 · server 95 · web 10 · e2e 10 (desktop + mobile) — all passing; typecheck clean; `npm audit --omit=dev` 0.
Acceptance scenarios (Part H): 1–2 solver fold/shove (sim + push/fold tests), 3 sizing comparison (Tier 2 options;
preflop raise sizes are Tier 3 — see limits), 4 terminal call (hand-calculated), 5 multiway call (Tier 3 / terminal
multiway model EV, never rated), 6 thin value, 7 bluff, 8 check/trap, 9 overbet vs smaller (coach tests), 10 PKO
(push/fold PKO rules), 11 ICM (labelled chip-EV only — not modelled), 12–13 historical hand ending early / unknown
cards (outcome shows only recorded cards), 14–15 simulated showdown / fold ending (reveal tests), 16–18 reasoning
none / correct / flawed, 19 replay without statistics, 20 mobile, 21 backup/restore, 22 migration/rollback,
23 account cleanup (rehearsal), 24 production smoke (after deploy).

## 11. Backup and restore evidence

Restore verified twice from the same production backup (30/30 tables, identical digest); `pg_dump`/`pg_restore`
path rehearsed locally (49 MB, restore with all constraints, integrity ok). **Missing**: the off-platform copy under an
owner-held key — only the weekly workflow in your private repository provides it; it has not run yet.

## 12. Rollback procedure and release order (after approval)

1. Green weekly-backup run (fresh, owner-recoverable recovery point). 2. Merge `feature/60d` → `main` and push
(Render auto-deploys). 3. Smoke: health, invite-only config, integrity report, owner counts (52,523 / 78,821 /
1,097), background context backfill completes. 4. Delete the 12 accounts with the manifest hash. 5. Run the weekly
backup again (post-release point). **Rollback**: redeploy `969cd94` in Render; the additive schema stays (verified
compatible); restore from the latest verified backup only if data is damaged.

## 13. Test accounts proposed for deletion

`docs/release/test-account-deletion-manifest.json` — 12 ids, all `@test.dev`, created 2026-11-01 by QA, no hands
or decisions, no references from other users; rows: Session 15, UserPreference 12, TrainingSession 12, ScenarioRun 6,
DecisionAttempt 81, Rating 18, RatingHistory 196, LeakObservation 137, ReviewItem 4, SimHand 210, RatingModelState 7,
ScenarioHistory 213. Hash `9b4ca2e62dfe0cb5…` — production deletion is refused unless it matches.

## 14. Known limitations and risks

* Tier 2 covers the river heads-up and all-in calls; preflop opens/3-bets and flop/turn bets stay Tier 3.
* Tier 2 is exploitative against the simulator's heuristic opponents, not GTO; real hands get no Tier 2.
* Reasoning is checked only for reasons that a fact can decide; position, blockers, stack depth are "not checked".
* ICM and bounty $EV are not modelled anywhere (labelled); PKO aggression mistakes remain "inconclusive".
* The exact flop all-in evaluation takes ~0.3 s here; on Render's 0.1-CPU free instance it may take several seconds
  once per such decision (then cached).
* Render free database expires 2026-12-01 (decision needed by 2026-11-20); Neon on hold.
* iPhone checks use Chromium, not Safari.

## 15. Release gate status

| Gate | Status |
|---|---|
| A Backup & recoverability | **BLOCKED** — private repo + owner key + first green run |
| B Poker EV & solver correctness | PASS |
| C Statistical validity | PASS |
| D Data integrity & migration | PASS |
| E Test-account removal | PASS (rehearsed; production run after deploy) |
| F Functional / UX / mobile regression | PASS |

**NOT READY — RELEASE BLOCKED** (Gate A). After a green weekly-backup run: READY FOR OWNER APPROVAL.
