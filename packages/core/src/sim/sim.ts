import { type Card, cardToInt, fullDeck } from '../cards/cards';
import { evaluateInts } from '../cards/evaluator';
import { createRng, hashString } from '../cards/rng';
import {
  type HandState,
  type LegalActions,
  type PlayerAction,
  type TableConfig,
  applyAction,
  computePots,
  createHand,
  dealNextStreet,
  isRunout,
  legalActions,
  positionsFor,
  totalPot,
} from '../engine';
import { AUDIT_DEAD_LEVELS } from '../gto/audit';
import { classIndex, hasPushFoldSolution, solvePushFold } from '../gto/pushfold';
import { type GtoAction, gradeGtoSpot } from '../gto/quiz';
import { DEFAULT_THRESHOLDS, type Grade, gradeFromEvLoss } from '../scenario/grading';
import { COMBOS, PREFLOP_TOP_SHARE, comboClass, comboIndex, comboInts, postflopStrength } from './strength';
import { ARCHETYPES, type ActionProbs, type Archetype, ARCHETYPE_PARAMS, type PolicyCtx, policy } from './villain';

export const SIM_MODEL_VERSION = 'sim-v1';
/** Chips per big blind inside the simulator. */
export const SIM_BB = 100;

export interface SimConfig {
  tableSize: number;
  heroPos: string;
  /** Starting stack per position, in BB (whole numbers of chips). */
  stacksBB: Record<string, number>;
  anteMode: 'none' | 'bigBlind';
  /** Villain model per position (every non-Hero seat). */
  villains: Record<string, Archetype>;
}

export function validateSimConfig(cfg: SimConfig): void {
  const layout = positionsFor(cfg.tableSize);
  if (cfg.tableSize < 2 || cfg.tableSize > 9) throw new Error('Table size must be 2–9');
  if (!layout.includes(cfg.heroPos)) throw new Error('Unknown hero position');
  for (const pos of layout) {
    const s = cfg.stacksBB[pos];
    if (!(typeof s === 'number' && s >= 2 && s <= 300 && Number.isInteger(s * SIM_BB))) throw new Error(`Invalid stack for ${pos}`);
    if (pos !== cfg.heroPos && !ARCHETYPES.includes(cfg.villains[pos]!)) throw new Error(`Missing villain model for ${pos}`);
  }
}

/** A random but sensible table: size, Hero seat, stacks and Villain models are all derived from the seed. */
export function randomSimConfig(seed: number, opts: { tableSize?: number; stackBB?: number; archetype?: Archetype | 'mixed' } = {}): SimConfig {
  const rng = createRng(hashString(`cfg:${seed}`));
  const tableSize = opts.tableSize ?? [2, 3, 6, 6, 6][Math.floor(rng() * 5)]!;
  const layout = positionsFor(tableSize);
  const heroPos = layout[Math.floor(rng() * layout.length)]!;
  const base = opts.stackBB ?? [8, 12, 15, 20, 25, 30, 40, 60, 100][Math.floor(rng() * 9)]!;
  const stacksBB: Record<string, number> = {};
  const villains: Record<string, Archetype> = {};
  for (const pos of layout) {
    stacksBB[pos] = pos === heroPos || opts.stackBB ? base : Math.max(2, Math.round(base * (0.6 + rng() * 0.9)));
    if (pos !== heroPos) villains[pos] = !opts.archetype || opts.archetype === 'mixed' ? ARCHETYPES[Math.floor(rng() * ARCHETYPES.length)]! : opts.archetype;
  }
  return { tableSize, heroPos, stacksBB, anteMode: rng() < 0.5 ? 'bigBlind' : 'none', villains };
}

export interface SimDeal {
  holes: Record<string, [Card, Card]>;
  /** All five board cards, fixed at the start and kept server-side; only dealt streets are ever shown. */
  board: Card[];
}

