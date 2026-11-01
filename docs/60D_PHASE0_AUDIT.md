# 60-day program — Phase 0 baseline audit (2026-11-01)

Every number below was measured today, by command, on the repository, production (Render API / live app) or a full local copy of production data. Reported-but-unverified items are marked as such.

## A. Current state

### Architecture

| Layer | Stack | Size |
|---|---|---|
| `packages/core` | Pure TypeScript: rules engine, cards/equity, scenario runtime, Glicko-2 + unified rating, SM-2 SRS, leaks, GTO push/fold solver, real-hand audit, full-hand simulator | 53 files, ~11.0k lines |
| `apps/server` | Express 5 + Prisma 6 + PostgreSQL 18, cookie sessions (scrypt) | 24 files, ~4.5k lines |
| `apps/web` | React 19 + Vite + Tailwind 4, EN/VI | 39 files, ~6.3k lines |
| Data | 85 solved postflop flops (gz, in repo), 189 push/fold solutions, 44 curated scenarios | — |
| Deploy | Render web service `free` (Singapore, auto-deploy on `main`), Render Postgres `free` | — |

Git: `main` = `feature/v3` = `66bf6cc` (deployed and live). Working tree clean.

### Feature inventory

| Feature | State | Evidence |
|---|---|---|
| Real-hand import (GG/N8), audit, quarantine | **Working** | 52,523 hands (52,483 accepted / 40 quarantined), 78,704 accepted decisions on prod |
| Real Hand Replay (no answer leakage) | Working | tests + e2e |
| Reviewed Strategy (annotation-graded) | **Partial**: 0 verified annotations (1,097 solver drafts await human review) | prod stats |
| GTO push/fold quiz, postflop quiz (85 flops) | Working, solver-verified | tests |
| Hero scenarios (35) / Read the Villain (9) | Working; small pool | content count |
| Full-hand simulator: continue to terminal, showdown, reveal, branches | Working | 80 prod hands, 0 failures; 500 local, 0 failures |
| Played / New / Review-due / Mastered states, New-only selection | Working (V3.1) | `ScenarioHistory`, tests |
| Ratings: Strategy / Fundamentals / overall with evidence threshold | Working | tests incl. migration backfill |
| SRS (SM-2, capped since today) | Working | prod bug fixed today (year-13084 due date) |
| Leak tracker | **Partial**: 16 leak keys, Wilson-bounded ranking, but only from *training* attempts; real-hand mistakes feed it only via the push/fold audit | `learning.ts`, `leaks.ts` |
| Personal leak memory / daily adaptive queue | **Partial**: review queue + Mixed Training exist; no per-leak memory, no "today" plan | — |
| Improvement analytics (7/30/60-day) | **Partial**: dashboard, progress, training-activity; no period comparisons | — |
| Private access (5–10 invited users) | **Missing**: registration is open to anyone with the URL | `auth.ts` |
| Backups | **Missing on production**: free plan — Render API: `recoveryStatus: NOT_AVAILABLE`, export → "database is a free tier database" | Render API |

### Database (production + full local copy)

| | Value |
|---|---|
| Prod disk used | 445 MB of 1 GB (incl. bloat from 2 interrupted imports) |
| **Fresh copy of the same data** | **170 MB** (restored from a backup today) |
| Largest tables (fresh) | RealHand 98 MB (raw text 80 MB, avg 1.5 KB/hand), RealDecision 54 MB, everything else < 4 MB each |
| Postgres compression (lz4 + toast target) | 98 → 96 MB: not worth it; app-level gzip would give ~6× if ever needed |
| Prod accounts | 13: owner + 12 test accounts (`@test.dev`) created by QA |

### Tests (run today)

