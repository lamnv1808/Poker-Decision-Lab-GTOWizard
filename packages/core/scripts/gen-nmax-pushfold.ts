/**
 * Generates the N-player push/fold reference dataset (APPROXIMATE_MODEL, chip EV) into
 * apps/server/data/ranges/. Run: npx tsx scripts/gen-nmax-pushfold.ts [--quick]
 *
 * Every record is validated (169 classes, frequency sums, checksum) before it is written; the manifest
 * lists per configuration the ε-Nash diagnostics, runtime and checksum. Nothing is interpolated: each
 * (table size, stack, ante) is its own solve.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { CLASSES, solvePushFold } from '../src/gto/pushfold';
import { RANGE_SCHEMA_VERSION, canonicalKey, recordChecksum, validateRecord, type RangeRecord } from '../src/dqe/ranges';
import { NMAX_APPROXIMATION, NMAX_EQUITY_METHOD, NMAX_PUSHFOLD_VERSION, nmaxRecords, solveNmaxPushFold } from '../src/dqe/nmaxPushFold';

const quick = process.argv.includes('--quick');
const OUT = new URL('../../../apps/server/data/ranges/', import.meta.url);
const TABLES = quick ? [6] : [6, 7, 8, 9];
const STACKS = quick ? [10] : [5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 17.5, 20];
const DEADS = quick ? [1] : [0, 1];
const ITER = Number(process.env.ITER ?? 3000);

const build = (r: Omit<RangeRecord, 'checksum' | 'keyString' | 'schema'>): RangeRecord => {
  const rec = { ...r, schema: RANGE_SCHEMA_VERSION, keyString: canonicalKey(r.key) } as RangeRecord;
  rec.checksum = recordChecksum(rec);
  return rec;
};

mkdirSync(OUT, { recursive: true });
const manifest: Record<string, unknown>[] = [];
const benchmark: Record<string, unknown>[] = [];
const t0 = Date.now();
const mem0 = process.memoryUsage().rss;

// Benchmark: N = 2 must reproduce the heads-up solver already in the app
for (const [S, D] of [[5, 0], [10, 0], [10, 1], [15, 1.5]] as const) {
  const hu = solvePushFold({ stackBB: S, deadBB: D });
  const nm = solveNmaxPushFold({ tableSize: 2, stackBB: S, deadBB: D }, { iterations: 1500 });
  let maxF = 0, maxEv = 0, flips = 0;
  for (let h = 0; h < CLASSES.length; h++) {
    maxF = Math.max(maxF, Math.abs(nm.shove[0]![h]! - hu.push[h]!), Math.abs(nm.call[0]![1]![h]! - hu.call[h]!));
    maxEv = Math.max(maxEv, Math.abs(nm.evShove[0]![h]! - hu.evShove[h]!));
    if ((nm.evShove[0]![h]! > 0) !== (hu.evShove[h]! > 0)) flips++;
  }
  benchmark.push({ stackBB: S, deadBB: D, maxFreqDiff: +maxF.toFixed(4), maxEvDiffBB: +maxEv.toFixed(5), evSignFlips: flips, epsilonNmax: nm.maxEpsilonBB, exploitabilityHU: hu.exploitabilityBB });
}
console.log('benchmark N=2 vs HU solver:', JSON.stringify(benchmark));

let rows = 0;
for (const n of TABLES) {
  const records: RangeRecord[] = [];
  for (const S of STACKS)
    for (const D of DEADS) {
      const sol = solveNmaxPushFold({ tableSize: n, stackBB: S, deadBB: D }, { iterations: ITER });
      const recs = nmaxRecords(sol, build);
      for (const r of recs) {
        const p = validateRecord(r);
        if (p.length) throw new Error(`invalid record ${r.keyString}: ${p.slice(0, 3).join('; ')}`);
      }
      records.push(...recs);
      rows += recs.length * CLASSES.length;
      manifest.push({ tableSize: n, stackBB: S, deadBB: D, nodes: recs.length, iterations: ITER, maxEpsilonBB: sol.maxEpsilonBB, maxNodeGainBB: sol.maxNodeGainBB, epsilonBySeat: sol.epsilonBySeat.map((x) => +x.toExponential(3)), runtimeMs: sol.runtimeMs });
      console.log(`${n}-max S=${S} D=${D}: ${recs.length} nodes, ε ${sol.maxEpsilonBB.toExponential(2)} BB/hand, node gain ${sol.maxNodeGainBB.toExponential(2)}, ${sol.runtimeMs} ms`);
    }
  const file = new URL(`pushfold-nmax-${n}max.json.gz`, OUT);
  writeFileSync(file, gzipSync(JSON.stringify({ schema: RANGE_SCHEMA_VERSION, method: NMAX_PUSHFOLD_VERSION, records })));
}
const summary = {
  schema: RANGE_SCHEMA_VERSION,
  method: NMAX_PUSHFOLD_VERSION,
  evidence: 'approximateModel',
  approximation: NMAX_APPROXIMATION,
  equitySource: NMAX_EQUITY_METHOD,
  licence: { id: 'PDL-computed', redistributable: true },
  generatedAt: new Date().toISOString(),
  iterations: ITER,
  configurations: manifest.length,
  records: manifest.reduce((a, m) => a + (m.nodes as number), 0),
  handRows: rows,
  totalRuntimeMs: Date.now() - t0,
  peakRssMB: Math.round(Math.max(process.memoryUsage().rss, mem0) / 1e6),
  benchmarkVsHeadsUp: benchmark,
  configurationsList: manifest,
};
writeFileSync(new URL('pushfold-nmax-manifest.json', OUT), JSON.stringify(summary, null, 1));
console.log(`done: ${summary.configurations} configurations, ${summary.records} records, ${rows} hand rows, ${Math.round(summary.totalRuntimeMs / 1000)} s, peak RSS ${summary.peakRssMB} MB`);