export function dealSim(seed: number, cfg: SimConfig): SimDeal {
  const rng = createRng(seed);
  const deck = fullDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  const holes: Record<string, [Card, Card]> = {};
  let k = 0;
  for (const pos of positionsFor(cfg.tableSize)) holes[pos] = [deck[k++]!, deck[k++]!];
  return { holes, board: deck.slice(k, k + 5) };
}

function tableFor(cfg: SimConfig, deal: SimDeal): TableConfig {
  return {
    smallBlind: SIM_BB / 2,
    bigBlind: SIM_BB,
    ante: cfg.anteMode === 'bigBlind' ? SIM_BB : 0,
    anteMode: cfg.anteMode === 'bigBlind' ? 'bigBlind' : 'none',
    players: positionsFor(cfg.tableSize).map((pos) => ({ id: pos, stack: Math.round(cfg.stacksBB[pos]! * SIM_BB), cards: deal.holes[pos] })),
  };
}

/** Required equity to call: the call divided by the pots Hero could win after calling (engine-computed). */
export function requiredEquityToCall(state: HandState): { required: number; callAmount: number; winnable: number } | null {
  const legal = legalActions(state);
  if (!legal || legal.toCall <= 0) return null;
  const me = state.players[state.toAct]!.id;
  const after = applyAction(state, { type: 'call' });
  const winnable = computePots(after)
    .filter((p) => p.eligible.includes(me))
    .reduce((s, p) => s + p.amount, 0);
  return { required: legal.callAmount / winnable, callAmount: legal.callAmount, winnable };
}

export interface PushFoldSpotInfo {
  role: 'sbShove' | 'bbCall';
  actorId: string;
  stackBB: number;
  deadBB: number;
}

/**
 * Exact heads-up push/fold subgame: folded to the SB (who may only shove or fold in the model), or
 * the BB facing an SB all-in after everyone else folded. Only used when the effective stack and dead
 * money land exactly on a solved grid point — never rounded.
 */
export function pushFoldSpot(state: HandState): PushFoldSpotInfo | null {
  if (state.street !== 'preflop' || state.toAct < 0) return null;
  const sb = state.players[0]!;
  const bbP = state.players[1]!;
  const actor = state.players[state.toAct]!;
  const vol = state.history.filter((h) => h.street === 'preflop' && ['fold', 'call', 'raise', 'bet', 'check'].includes(h.type));
  const others = vol.filter((h) => h.playerId !== sb.id && h.playerId !== bbP.id);
  if (!others.every((h) => h.type === 'fold')) return null;
  const sbActs = vol.filter((h) => h.playerId === sb.id);
  const bb = state.config.bigBlind;
  let role: PushFoldSpotInfo['role'];
  if (actor.id === sb.id && sbActs.length === 0) role = 'sbShove';
  else if (actor.id === bbP.id && sbActs.length === 1 && sbActs[0]!.type === 'raise' && (sbActs[0]!.allIn || sb.stack === 0)) role = 'bbCall';
  else return null;
  if (role === 'sbShove' && sb.allIn) return null;
  // same definitions as the real-hand push/fold audit: chips each can put in (blind included), antes dead
  const exactStack = Math.min(sb.stack + sb.streetCommitted, bbP.stack + bbP.streetCommitted) / bb;
  const deadBB = state.deadAntes / bb;
  if (!(exactStack >= 2 && exactStack <= 15) || Math.abs(exactStack * 2 - Math.round(exactStack * 2)) > 1e-9) return null;
  if (!AUDIT_DEAD_LEVELS.some((d) => Math.abs(d - deadBB) < 1e-9)) return null;
  if (!hasPushFoldSolution(exactStack, deadBB)) return null;
  return { role, actorId: actor.id, stackBB: exactStack, deadBB };
}

export interface VillainEvent {
  historyIndex: number;
  playerId: string;
  archetype: Archetype;
  source: 'solver' | 'heuristic';
  chosen: keyof ActionProbs;
}

