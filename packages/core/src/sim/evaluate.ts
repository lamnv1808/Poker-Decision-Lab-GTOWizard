import { type Card, cardToInt } from '../cards/cards';
import { evaluateInts } from '../cards/evaluator';
import { classOfCombo } from '../cards/range';
import { type HandState, type PlayerAction, applyAction, computePots, legalActions } from '../engine';
import { classEquity } from '../gto/pushfold';
import { DEFAULT_THRESHOLDS, type Grade, gradeFromEvLoss } from '../scenario/grading';
import { type SimConfig, requiredEquityToCall, sizeAggressive, villainModel } from './sim';
import { COMBOS, comboClass, comboInts } from './strength';
import { ARCHETYPE_LABELS, type ActionProbs } from './villain';

/**
 * Tier 2 — model-based evaluation (Phase 1 overhaul).
 *
 * In the simulator, Villain really plays the archetype model, so after its actions the range it holds
 * is the exact Bayesian posterior of that model. Where the rest of the hand cannot involve another
 * Hero decision we do not model — the river heads-up (one Villain response, then at most one Hero
 * call/fold), or a call that ends the betting all-in — the EV of every legal action and size is
 * computed EXACTLY against that model by enumerating every Villain combo (and every runout when cards
 * are still to come). This is exploitative EV against this simulated opponent: it is not a solver
 * (GTO) answer, and it is said so. Everything else returns null (Tier 3: limited evidence).
 *
 * EV convention (BB): expected change of Hero's stack from this decision on. Fold = 0; chips already
 * in the pot are sunk.
 */
export const MODEL_EVAL_VERSION = 'model-eval-v1';
type L = { en: string; vi: string };

export type OptionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';
export interface ActionOption {
  key: string;
  kind: OptionKind;
  make: PlayerAction;
  /** Bet/raise size: % of the pot before the action (bets) and raise-to in BB. */
  sizePctPot?: number;
  toBB?: number;
  /** Chips Hero puts in with this action (BB). */
  addedBB?: number;
  evBB: number;
  /** Model reactions to this action, over Villain's current range (shares sum to 1). */
  reaction?: { fold: number; call: number; raise: number };
  /** Hero's showdown share vs the part of the range that calls (or that it faces when calling). */
  equityWhenCalled?: number;
  /** For a check out of position: share of the range that bets, and the share Hero wins vs those bets. */
  villainBets?: number;
  /** Hero's best reply after a Villain re-raise/bet (range-level, Hero does not see the cards). */
  replyToAggression?: 'call' | 'fold';
  isChosen?: boolean;
}

export interface ModelEvaluation {
  version: string;
  tier: 'model';
  scope: 'riverHeadsUp' | 'allInCall';
  opponent: { id: string; archetype: string; label: L; rangeCombos: number };
  equityMethod: 'exact' | 'exactRunouts' | 'classTable';
  options: ActionOption[];
  chosenKey: string;
  bestKey: string;
  /** Options within the tolerance of the best — all reasonable. */
  goodKeys: string[];
  evLossBB: number;
  grade: Grade;
  confidence: 'high' | 'medium';
  toleranceBB: number;
  assumptions: L[];
  /** Pot odds facts used by the reasoning checks. */
  facts: { potBB: number; toCallBB: number; requiredEquity: number | null; equityVsRange: number };
}

interface Leaf { contested: number; heroOnly: number; heroAdded: number; heroFolded: boolean; villainFolded: boolean }

function leafOf(start: HandState, leaf: HandState, heroId: string, villainId: string): Leaf {
  const h0 = start.players.find((p) => p.id === heroId)!;
  const h1 = leaf.players.find((p) => p.id === heroId)!;
  const v1 = leaf.players.find((p) => p.id === villainId)!;
  const pots = computePots(leaf);
  let contested = 0;
  let heroOnly = 0;
  for (const p of pots) {
    const h = p.eligible.includes(heroId);
    const v = p.eligible.includes(villainId);
    if (h && v) contested += p.amount;
    else if (h) heroOnly += p.amount;
  }
  return { contested, heroOnly, heroAdded: h1.totalCommitted - h0.totalCommitted, heroFolded: h1.folded, villainFolded: v1.folded };
}