| Suite | Result | Coverage |
|---|---|---|
| core (vitest) | 182 passed | statements 83.7%, branches 75.7%, lines 89.6% |
| server (vitest, real Postgres) | 74 passed (76 after today's additions) | statements 86.7%, branches 73.4%, lines 91.4% |
| web unit | 10 passed | — |
| e2e (Playwright, desktop + mobile) | 7 passed | — |

### Baselines

| Metric | Value | Source |
|---|---|---|
| Full-hand completion | 80/80 prod (after fix), 500/500 local | `qa-sim.ts` today |
| Grading coverage | 23.3% overall · random tables 10.4% · solver-flop tables 48% (prod, 80 hands) | qa-sim |
| Exact duplicate deals / situation repeats in 30 hands | 0 / 0 (500 local hands) | DB query |
| API latency (prod) | median 395 ms, p95 759 ms, measured from here; a bare `/health` takes 0.4–0.9 s from here, so this is network-dominated | qa-sim + curl |
| Server latency (local, same code) | median 20 ms, p95 51 ms per action | qa-sim |
| Backup of full data | 27.9 MB gzip, 17–27 s, server peak RSS 222 MB (limit 512 MB) | measured |
| Restore + verify | 18 s; 29/29 tables, counts + checksums identical; restored app works | measured |
| Monthly cost | **$0 today**; the free DB is **deleted after 2026-12-01** | Render API |

## B. Gap analysis vs the 60-day target

| Target | Status | Gap |
|---|---|---|
| Zero data loss, $0–5/month | at risk | no backups; DB expiry in 30 days → **P0** |
| 5–10 invited users only | open registration | invite-only signup |
| Complete hands, no repeats, correct scoring | met (V3.1) | keep regression tests; real-hand vs simulated vs hypothetical labelling already present — re-verify in Phase 2 |
| Evidence-backed leak engine | partial | real-hand context normalization, pattern stats (VPIP/jam by stack/position, river calls…), verified-vs-suspected classes |
| Personal leak memory + daily queue | partial | per-leak memory, 5/10/20-minute "Today" plan |
| 7/30/60-day analytics | partial | period comparisons, weekly summary |
| Grading coverage | 10% on random tables | honest limit: needs more solver data (backlog, not faked) |

## C. Prioritized backlog

| # | Item | Phase | Size | Approval needed |
|---|---|---|---|---|
| 1 | **Backup tooling** (read-only admin export + restore/verify script) | 1 | S | **done locally**; deploy needs approval |
| 2 | Take a production backup now, then weekly (GitHub Actions artifact, $0) | 1 | S | yes (deploy + repo secret) |
| 3 | Migrate DB to Neon free (Singapore): maintenance mode → backup → restore → checksum verify → switch `DATABASE_URL` → keep Render DB until expiry | 1 | M | **yes** + you create the Neon account |
| 4 | Invite-only registration (codes generated by the owner) | 1 | S | **done locally**; deploy with `OWNER_EMAILS` set |
| 5 | Remove the 12 `@test.dev` QA accounts | 1 | S | yes (destructive) |
| 6 | Maintenance/read-only flag for the migration window | 1 | S | no |
| 7 | Re-audit rating paths per module with an automated cross-check | 2 | S | no |
| 8 | Real-hand decision context normalization (position, eff. stack, format, street, SPR, sizing, bounty) | 3 | M | no |
| 9 | Leak engine v2: verified (solver/annotation/math) vs suspected (frequency patterns with sample sizes) | 3 | L | no |
| 10 | Leak memory + daily 5/10/20-minute queue | 4 | L | no |
| 11 | Improvement analytics 7/30/60 days + weekly summary | 5 | M | no |
| 12 | Onboarding + simple import for friends; per-user isolation re-test | 6 | M | no |
| 13 | App-level gzip of raw hands (only if growth needs it) | later | S | — |

## D. Plan

- **Days 1–3 (now):** audit ✔, backup tooling ✔ (local, tested).
- **Days 4–14:** deploy backup endpoint → production backup → Neon migration (approval) → invite-only signup → weekly automatic backups → test-account cleanup.
- **Days 15–24:** Hero/scoring re-verification and regression suite (most behaviour exists since V3.1).
- **Days 25–35:** leak intelligence.
- **Days 36–46:** leak memory + daily queue.
- **Days 47–54:** improvement analytics.
- **Days 55–60:** private beta hardening.

## E. Risks, dependencies, cost

| Risk | Impact | Mitigation |
|---|---|---|
| Render free DB deleted after 2026-12-01 | total data loss | backup now; migrate before ~2026-11-20 |
| No platform backups on free tiers | unrecoverable mistakes | our verified backup + weekly artifact |
| Neon free limits (0.5 GB storage, 100 CU-hours/month, 5 GB egress) | suspension if exceeded | data is 170 MB (~34%); 1 user ≈ few CU-hours; monitor monthly |
| Free web service sleeps after 15 min | ~1 min first load | accepted at $0; Starter is $7/month if ever needed |
| Open registration on a public URL | strangers using resources | invite-only signup (backlog #4) |
| Backup files contain password/session hashes | sensitive | download only to private storage; never in the repo |

**Cost:** today $0; target after migration: **$0/month** (Render free web + Neon free). Upgrade only if a limit is hit, presenting the trade-off first.
