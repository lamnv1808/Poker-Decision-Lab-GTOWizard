/**
 * R3 research — how many historical flop decisions could a heads-up single-raised-pot solver library grade?
 * READ-ONLY, aggregates only.   DATABASE_URL=<isolated copy> npx tsx scripts/dqe-flop-pilot-census.ts
 *
 * Funnel against the solved configuration of the existing 85-flop library (pdl-gto / postflop-solver):
 * BTN opens 2.2 BB, BB calls, pot 5.9 BB at the flop (BB ante), 32 BB effective; flop OOP bet 33 %, IP bet 33 /
 * 75 %, raises 3×. A decision is "solver-gradeable" only if EVERY element of the solved game matches: line,
 * positions, open size, stack depth, pot, the action sequence on the flop so far, the size of Hero's action,
 * the board (suit-isomorphic), chip EV. Also reports what a full isomorphic-board library would add.
 */
import { readdirSync, existsSync } from 'node:fs';
import { auditHand, dqeDecisionFromReal, evaluateDecision, huPushFoldSource, snapshotForHeroAction } from '@pdl/core';
import { prisma } from '../src/db';

const RANKS = '23456789TJQKA';
function flopKey(cards: string[]): string {
  const cs = [...cards].sort((a, b) => RANKS.indexOf(b[0]!) - RANKS.indexOf(a[0]!) || (a[1]! < b[1]! ? -1 : 1));
  const map = new Map<string, string>();
  return cs.map((c) => { if (!map.has(c[1]!)) map.set(c[1]!, 'abcd'[map.size]!); return c[0]! + map.get(c[1]!)!; }).join('');
}
const DIR = new URL('../data/postflop/', import.meta.url).pathname;
const solved = new Set(existsSync(DIR) ? readdirSync(DIR).map((f) => f.replace('.json.gz', '')).map((f) => flopKey([f.slice(0, 2), f.slice(2, 4), f.slice(4, 6)])) : []);
const within = (x: number, target: number, rel: number) => Math.abs(x - target) <= target * rel;
/** BROAD=1: upper bound for a library covering EVERY position pair and stack depth (same tree sizes); stages 4–7 skipped */
const BROAD = process.env.BROAD === '1';

function flopActsFirst(rec: { parsed: { actions: { street: string; player: string }[] } }, hero: string) {
  const first = rec.parsed.actions.find((p) => p.street === 'flop');
  return first?.player === hero;
}