/** Hero's chip result at a leaf given Hero's showdown share r (1 win, 0.5 split, 0 lose). */
function net(l: Leaf, r: number): number {
  if (l.heroFolded) return -l.heroAdded;
  if (l.villainFolded) return l.contested + l.heroOnly - l.heroAdded;
  return r * l.contested + l.heroOnly - l.heroAdded;
}

/** Showdown share of Hero vs every Villain combo in range (exact; enumerates runouts when needed). */
function shares(heroCards: readonly Card[], board: readonly Card[], live: number[]): { r: Float64Array; method: ModelEvaluation['equityMethod'] } {
  const r = new Float64Array(COMBOS.length);
  const h = heroCards.map(cardToInt);
  const b = board.map(cardToInt);
  if (board.length === 0) {
    const hc = classOfCombo(heroCards[0]!, heroCards[1]!);
    for (const i of live) r[i] = classEquity(hc, comboClass(i));
    return { r, method: 'classTable' };
  }
  const used = new Set([...h, ...b]);
  const rest = Array.from({ length: 52 }, (_, i) => i).filter((c) => !used.has(c));
  const runouts: number[][] = [];
  if (board.length === 5) runouts.push([]);
  else if (board.length === 4) for (const c of rest) runouts.push([c]);
  else for (let x = 0; x < rest.length; x++) for (let y = x + 1; y < rest.length; y++) runouts.push([rest[x]!, rest[y]!]);
  for (const i of live) {
    const [a, c] = comboInts(i);
    let s = 0;
    let n = 0;
    for (const ro of runouts) {
      if (ro.includes(a) || ro.includes(c)) continue;
      const full = [...b, ...ro];
      const hs = evaluateInts([...h, ...full]);
      const vs = evaluateInts([a, c, ...full]);
      s += hs > vs ? 1 : hs === vs ? 0.5 : 0;
      n++;
    }
    r[i] = n ? s / n : 0;
  }
  return { r, method: board.length === 5 ? 'exact' : 'exactRunouts' };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function evaluateVsModel(state: HandState, cfg: SimConfig, ranges: Record<string, Float64Array>, chosen: PlayerAction, opts: { modelVersion?: string } = {}): ModelEvaluation | null {
  const legal = legalActions(state);
  if (!legal) return null;
  const hero = state.players[state.toAct]!;
  const opps = state.players.filter((p) => !p.folded && p.id !== hero.id);
  if (opps.length !== 1 || !hero.cards) return null;
  const villain = opps[0]!;
  const w = ranges[villain.id];
  const arch = cfg.villains[villain.id];
  if (!w || !arch) return null;
  const bb = state.config.bigBlind;
  const river = state.board.length === 5;
  // scope: river heads-up (every action), or a call that ends the betting with someone all-in
  const facingAllIn = legal.toCall > 0 && (villain.stack === 0 || legal.callIsAllIn);
  if (!river && !facingAllIn) return null;
  const dead = new Set([...hero.cards, ...state.board].map(cardToInt));
  const live: number[] = [];
  let total = 0;
  for (let i = 0; i < w.length; i++) {
    if (!(w[i]! > 0)) continue;
    const [a, c] = comboInts(i);
    if (dead.has(a) || dead.has(c)) continue;
    live.push(i);
    total += w[i]!;
  }
  if (!live.length || !(total > 0)) return null;
  const { r, method } = shares(hero.cards, state.board, live);
  const avg = (f: (i: number) => number) => live.reduce((s, i) => s + w[i]! * f(i), 0) / total;
  const equityVsRange = avg((i) => r[i]!);

  /** EV of the subtree where Villain acts at s (after Hero's action). */
  const villainNode = (s: HandState): { ev: number; reaction: ActionOption['reaction']; eqCalled: number; reply?: 'call' | 'fold'; villainBets?: number } => {
    if (s.complete || s.awaitingBoard || legalActions(s) === null || s.players[s.toAct]!.id !== villain.id) {
      const lf = leafOf(state, s, hero.id, villain.id);
      return { ev: avg((i) => net(lf, r[i]!)), reaction: undefined, eqCalled: equityVsRange };
    }
    const vl = legalActions(s)!;
    const m = villainModel(s, cfg, undefined, opts.modelVersion);
    const probs = new Map<number, ActionProbs>(live.map((i) => [i, m.probsFor(i)]));
    const pf = avg((i) => probs.get(i)!.fold);
    const pp = avg((i) => probs.get(i)!.passive);
    const pa = avg((i) => probs.get(i)!.aggressive);
    const foldLeaf = vl.canFold && !vl.canCheck ? leafOf(state, applyAction(s, { type: 'fold' }), hero.id, villain.id) : null;
    const passiveState = applyAction(s, vl.canCheck ? { type: 'check' } : { type: 'call' });
    // passive closes the action on the river / when all-in; otherwise Hero would act again
    const passiveDone = passiveState.complete || passiveState.awaitingBoard || legalActions(passiveState) === null || passiveState.players[passiveState.toAct]!.id !== hero.id;
    const passiveLeaf = leafOf(state, passiveState, hero.id, villain.id);
    let ev = live.reduce((s2, i) => s2 + w[i]! * (probs.get(i)!.fold * (foldLeaf ? net(foldLeaf, r[i]!) : 0) + probs.get(i)!.passive * net(passiveLeaf, r[i]!)), 0);
    let reply: 'call' | 'fold' | undefined;
    // the scope guarantees a passive Villain action ends the betting (river heads-up, or all-in)
    if (!passiveDone) throw new Error('model evaluation reached a decision it does not model');
    if (pa > 0 && (vl.canBet || vl.canRaise)) {
      const aggr = sizeAggressive(s, vl, arch, m.shoveOnly);
      const sa = applyAction(s, aggr);
      // Hero's range-level reply: call or fold (re-raising again is not modelled)
      const hl = legalActions(sa);
      const callLeaf = hl ? leafOf(state, applyAction(sa, { type: 'call' }), hero.id, villain.id) : leafOf(state, sa, hero.id, villain.id);
      const foldLeaf2 = hl && hl.canFold ? leafOf(state, applyAction(sa, { type: 'fold' }), hero.id, villain.id) : null;
      const evCall = live.reduce((s2, i) => s2 + w[i]! * probs.get(i)!.aggressive * net(callLeaf, r[i]!), 0);
      const evFold = foldLeaf2 ? live.reduce((s2, i) => s2 + w[i]! * probs.get(i)!.aggressive * net(foldLeaf2, 0), 0) : -Infinity;
      reply = evCall >= evFold ? 'call' : 'fold';
      ev += Math.max(evCall, evFold);
    }
    const calledW = live.reduce((s2, i) => s2 + w[i]! * probs.get(i)!.passive, 0);
    const eqCalled = calledW > 0 ? live.reduce((s2, i) => s2 + w[i]! * probs.get(i)!.passive * r[i]!, 0) / calledW : NaN;
    return { ev: ev / total, reaction: { fold: r3(pf), call: r3(pp), raise: r3(pa) }, eqCalled, reply, villainBets: vl.canCheck ? r3(pa) : undefined };
  };

  const options: ActionOption[] = [];
  const add = (key: string, kind: OptionKind, make: PlayerAction, extra: Partial<ActionOption> = {}) => {
    const s = applyAction(state, make);
    const node = villainNode(s);
    options.push({ key, kind, make, evBB: r3(node.ev / bb), ...(node.reaction ? { reaction: node.reaction } : {}), ...(Number.isFinite(node.eqCalled) ? { equityWhenCalled: r3(node.eqCalled) } : {}), ...(node.reply ? { replyToAggression: node.reply } : {}), ...(node.villainBets !== undefined ? { villainBets: node.villainBets } : {}), ...extra });
  };
  if (legal.toCall > 0) {
    options.push({ key: 'fold', kind: 'fold', make: { type: 'fold' }, evBB: 0 });
    add('call', 'call', { type: 'call' }, { equityWhenCalled: r3(equityVsRange) });
  } else add('check', 'check', { type: 'check' });
  // bet/raise sizes (river only: an all-in call scope has no raise worth modelling)
  if (river && (legal.canBet || legal.canRaise)) {
    const type = legal.canBet ? 'bet' : 'raise';
    const sizes = new Map<number, string>();
    const pot = legal.pot;
    const put = (to: number, key: string) => {
      const t = Math.round(Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, to)));
      if (![...sizes.keys()].some((x) => Math.abs(x - t) < bb * 0.05)) sizes.set(t, t >= legal.maxRaiseTo ? 'allin' : key);
    };
    if (type === 'bet') for (const f of [0.33, 0.5, 0.75, 1, 1.5]) put(f * pot, `bet:${Math.round(f * 100)}`);
    else for (const m of [2.5, 3.5]) put(m * state.currentBet, `raise:${m}x`);
    put(legal.maxRaiseTo, 'allin');
    if ((chosen.type === 'bet' || chosen.type === 'raise') && chosen.amount) put(chosen.amount, `${type}:yours`);
    for (const [to, key] of [...sizes].sort((a, b) => a[0] - b[0])) {
      const added = to - hero.streetCommitted;
      add(key, to >= legal.maxRaiseTo ? 'allin' : type, { type, amount: to }, { toBB: r3(to / bb), addedBB: r3(added / bb), sizePctPot: Math.round((100 * (type === 'bet' ? added : to - state.currentBet)) / pot) });
    }
  }
  // which option is Hero's
  let chosenKey: string;
  if (chosen.type === 'fold' || chosen.type === 'check' || chosen.type === 'call') chosenKey = chosen.type;
  else {
    const near = options.filter((o) => o.toBB !== undefined).sort((a, b) => Math.abs(a.toBB! * bb - chosen.amount!) - Math.abs(b.toBB! * bb - chosen.amount!))[0];
    if (!near) return null;
    chosenKey = near.key;
  }
  const mine = options.find((o) => o.key === chosenKey);
  if (!mine) return null;
  mine.isChosen = true;
  const best = options.reduce((a, b) => (b.evBB > a.evBB ? b : a));
  const toleranceBB = Math.max(0.05, r3(0.01 * (legal.pot / bb)));
  const goodKeys = options.filter((o) => best.evBB - o.evBB <= toleranceBB).map((o) => o.key);
  const evLossBB = r3(Math.max(0, best.evBB - mine.evBB));
  const grade: Grade = goodKeys.includes(chosenKey) ? 'excellent' : gradeFromEvLoss(evLossBB, DEFAULT_THRESHOLDS.bb);
  const assumptions: L[] = [
    { en: `Opponent = this table's ${ARCHETYPE_LABELS[arch].en} model; its range is the exact Bayesian range of that model after its actions. Exploitative EV vs this opponent, not a GTO solution.`, vi: `Đối thủ = mô hình ${ARCHETYPE_LABELS[arch].vi} của bàn này; range là range Bayesian chính xác của mô hình sau các hành động. EV khai thác đối thủ này, không phải lời giải GTO.` },
    { en: 'After a Villain raise or bet, you are assumed to call or fold (whichever is better against its range); re-raising again is not modelled.', vi: 'Sau khi Villain raise hoặc cược, giả định bạn theo hoặc bỏ (cách nào tốt hơn trước range đó); không mô hình hoá việc re-raise tiếp.' },
    { en: 'Chip EV only: tournament payouts (ICM) and bounties are not modelled.', vi: 'Chỉ chip EV: không mô hình hoá ICM và bounty.' },
  ];
  if (method === 'classTable') assumptions.push({ en: 'Preflop all-in equity uses the hand-class table (suits averaged).', vi: 'Equity all-in preflop dùng bảng theo lớp bài (trung bình theo chất).' });
  return {
    version: MODEL_EVAL_VERSION,
    tier: 'model',
    scope: river ? 'riverHeadsUp' : 'allInCall',
    opponent: { id: villain.id, archetype: arch, label: ARCHETYPE_LABELS[arch], rangeCombos: live.length },
    equityMethod: method,
    options,
    chosenKey,
    bestKey: best.key,
    goodKeys,
    evLossBB,
    grade,
    confidence: method === 'classTable' ? 'medium' : 'high',
    toleranceBB,
    assumptions,
    facts: {
      potBB: r3(legal.pot / bb),
      toCallBB: r3(legal.toCall / bb),
      requiredEquity: legal.toCall > 0 ? r3(requiredEquityToCall(state)!.required) : null,
      equityVsRange: r3(equityVsRange),
    },
  };
}
