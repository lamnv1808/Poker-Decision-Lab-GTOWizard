# Postflop solution generator (offline tool)

Generates `apps/server/data/postflop/*.json.gz` — the solved flops behind the postflop GTO Quiz.

* Solver: [postflop-solver](https://github.com/b-inary/postflop-solver) by b-inary (discounted CFR), **AGPL-3.0-or-later**.
  It is not vendored here and is not part of the app; this tool links it and therefore is also AGPL-3.0-or-later.
  The app only reads the exported JSON (solver output).
* Spot: MTT single-raised pot, BTN opens 2.2BB, BB (1BB big-blind ante) calls, 32BB effective (the median effective
  stack of the owner's real single-raised pots). Pot 5.9BB.
* Ranges (stated assumptions, not solver output): see `src/main.rs`.
* Tree: flop OOP bet 33% / IP bet 33%, 75%, raises 3x; turn 66%, raise 3x; river 75% or all-in, raise all-in.
* Precision: every flop solved to ≤ 1% of the pot exploitability (value stored per file).
* `flops.json`: 85 flops chosen from the owner's 4,047 real heads-up single-raised pots, stratified by texture.

## Rebuild
```bash
git clone https://github.com/b-inary/postflop-solver tools/postflop-solver   # sibling of this folder
cd tools/solver-export
RUSTFLAGS="--cap-lints warn -C target-cpu=native" cargo build --release
./target/release/pdl-gto Ks9s3h out.json 1.0 32          # one flop: <flop> <out> <exploitability % pot> <stack BB>
```
`run-library.sh` solves every flop in `flops.json` (≈70 s each on 4 cores, ≈1.8 GB RAM), then gzip the outputs into
`apps/server/data/postflop/`.
