/**
 * V3.1 QA: play N full hands through the real HTTP API with a sensible rule-based Hero.
 * Usage: npx tsx scripts/qa-sim.ts <baseUrl> <hands> <solverFlopShare>
 * Reports terminal streets, showdown rate, grading coverage by assessment, repetition, latency,
 * invalid actions and integrity (chip conservation, terminal state).
 */
import { type Card, PREFLOP_TOP_SHARE, comboIndex, postflopStrength } from '@pdl/core';

const [base = 'http://localhost:8095', nArg = '500', sfArg = '0.2'] = process.argv.slice(2);
const N = Number(nArg);
let cookie = '';
const lat: number[] = [];
async function call(method: string, path: string, body?: unknown) {
  const t = performance.now();
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  lat.push(performance.now() - t);
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0]!;
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}
type Legal = { canFold: boolean; canCheck: boolean; canBet: boolean; canRaise: boolean; callAmount: number; minRaiseTo: number; maxRaiseTo: number; pot: number; toCall: number };

function heroAction(v: { heroCards: string[]; state: { board: string[]; street: string; currentBet: number; players: { id: string; stack: number; streetCommitted: number }[] }; legal: Legal; bigBlind: number; config: { heroPos: string } }, rnd: () => number) {
  const l = v.legal;
  const [a, b] = v.heroCards as Card[];
  const s = v.state.street === 'preflop' ? 1 - PREFLOP_TOP_SHARE[comboIndex(a!, b!)]! : postflopStrength(v.state.board as Card[])[comboIndex(a!, b!)]!;
  const me = v.state.players.find((p) => p.id === v.config.heroPos)!;
  const size = (frac: number) => Math.round(Math.min(l.maxRaiseTo, Math.max(l.minRaiseTo, v.state.currentBet + frac * (l.pot + l.toCall))));
  const aggressive = (frac: number) => (l.canBet ? { type: 'bet', amount: size(frac) } : l.canRaise ? { type: 'raise', amount: size(frac) } : l.canCheck ? { type: 'check' } : { type: 'call' });
  const passive = l.canCheck ? { type: 'check' } : { type: 'call' };
  const fold = l.canFold ? { type: 'fold' } : { type: 'check' };
  const price = l.toCall / Math.max(1, l.pot + l.toCall);
  if (v.state.street === 'preflop') {
    if (s > 0.88) return aggressive(rnd() < 0.2 ? 5 : 1);
    if (s > 0.62) return l.toCall <= 0.15 * (me.stack + me.streetCommitted) ? passive : fold;
    return rnd() < 0.05 ? aggressive(1) : fold;
  }
  if (s > 0.8) return rnd() < 0.7 ? aggressive(0.66) : passive;
  if (s > 0.45) return price < 0.35 ? passive : fold;
  if (l.toCall === 0 && rnd() < 0.12) return aggressive(0.5);
  return l.toCall === 0 ? passive : fold;
}

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const main = async () => {
  await call('POST', '/auth/register', { email: `qa-${Date.now()}@test.dev`, password: 'correct horse battery', displayName: 'QA' });
  const terminal: Record<string, number> = { preflop: 0, flop: 0, turn: 0, river: 0 };
  let showdown = 0, decisions = 0, invalid = 0, corrupt = 0, notTerminal = 0, hands = 0;
  const assess: Record<string, number> = {};
  const byTable: Record<string, { hands: number; decisions: number; graded: number }> = { random: { hands: 0, decisions: 0, graded: 0 }, solverFlop: { hands: 0, decisions: 0, graded: 0 } };
  for (let i = 0; i < N; i++) {
    const table = rnd() < Number(sfArg) ? 'solverFlop' : 'random';
    let v = (await call('POST', '/sim/hands', { table, mode: 'rated' })).body;
    for (let k = 0; k < 40 && v.status === 'active' && v.legal; k++) {
      // in a solved spot a user sees the tree's actions offered; pick among them like a user would
      const opts = v.current?.solverOptions as { action: unknown }[] | null;
      const action = opts?.length ? opts[Math.floor(rnd() * opts.length)]!.action : heroAction(v, rnd);
      const r = await call('POST', `/sim/hands/${v.id}/act`, { clientAttemptId: `qa-${i}-${k}-${Date.now()}`, action, confidence: 1 + Math.floor(rnd() * 3) });
      if (r.status !== 200) {
        console.error('non-200', r.status, JSON.stringify(r.body).slice(0, 200));
        invalid++;
        break;
      }
      v = r.body.view;
    }
    hands++;
    byTable[table]!.hands++;
    if (v.status !== 'complete' || !v.review) {
      notTerminal++;
      continue;
    }
    const net = Object.values(v.review.netBB as Record<string, number>).reduce((s, x) => s + x, 0);
    if (Math.abs(net) > 0.05) corrupt++;
    terminal[v.review.terminalStreet]!++;
    if (v.review.endedBy === 'showdown') showdown++;
    for (const d of v.decisions) {
      decisions++;
      byTable[table]!.decisions++;
      const a = d.feedback?.assessment ?? 'none';
      assess[a] = (assess[a] ?? 0) + 1;
      if (d.feedback?.graded) byTable[table]!.graded++;
    }
  }
  const graded = Object.entries(assess).filter(([k]) => ['solverVerified', 'assumedRange', 'mathVerified', 'reviewedStrategy'].includes(k)).reduce((s, [, n]) => s + n, 0);
  lat.sort((x, y) => x - y);
  const pct = (x: number, t: number) => `${((100 * x) / Math.max(1, t)).toFixed(1)}%`;
  const out = {
    hands,
    avgDecisionsPerHand: +(decisions / hands).toFixed(2),
    terminalStreet: Object.fromEntries(Object.entries(terminal).map(([k, n]) => [k, pct(n, hands - notTerminal)])),
    reachedShowdown: pct(showdown, hands - notTerminal),
    decisions,
    graded: pct(graded, decisions),
    byAssessment: Object.fromEntries(Object.entries(assess).map(([k, n]) => [k, `${n} (${pct(n, decisions)})`])),
    byTable: Object.fromEntries(Object.entries(byTable).map(([k, x]) => [k, { hands: x.hands, decisions: x.decisions, graded: pct(x.graded, x.decisions) }])),
    // exact / situation repetition is measured from the database (SimHand.exactKey / fingerprint)
    latencyMs: { median: +lat[Math.floor(lat.length / 2)]!.toFixed(1), p95: +lat[Math.floor(lat.length * 0.95)]!.toFixed(1), max: +lat[lat.length - 1]!.toFixed(1) },
    invalidActionResponses: invalid,
    handsNotTerminal: notTerminal,
    chipConservationFailures: corrupt,
  };
  console.log(JSON.stringify(out, null, 2));
};
void main();
