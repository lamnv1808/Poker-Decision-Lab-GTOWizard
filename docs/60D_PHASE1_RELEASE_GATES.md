# Phase 1 release gates — report (2026-11-02)

Branch `feature/60d` (local; HEAD at the time of writing `9da076e` + this report). Production still runs
`main` = `969cd94` (deploy `dep-dbjre8bm8hqs73851dkg`, live). **Nothing was deployed or deleted.** The
release is held on one owner action (Gate A, durable off-platform backup storage); see "Status".

All numbers were measured on the production backup taken today, restored into isolated local databases.

## Status

| Gate | Result | Blocking? |
|---|---|---|
| A — Backup & recoverability | **BLOCKED** (backup + restore verified; durable off-platform encrypted storage needs the owner) | yes |
| B — Poker EV & solver correctness | **PASS after fixes** | no |
| C — Statistical validity | **PASS after fixes** | no |
| D — Data integrity & migration safety | **PASS** | no |
| E — Safe removal of test accounts | **PASS (rehearsed on a copy)**; production deletion waits for A | yes (by A) |
| F — Functional & UX regression | **PASS** | no |

Owner action to unblock (decided 2026-11-02: "I'll set up the backup repo first"): follow
`docs/BACKUP.md` → "One-time setup of the weekly job" (private repository, two secrets, copy the workflow,
run once). When the first run is green, the release proceeds as in "Release procedure" below.

## A. Backup & recoverability

| Check | Evidence |
|---|---|
| Production database identity | web service `srv-dbj95te7bikc73ep6f8g` `DATABASE_URL` host contains the database id `dpg-dbj9sk49v7es739gggl0-a`, internal host, database `poker_lab` (checked without printing credentials). Postgres 18, free plan, **expiresAt 2026-12-01T02:05:04Z**, IP allow list 0.0.0.0/0 |
| Consistent backup | `GET /api/admin/backup` (one REPEATABLE READ read-only transaction): 48,978,303 bytes, 6 min 14 s, 30 tables, manifest digest `18c35749184bfa86…`, file SHA-256 `8a52685bc6c56174…` |
| Restore into isolated DB | fresh database migrated to `main`'s schema → `restore-backup.ts`: **VERIFIED 30/30 tables**, row counts and per-table MD5 identical, 32 s |
| Referential & ownership integrity | Postgres FKs enforced on load; `integrity-report.ts`: 0 violations in all 7 same-owner checks |
| Recoverable data | User 13, RealHand 52,523, RealDecision 78,821, Annotation 1,097, DecisionAttempt 192, RatingHistory 308, ReviewItem 20, HandHistory 18,577 (legacy uploads), … all present |
| App on the restored copy | 56/56 journey checks (Gate F) ran on it |
| pg_dump path (weekly job) | rehearsed locally: dump 49 MB in 6 s, `pg_restore --exit-on-error` OK, integrity report ok |
| Off-platform, encrypted, access-controlled storage | **not yet**: the weekly job (GPG AES-256, private artifacts, 35-day retention, failure issue) is ready in `ops/backup/weekly-backup.yml` but needs a private repository and two secrets. Storing a passphrase in the Render secret store from this session was blocked by a safety rule; the owner chose the repository route. The 2026-11-01 backup delivered earlier is unencrypted and in the owner's hands. |
| No public backup download | `/api/admin/backup` is off by default in production after this release (`BACKUP_ENDPOINT`), and was always admin-token only |

Schema version is now recorded in every app backup (applied migrations); restore refuses a mismatched target.

## B. Poker mathematics audit

**Formulas (BB, relative to folding; S = effective stack incl. the posted blind, D = dead antes):**
SB shove = P(fold)·(1.5 + D) + P(call)·(eq·(2S + D) − (S − 0.5)); BB call = eq·(2S + D) − (S − 1).
Verified against the code by hand-derived cases (never-called shove = 1.5 + D exactly; AA vs a KK-only
calling range; KK vs an AA-only shoving range, with and without antes) and the equity table against
published all-in equities (AA–KK 81.95%, KK–AKo 69.7%, AKs–QQ 46%, 22–AKo 52.5%, AA–72o 87.6%).
Every precomputed grid point (stacks 2–15 BB by 0.5, antes 0–1.5 BB) is a best-response equilibrium to
±0.02 BB with exploitability < 0.02 BB; push ranges widen as stacks shrink and as dead money grows.

**What the six reported groups were:** each value was the **sum** of chip-EV loss over that group's
verified mistakes (not an average), at the rounded grid point.

