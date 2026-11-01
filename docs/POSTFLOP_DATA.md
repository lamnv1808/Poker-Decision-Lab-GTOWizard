# Postflop GTO data

The postflop GTO Quiz uses flops **solved by this project** with the open-source
[postflop-solver](https://github.com/b-inary/postflop-solver) (AGPL-3.0, run offline as a separate tool —
see `tools/solver-export/`). Only the solver's output (`apps/server/data/postflop/*.json.gz`) is used by the app.

| | |
|---|---|
| Spot | MTT single-raised pot: BTN opens 2.2BB, SB folds, BB (1BB big-blind ante) calls; 32BB effective; pot 5.9BB |
| Preflop ranges | Stated assumptions (BTN open ≈48%, BB flat-call range) — **not** solver output |
| Tree | Flop: BB lead 33%; BTN bet 33% / 75%; raises 3x. Turn 66% (raise 3x). River 75% or all-in |
| Precision | Each flop solved to ≤1% of the pot (per-file value; grading treats EV gaps within 2× that as equal) |
| Flops | Chosen from the owner's 4,047 real heads-up single-raised pots, stratified by board texture |
| Quizzed decisions | BTN after a check (check / bet 33% / bet 75%); BB facing a 33% and a 75% c-bet (fold / call / raise) |

Grading: EV loss in BB versus the best action for the exact hand. Actions the equilibrium mixes (≥10%) and EV gaps within the
solver's precision are graded as correct. Answers are never sent to the browser before the user commits.

Commercial GTO libraries (GTO Wizard, etc.) are proprietary; none of their data is used.
