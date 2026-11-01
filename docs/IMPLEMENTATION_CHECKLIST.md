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

## Phase 5 — Hero & Villain ✅
- ✅ Hero mode; Villain mode with multiple choice, action/sizing prediction, range grid, combo count, percentage estimate; observed/assumption/derived labels

## Phase 6 — Ratings & progress ✅
- ✅ Glicko-2 per 10 skills + overall (verified against Glickman's published example), history, ±95% bands
- ✅ Dashboard, progress charts and breakdowns (street, position, stack depth, difficulty, concept)

## Phase 7 — Leaks & spaced repetition ✅
- ✅ 16-leak taxonomy, Wilson-bound ranking (≥6 opportunities, ≥2 errors), trend, severity, confidence, recommended scenarios
- ✅ SM-2 review, confidence input, queue filters (due, missed, weak, bookmarked, new, mixed), notes API

## Phase 8 — Hand-history import ✅
- ✅ GG/Natural8 tournament TXT + ZIP, dedup, engine reconstruction with pot check, stored errors, hidden-action spot quiz, save-to-queue, per-user isolation

## Phase 9 — Tournament expansion ◐
- ✅ PKO (3), bubble/final-table ICM (2), short-stack modules; ChipEV vs ICM vs bounty distinguished
- ◐ Content depth: 44 scenarios (23 math-verified, 21 heuristic). More final-table/PKO depth is content work, not engine work.

## Phase 10 — QA & release ◐
- ✅ Unit (core 130), integration (server 15, real Postgres), component (web 10), Playwright E2E (desktop + mobile)
- ✅ Security: hashed passwords/sessions, httpOnly SameSite cookies, origin check, rate limits, input validation, per-user isolation tests, no answers in bundle
- ✅ Deployment config (`render.yaml`) and instructions (`docs/DEPLOYMENT.md`)
- ⛔ Actual cloud deployment and two-real-computer verification need hosting credentials/approval (not available in this environment)

## Known limitations
- No solver data is included; nothing is labelled solver-verified. `COACH_REVIEWED` requires a named reviewer — none yet.
- Off-tree actions end the hand (no heuristic continuation is invented).
- GG run-it-twice hands and dead-small-blind hands are reported as unsupported.
- Notes have an API but only a minimal UI (attached to history/hands is future work).