export interface HeroDecisionInfo {
  index: number;
  historyIndex: number;
  street: HandState['street'];
  potBB: number;
  toCallBB: number;
  /** null when there is nothing to call. Uses the winnable pot. */
  requiredEquity: number | null;
  spr: number | null;
  /** Hero equity vs the Villains' ranges implied by the archetype model (Monte Carlo). */
  modelEquity: { equity: number; stdErr: number; samples: number; opponents: { id: string; archetype: Archetype; rangePct: number }[] };
  /** Legal actions at this decision (sent to the client only after the hand is over). */
  legal: LegalActions;
  solver: null | { role: PushFoldSpotInfo['role']; stackBB: number; deadBB: number; heroClass: string; frequency: number; evAggressiveBB: number };
}

export interface HeroFeedback {
  graded: boolean;
  grade?: Grade;
  evLossBB?: number;
  basis: 'solverEv' | 'modelEv' | 'none';
  /** strategy = solver-verified (may move Elo in rated mode); fundamentals = model-based maths. */
  track: 'strategy' | 'fundamentals' | null;
  best?: string;
  evByAction?: Record<string, number>;
  note: { en: string; vi: string };
}

export interface SimDecision {
  info: HeroDecisionInfo;
  action?: PlayerAction;
  feedback?: HeroFeedback;
}

export interface SimRun {
  seed: number;
  config: SimConfig;
  deal: SimDeal;
  state: HandState;
  decisions: SimDecision[];
  villainEvents: VillainEvent[];
  /** Weight per combo, per Villain (model-implied range). */
  ranges: Record<string, Float64Array>;
  awaitingHero: boolean;
}

function ctxFor(state: HandState, legal: LegalActions): PolicyCtx {
  const actor = state.players[state.toAct]!;
  const raises = state.history.filter((h) => h.street === state.street && (h.type === 'raise' || h.type === 'bet')).length;
  return {
    street: state.street,
    toCall: legal.toCall,
    raises,
    requiredEq: requiredEquityToCall(state)?.required ?? 0,
    nOpp: state.players.filter((p) => !p.folded && p.id !== actor.id).length,
    canCheck: legal.canCheck,
    canRaise: legal.canRaise || legal.canBet,
  };
}

function strengthOf(state: HandState): (i: number) => number {
  if (state.street === 'preflop') return (i) => PREFLOP_TOP_SHARE[i]!;
  const t = postflopStrength(state.board);
  return (i) => t[i]!;
}

function sizeAggressive(state: HandState, legal: LegalActions, arch: Archetype, shoveOnly: boolean): PlayerAction {
  const type = legal.canBet ? 'bet' : 'raise';
  if (!legal.canBet && !legal.canRaise) return { type: 'call' };
  const actor = state.players[state.toAct]!;
  const total = actor.stack + actor.streetCommitted;
  const bb = state.config.bigBlind;
  let to: number;
  if (shoveOnly) to = legal.maxRaiseTo;
  else if (state.street === 'preflop') {
    const raises = state.history.filter((h) => h.street === 'preflop' && h.type === 'raise').length;
    const callers = state.history.filter((h) => h.street === 'preflop' && h.type === 'call').length;
    to = raises === 0 ? (arch === 'station' ? 3 : 2.5) * bb + callers * bb : raises === 1 ? 3 * state.currentBet + callers * state.currentBet : 2.3 * state.currentBet;
    const eff = Math.min(total, Math.max(...state.players.filter((p) => !p.folded && p.id !== actor.id).map((p) => p.stack + p.streetCommitted)));
    if (to >= 0.45 * total || eff <= 12 * bb) to = legal.maxRaiseTo;
  } else {
    to = state.currentBet === 0 ? ARCHETYPE_PARAMS[arch].betFrac * legal.pot : 3 * state.currentBet;
    if (to >= 0.6 * total) to = legal.maxRaiseTo;
  }
  to = Math.round(Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, to)));
  return { type, amount: to };
}

