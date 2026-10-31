# Adding scenarios safely

1. Write the scenario in `packages/core/src/content/scenarios/*.ts` (see `m04-shortstack.ts` for a math-verified example, `m01-preflop.ts` for a multi-street heuristic tree). Never author pots or stacks — only actions.
2. Choose the classification honestly:
   - `MATH_VERIFIED`: every decision has a model (`shove` / `call` / `riverBet`) with explicit ranges; EVs are computed by the app.
   - `SOLVER_VERIFIED`: requires `source.reference` and option `frequency`/`ev` from a real solver run or licensed dataset.
   - `COACH_REVIEWED`: requires `source.reviewedBy`.
   - `HEURISTIC` / `EXPERIMENTAL`: practice only, never rated.
3. Run `npm run validate:content`. It replays every branch on the engine, checks all options are legal, recomputes model EVs (printed), and enforces the classification rules. Make the explanation text agree with the printed EVs.
4. Published versions are immutable. To change a published scenario, bump `version`; the seeder rejects content changes without a version bump. Old attempts keep pointing to the version they were graded on.
