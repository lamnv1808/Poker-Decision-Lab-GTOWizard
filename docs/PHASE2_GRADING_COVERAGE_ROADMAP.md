# Phase 2 — highest-priority product gap: reliable grading coverage

**Gap.** Of 896 sampled simulator decisions, only **17.4 %** receive a reliable grade (2.6 % solver-verified + 14.8 %
model-based); 82.6 % are "assessment limited". On real hands only the exact push/fold spots are graded
(947 of 78,704 decisions, 1.2 %) plus verified annotations (none yet). **No grade will be fabricated to raise
these numbers**: every step below adds coverage only where an exact computation or a stated, tested model exists.

Baseline (fixed benchmark: 400 seeded simulator hands, same Hero policy, re-measured after every step):

| Street | Solver | Model | Limited |
|---|---|---|---|
| Preflop | 23 | 19 | 388 |
| Flop | 0 | 9 | 191 |
| Turn | 0 | 7 | 142 |
| River | 0 | 98 | 19 |

## Roadmap (in priority order)

| # | Step | Street | Method (why it is defensible) | Tier | Gate before release |
|---|---|---|---|---|---|
| 1 | **Turn heads-up, backward induction** | turn | For each turn action, average over the 44 river cards the exact river evaluation (already built), with Hero assumed to play the river optimally against the model. Exact given that stated assumption. | model | matches an independent engine simulation where Hero follows the computed river policy; ≤ 1 s per decision on the server (cached) |
| 2 | **Exact all-in subgames preflop** | preflop | Open-shove from any position and re-shove / call-a-shove spots are terminal chip-EV games: n-player push/fold equilibria (≤ 20 BB) solved like today's heads-up grid; extend the ante grid above 1.5 BB (today's "outside grid" AA case). | solver | best-response property on every grid point, published-chart spot checks, robustness rule as today |
| 3 | **River multiway** | river | Exact enumeration is too costly with 2+ opponents; Monte Carlo over the joint posterior with a confidence interval, grading only when the best action is separated from the others beyond the interval. | model (confidence shown) | coverage of the 19 limited rivers; interval calibration test |
| 4 | **Flop heads-up, sampled lookahead** | flop | Step 1's backward induction from the flop with sampled turn/river cards (fixed seed), grading only when the best action wins beyond the sampling error. | model | simulation agreement; latency budget |
| 5 | **Larger solved flop library** | flop | Run the existing postflop solver for more configurations (3-bet pots, SB vs BB, other SPRs and sizes). Matches only when positions, stacks, pot, sizes all match. | solver | exploitability threshold per solve, match rules tested |
| 6 | **Preflop opens / 3-bets** | preflop | Non-terminal, so no exact answer exists without a postflop model. Option: an explicit preflop model (stated ranges + equity-realisation factors) shown as *model*, never as solver; or licensed solved charts (cost, needs approval). | model / solver | owner decision on the source; no grade until one is chosen |
| 7 | **Real hands** | all | (a) owner review of the 1,097 draft solver annotations → verified grades; (b) steps 2 and 5 apply to real hands whenever the spot matches exactly; (c) no opponent model is assumed for real opponents in grades (learning aids only, labelled). | solver / verified | annotation review workflow exists; matching tests on real fixtures |

Expected effect (to be measured, not promised): steps 1–3 would make most heads-up turn and river decisions and
the short-stack preflop all-in decisions gradable; flop and open-raise decisions remain the hardest and are
addressed only with steps 4–6. Coverage is reported per street and per tier on the fixed benchmark and on real
hands after each step; a step that cannot pass its gate is not released.