function villainAct(seed: number, state: HandState, cfg: SimConfig, ranges: Record<string, Float64Array>): { action: PlayerAction; event: VillainEvent } {
  const legal = legalActions(state)!;
  const actor = state.players[state.toAct]!;
  const arch = cfg.villains[actor.id]!;
  const spot = pushFoldSpot(state);
  let probsFor: (i: number) => ActionProbs;
  let source: VillainEvent['source'] = 'heuristic';
  if (spot && spot.actorId === actor.id) {
    source = 'solver';
    const sol = solvePushFold({ stackBB: spot.stackBB, deadBB: spot.deadBB });
    const freq = spot.role === 'sbShove' ? sol.push : sol.call;
    probsFor = (i) => {
      const f = freq[classIndex(comboClass(i))]!;
      return spot.role === 'sbShove' ? { fold: 1 - f, passive: 0, aggressive: f } : { fold: 1 - f, passive: f, aggressive: 0 };
    };
  } else {
    const ctx = ctxFor(state, legal);
    const x = strengthOf(state);
    probsFor = (i) => policy(arch, ctx, x(i));
  }
  const own = comboIndex(actor.cards![0]!, actor.cards![1]!);
  const pr = probsFor(own);
  const r = createRng(hashString(`${seed}:${state.history.length}:${actor.id}`))();
  const chosen: keyof ActionProbs = r < pr.fold ? 'fold' : r < pr.fold + pr.passive ? 'passive' : 'aggressive';
  const w = ranges[actor.id]!;
  for (let i = 0; i < w.length; i++) {
    if (w[i] === 0) continue;
    const p = probsFor(i)[chosen];
    w[i] = Number.isFinite(p) ? w[i]! * p : 0;
  }
  let action: PlayerAction;
  if (chosen === 'fold') action = legal.canFold ? { type: 'fold' } : { type: 'check' };
  else if (chosen === 'passive') action = legal.canCheck ? { type: 'check' } : { type: 'call' };
  else action = sizeAggressive(state, legal, arch, source === 'solver');
  return { action, event: { historyIndex: state.history.length, playerId: actor.id, archetype: arch, source, chosen } };
}

