/**
 * Phase 4A research audit — READ-ONLY, aggregates only (no hands, cards, names or ids are printed).
 *
 *   DATABASE_URL=<isolated restored copy> npx tsx scripts/dqe-phase4a.ts [--out dir]
 *
 * 1. Reproduces the merged DQE baseline (same sources and tolerances as scripts/dqe-audit.ts).
 * 2. Intersects the top Unrated families with format, stack, position, street and action.
 * 3. For each proposed Phase 4 module, decides per decision whether it would apply and what evidence it
 *    could add, then combines modules by DEDUPLICATED decision id (a decision counts once).
 * 4. Measures what the hand histories contain for PKO modelling (buy-in, starting stack, recorded bounties).
 * 5. Census of heads-up single-raised-pot flop lines for the solver-library feasibility study.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { auditHand, buyInFromTournamentName, decisionMath, dqeDecisionFromReal, evaluateDecision, huPushFoldSource, rangeLibrarySource, snapshotForHeroAction, stackBucket, type PlayerAction, type RangeRecord } from '@pdl/core';
import { prisma } from '../src/db';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const OUT = arg('--out') ?? 'dqe-phase4a-out';
const DATA = new URL('../data/ranges/', import.meta.url).pathname;
const library: RangeRecord[] = [];
if (existsSync(DATA)) for (const f of readdirSync(DATA).filter((x) => x.endsWith('.json.gz'))) library.push(...(JSON.parse(gunzipSync(readFileSync(join(DATA, f))).toString()) as { records: RangeRecord[] }).records);
const sources = [huPushFoldSource, rangeLibrarySource('pdl-pushfold-nmax', library, { stackBB: (s: number) => (s <= 15.25 ? 0.25 : 1.25), deadBB: 0.25 })];
const SOLVED_FLOPS = new Set(existsSync(new URL('../data/postflop/', import.meta.url).pathname) ? readdirSync(new URL('../data/postflop/', import.meta.url).pathname).map((f) => f.replace('.json.gz', '')) : []);

type Counter = Map<string, number>;
const inc = (m: Counter, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const top = (m: Counter, n = 40) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
const cat = (c: string) => ({ VERIFIED_SOLVER_EV: 'verified', VERIFIED_REFERENCE_FREQUENCY: 'freq', EXACT_MATHEMATICAL_RESULT: 'math', MODEL_ESTIMATE: 'model', HEURISTIC_GUIDANCE: 'heuristic', INSUFFICIENT_EVIDENCE: 'unrated' })[c] ?? c;
const sb = (s: number | null) => (s == null ? '?' : stackBucket(s));
// suit-isomorphic flop key (ranks sorted desc, suits relabelled by first appearance)
const RANKS = '23456789TJQKA';
function flopKey(cards: string[]): string {
  const cs = [...cards].sort((a, b) => RANKS.indexOf(b[0]!) - RANKS.indexOf(a[0]!) || (a[1]! < b[1]! ? -1 : 1));
  const map = new Map<string, string>();
  const letters = 'abcd';
  return cs.map((c) => { if (!map.has(c[1]!)) map.set(c[1]!, letters[map.size]!); return c[0]! + map.get(c[1]!)!; }).join('');
}
const solvedKeys = new Set([...SOLVED_FLOPS].map((f) => flopKey([f.slice(0, 2), f.slice(2, 4), f.slice(4, 6)])));

async function main() {
  const t0 = Date.now();
  mkdirSync(OUT, { recursive: true });

  // ---------- pass 1: what the histories contain for PKO (buy-in, starting stack, recorded bounties)
  const startStacks = new Map<string, Counter>(); // tournament name → Level-1 hero stack histogram (Phase 4A method, kept for comparison)
  const firstHand = new Map<string, { ts: string; name: string; stack: number }>(); // tournament id → Hero's first recorded hand
  let last = '';
  let handsPko = 0, pkoBuyIn = 0, seatsWithBounty = 0, seatsPko = 0;
  for (;;) {
    const page = await prisma.realHand.findMany({ where: { status: 'accepted', id: { gt: last } }, orderBy: { id: 'asc' }, take: 500, select: { id: true, raw: true, format: true } });
    if (!page.length) break;
    last = page[page.length - 1]!.id;
    for (const h of page) {
      const a = auditHand(h.raw);
      if (!a.rec) continue;
      const p = a.rec.parsed;
      const name = (p.tournamentName ?? '').trim();
      if (h.format === 'PKO') {
        handsPko++;
        if (buyInFromTournamentName(name) != null) pkoBuyIn++;
        seatsPko += p.seats.length;
        seatsWithBounty += p.seats.filter((x) => x.bounty != null).length;
      }
      const heroSeat = p.seats.find((x) => x.name === p.heroName);
      const ts = (h.raw.match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/) ?? [])[1] ?? '';
      if (p.tournamentId && heroSeat && ts) { const f = firstHand.get(p.tournamentId); if (!f || ts < f.ts) firstHand.set(p.tournamentId, { ts, name, stack: heroSeat.stack }); }
      if (/^Level\s*1\b|^Level1\b/i.test(p.level ?? '') || /^1$/.test(p.level ?? '')) {
        const hero = p.seats.find((x) => x.name === p.heroName);
        if (hero) { const m = startStacks.get(name) ?? new Map(); inc(m, String(hero.stack)); startStacks.set(name, m); }
      }
    }
  }
  const startStackLevel1 = new Map<string, number>();
  for (const [name, m] of startStacks) { const [v, n] = top(m, 1)[0]!; if (n >= 3) startStackLevel1.set(name, Number(v)); }
  // verified: mode of the first-hand stacks of a series, ≥3 tournaments, ≥90 % at the mode
  const firstByName = new Map<string, Counter>();
  for (const f of firstHand.values()) { const m = firstByName.get(f.name) ?? new Map(); inc(m, String(f.stack)); firstByName.set(f.name, m); }
  const startStackByName = new Map<string, number>();
  for (const [name, m] of firstByName) { const tot = [...m.values()].reduce((a, b) => a + b, 0); const [v, n] = top(m, 1)[0]!; if (tot >= 3 && n / tot >= 0.9) startStackByName.set(name, Number(v)); }

  // ---------- pass 2: decisions
  const base: Counter = new Map();
  const fam: Counter = new Map();
  const famX: Counter = new Map(); // family intersections
  const mod: Counter = new Map(); // module × current category × new evidence
  const union: Counter = new Map(); // deduplicated: set of modules that lift an Unrated decision
  const census: Counter = new Map();
  const pkoBand: Counter = new Map();
  const contentLines: string[] = [];
  let total = 0, failed = 0;
  last = '';
  for (;;) {
    const page = await prisma.realHand.findMany({ where: { status: 'accepted', id: { gt: last } }, orderBy: { id: 'asc' }, take: 400, select: { id: true, raw: true, format: true, decisions: { where: { status: 'accepted' }, orderBy: { id: 'asc' }, select: { id: true, heroActionNo: true } } } });
    if (!page.length) break;
    last = page[page.length - 1]!.id;
    for (const h of page) {
      const a = auditHand(h.raw);
      const rawHash = createHash('sha256').update(h.raw).digest('hex');
      for (const d of h.decisions) {
        total++;
        const snap = a.rec ? snapshotForHeroAction(a.rec, d.heroActionNo) : null;
        if (!a.rec || !snap) { failed++; inc(base, 'RECONSTRUCTION_FAILED'); continue; }
        const rec = a.rec;
        const x = dqeDecisionFromReal(rec, snap, h.format, d.id);
        const v = evaluateDecision(x, sources);
        const c = cat(v.category);
        inc(base, v.category);
        contentLines.push(`${createHash('sha256').update(`${rawHash}|${d.heroActionNo}`).digest('hex')}|${v.category}|${v.grade}|${v.source?.referenceKey ?? ''}`);
        const pre = x.street === 'preflop';
        const S = x.effStackBB;
        const ways = x.villainPositions.length + 1;
        const fmt = x.economics;
        const family = pre ? `preflop|${x.node}|${x.tableSize}-max|${x.heroPos}|${sb(S)}` : `${x.street}|${ways >= 3 ? '3+way' : 'HU'}|${sb(S)}`;
        if (c === 'unrated') {
          inc(fam, family);
          inc(famX, `fmt|${fmt}`); inc(famX, `street|${x.street}`); inc(famX, `stack|${sb(S)}`); inc(famX, `action|${x.street === 'preflop' ? 'pre' : 'post'}:${x.chosenAction}`);
          if (pre) inc(famX, `pos|${x.heroPos}`);
          inc(famX, `fmt×street×stack|${fmt}|${x.street}|${sb(S)}`);
          if (pre) inc(famX, `fmt×node×stack|${fmt}|${x.node}|${sb(S)}`);
        }

        // ----- module flags: what each could add for THIS decision
        const lifts: string[] = [];
        const chosenRaw = rec.parsed.actions[snap.actionIndex]!;
        const chosen: PlayerAction = { type: chosenRaw.type as PlayerAction['type'], amount: chosenRaw.type === 'bet' || chosenRaw.type === 'raise' ? chosenRaw.amount : undefined };

        // M1 PKO push/fold model band (≤20 BB, first-in after folds or facing one shove)
        const pfShape = pre && S != null && S <= 20 && ((x.node === 'unopened' && x.history.every((p) => p.action === 'fold')) || x.node === 'facingShove');
        if (pfShape && fmt === 'PKO') {
          const name = (rec.parsed.tournamentName ?? '').trim();
          const buyIn = buyInFromTournamentName(name);
          const start = startStackByName.get(name) ?? null;
          const status = buyIn == null ? 'noBuyIn' : start == null ? 'noStartingStack' : 'band';
          inc(mod, `M1|${c}|${status}`);
          if (status === 'band' && S != null) {
            // bounty decision value band in BB (low/mid/high scenarios = 0.625 / 1.125 / 2.625 starting stacks)
            const ssBB = start! / rec.parsed.bigBlind;
            const lo = 0.625 * ssBB, hi = 2.625 * ssBB;
            const regime = hi / S < 0.25 ? 'bounty<0.25stack(all scenarios)' : lo / S >= 1 ? 'bounty≥stack(all scenarios)' : 'spansRegimes';
            inc(pkoBand, `${c}|${regime}`);
            for (const [tag, small, big] of [['strict', 0.15, 1.5], ['default', 0.25, 1], ['loose', 0.35, 0.75]] as const) inc(pkoBand, `thresholds:${tag}|${c}|${hi / S < small || lo / S >= big ? 'robust' : 'sensitive'}`);
            if (c === 'unrated' && regime !== 'spansRegimes') lifts.push('M1');
          }
        }

        // M2 decision maths (identities + model references) for the chosen action
        const m = decisionMath(snap.state, snap.heroId, chosen, { economics: fmt });
        const keys = new Set(m.facts.map((f) => f.key));
        const decisive = keys.has('breakEvenFoldFrequency') || keys.has('riskReward') || keys.has('requiredEquity') || keys.has('allInCallThreshold');
        inc(mod, `M2|${c}|${m.status === 'unsupported' ? 'unsupported' : decisive ? 'decisionFacts' : keys.size ? 'descriptiveOnly(SPR)' : 'none'}|${pre ? 'pre' : 'post'}`);
        // a fact counts as decision-relevant only if it prices the CHOSEN action: Hero's bet/raise/shove (risk,
        // break-even fold frequency). For an unopened fold or limp, the price of limping does not evaluate the
        // decision; a check only gets the (descriptive) SPR.
        const aggressive = chosen.type === 'bet' || chosen.type === 'raise';
        if (c === 'unrated' && m.status === 'ok' && decisive && aggressive) lifts.push(pre ? 'M2pre' : 'M2post');

        // M3 preflop ranges 15–40 BB (restricted-tree CFR, chip EV) — PKO/ICM need separate economics
        if (pre && S != null && S > 15 && S <= 40) {
          const t = x.tableSize <= 6 ? '≤6-max' : '7-9-max';
          inc(mod, `M3|${c}|${fmt}|${x.node}|${t}`);
          if (c === 'unrated' && fmt === 'chipEV' && x.node !== 'facingShoveMultiway') lifts.push('M3chip');
          if (c === 'unrated' && fmt === 'PKO' && x.node !== 'facingShoveMultiway') lifts.push('M3pkoPolicy');
        }

        // M4 heads-up single-raised-pot flop library (census + solved-board match)
        if (x.street === 'flop' && ways === 2) {
          const preActs = rec.parsed.actions.filter((p) => p.street === 'preflop');
          const raises = preActs.filter((p) => p.type === 'raise' || p.type === 'bet');
          const calls = preActs.filter((p) => p.type === 'call');
          const shoves = raises.filter((p) => p.allIn);
          const line = raises.length === 0 ? 'limped' : raises.length === 1 && !shoves.length ? 'SRP' : raises.length === 2 ? '3BP' : '4BP+';
          const opener = raises[0] ? rec.positions[raises[0].player] ?? '?' : '-';
          const caller = raises.length === 1 ? (calls.filter((p) => p.player !== raises[0]!.player).map((p) => rec.positions[p.player] ?? '?').pop() ?? '?') : '-';
          const flop = rec.parsed.board.slice(0, 3).map(String);
          const key = flop.length === 3 ? flopKey(flop) : null;
          const solved = key != null && solvedKeys.has(key);
          const pair = line === 'SRP' ? `${opener}v${caller}` : line;
          inc(census, `${line}|${pair}|${sb(S)}|${fmt}`);
          inc(census, `ALL|${line}`);
          if (line === 'SRP' && opener === 'BTN' && caller === 'BB') inc(census, `BTNvBB|${sb(S)}|${solved ? 'boardSolved' : 'boardNotSolved'}|${c}`);
          if (line === 'SRP' && S != null && S >= 25) { inc(mod, `M4|${c}|${fmt}|${pair}`); if (c === 'unrated') lifts.push(`M4:${pair}`); }
        }

        if (c === 'unrated') {
          const set = [...new Set(lifts.map((l) => (l.startsWith('M4:') ? 'M4' : l)))].sort();
          inc(union, set.length ? set.join('+') : '(none)');
        }
      }
    }
  }
  const contentHash = createHash('sha256').update(contentLines.sort().join('\n')).digest('hex');
  const report = {
    decisions: total,
    reconstructionFailed: failed,
    baseline: Object.fromEntries(top(base, 10)),
    baselineContentSha256: contentHash,
    pkoData: { handsPko, pkoBuyInParsed: pkoBuyIn, seatsPko, seatsWithRecordedBounty: seatsWithBounty, tournaments: firstHand.size, seriesWithVerifiedStartingStack: startStackByName.size, seriesSeen: firstByName.size, phase4aLevel1Estimates: startStackLevel1.size, verifiedVsLevel1Disagree: [...startStackByName.entries()].filter(([k, v]) => startStackLevel1.has(k) && startStackLevel1.get(k) !== v).length },
    topUnratedFamilies: top(fam, 30),
    unratedIntersections: top(famX, 80),
    modules: top(mod, 200),
    pkoBountyRegimes: top(pkoBand, 20),
    unratedLiftCombinations: top(union, 40),
    flopCensus: top(census, 400),
    runtimeMs: Date.now() - t0,
    peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
  };
  writeFileSync(join(OUT, 'phase4a-report.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report));
}
main().finally(() => prisma.$disconnect());
