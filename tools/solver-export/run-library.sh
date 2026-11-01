#!/bin/bash
# Solves every flop in flops.json (skips ones already solved). Usage: ./run-library.sh
cd "$(dirname "$0")"
mkdir -p lib
for f in $(python3 -c "import json; print(' '.join(x['flop'] for x in json.load(open('flops.json'))))"); do
  [ -s "lib/$f.json" ] && continue
  ./target/release/pdl-gto "$f" "lib/$f.json.tmp" 1.0 32 2>>lib/solve.log && mv "lib/$f.json.tmp" "lib/$f.json"
  echo "$(date +%H:%M:%S) $f done ($(ls lib/*.json | wc -l) total)" >> lib/progress.log
done
echo ALL_DONE >> lib/progress.log