**Defect found and fixed:** stacks are rounded to 0.5 BB and antes to the nearest solved level (or clamped at
the grid edge). A verdict is now *verified* only if it is a mistake at every corner of the grid cell around
the exact stack/antes; otherwise it is *near threshold* and not counted. Result on the real data:

| | Before | After |
|---|---|---|
| Verified chip-EV mistakes | 25 | **18** (7 near threshold, 11 PKO aggressive = inconclusive) |
| Total verified chip-EV loss | 47.05 BB | **33.61 BB** (conservative cell minimum 31.14 BB) |
| "SB shove 6.5–10 BB: −6.00 BB" | reported | **withdrawn** — one fold of AA at 8.3 BB with 1.6 BB antes, outside the solved ante grid (≤ 1.5 BB). The fold is real in the hand history, but it is not a verified grid verdict |

| Group (all folds = too tight) | Verified / spots | Sum (conservative) | Avg |
|---|---|---|---|
| BB call vs shove 10.5–15 BB | 5 / 74 | 12.55 BB (11.67) | 2.51 |
| BB call 6.5–10 BB | 4 / 168 | 6.23 BB (5.81) | 1.56 |
| SB shove 10.5–15 BB | 3 / 164 | 5.23 BB (4.66) | 1.74 |
| BB call ≤ 6 BB | 3 / 72 | 5.21 BB (4.78) | 1.74 |
| SB shove ≤ 6 BB | 3 / 119 | 4.40 BB (4.22) | 1.47 |

Double counting: 1,097 push/fold verdicts on 1,097 distinct hands; 0 duplicate hand ids; every stored verdict
re-derived from the raw hand text is identical (1,097/1,097). `scripts/audit-pushfold.ts` lists each
verified mistake with hand id, date, format, exact and rounded stack/antes, loss and cell range.

**Matching criteria:** heads-up subgame only (folded to SB, or BB facing an SB all-in for effectively all
chips), effective stack ≤ 15.25 BB, Hero's action shove/call/fold (anything else = outside the model).

**Evidence labels:** solver = chip EV vs the heads-up push/fold equilibrium, robust to rounding; **ICM and
payouts are not modelled** (labelled everywhere): late in a tournament a chip-losing fold can be right. PKO:
shove/call "mistakes" are inconclusive (the bounty adds EV to aggression); folds stay chip-EV verified.
Patterns = heuristic bands (suspicion, not proof); descriptive = no verdict.

**Unsupported (labelled, not judged):** multiway pots, stacks > 15 BB, antes > 1.5 BB, raises that are not
all-in, ICM, bounty EV, postflop real-hand spots without a verified annotation.

## C. Statistical audit

Recalculated independently in SQL (no application code) on the restored copy:

| UTG1 opens, unopened, 25 BB+ | Opens / spots | Rate | Tournaments |
|---|---|---|---|
| last 30 days (to 2026-10-31 23:44) | 78 / 219 | 35.6% | 60 |
| 30 days before | 154 / 677 | 22.7% | 141 |

Strata (current vs previous): 25–40 BB 27.9% vs 14.0%; 40+ BB 39.1% vs 26.1%; PKO 36.8% vs 22.9%;
regular 26.9% vs 12.5% (small n); 8 players seated 36.4% vs 22.7%. The increase appears in every stratum,
so it is not a change in the mix of stacks, formats or table sizes. No decision appears twice; training
attempts are never mixed in (real decisions only).

| Comparison | Before | After (cluster-robust by tournament + BH) |
|---|---|---|
| UTG1 30 d | p = 0.0002, "worse" | p = 0.0007 (design effect 1.25), q = 0.0021 → **"further from the heuristic band"** (behavioural change; a potential concern, not a verified error) |
| Push/fold mistakes 30 d | 7/364 vs 16/556, p = 0.36 | 4/364 vs 12/556 (robust verdicts), p = 0.23 → **no clear change** |
| Push/fold mistakes 7 d | (z-test) "better", p = 0.096 | Fisher exact 0/68 vs 1/50, p = 0.42 → **no clear change** |

Methods now: two-sided p < 0.10; decisions clustered by tournament (training by day) with cluster-robust
variance (never smaller than the binomial one); Fisher's exact test when any expected count < 5; fewer
than 20 spots or 8 clusters → "insufficient"; all pattern comparisons of a period corrected together with
Benjamini–Hochberg (FDR 10%) and labelled exploratory; pattern verdicts are toward/away from the band,
never better/worse; no causal claims. Remaining limits: heuristic bands are not a strategic baseline; GG
timestamps are stored as given (timezone not normalised — at most a few hours at window edges);
seasonality and field strength are not controlled.