async function main() {
  const t0 = Date.now();
  const funnel = new Map<string, number>();
  const inc = (k: string) => funnel.set(k, (funnel.get(k) ?? 0) + 1);
  const why = new Map<string, number>();
  const miss = (k: string) => why.set(k, (why.get(k) ?? 0) + 1);
  const finalCat = new Map<string, number>();
  let last = '';
  for (;;) {
    const page = await prisma.realHand.findMany({ where: { status: 'accepted', id: { gt: last } }, orderBy: { id: 'asc' }, take: 400, select: { id: true, raw: true, format: true, decisions: { where: { status: 'accepted' }, orderBy: { id: 'asc' }, select: { id: true, heroActionNo: true } } } });
    if (!page.length) break;
    last = page[page.length - 1]!.id;
    for (const h of page) {
      const a = auditHand(h.raw);
      for (const d of h.decisions) {
        const snap = a.rec ? snapshotForHeroAction(a.rec, d.heroActionNo) : null;
        if (!a.rec || !snap || snap.state.street !== 'flop') continue;
        const rec = a.rec;
        const s = snap.state;
        const bb = rec.parsed.bigBlind;
        const x = dqeDecisionFromReal(rec, snap, h.format, d.id);
        inc('1 flop decisions');
        const live = s.players.filter((p) => !p.folded);
        if (live.length !== 2) { miss('not heads-up'); continue; }
        inc('2 heads-up');
        const pre = rec.parsed.actions.filter((p) => p.street === 'preflop');
        const raises = pre.filter((p) => p.type === 'raise' || p.type === 'bet');
        if (raises.length !== 1 || raises[0]!.allIn) { miss('not a single-raised pot'); continue; }
        inc('3 single-raised pot');
        const opener = rec.positions[raises[0]!.player];
        const caller = live.map((p) => p.id).find((id) => id !== raises[0]!.player);
        if (!BROAD && (opener !== 'BTN' || rec.positions[caller ?? ''] !== 'BB')) { miss(`positions ${opener}v${rec.positions[caller ?? '']}`.slice(0, 40)); continue; }
        inc('4 BTN open, BB call');
        const openBB = raises[0]!.amount / bb;
        if (!(openBB >= 2.0 && openBB <= 2.5)) { miss('open size not 2.0–2.5 BB'); continue; }
        inc('5 open 2.0–2.5 BB');
        const effAtFlopStart = Math.min(...live.map((p) => (p.stack + p.streetCommitted) / bb)) + openBB; // stack behind at the flop + the open ≈ effective stack at the start of the hand
        if (!BROAD && !within(effAtFlopStart, 32, 0.1)) { miss(`stack not 32 BB ±10 % (${effAtFlopStart < 32 ? 'shorter' : 'deeper'})`); continue; }
        inc('6 stack 32 BB ±10 %');
        const flopCommitted = s.players.reduce((acc, p) => acc + p.streetCommitted, 0);
        const potBB = (x.potBB ?? 0) - flopCommitted / bb;
        if (!BROAD && !within(potBB, 5.9, 0.15)) { miss('flop pot not 5.9 BB ±15 % (ante structure)'); continue; }
        inc('7 pot 5.9 BB ±15 %');
        // flop line so far and Hero's action must be on the solved tree
        const flopActs = rec.parsed.actions.slice(0, snap.actionIndex).filter((p) => p.street === 'flop');
        // out of position = the player who acts first on the flop (BB/SB, or the earlier seat)
        const heroIsBB = BROAD ? s.players.find((p) => p.id === snap.heroId)!.seat !== undefined && flopActsFirst(rec, snap.heroId) : rec.positions[snap.heroId] === 'BB';
        const potBefore = potBB * bb;
        const seq = flopActs.map((p) => (p.type === 'check' ? 'x' : p.type === 'bet' ? (within(p.amount / potBefore, 0.33, 0.25) ? 'b33' : within(p.amount / potBefore, 0.75, 0.2) ? 'b75' : 'b?') : p.type === 'raise' ? 'r' : p.type === 'call' ? 'c' : '?')).join('-');
        const okSeq = heroIsBB ? ['', 'x-b33', 'x-b75'].includes(seq) : ['x', 'b33'].includes(seq);
        if (!okSeq) { miss(`flop line off-tree or deeper than one action (${seq || 'none'})`); continue; }
        inc('8 flop line on tree');
        const act = rec.parsed.actions[snap.actionIndex]!;
        const facing = seq.endsWith('b33') || seq.endsWith('b75');
        let onTree = false;
        if (act.type === 'check' || act.type === 'fold' || act.type === 'call') onTree = true;
        else if (act.type === 'bet' && !facing) {
          const f = act.amount / potBefore;
          onTree = heroIsBB ? within(f, 0.33, 0.25) : within(f, 0.33, 0.25) || within(f, 0.75, 0.2);
        } else if (act.type === 'raise' && facing) {
          const betTo = flopActs[flopActs.length - 1]!.amount;
          onTree = within(act.amount / betTo, 3, 0.2);
        }
        if (!onTree) { miss('Hero’s size not on the solved tree'); continue; }
        inc('9 Hero action on tree');
        if (x.economics !== 'chipEV') { miss('PKO (chip-EV solution not admissible)'); inc('9b … of which PKO'); continue; }
        inc('10 chip EV');
        const key = flopKey(rec.parsed.board.slice(0, 3).map(String));
        if (!solved.has(key)) { miss('board not among the 85 solved flops'); inc('10b … would match with a full isomorphic-board library'); continue; }
        inc('11 board solved → gradeable');
        const v = evaluateDecision(x, [huPushFoldSource]);
        finalCat.set(v.category, (finalCat.get(v.category) ?? 0) + 1);
      }
    }
  }
  console.log(JSON.stringify({ version: 'dqe-flop-pilot-census-1', mode: BROAD ? 'broad-upper-bound' : 'existing-config', solvedFlops: solved.size, funnel: Object.fromEntries([...funnel.entries()].sort()), exclusionReasons: Object.fromEntries([...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)), gradeableBaselineCategory: Object.fromEntries(finalCat), runtimeMs: Date.now() - t0 }));
}
main().finally(() => prisma.$disconnect());
