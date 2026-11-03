# P0 training UX — reconciliation with the Codex patch (local evidence, 2026-11-03)

Evidence class: LOCAL tests in an isolated container (Node v22.23.4, local PostgreSQL 16, databases
`pdl_test` and `pdl_e2e_test`; the test setups refuse any database whose name does not end in `_test`).
No production or Neon access, no push, no PR, no merge, no deploy, no migration.

## Branches (local only; none pushed; upstream tracking removed, push.default=nothing)
| Branch | Base | Commits | Content |
|---|---|---|---|
| `review/codex-p0` | origin/main b8a2f51 | 1 | Codex patch applied unmodified (patch SHA-256 ad457077…6ee4) |
| `ux/quick-feedback` | b8a2f51 | 5 | Quick Feedback, sticky Next, Fresh remount, 60 s limit, Mixed refusal |
| `p0/reconciled` | b8a2f51 | 5 cherry-picked + reconciliation | ux/quick-feedback + Codex unique parts (see commit message) |
| `perf/daily-plan` | b8a2f51 | 1 | one-SQL decision loader (separate PR) |

## Reproduction suite `apps/web/e2e/p0-repro.spec.ts` (same file on every branch)
| | main | Codex patch | p0/reconciled |
|---|---|---|---|
| R1 plan request never answers → error + retry | FAIL (endless spinner, reproduced) | pass | pass |
| R2/R3 empty-body 5xx → readable message | pass* | pass* | pass |
| R4 replay-only focus, no imported hands | pass (409 text; dead session created) | pass (session ends) | pass (refused before creation) |
| R5 consecutive push/fold items → new spot | FAIL (old spot kept, reproduced) | pass | pass |
| R6 double click Start → one session | FAIL (two sessions, reproduced) | pass | pass |
| R7 active hand resumed, decisions unchanged | pass | pass | pass |
| R8 mobile GTO Next on screen; Enter advances | pass | pass | pass |
\* locally the server sends an HTTP/1.1 reason phrase; the empty-status-text case of Render's HTTP/2 is
covered by unit tests: on the Codex patch it still yields an EMPTY error message, and requests outside
/daily, /mixed, /gto (e.g. /sim) stay unbounded; both fixed on p0/reconciled (`apps/web/src/api.test.ts`).

## Commands (reproducible)
```
git worktree add ../pdl-p0 p0/reconciled && cd ../pdl-p0   # plus node_modules
npm run typecheck
(cd packages/core && npx vitest run)
(cd apps/web && npx vitest run)
(cd apps/server && npx vitest run -c vitest.unit.config.ts)                     # mocked, no DB
(cd apps/server && TEST_DATABASE_URL=postgresql://pdl:pdl@localhost:5432/pdl_test npx vitest run)
(cd apps/web && npx vite build && npx playwright test)                           # pdl_e2e_test
```
Results on p0/reconciled: typecheck ok; core 242/242; web 34/34; server unit 3/3; server integration
100/100; e2e 26/26 (desktop + mobile).
The e2e helper now gives each test its own client address because the suite registers 26 users and
the production registration limit (20 per IP per 10 min, unchanged) is reached otherwise.

## Not established here
Production reproduction of the original incidents (no production access). The red error in production
may have other causes than the two reproduced here (empty-message 5xx, unservable focus). The slow first
Today load (~4 s on 78,704 decisions locally) is addressed separately on `perf/daily-plan`.