Priority now multiplies an **evidence** factor (solver 1, training 0.8, pattern 0.6) so a heuristic
suspicion cannot outrank a verified mistake of similar size; every focus leak gets at least one graded drill.

## D. Data integrity & migration safety

Migrations to apply in production (all additive): `20261101221443_decision_context` (nullable columns +
`contextV` default 0 + one index), `20261101221828_decision_pf_audit` (nullable JSONB),
`20261101222655_leak_memory` (3 new tables), `20261102021049_leak_memory_evidence` (2 columns on a new
table). No DROP, UPDATE, DELETE, RENAME, type change or NOT NULL on existing columns. Applied on the
restored copy in 1.5 s.

| Fingerprint (MD5) | Before migration | After migration + v3 backfill |
|---|---|---|
| RealHand raw text | `9116043d…` | `9116043d…` |
| RealDecision identity/ownership/status | `4d495b59…` | `4d495b59…` |
| Annotations | `4ad121f6…` | `4ad121f6…` |
| Users / attempts / rating history | `c8027e85…` / `176ab2e5…` / `ceb15664…` | identical |

Backfill (v3 contexts, 78,704 decisions, 0 failures, 55 s locally) runs in the background after deploy,
paced; Phase 1 pages show "being re-analysed" until it finishes. **Rollback:** `main` (`969cd94`) was run
against the migrated copy: login, dashboard, real hands, history, review queue, GTO audit and creating a
session all 200/201 — so rolling back the code does not require reversing the migrations.

## E. Test accounts

Exact ids (12, all `@test.dev`, created by QA 2026-11-01): `f69d25ec…`, `1d71fa62…`, `1dc7ca8e…`,
`8a51be23…`, `729e958d…`, `aa61b723…`, `7cd379ac…`, `f9f67ba3…`, `eed31a58…`, `5e50f7bc…`, `089cd977…`,
`353a65f5…` (full ids in the release manifest). None owns hands or decisions; none is referenced by other
users' data. Dry-run manifest (hash `9b4ca2e6…`): Session 15, UserPreference 12, TrainingSession 12,
ScenarioRun 6, DecisionAttempt 81, Rating 18, RatingHistory 196, LeakObservation 137, ReviewItem 4,
SimHand 210, RatingModelState 7, ScenarioHistory 213. Rehearsal on a production copy: one transaction,
rows removed = manifest exactly, integrity ok, owner's hands/decisions/annotations fingerprints unchanged,
only the owner account left.

## F. Regression

core 228 · server 91 · web 10 unit/integration tests; e2e 9/9 (desktop + mobile); typecheck clean;
`npm audit --omit=dev` 0 vulnerabilities. Staging on the restored production copy (owner password replaced
**in the copy only**): 56/56 checks on desktop 1366 and iPhone SE 375 / iPhone 15 393 / iPhone 15 Pro Max 430
(Chromium with iPhone viewport, touch and user agent — WebKit is not available in this environment):
owner login, Today, My Leaks, Progress, Push/Fold Audit (now real verdicts: 18 verified, 52,483 hands),
History, Hand Review, a daily session, replay of an own push/fold mistake showing the solver verdict, GTO
quiz pre-filtered by a plan link, owner invite creation, Vietnamese, no horizontal overflow, no 5xx.

## Release procedure (when Gate A is green)

1. Break-glass backup is not needed if the weekly job has just produced a verified recovery point.
2. Merge `feature/60d` → `main`, push → Render auto-deploys; watch the deploy to `live`.
3. Smoke: health, `/api/auth/config` = invite, admin integrity report ok, owner counts unchanged
   (52,523 hands / 78,821 decisions / 1,097 annotations), backfill progress to completion.
4. Delete the 12 accounts with the hash-confirmed admin endpoint; verify integrity and counts.
5. Run the weekly job once more (post-release recovery point); confirm green.

**Rollback:** redeploy commit `969cd94` from the Render dashboard (or API); leave the database as is.
Stop and restore from the latest verified backup only if data is damaged.

## Phase 2 readiness (safe to build on)

Normalised decision context (v3) and the evidence-labelled leak engine; persistent leak memory with
snapshots; the daily planner (pure, tested); clustered period statistics; audited push/fold verdicts;
integrity report + verified backup/restore. Next candidates: extend the solved ante grid above 1.5 BB;
a friends' import path that feeds RealHand (today the Hands page upload feeds only the legacy table);
ICM-aware labels when tournament stage is known; Neon migration once permissions exist (deadline for a
database decision: 2026-11-20).
