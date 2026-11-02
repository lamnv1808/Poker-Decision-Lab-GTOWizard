import { type Card, cardToInt, fullDeck } from '../cards/cards';
import { categoryOf as handCategory, evaluate, evaluateInts } from '../cards/evaluator';
import { classOfCombo } from '../cards/range';
import { topicsFor } from '../realhands/topics';
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
import { type ModelEvaluation, evaluateVsModel } from './evaluate';
import { type ReasoningAssessment, explainModel } from './coach';
import { ARCHETYPES, type ActionProbs, type Archetype, ARCHETYPE_PARAMS, type PolicyCtx, policy } from './villain';

/** Villain model version; stored with each hand so it always rebuilds with the model it was dealt with. */
export const SIM_MODEL_VERSION = 'sim-v1.1';
/** Chips per big blind inside the simulator. */
export const SIM_BB = 100;

export interface SimConfig {
  tableSize: number;
  heroPos: string;
  /** Starting stack per position, in BB (whole numbers of chips). */
  stacksBB: Record<string, number>;
  anteMode: 'none' | 'bigBlind' | 'each';
  /** Ante size in BB (defaults: 1 for a big-blind ante, 0.125 for antes from everyone). */
  anteBB?: number;
  /** Villain model per position (every non-Hero seat). */
  villains: Record<string, Archetype>;
  /** Exact chip units (used when continuing a curated scenario); default SB 50 / BB 100. */
  chips?: { smallBlind: number; bigBlind: number; ante: number };
}

