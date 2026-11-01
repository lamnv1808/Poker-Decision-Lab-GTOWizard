/**
 * Builds the 169×169 preflop all-in equity table used by the push/fold equilibrium solver.
 * For each pair of hand classes: uniformly random non-conflicting combo pairs and random boards
 * (seeded Monte Carlo). Combo-pair counts (card removal weights) are exact.
 * Output: src/gto/preflop-equity.json. Run: npx tsx scripts/build-preflop-equity.ts [samplesPerPair]
 */
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { ALL_CLASSES, classCombos } from '../src/cards/range';
import { cardToInt } from '../src/cards/cards';
import { evaluateInts } from '../src/cards/evaluator';
import { createRng, hashString } from '../src/cards/rng';

const N = ALL_CLASSES.length;
const combos = ALL_CLASSES.map((c) => classCombos(c).map(([a, b]) => [cardToInt(a), cardToInt(b)] as [number, number]));

function pairs(i: number, j: number) {
  const out: [number, number, number, number][] = [];
  for (const [a, b] of combos[i]!) for (const [c, d] of combos[j]!) if (a !== c && a !== d && b !== c && b !== d) out.push([a, b, c, d]);
  return out;
}

function solvePair(i: number, j: number, samples: number): number {
  const ps = pairs(i, j);
  const rng = createRng(hashString(`${ALL_CLASSES[i]}|${ALL_CLASSES[j]}`));
  const used = new Uint8Array(52);
  let score = 0;
  for (let s = 0; s < samples; s++) {
    const [a, b, c, d] = ps[Math.floor(rng() * ps.length)]!;
    used.fill(0);
    used[a] = used[b] = used[c] = used[d] = 1;
    const board: number[] = [];
    while (board.length < 5) {
      const k = Math.floor(rng() * 52);
      if (!used[k]) {
        used[k] = 1;
        board.push(k);
      }
    }
    const h = evaluateInts([a, b, ...board]);
    const v = evaluateInts([c, d, ...board]);
    score += h > v ? 1 : h === v ? 0.5 : 0;
  }
  return score / samples;
}

if (isMainThread) {
  const samples = Number(process.argv[2] ?? 20000);
  const tasks: [number, number][] = [];
  for (let i = 0; i < N; i++) for (let j = i; j < N; j++) tasks.push([i, j]);
  const workers = Math.max(1, availableParallelism());
  const eq = new Float64Array(N * N);
  const t0 = Date.now();
  let done = 0;
  await Promise.all(
    Array.from({ length: workers }, (_, w) =>
      new Promise<void>((resolve, reject) => {
        const mine = tasks.filter((_, k) => k % workers === w);
        const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { mine, samples }, execArgv: process.execArgv });
        worker.on('message', (m: [number, number, number][]) => {
          for (const [i, j, e] of m) {
            eq[i * N + j] = e;
            eq[j * N + i] = 1 - e;
          }
          done += m.length;
        });
        worker.on('error', reject);
        worker.on('exit', () => resolve());
      }),
    ),
  );
  // identical classes split exactly in expectation
  for (let i = 0; i < N; i++) eq[i * N + i] = 0.5;
  const w = new Array<number>(N * N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) w[i * N + j] = pairs(i, j).length;
  writeFileSync(
    new URL('../src/gto/preflop-equity.json', import.meta.url),
    JSON.stringify({
      method: `Seeded Monte Carlo, ${samples} random combo-pair/board samples per class matchup; exact combo-pair weights`,
      samplesPerPair: samples,
      classes: ALL_CLASSES,
      eq: Array.from(eq, (x) => Math.round(x * 10000) / 10000),
      w,
    }),
  );
  console.log(`done ${done} matchups in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else {
  const { mine, samples } = workerData as { mine: [number, number][]; samples: number };
  const out: [number, number, number][] = [];
  for (const [i, j] of mine) out.push([i, j, i === j ? 0.5 : solvePair(i, j, samples)]);
  parentPort!.postMessage(out);
}
