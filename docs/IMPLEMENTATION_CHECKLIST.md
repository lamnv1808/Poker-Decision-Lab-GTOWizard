# Implementation checklist & progress log

Legend: ✅ done & tested · ◐ partial · ⛔ blocked/not done

## Phase 0 — Audit & architecture ✅
- ✅ Repository audit. (Originally developed inside the hsk-flashcard repo; moved to its own repository with full history.)
- ✅ No Supabase/hosting credentials in the environment → own auth on Postgres (see ARCHITECTURE.md).
- ✅ Architecture, data model, risks: `docs/ARCHITECTURE.md`.

## Phase 1 — Foundation ✅
- ✅ Frontend (React/Vite/Tailwind/Zustand/Router), backend (Express/Prisma/Zod), PostgreSQL migrations
- ✅ Auth (register/login/logout, scrypt, sessions, rate limiting, origin check), persistent preferences
- ✅ Dark design system, navigation (10 sections), EN/VI with key-completeness test

## Phase 2 — Table & rules engine ✅
- ✅ Blinds, antes (per-player and BB ante), min-raise, short all-in (incl. cumulative reopening), side pots, uncalled bets, street transitions, showdown with odd chips
- ✅ 6/8/9-max table component, current actor highlight, committed bets, dealer button, action history
- ✅ Action bar: legal-only actions, slider, numeric input, presets (BB preflop, % pot postflop), raise-to vs added vs increment shown

## Phase 3 — Scenario engine ✅
- ✅ Zod schema, decision trees with branching, sizing bands, scripted villains, server-side runs, off-tree honesty, full review sequence

## Phase 4 — Math & strategy ✅
- ✅ Pot odds, MDF, bluff break-even, indifference ratios, SPR, EV, outs, implied odds, ICM (Malmuth–Harville, with busts), bubble factor, bounty model
- ✅ Exact postflop equity; seeded MC preflop with std. error
- ✅ Models: shove (multi-caller), call (incl. PKO bounty, ICM), river bet sizing
- ✅ EV-loss grading with configurable thresholds, rubric grading, source-aware rating eligibility
- ✅ Sampling error reported in BB and ICM units; EV differences within 2 standard errors are not graded as losses

## Phase 5 — Hero & Villain ✅
- ✅ Hero mode; Villain mode with multiple choice, action/sizing prediction, range grid, combo count, percentage estimate; observed/assumption/derived labels

## Phase 6 — Ratings & progress ✅
- ✅ Glicko-2 per 10 skills + overall (verified against Glickman's published example), history, ±95% bands
- ✅ Dashboard, progress charts and breakdowns (street, position, stack depth, difficulty, concept)

## Phase 7 — Leaks & spaced repetition ✅
- ✅ 16-leak taxonomy, Wilson-bound ranking (≥6 opportunities, ≥2 errors), trend, severity, confidence, recommended scenarios
- ✅ SM-2 review, confidence input, queue filters (due, missed, weak, bookmarked, new, mixed)
- ✅ Review History page: sessions, decisions (all / incorrect / reattempts), bookmarks, notes; notes and bookmarks on the training and hand-review screens

## Phase 8 — Hand-history import ✅
- ✅ GG/Natural8 tournament TXT + ZIP, dedup, engine reconstruction with pot check, stored errors, hidden-action spot quiz, save-to-queue, per-user isolation

## GTO push/fold module ✅
- ✅ 169×169 preflop all-in equity table (seeded Monte Carlo, 20k samples/matchup, exact card-removal weights) — `packages/core/scripts/build-preflop-equity.ts`
- ✅ Heads-up push/fold Nash solver (fictitious play), matches the published 10BB result (58.3% shove / 37.4% call); 189 precomputed solutions (2–15BB × 7 ante levels), worst exploitability 0.00011 BB — `scripts/build-pushfold-solutions.ts`
- ✅ GTO Quiz: endless random spots (SB shove/fold, BB call/fold), EV-loss grading vs equilibrium, range heat-maps, keyboard play, rated as SOLVER_VERIFIED (source: this app's solver, stated model)
- ✅ Push/Fold Audit of imported hands: every heads-up push/fold decision graded; too tight vs too loose, by stack band, costliest hands
- ✅ Tested on 52,525 real GG/Natural8 hands: 52,483/52,486 Hold'em hands reconstruct exactly; four engine rule gaps found and fixed
- ✅ Bulk import: 19k hands in ~50 s within a 320 MB heap (Render free plan)
- Limits: push/fold model only (no limp/min-raise), heads-up subgame, chip EV (no ICM/bounty). Multi-way and postflop solving are future work.

## Trainer data V1 + V2 ✅ (local branch, not deployed)
- ✅ V2 audit against the engine; quarantine with reasons (see `docs/REAL_HANDS.md`)
- ✅ Fundamentals / Real Hand Replay / Reviewed Strategy as separate modes and score tracks
- ✅ Leakage-safe question payloads; reasoning + confidence before reveal; observed action = historical
- ✅ Versioned annotations (draft → verified), review queue with filters; 1,097 solver drafts (0 verified)
- ✅ Train/assessment split by tournament and time; family-based familiarity limits
- ✅ Concept topics + concept-level spaced repetition; per-track metrics (calibration, response time, per-standard)
- ✅ Export/backup
- ⛔ V1 package not received

## Phase 9 — Tournament expansion ◐
- ✅ PKO (3), bubble/final-table ICM (2), short-stack modules; ChipEV vs ICM vs bounty distinguished
- ◐ Content depth: 44 scenarios (23 math-verified, 21 heuristic). More final-table/PKO depth is content work, not engine work.

## Phase 10 — QA & release ◐
- ✅ Unit (core 131), integration (server 17, real Postgres), component (web 10), Playwright E2E (desktop + mobile); CI green on GitHub
- ✅ Security: hashed passwords/sessions, httpOnly SameSite cookies, origin check, rate limits, input validation, per-user isolation tests, no answers in bundle
- ✅ Deployment config (`render.yaml`) and instructions (`docs/DEPLOYMENT.md`)
- ⛔ Actual cloud deployment and two-real-computer verification need hosting credentials/approval (not available in this environment)

## Known limitations
- No solver data is included; nothing is labelled solver-verified. `COACH_REVIEWED` requires a named reviewer — none yet.
- Off-tree actions end the hand (no heuristic continuation is invented).
- GG run-it-twice hands and dead-small-blind hands are reported as unsupported.
