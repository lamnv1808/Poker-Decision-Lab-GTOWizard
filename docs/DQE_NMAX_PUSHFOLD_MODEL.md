# N-player push/fold model (`pdl-pushfold-nmax-fp-v1`) — APPROXIMATE MODEL ESTIMATE

**Trust class: `MODEL_ESTIMATE` only.** Records carry `evidence: approximateModel` and
`validation.status: approximate`. The Decision Quality Engine never turns them into a grade, an EV loss,
a rating change or "verified" wording (enforced in `assertVerdictInvariants` and tested over every shipped
record in `apps/server/test/rangeData.test.ts`). Verified solver EV comes only from the heads-up push/fold
solver, which applies when everyone but the blinds has folded.

## Game that is solved (simplified)

- Chip EV only. Not ICM, not PKO / bounty, not cash rake. A PKO or ICM decision never matches these records.
- 6, 7, 8 or 9 players, all with the **same** effective stack S (5–15 BB in 0.5 steps, 17.5, 20) and dead
  money D of 0 or 1 BB (antes), blinds 0.5 / 1.
- Actions: first-in **shove or fold** only (no limp, no smaller raise); facing a shove, **call or fold**.
- **No overcalls**: after the first call every remaining player folds, so there are no multiway all-ins.
  This is the main simplification. In the real game a player behind can overcall, so the true caller
  ranges are somewhat tighter than modelled and the shover's EV is somewhat different.
- Card removal: exact between shover and caller (169×169 equities with combo-pair weights); the cards of
  players who folded earlier are **ignored** (no folding-range blocker effects).
- Equities: seeded Monte Carlo, 20,000 samples per class matchup (≈ ±0.35 % equity).

## Convergence

Simultaneous fictitious play, 3,000 iterations per configuration; the stored strategy is rounded to 3
decimals and ε is measured **on the stored strategy**:

| table | configurations | max ε (BB/hand) | median ε | max single-node gain (BB) |
|---|---|---|---|---|
| 6-max | 46 | 2.0e-3 | 1.2e-3 | 9.5e-3 |
| 7-max | 46 | 3.2e-3 | 1.6e-3 | 1.6e-2 |
| 8-max | 46 | 3.9e-3 | 2.2e-3 | 2.1e-2 |
| 9-max | 46 | 4.5e-3 | 3.0e-3 | 2.2e-2 |

ε is the exploitability **within the simplified game**. It says nothing about the error introduced by the
simplifications themselves, which is not measured and can be larger. Hands whose shove/fold EVs are close
are effectively indifferent; their frequencies are not unique.

Benchmark: with 2 players the solver reproduces the app's heads-up solver (EV within 0.0062 BB,
frequencies within 0.01).

## Matching

Exact (table, position, history, S, D) match, or the nearest grid point within ±0.25 BB stack (±1.25 BB
above 15 BB) and ±0.25 BB dead money; a nearest-grid match is reported as `grid_rounded`. Grid tolerance is
allowed **only** for approximate records — verified records require an exact match.

## Files

`apps/server/data/ranges/pushfold-nmax-{6,7,8,9}max.json.gz` (184 configurations, 5,796 records, 979,524
hand rows) and `pushfold-nmax-manifest.json` (per-file SHA-256 and record counts, per-configuration ε,
runtime, memory, benchmark). Regenerate with `npx tsx packages/core/scripts/gen-nmax-pushfold.ts`
(≈ 42 min, peak RSS ≈ 274 MB). Licence: PDL-computed, no third-party data.