/** Monte Carlo equity of Hero against one weighted range per opponent (multiway supported). */
export function modelEquity(hero: readonly Card[], board: readonly Card[], ranges: Float64Array[], samples: number, seed: number): { equity: number; stdErr: number; samples: number } {
  const rng = createRng(seed);
  const dead = new Set([...hero, ...board].map(cardToInt));
  const cums = ranges.map((w) => {
    const c = new Float64Array(w.length);
    let s = 0;
    for (let i = 0; i < w.length; i++) {
      const [a, b] = comboInts(i);
      if (!dead.has(a) && !dead.has(b)) s += w[i]!;
      c[i] = s;
    }
    return c;
  });
  if (cums.some((c) => c[c.length - 1]! <= 0)) return { equity: NaN, stdErr: 0, samples: 0 };
  const pickCombo = (c: Float64Array) => {
    const t = rng() * c[c.length - 1]!;
    let lo = 0;
    let hi = c.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (c[m]! <= t) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const deck = Array.from({ length: 52 }, (_, i) => i);
  const h = hero.map(cardToInt);
  const b = board.map(cardToInt);
  let total = 0;
  let totalSq = 0;
  let n = 0;
  for (let s = 0; s < samples; s++) {
    const used = new Set(dead);
    const opp: (readonly [number, number])[] = [];
    let ok = true;
    for (const c of cums) {
      let tries = 0;
      let got: readonly [number, number] | null = null;
      while (tries++ < 40) {
        const ci = comboInts(pickCombo(c));
        if (!used.has(ci[0]) && !used.has(ci[1])) {
          got = ci;
          break;
        }
      }
      if (!got) {
        ok = false;
        break;
      }
      used.add(got[0]);
      used.add(got[1]);
      opp.push(got);
    }
    if (!ok) continue;
    const runout = [...b];
    while (runout.length < 5) {
      const c = deck[Math.floor(rng() * 52)]!;
      if (!used.has(c)) {
        used.add(c);
        runout.push(c);
      }
    }
    const hs = evaluateInts([...h, ...runout]);
    const os = opp.map((o) => evaluateInts([o[0], o[1], ...runout]));
    const best = Math.max(hs, ...os);
    const share = hs < best ? 0 : 1 / (1 + os.filter((x) => x === best).length);
    total += share;
    totalSq += share * share;
    n++;
  }
  const mean = n ? total / n : NaN;
  const variance = n > 1 ? Math.max(0, totalSq / n - mean * mean) : 0;
  return { equity: mean, stdErr: n ? Math.sqrt(variance / n) : 0, samples: n };
}

function heroInfo(run: { seed: number; config: SimConfig; ranges: Record<string, Float64Array> }, state: HandState, index: number, samples: number): HeroDecisionInfo {
  const bb = state.config.bigBlind;
  const legal = legalActions(state)!;
  const hero = state.players[state.toAct]!;
  const req = requiredEquityToCall(state);
  const opps = state.players.filter((p) => !p.folded && p.id !== hero.id);
  const eq = modelEquity(hero.cards!, state.board, opps.map((p) => run.ranges[p.id]!), samples, hashString(`${run.seed}:eq:${index}`));
  const live = (w: Float64Array) => {
    let s = 0;
    for (let i = 0; i < w.length; i++) s += w[i]!;
    return s / COMBOS.length;
  };
  const spot = pushFoldSpot(state);
  let solver: HeroDecisionInfo['solver'] = null;
  if (spot && spot.actorId === hero.id) {
    const sol = solvePushFold({ stackBB: spot.stackBB, deadBB: spot.deadBB });
    const cls = comboClass(comboIndex(hero.cards![0]!, hero.cards![1]!));
    const ci = classIndex(cls);
    solver = { role: spot.role, stackBB: spot.stackBB, deadBB: spot.deadBB, heroClass: cls, frequency: (spot.role === 'sbShove' ? sol.push : sol.call)[ci]!, evAggressiveBB: Math.round((spot.role === 'sbShove' ? sol.evShove : sol.evCall)[ci]! * 1000) / 1000 };
  }
  const eff = Math.min(hero.stack, Math.max(0, ...opps.map((p) => p.stack)));
  return {
    index,
    historyIndex: state.history.length,
    street: state.street,
    potBB: totalPot(state) / bb,
    toCallBB: legal.callAmount / bb,
    requiredEquity: req ? Math.round(req.required * 10000) / 10000 : null,
    spr: state.street === 'preflop' ? null : Math.round((eff / Math.max(1, totalPot(state))) * 100) / 100,
    legal,
    modelEquity: { equity: Math.round(eq.equity * 10000) / 10000, stdErr: Math.round(eq.stdErr * 10000) / 10000, samples: eq.samples, opponents: opps.map((p) => ({ id: p.id, archetype: run.config.villains[p.id]!, rangePct: Math.round(live(run.ranges[p.id]!) * 1000) / 10 })) },
    solver,
  };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

function gradeHero(info: HeroDecisionInfo, state: HandState, action: PlayerAction): HeroFeedback {
  const legal = legalActions(state)!;
  const bb = state.config.bigBlind;
  if (info.solver) {
    const s = info.solver;
    let act: GtoAction | 'other' = 'other';
    if (action.type === 'fold') act = 'fold';
    else if (s.role === 'sbShove' && (action.type === 'raise' || action.type === 'bet') && action.amount === legal.maxRaiseTo) act = 'shove';
    else if (s.role === 'bbCall' && action.type === 'call') act = 'call';
    if (act === 'other')
      return {
        graded: false,
        basis: 'none',
        track: null,
        note: { en: 'Outside the push/fold model (only all-in or fold is modelled here), so this action is not graded.', vi: 'Nằm ngoài mô hình push/fold (chỉ all-in hoặc bỏ bài), nên hành động này không được chấm.' },
      };
    const g = gradeGtoSpot({ seed: 0, role: s.role, stackBB: s.stackBB, anteFormat: 'none', deadBB: s.deadBB, heroCards: state.players[state.toAct]!.cards! as [Card, Card], heroClass: s.heroClass }, act, solvePushFold({ stackBB: s.stackBB, deadBB: s.deadBB }));
    const aggr = s.role === 'sbShove' ? 'shove' : 'call';
    return {
      graded: true,
      grade: g.grade,
      evLossBB: Math.round(g.evLossBB * 1000) / 1000,
      basis: 'solverEv',
      track: 'strategy',
      best: g.bestAction,
      evByAction: { [aggr]: s.evAggressiveBB, fold: 0 },
      note: {
        en: `Heads-up push/fold equilibrium (${s.stackBB} BB, ${s.deadBB} BB dead): ${aggr} ${s.heroClass} ${Math.round(s.frequency * 100)}% of the time; EV of ${aggr} ${s.evAggressiveBB.toFixed(2)} BB vs fold 0.`,
        vi: `Cân bằng push/fold đối đầu (${s.stackBB} BB, ${s.deadBB} BB chết): ${aggr === 'shove' ? 'all-in' : 'theo'} ${s.heroClass} ${Math.round(s.frequency * 100)}% số lần; EV ${s.evAggressiveBB.toFixed(2)} BB so với bỏ bài 0.`,
      },
    };
  }
  const eq = info.modelEquity.equity;
  if (legal.toCall > 0 && (action.type === 'fold' || action.type === 'call') && Number.isFinite(eq)) {
    const after = applyAction(state, { type: 'call' });
    const live = after.players.filter((p) => !p.folded);
    const closes = after.complete || (after.awaitingBoard && isRunout(after));
    const req = requiredEquityToCall(state)!;
    if (live.length === 2 && closes) {
      const evCall = (eq * req.winnable - req.callAmount) / bb;
      const noise = (2 * info.modelEquity.stdErr * req.winnable) / bb;
      const chosen = action.type === 'call' ? evCall : 0;
      const loss = Math.abs(evCall) <= noise ? 0 : Math.max(0, evCall) - chosen;
      return {
        graded: true,
        grade: gradeFromEvLoss(Math.max(0, loss), DEFAULT_THRESHOLDS.bb),
        evLossBB: Math.round(Math.max(0, loss) * 1000) / 1000,
        basis: 'modelEv',
        track: 'fundamentals',
        best: Math.abs(evCall) <= noise ? 'either' : evCall > 0 ? 'call' : 'fold',
        evByAction: { call: Math.round(evCall * 1000) / 1000, fold: 0 },
        note: {
          en: `The call ends the betting, so EV is exact under the Villain model: equity ${pct(eq)} (±${pct(2 * info.modelEquity.stdErr)}) vs required ${pct(req.required)} → call EV ${evCall.toFixed(2)} BB. Assumed-range model, not a solver.`,
          vi: `Lệnh theo kết thúc việc cược, nên EV chính xác theo mô hình đối thủ: equity ${pct(eq)} (±${pct(2 * info.modelEquity.stdErr)}) so với cần ${pct(req.required)} → EV theo ${evCall.toFixed(2)} BB. Mô hình range giả định, không phải solver.`,
        },
      };
    }
    return {
      graded: false,
      basis: 'none',
      track: null,
      note: {
        en: `More betting can follow, so no EV is claimed. Price check only: equity vs the model's range ${pct(eq)}, required ${pct(req.required)}.`,
        vi: `Còn có thể cược tiếp, nên không đưa ra EV. Chỉ so giá: equity so với range mô hình ${pct(eq)}, cần ${pct(req.required)}.`,
      },
    };
  }
  return {
    graded: false,
    basis: 'none',
    track: null,
    note: Number.isFinite(eq)
      ? { en: `Not graded (no validated EV for this action). Equity vs the model's range: ${pct(eq)}.`, vi: `Không chấm (không có EV đã kiểm chứng cho hành động này). Equity so với range mô hình: ${pct(eq)}.` }
      : { en: 'Not graded.', vi: 'Không chấm.' },
  };
}

/**
 * Deterministically (re)build a hand from its seed, config and Hero's actions. Villains act by the
 * model; streets are dealt from the fixed board. Stops when Hero must act or the hand is over.
 * Throws IllegalActionError if a Hero action is not legal.
 */
export function runSim(seed: number, config: SimConfig, heroActions: readonly PlayerAction[], opts: { equitySamples?: number } = {}): SimRun {
  validateSimConfig(config);
  const deal = dealSim(seed, config);
  let state = createHand(tableFor(config, deal));
  const ranges: Record<string, Float64Array> = {};
  for (const id of Object.keys(config.villains)) ranges[id] = new Float64Array(COMBOS.length).fill(1);
  const run: SimRun = { seed, config, deal, state, decisions: [], villainEvents: [], ranges, awaitingHero: false };
  const samples = opts.equitySamples ?? 2500;
  let k = 0;
  for (let guard = 0; guard < 400; guard++) {
    if (state.complete) break;
    if (state.awaitingBoard) {
      const n = state.board.length;
      state = dealNextStreet(state, n === 0 ? deal.board.slice(0, 3) : [deal.board[n]!]);
      continue;
    }
    const actor = state.players[state.toAct]!;
    if (actor.id === config.heroPos) {
      const info = heroInfo(run, state, run.decisions.length, samples);
      if (k >= heroActions.length) {
        run.decisions.push({ info });
        run.awaitingHero = true;
        break;
      }
      const action = heroActions[k++]!;
      const next = applyAction(state, action);
      run.decisions.push({ info, action, feedback: gradeHero(info, state, action) });
      state = next;
      continue;
    }
    const { action, event } = villainAct(seed, state, config, ranges);
    run.villainEvents.push(event);
    state = applyAction(state, action);
  }
  run.state = state;
  return run;
}

export interface TimelineEntry {
  street: HandState['street'];
  playerId: string;
  type: string;
  toBB: number;
  addedBB: number;
  allIn: boolean;
  /** Villain action source / model, or Hero decision index. */
  villain?: { archetype: Archetype; source: 'solver' | 'heuristic' };
  heroDecision?: number;
}

/** Hand review after completion: every action, Hero feedback references, showdown cards only, net results. */
export function simReview(run: SimRun) {
  const bb = run.state.config.bigBlind;
  const events = new Map(run.villainEvents.map((e) => [e.historyIndex, e]));
  const heroIdx = new Map(run.decisions.map((d, i) => [d.info.historyIndex, i]));
  const timeline: TimelineEntry[] = run.state.history.map((h, i) => ({
    street: h.street,
    playerId: h.playerId,
    type: h.type,
    toBB: h.amount / bb,
    addedBB: h.added / bb,
    allIn: h.allIn,
    villain: events.has(i) ? { archetype: events.get(i)!.archetype, source: events.get(i)!.source } : undefined,
    heroDecision: heroIdx.get(i),
  }));
  const showdown = run.state.result?.showdown ? run.state.players.filter((p) => !p.folded).map((p) => ({ id: p.id, cards: p.cards! })) : [];
  const net = Object.fromEntries(run.state.players.map((p) => [p.id, Math.round(((run.state.result?.awards[p.id] ?? 0) - p.totalCommitted - p.anteCommitted) / bb * 100) / 100]));
  return { timeline, showdown, net, board: run.state.board, decisions: run.decisions };
}
