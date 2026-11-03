# Today's Plan / leak engine: decision loading (perf/daily-plan)

## Measurement (local copy, 78,704 analysed decisions, one user; Node 22; DB on the same host)

`apps/server/scripts/perf-daily.ts`, p50 of 5 runs:

| Stage | Before (Prisma) | After (one SQL join) |
|---|---|---|
| `loadDecisionRows` (fetch + map) | 3,788 ms | 660 ms |
| `leakCandidates` (fetch + analysis) | 3,735 ms | 896 ms |
| `refreshLeakMemory` (stale memory) | 3,534 ms | 897 ms |
| `GET /daily/plan`, memory fresh (usual) | 180 ms | 175 ms |
| `GET /daily/plan`, memory stale (first call of the day / after an import) | 3,987 ms | 1,056 ms |

The analysis itself is ~0.2 s; the cost was Prisma loading the decisions and then the hands by
78k ids in a second query. Same loader feeds `/api/leaks/real`, `/api/improvement`, `/api/gto/audit`.
On production hardware (shared CPU, remote DB) absolute numbers will be higher; re-measure with the
`profile-endpoints` workflow after merge.

## Equivalence

* `apps/server/test/decision-rows.test.ts`: same rows and fields (order-insensitive), hand-id
  cluster fallback, same leak statistics, user/status/context filters.
* `apps/server/scripts/perf-compare.ts` on the 78,704-row copy: identical rows, identical
  `analyzePatterns` and `analyzeSolver` output.

## Pre-existing finding (not changed here)

Neither loader orders rows, and `analyzePatterns` keeps input order for (a) the order of its output
entries and (b) tie-breaking of example ids with equal `playedAt` (1 of 19 entries on this copy).
Counts, rates, intervals and verdicts are order-independent (verified by reversing the input).
A deterministic `ORDER BY` would be a separate, deliberate change.
