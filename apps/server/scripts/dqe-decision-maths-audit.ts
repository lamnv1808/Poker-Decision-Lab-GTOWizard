/**
 * Gate 1 audit — Decision Maths over every accepted historical decision. READ-ONLY, aggregates only.
 *
 *   DATABASE_URL=<isolated copy> npx tsx scripts/dqe-decision-maths-audit.ts [--out dir]
 *
 * For each decision: the existing DQE verdict (unchanged baseline) and decisionMath() for the action actually
 * taken, using only the state before the action. Reports eligibility per calculation, unsupported reasons,
 * which decisions gain a fact that prices the chosen action, what stays Unrated and why, a cross-check of the
 * required-equity value against the DQE's own (independent) computation, and runtime per decision.
 * A decision is never counted as gradeable because it has a fact (gradeable is false by construction).
 */
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { auditHand, decisionMath, dqeDecisionFromReal, evaluateDecision, huPushFoldSource, pricesChosenAction, rangeLibrarySource, snapshotForHeroAction, type PlayerAction, type RangeRecord } from '@pdl/core';
import { prisma } from '../src/db';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const OUT = arg('--out') ?? 'dqe-decision-maths-out';
const DATA = new URL('../data/ranges/', import.meta.url).pathname;
const library: RangeRecord[] = [];
if (existsSync(DATA)) for (const f of readdirSync(DATA).filter((x) => x.endsWith('.json.gz'))) library.push(...(JSON.parse(gunzipSync(readFileSync(join(DATA, f))).toString()) as { records: RangeRecord[] }).records);
const sources = [huPushFoldSource, rangeLibrarySource('pdl-pushfold-nmax', library, { stackBB: (s: number) => (s <= 15.25 ? 0.25 : 1.25), deadBB: 0.25 })];

type C = Map<string, number>;
const inc = (m: C, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const obj = (m: C) => Object.fromEntries([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
const cat = (c: string) => ({ VERIFIED_SOLVER_EV: 'verified', EXACT_MATHEMATICAL_RESULT: 'math', MODEL_ESTIMATE: 'model', INSUFFICIENT_EVIDENCE: 'unrated' } as Record<string, string>)[c] ?? c;

async function main() {
  const t0 = Date.now();
  mkdirSync(OUT, { recursive: true });
  const baseline: C = new Map();
  const eligible: C = new Map(); // street|factId → decisions with that fact
  const unsupported: C = new Map(); // street|factId|reason
  const whole: C = new Map(); // street|status|reason
  const priced: C = new Map(); // street|baselineCategory|chosen|pricesChosen(yes/no)
  const unratedPost: C = new Map(); // postflop Unrated: why nothing prices the action
  const crossCheck = { compared: 0, agree: 0, maxAbsDiff: 0, disagreeSamples: [] as string[] };
  let total = 0, failed = 0, mathNs = 0n, gradeableViolations = 0;
  let last = '';
  for (;;) {
    const page = await prisma.realHand.findMany({ where: { status: 'accepted', id: { gt: last } }, orderBy: { id: 'asc' }, take: 400, select: { id: true, raw: true, format: true, decisions: { where: { status: 'accepted' }, orderBy: { id: 'asc' }, select: { id: true, heroActionNo: true } } } });
    if (!page.length) break;
    last = page[page.length - 1]!.id;
    for (const h of page) {
      const a = auditHand(h.raw);
      for (const d of h.decisions) {
        total++;
        const snap = a.rec ? snapshotForHeroAction(a.rec, d.heroActionNo) : null;
        if (!a.rec || !snap) { failed++; continue; }
        const x = dqeDecisionFromReal(a.rec, snap, h.format, d.id);
        const v = evaluateDecision(x, sources);
        const c = cat(v.category);
        inc(baseline, v.category);
        const street = x.street;
        const raw = a.rec.parsed.actions[snap.actionIndex]!;
        const chosen: PlayerAction = { type: raw.type as PlayerAction['type'], amount: raw.type === 'bet' || raw.type === 'raise' ? raw.amount : undefined };
        const t = process.hrtime.bigint();
        const m = decisionMath(snap.state, snap.heroId, chosen, { economics: x.economics });
        mathNs += process.hrtime.bigint() - t;
        if (m.gradeable !== false || m.strategicVerdict !== 'NOT_ESTABLISHED') gradeableViolations++;
        inc(whole, `${street}|${m.status}|${m.unsupportedReason ?? '-'}`);
        for (const f of m.facts) inc(eligible, `${street}|${f.id}|${f.class}`);
        for (const u of m.unsupported) inc(unsupported, `${street}|${u.id}|${u.reason.split(':')[0]!.slice(0, 60)}`);
        const p = m.status === 'ok' && pricesChosenAction(m);
        inc(priced, `${street === 'preflop' ? 'preflop' : 'postflop'}|${c}|${chosen.type}|${p ? 'priced' : 'notPriced'}`);
        if (street !== 'preflop' && c === 'unrated' && !p) inc(unratedPost, m.status !== 'ok' ? `unsupported: ${m.unsupportedReason}` : chosen.type === 'check' ? 'check: only descriptive facts (SPR, effective stack)' : `${chosen.type}: no fact prices it`);
        // independent cross-check: the DQE computes required equity from the same state by its own path
        const req = m.facts.find((f) => f.id === 'requiredEquity' || f.id === 'allInCallThreshold');
        if (req && x.requiredEquity != null) {
          crossCheck.compared++;
          const diff = Math.abs(req.value - x.requiredEquity);
          crossCheck.maxAbsDiff = Math.max(crossCheck.maxAbsDiff, diff);
          if (diff < 1e-3) crossCheck.agree++;
          else if (crossCheck.disagreeSamples.length < 10) crossCheck.disagreeSamples.push(`${street} ${chosen.type}: maths ${req.value} vs dqe ${x.requiredEquity}`);
        }
      }
    }
  }
  const report = {
    version: 'dqe-decision-maths-audit-1',
    decisions: total,
    reconstructionFailed: failed,
    baseline: obj(baseline),
    gradeableViolations,
    wholeDecision: obj(whole),
    factsByStreet: obj(eligible),
    unsupportedByStreet: obj(unsupported),
    chosenActionPriced: obj(priced),
    postflopUnratedNotPriced: obj(unratedPost),
    requiredEquityCrossCheck: crossCheck,
    decisionMathMicrosPerDecision: Math.round(Number(mathNs / BigInt(Math.max(1, total - failed))) / 10) / 100,
    runtimeMs: Date.now() - t0,
    peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
  };
  writeFileSync(join(OUT, 'decision-maths-audit.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report));
}
main().finally(() => prisma.$disconnect());