export function validateSimConfig(cfg: SimConfig): void {
  const layout = positionsFor(cfg.tableSize);
  if (cfg.tableSize < 2 || cfg.tableSize > 9) throw new Error('Table size must be 2–9');
  if (!layout.includes(cfg.heroPos)) throw new Error('Unknown hero position');
  for (const pos of layout) {
    const s = cfg.stacksBB[pos];
    const bb = cfg.chips?.bigBlind ?? SIM_BB;
    if (!(typeof s === 'number' && s > 0 && s <= 1000 && Math.abs(s * bb - Math.round(s * bb)) < 1e-6)) throw new Error(`Invalid stack for ${pos}`);
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

/**
 * Deal from an external random source (pass a CSPRNG such as crypto.randomInt). Unlike dealSim,
 * the result cannot be reconstructed from anything the client sees.
 */
export function dealSimSecure(cfg: SimConfig, randomInt: (maxExclusive: number) => number): SimDeal {
  const deck = fullDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  const holes: Record<string, [Card, Card]> = {};
  let k = 0;
  for (const pos of positionsFor(cfg.tableSize)) holes[pos] = [deck[k++]!, deck[k++]!];
  return { holes, board: deck.slice(k, k + 5) };
}

function tableFor(cfg: SimConfig, deal: SimDeal): TableConfig {
  return {
    smallBlind: cfg.chips?.smallBlind ?? SIM_BB / 2,
    bigBlind: cfg.chips?.bigBlind ?? SIM_BB,
    ante: cfg.chips ? cfg.chips.ante : cfg.anteMode === 'none' ? 0 : Math.round((cfg.anteBB ?? (cfg.anteMode === 'bigBlind' ? 1 : 0.125)) * SIM_BB),
    anteMode: cfg.anteMode,
    players: positionsFor(cfg.tableSize).map((pos) => ({ id: pos, stack: Math.round(cfg.stacksBB[pos]! * (cfg.chips?.bigBlind ?? SIM_BB)), cards: deal.holes[pos] })),
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
  /** solver = validated frequencies; heuristic = archetype model; scripted = fixed by a curated scenario */
  source: 'solver' | 'heuristic' | 'scripted';
  chosen: keyof ActionProbs;
  /** Set when the Branch Challenge forced this Villain choice. */
  forced?: boolean;
  /** For the post-hand explanation only: the model's probabilities for Villain's actual hand. */
  probs?: ActionProbs;
  /** Villain's hand strength as the model saw it: preflop top-share, postflop strength percentile. */
  strength?: { kind: 'preflopTop' | 'postflop'; value: number };
}

/**
 * Validated strategy for a spot (e.g. the 85-flop postflop library), supplied by the server only
 * when the hand matches the solver's exact assumptions.
 */
export interface OracleNode {
  source: string;
  actions: { key: string; make: PlayerAction }[];
  /** Frequencies and EVs (BB) for a hand, or null if the hand is outside the solved range. */
  strategy(cards: readonly [Card, Card]): { f: number[]; ev: number[] } | null;
  /** Index of the solver action matching Hero's action, or -1 if outside the solved tree. */
  matchHero(action: PlayerAction): number;
  /** EV differences within this (BB) are within solver precision. */
  noiseBB: number;
  label: { en: string; vi: string };
}
export type SpotOracle = (state: HandState, actorId: string) => OracleNode | null;

export interface RunOptions {
  equitySamples?: number;
  /** Production passes a CSPRNG deal; the seeded deal is for tests and tooling. */
  deal?: SimDeal;
  /** Scripted actions (from a curated scenario) applied before any model or Hero decision. */
  prefix?: { playerId: string; action: PlayerAction }[];
  /** Branch Challenge: force a Villain choice at a given history index. */
  villainOverrides?: Record<number, keyof ActionProbs>;
  oracle?: SpotOracle;
  /** Villain model version the hand was created with (default: current). */
  modelVersion?: string;
  /** Model equity already computed for past Hero decisions (by decision index) — skips Monte Carlo. */
  equityCache?: Record<number, CachedEquity>;
  /** Skip Monte Carlo for the decision Hero has not made yet (its equity is never shown before acting). */
  skipPendingEquity?: boolean;
  /** Feedback already computed for past Hero decisions (by decision index) — skips re-grading. */
  feedbackCache?: Record<number, HeroFeedback>;
}
export interface CachedEquity { equity: number; stdErr: number; samples: number }

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
  /** Present when a validated solver spot covers this decision. */
  /** Solved tree at this decision: action keys and the exact engine actions (structure only — no frequencies). */
  oracle?: { source: string; label: { en: string; vi: string }; actions: string[]; options: PlayerAction[] };
  /** Curriculum concepts present at the decision (from public information only). */
  topics: string[];
  solver: null | { role: PushFoldSpotInfo['role']; stackBB: number; deadBB: number; heroClass: string; frequency: number; evAggressiveBB: number };
}

export type Assessment = 'solverVerified' | 'mathVerified' | 'reviewedStrategy' | 'assumedRange' | 'heuristicCoaching' | 'notEvaluated';

export interface HeroFeedback {
  /** What kind of reference stands behind this feedback (shown on every decision). */
  assessment?: Assessment;
  /**
   * Evidence tier: solver = an exact solved spot matches; model = exact EV against this table's
   * opponent model (exploitative, not GTO); limited = no defensible comparison, facts only.
   */
  tier?: 'solver' | 'model' | 'limited';
  /** Tier 2: every legal action / size with its EV against the model. */
  model?: ModelEvaluation;
  /** The headline coaching: recommended action, one-line why, sizing comparison (when known). */
  explain?: { recommended: { en: string; vi: string }; why: { en: string; vi: string }; sizing: { en: string; vi: string } | null };
  /** Tier 3: what is missing for a defensible comparison. */
  limitation?: { en: string; vi: string };
  /** Structured reasoning checks (added by the server when the player ticked reasons). */
  reasoning?: ReasoningAssessment;
  /** Heuristic coaching for decisions without a validated answer — guidance, never a grade. */
  coaching?: { en: string; vi: string };
  graded: boolean;
  grade?: Grade;
  evLossBB?: number;
  basis: 'solverEv' | 'modelEv' | 'none';
  /**
   * strategy = solver-verified (may move the Strategy rating in rated mode); fundamentals = model-based
   * maths of a terminal call (Fundamentals rating); model = Tier 2 model EV (recorded, never rated).
   */
  track: 'strategy' | 'fundamentals' | 'model' | null;
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

export function sizeAggressive(state: HandState, legal: LegalActions, arch: Archetype, shoveOnly: boolean): PlayerAction {
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

const categoryOf = (a: PlayerAction): keyof ActionProbs => (a.type === 'fold' ? 'fold' : a.type === 'check' || a.type === 'call' ? 'passive' : 'aggressive');

/** The model's action probabilities for every combo at Villain's decision (solver, oracle or heuristic). */
export function villainModel(state: HandState, cfg: SimConfig, oracle?: SpotOracle, modelVersion?: string): { probsFor: (i: number) => ActionProbs; source: VillainEvent['source']; node: OracleNode | null; shoveOnly: boolean } {
  const legal = legalActions(state)!;
  const actor = state.players[state.toAct]!;
  const arch = cfg.villains[actor.id]!;
  const node = oracle?.(state, actor.id) ?? null;
  if (node) {
    const cat = node.actions.map((x) => categoryOf(x.make));
    return {
      source: 'solver',
      node,
      shoveOnly: false,
      probsFor: (i) => {
        const st = node.strategy(COMBOS[i]!);
        const out = { fold: 0, passive: 0, aggressive: 0 };
        if (st) st.f.forEach((f, k) => (out[cat[k]!] += f));
        return out;
      },
    };
  }
  const spot = pushFoldSpot(state);
  if (spot && spot.actorId === actor.id) {
    const sol = solvePushFold({ stackBB: spot.stackBB, deadBB: spot.deadBB });
    const freq = spot.role === 'sbShove' ? sol.push : sol.call;
    return {
      source: 'solver',
      node: null,
      shoveOnly: true,
      probsFor: (i) => {
        const f = freq[classIndex(comboClass(i))]!;
        return spot.role === 'sbShove' ? { fold: 1 - f, passive: 0, aggressive: f } : { fold: 1 - f, passive: f, aggressive: 0 };
      },
    };
  }
  const ctx = ctxFor(state, legal);
  const x = strengthOf(state);
  return { source: 'heuristic', node: null, shoveOnly: false, probsFor: (i) => policy(arch, ctx, x(i), modelVersion) };
}

function updateRange(w: Float64Array, probsFor: (i: number) => ActionProbs, chosen: keyof ActionProbs) {
  for (let i = 0; i < w.length; i++) {
    if (w[i] === 0) continue;
    const p = probsFor(i)[chosen];
    w[i] = Number.isFinite(p) ? w[i]! * p : 0;
  }
}

function villainAct(seed: number, state: HandState, cfg: SimConfig, ranges: Record<string, Float64Array>, opts: RunOptions): { action: PlayerAction; event: VillainEvent } {
  const legal = legalActions(state)!;
  const actor = state.players[state.toAct]!;
  const arch = cfg.villains[actor.id]!;
  const m = villainModel(state, cfg, opts.oracle, opts.modelVersion);
  const own = comboIndex(actor.cards![0]!, actor.cards![1]!);
  const pr = m.probsFor(own);
  const r = createRng(hashString(`${seed}:${state.history.length}:${actor.id}`))();
  const forcedCat = opts.villainOverrides?.[state.history.length];
  let chosen: keyof ActionProbs = forcedCat ?? (r < pr.fold ? 'fold' : r < pr.fold + pr.passive ? 'passive' : 'aggressive');
  // a forced fold where checking is free is a check; a forced raise when raising is impossible is a call
  if (chosen === 'fold' && legal.canCheck) chosen = 'passive';
  if (chosen === 'aggressive' && !legal.canBet && !legal.canRaise) chosen = 'passive';
  updateRange(ranges[actor.id]!, m.probsFor, chosen);
  let action: PlayerAction;
  if (m.node && !forcedCat) {
    // sample the solver action itself (sizes come from the solved tree)
    const st = m.node.strategy([actor.cards![0]!, actor.cards![1]!])!;
    let t = createRng(hashString(`${seed}:o:${state.history.length}`))() * st.f.reduce((a, b) => a + b, 0);
    let k = 0;
    for (; k < st.f.length - 1; k++) if ((t -= st.f[k]!) < 0) break;
    action = m.node.actions[k]!.make;
    chosen = categoryOf(action);
  } else if (chosen === 'fold') action = { type: 'fold' };
  else if (chosen === 'passive') action = legal.canCheck ? { type: 'check' } : { type: 'call' };
  else action = sizeAggressive(state, legal, arch, m.shoveOnly);
  const sx = strengthOf(state)(own);
  return {
    action,
    event: {
      historyIndex: state.history.length,
      playerId: actor.id,
      archetype: arch,
      source: m.source,
      chosen,
      ...(forcedCat ? { forced: true } : {}),
      probs: { fold: Math.round(pr.fold * 1000) / 1000, passive: Math.round(pr.passive * 1000) / 1000, aggressive: Math.round(pr.aggressive * 1000) / 1000 },
      strength: { kind: state.street === 'preflop' ? 'preflopTop' : 'postflop', value: Math.round(sx * 1000) / 1000 },
    },
  };
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

function heroInfo(run: { seed: number; config: SimConfig; ranges: Record<string, Float64Array> }, state: HandState, index: number, samples: number, cached?: CachedEquity): HeroDecisionInfo {
  const bb = state.config.bigBlind;
  const legal = legalActions(state)!;
  const hero = state.players[state.toAct]!;
  const req = requiredEquityToCall(state);
  const opps = state.players.filter((p) => !p.folded && p.id !== hero.id);
  // deterministic, so a value computed when the decision was made can be reused on every rebuild
  const eq = cached ?? modelEquity(hero.cards!, state.board, opps.map((p) => run.ranges[p.id]!), samples, hashString(`${run.seed}:eq:${index}`));
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
    topics: topicsFor(state, hero.id, hero.cards!, 'MTT'),
    modelEquity: { equity: Math.round(eq.equity * 10000) / 10000, stdErr: Math.round(eq.stdErr * 10000) / 10000, samples: eq.samples, opponents: opps.map((p) => ({ id: p.id, archetype: run.config.villains[p.id]!, rangePct: Math.round(live(run.ranges[p.id]!) * 1000) / 10 })) },
    solver,
  };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

function gradeHeroBase(info: HeroDecisionInfo, state: HandState, action: PlayerAction): HeroFeedback {
  const legal = legalActions(state)!;
  const bb = state.config.bigBlind;
  if (info.solver) {
    const s = info.solver;
    let act: GtoAction | 'other' = 'other';
    if (action.type === 'fold') act = 'fold';
    else if (s.role === 'sbShove' && (action.type === 'raise' || action.type === 'bet')) {
      // any raise that puts the BB all-in is a shove in the push/fold model (effective stack)
      const bbP = state.players[1]!;
      if ((action.amount ?? 0) >= Math.min(legal.maxRaiseTo, bbP.stack + bbP.streetCommitted)) act = 'shove';
    }
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
    // Exact under the model when the call ends the betting and there is a single pot (no side pots):
    // EV = equity × pot − call, heads-up or multiway (equity is computed against every live range).
    if (live.length >= 2 && closes && computePots(after).length === 1) {
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
          en: `The call ends the betting, so the EV follows from the Villain model (Monte Carlo): equity ${pct(eq)} (±${pct(2 * info.modelEquity.stdErr)}) vs required ${pct(req.required)} → call EV ${evCall.toFixed(2)} BB. Assumed-range model, not a solver.`,
          vi: `Lệnh theo kết thúc việc cược, nên EV tính trực tiếp từ mô hình đối thủ (Monte Carlo): equity ${pct(eq)} (±${pct(2 * info.modelEquity.stdErr)}) so với cần ${pct(req.required)} → EV theo ${evCall.toFixed(2)} BB. Mô hình range giả định, không phải solver.`,
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

function oracleGrade(node: OracleNode, info: HeroDecisionInfo, state: HandState, action: PlayerAction): HeroFeedback {
  const hero = state.players[state.toAct]!;
  const idx = node.matchHero(action);
  const st = node.strategy([hero.cards![0]!, hero.cards![1]!]);
  if (idx < 0 || !st)
    return {
      assessment: 'notEvaluated',
      graded: false,
      basis: 'none',
      track: null,
      note:
        idx < 0
          ? { en: `Outside the solved tree (${node.actions.map((x) => x.key).join(', ')}), so this action is not graded.`, vi: `Nằm ngoài cây đã giải (${node.actions.map((x) => x.key).join(', ')}), nên hành động này không được chấm.` }
          : { en: 'Your hand is outside the range the solver assumed for this spot, so it is not graded.', vi: 'Tay bài nằm ngoài range mà solver giả định cho spot này, nên không được chấm.' },
    };
  const best = Math.max(...st.ev);
  const loss = Math.max(0, best - st.ev[idx]!);
  const inMix = st.f[idx]! >= 0.1;
  const grade: Grade = loss <= node.noiseBB || (inMix && loss <= 3 * node.noiseBB) ? 'excellent' : gradeFromEvLoss(loss, DEFAULT_THRESHOLDS.bb);
  const bestKey = node.actions[st.ev.indexOf(best)]!.key;
  const freqs = node.actions.map((x, k) => `${x.key} ${Math.round(st.f[k]! * 100)}%`).join(', ');
  void info;
  return {
    assessment: 'solverVerified',
    graded: true,
    grade,
    evLossBB: Math.round(loss * 1000) / 1000,
    basis: 'solverEv',
    track: 'strategy',
    best: bestKey,
    evByAction: Object.fromEntries(node.actions.map((x, k) => [x.key, Math.round(st.ev[k]! * 1000) / 1000])),
    note: { en: `${node.label.en}. Solver strategy for your hand: ${freqs}.`, vi: `${node.label.vi}. Chiến lược solver cho tay bài của bạn: ${freqs}.` },
  };
}

/**
 * Tier 3 facts for decisions without a defensible comparison: what is exactly true at the decision
 * (equity vs the model's current ranges, the price) and what that number leaves out. No recommendation.
 */
function coachingFor(info: HeroDecisionInfo, action: PlayerAction): { en: string; vi: string } | undefined {
  const eq = info.modelEquity.equity;
  if (!Number.isFinite(eq)) return undefined;
  const p = (x: number) => `${Math.round(x * 100)}%`;
  void action;
  const left = { en: 'Raw equity ignores the betting still to come (who realises their equity, position, later bets), so it does not rank the actions by itself.', vi: 'Equity thô bỏ qua phần cược còn lại (ai hiện thực hoá được equity, vị trí, các cược sau), nên tự nó không xếp hạng được các hành động.' };
  if (info.requiredEquity !== null)
    return { en: `Facts: your equity vs the opponents' modelled ranges is ${p(eq)}; the price requires ${p(info.requiredEquity)} to call. ${left.en}`, vi: `Dữ kiện: equity của bạn so với range mô hình của đối thủ là ${p(eq)}; giá yêu cầu ${p(info.requiredEquity)} để theo. ${left.vi}` };
  return { en: `Facts: your equity vs the opponents' modelled ranges is ${p(eq)}. ${left.en}`, vi: `Dữ kiện: equity của bạn so với range mô hình của đối thủ là ${p(eq)}. ${left.vi}` };
}

const solverExplain = (fb: HeroFeedback) =>
  fb.best ? { recommended: { en: fb.best === 'mixed' || fb.best === 'either' ? 'Either action (mixed strategy)' : fb.best, vi: fb.best === 'mixed' || fb.best === 'either' ? 'Hành động nào cũng được (chiến lược trộn)' : fb.best }, why: fb.note, sizing: null } : undefined;

function gradeHero(info: HeroDecisionInfo, state: HandState, action: PlayerAction, node: OracleNode | null = null, model?: { cfg: SimConfig; ranges: Record<string, Float64Array>; modelVersion?: string }): HeroFeedback {
  if (node) {
    const fb = oracleGrade(node, info, state, action);
    return { ...fb, tier: fb.graded ? 'solver' : 'limited', ...(fb.graded ? { explain: solverExplain(fb) } : { limitation: fb.note }) };
  }
  const fb = gradeHeroBase(info, state, action);
  if (fb.basis === 'solverEv') return { ...fb, assessment: 'solverVerified', tier: 'solver', explain: solverExplain(fb) };
  // Tier 2: exact EV of every action and size against this table's opponent model
  const me = model && !info.solver ? evaluateVsModel(state, model.cfg, model.ranges, action, { modelVersion: model.modelVersion }) : null;
  if (me) {
    const best = me.options.find((o) => o.key === me.bestKey)!;
    return {
      explain: explainModel(me),
      assessment: 'assumedRange',
      tier: 'model',
      model: me,
      graded: true,
      grade: me.grade,
      evLossBB: me.evLossBB,
      basis: 'modelEv',
      // model-based grades are recorded and shown, but never move a rating
      track: 'model',
      best: best.key,
      evByAction: Object.fromEntries(me.options.map((o) => [o.key, o.evBB])),
      note: { en: `Exact EV against this table's ${me.opponent.label.en} model (exploitative, not GTO).`, vi: `EV chính xác trước mô hình ${me.opponent.label.vi} của bàn này (khai thác, không phải GTO).` },
    };
  }
  if (fb.basis === 'modelEv') return { ...fb, assessment: 'assumedRange', tier: 'model' };
  const coaching = coachingFor(info, action);
  const many = info.modelEquity.opponents.length > 1;
  const limitation = many
    ? { en: 'Assessment limited — several opponents are still in the hand, and later streets would have to be modelled to compare actions.', vi: 'Đánh giá có giới hạn — còn nhiều đối thủ trong ván, và cần mô hình hoá các street sau để so sánh hành động.' }
    : { en: 'Assessment limited — more betting can follow, so comparing actions would require modelling your later decisions. Only the facts below are verified.', vi: 'Đánh giá có giới hạn — còn có thể cược tiếp, nên so sánh hành động đòi hỏi mô hình hoá các quyết định sau của bạn. Chỉ các dữ kiện dưới đây là đã kiểm chứng.' };
  return { ...fb, tier: 'limited', limitation, assessment: coaching ? 'heuristicCoaching' : 'notEvaluated', ...(coaching ? { coaching } : {}) };
}

/**
 * Deterministically (re)build a hand from its seed, config and Hero's actions. Villains act by the
 * model; streets are dealt from the fixed board. Stops when Hero must act or the hand is over.
 * Throws IllegalActionError if a Hero action is not legal.
 */
export function runSim(seed: number, config: SimConfig, heroActions: readonly PlayerAction[], opts: RunOptions = {}): SimRun {
  validateSimConfig(config);
  const deal = opts.deal ?? dealSim(seed, config);
  let state = createHand(tableFor(config, deal));
  const ranges: Record<string, Float64Array> = {};
  for (const id of Object.keys(config.villains)) ranges[id] = new Float64Array(COMBOS.length).fill(1);
  const run: SimRun = { seed, config, deal, state, decisions: [], villainEvents: [], ranges, awaitingHero: false };
  const samples = opts.equitySamples ?? 2500;
  const prefix = opts.prefix ?? [];
  let k = 0;
  let pi = 0;
  for (let guard = 0; guard < 400; guard++) {
    if (state.complete) break;
    if (state.awaitingBoard) {
      const n = state.board.length;
      state = dealNextStreet(state, n === 0 ? deal.board.slice(0, 3) : [deal.board[n]!]);
      continue;
    }
    const actor = state.players[state.toAct]!;
    if (pi < prefix.length) {
      // scripted part of a curated scenario: exactly as authored; Villain ranges still follow the model
      const p = prefix[pi++]!;
      if (p.playerId !== actor.id) throw new Error(`Scripted action for ${p.playerId}, but ${actor.id} is to act`);
      if (actor.id !== config.heroPos) {
        const m = villainModel(state, config, undefined, opts.modelVersion);
        updateRange(ranges[actor.id]!, m.probsFor, categoryOf(p.action));
        run.villainEvents.push({ historyIndex: state.history.length, playerId: actor.id, archetype: config.villains[actor.id]!, source: 'scripted', chosen: categoryOf(p.action) });
      }
      state = applyAction(state, p.action);
      continue;
    }
    if (actor.id === config.heroPos) {
      const node = opts.oracle?.(state, actor.id) ?? null;
      const idx = run.decisions.length;
      const pending = k >= heroActions.length;
      const cached = opts.equityCache?.[idx];
      const info = heroInfo(run, state, idx, pending && opts.skipPendingEquity ? 0 : samples, cached);
      if (node) info.oracle = { source: node.source, label: node.label, actions: node.actions.map((x) => x.key), options: node.actions.map((x) => x.make) };
      if (k >= heroActions.length) {
        run.decisions.push({ info });
        run.awaitingHero = true;
        break;
      }
      const action = heroActions[k++]!;
      const next = applyAction(state, action);
      run.decisions.push({ info, action, feedback: opts.feedbackCache?.[idx] ?? gradeHero(info, state, action, node, { cfg: config, ranges, modelVersion: opts.modelVersion }) });
      state = next;
      continue;
    }
    const { action, event } = villainAct(seed, state, config, ranges, opts);
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
  /** Villain action source / model (+ the model's reasoning, shown only after the hand). */
  villain?: Omit<VillainEvent, 'historyIndex' | 'playerId'>;
  heroDecision?: number;
}

/**
 * Hand review after completion: every action (with the Villain model's reasoning), Hero feedback
 * references, showdown cards of players entitled to show, winners with hand categories, payouts.
 */
export function simReview(run: SimRun) {
  const s = run.state;
  const bb = s.config.bigBlind;
  const events = new Map(run.villainEvents.map((e) => [e.historyIndex, e]));
  const heroIdx = new Map(run.decisions.map((d, i) => [d.info.historyIndex, i]));
  const timeline: TimelineEntry[] = s.history.map((h, i) => {
    const e = events.get(i);
    return {
      street: h.street,
      playerId: h.playerId,
      type: h.type,
      toBB: h.amount / bb,
      addedBB: h.added / bb,
      allIn: h.allIn,
      villain: e ? { archetype: e.archetype, source: e.source, chosen: e.chosen, forced: e.forced, probs: e.probs, strength: e.strength } : undefined,
      heroDecision: heroIdx.get(i),
    };
  });
  const showdown = s.result?.showdown ? s.players.filter((p) => !p.folded).map((p) => ({ id: p.id, cards: p.cards!, category: s.board.length === 5 ? handCategory(evaluate([...p.cards!, ...s.board])) : null })) : [];
  const net = Object.fromEntries(s.players.map((p) => [p.id, Math.round((((s.result?.awards[p.id] ?? 0) - p.totalCommitted - p.anteCommitted) / bb) * 100) / 100]));
  const awards = Object.entries(s.result?.awards ?? {}).filter(([, v]) => v > 0).map(([id, v]) => ({ id, amountBB: Math.round((v / bb) * 100) / 100 }));
  const winners = awards.map((a) => ({ ...a, category: showdown.find((x) => x.id === a.id)?.category ?? null }));
  const lastVoluntary = [...s.history].reverse().find((h) => ['fold', 'check', 'call', 'bet', 'raise'].includes(h.type));
  return {
    timeline,
    showdown,
    net,
    winners,
    pots: (s.result?.pots ?? []).map((p) => ({ amountBB: p.amount / bb, eligible: p.eligible })),
    endedBy: s.result?.showdown ? 'showdown' : 'fold',
    terminalStreet: s.board.length === 5 ? 'river' : s.board.length === 4 ? 'turn' : s.board.length === 3 ? 'flop' : 'preflop',
    lastAction: lastVoluntary?.type ?? null,
    board: s.board,
    decisions: run.decisions,
  };
}

/**
 * Simulator-only, after the hand is over: the cards nobody saw (folded opponents' hands and the
 * community cards that were never dealt). Hypothetical — not information Hero had or could have had.
 */
export function simHiddenInfo(run: SimRun) {
  if (!run.state.complete) throw new Error('Hand not finished');
  const s = run.state;
  return {
    runout: run.deal.board.slice(s.board.length),
    opponents: s.players.filter((p) => p.id !== run.config.heroPos).map((p) => ({ id: p.id, cards: p.cards!, folded: p.folded })),
  };
}

/**
 * Continue a curated scenario as a full hand: same table, stacks, Hero cards and authored board
 * (where defined); every unknown card is dealt with the supplied CSPRNG; the scenario's actions
 * become a scripted prefix; from there on Villains follow the model (default TAG, labelled).
 */
export function scenarioContinuation(
  sc: { format: { tableSize: number }; table: { heroPos: string; heroCards: string; smallBlind: number; bigBlind: number; ante: number; anteMode: 'none' | 'each' | 'bigBlind'; players: { pos: string; stackBB: number; cards?: string }[] }; board: { flop?: string; turn?: string; river?: string } },
  endState: HandState,
  randomInt: (maxExclusive: number) => number,
  archetype: Archetype = 'tag',
): { config: SimConfig; deal: SimDeal; prefix: { playerId: string; action: PlayerAction }[] } {
  const layout = positionsFor(sc.format.tableSize);
  const toCards = (x?: string) => (x ? (x.match(/.{2}/g) as Card[]) : []);
  const used = new Set<Card>();
  const holes: Record<string, [Card, Card]> = {};
  holes[sc.table.heroPos] = toCards(sc.table.heroCards) as [Card, Card];
  for (const p of sc.table.players) if (p.cards && p.pos !== sc.table.heroPos) holes[p.pos] = toCards(p.cards) as [Card, Card];
  const authored = [...toCards(sc.board.flop), ...toCards(sc.board.turn), ...toCards(sc.board.river)];
  for (const c of [...Object.values(holes).flat(), ...authored]) used.add(c);
  const deck = fullDeck().filter((c) => !used.has(c));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  let k = 0;
  for (const pos of layout) if (!holes[pos]) holes[pos] = [deck[k++]!, deck[k++]!];
  const board = [...authored];
  while (board.length < 5) board.push(deck[k++]!);
  const bb = sc.table.bigBlind;
  const config: SimConfig = {
    tableSize: sc.format.tableSize,
    heroPos: sc.table.heroPos,
    stacksBB: Object.fromEntries(sc.table.players.map((p) => [p.pos, p.stackBB])),
    anteMode: sc.table.anteMode,
    villains: Object.fromEntries(layout.filter((p) => p !== sc.table.heroPos).map((p) => [p, archetype])),
    chips: { smallBlind: sc.table.smallBlind, bigBlind: bb, ante: sc.table.ante },
  };
  const prefix = endState.history
    .filter((h) => h.type === 'fold' || h.type === 'check' || h.type === 'call' || h.type === 'bet' || h.type === 'raise')
    .map((h) => ({ playerId: h.playerId, action: (h.type === 'bet' || h.type === 'raise' ? { type: h.type, amount: h.amount } : { type: h.type }) as PlayerAction }));
  return { config, deal: { holes, board }, prefix };
}

/**
 * Strategic fingerprint of a dealt situation, for diversity (not identity): two hands with the same
 * fingerprint put Hero in an equivalent spot (same table, seat, stack bucket, hand class, opponents).
 * Different board textures / actions later in the hand still make them different hands to play.
 */
export function simFingerprint(cfg: SimConfig, deal: SimDeal, originKey = 'random'): string {
  const hero = deal.holes[cfg.heroPos]!;
  const heroStack = cfg.stacksBB[cfg.heroPos]!;
  const eff = Math.min(heroStack, Math.max(...Object.keys(cfg.villains).map((p) => cfg.stacksBB[p]!)));
  const bucket = [10, 15, 25, 40, 60, 100].find((b) => eff <= b) ?? 999;
  const opp = Object.values(cfg.villains).sort().join(',');
  return [originKey, cfg.tableSize, cfg.heroPos, `<=${bucket}`, classOfCombo(hero[0], hero[1]), opp].join('|');
}

/** Exact-deal key: identical cards in identical seats on an identical table (server-side only). */
export function simExactKey(cfg: SimConfig, deal: SimDeal): string {
  const seats = positionsFor(cfg.tableSize).map((p) => `${p}:${cfg.stacksBB[p]}:${cfg.villains[p] ?? 'H'}:${[...deal.holes[p]!].sort().join('')}`);
  return `${seats.join('/')}#${deal.board.join('')}#${cfg.anteMode}`;
}
