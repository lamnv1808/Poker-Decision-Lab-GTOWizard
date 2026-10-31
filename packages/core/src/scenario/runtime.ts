import { type Card, parseCards } from '../cards/cards';
import {
  type HandState,
  type LegalActions,
  type PlayerAction,
  type TableConfig,
  IllegalActionError,
  applyAction,
  createHand,
  dealNextStreet,
  legalActions,
  positionsFor,
  totalPot,
} from '../engine';
import type { DecisionNode, DecisionOption, QuestionNode, Scenario, ScriptAction } from './schema';

/**
 * Scenario runtime: walks a scenario's decision tree on the authoritative engine.
 * Script nodes and board dealing are processed automatically; execution stops at
 * decision/question nodes (awaiting the user) and end nodes.
 */

export interface RunCursor {
  nodeId: string;
  state: HandState;
  /** Set when the tree cannot continue (e.g. board not defined, or off-tree action). */
  terminated?: 'end' | 'offTree' | 'noBoard';
}

export function heroId(scenario: Scenario): string {
  return scenario.table.heroPos;
}

/** Build the engine table, players ordered clockwise from SB. Villain cards are included only if `withHidden`. */
export function buildTable(scenario: Scenario, withHidden = true): TableConfig {
  const { table } = scenario;
  const layout = positionsFor(scenario.format.tableSize);
  const byPos = new Map(table.players.map((p) => [p.pos, p]));
  if (byPos.size !== table.players.length) throw new Error('Duplicate positions');
  if (table.players.length !== layout.length) throw new Error(`Expected ${layout.length} players for a ${scenario.format.tableSize}-max table`);
  return {
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    ante: table.ante,
    anteMode: table.anteMode,
    players: layout.map((pos) => {
      const p = byPos.get(pos);
      if (!p) throw new Error(`Missing player at ${pos}`);
      const chips = Math.round(p.stackBB * table.bigBlind);
      if (Math.abs(chips - p.stackBB * table.bigBlind) > 1e-6) throw new Error(`Stack for ${pos} is not a whole number of chips`);
      const cards = pos === table.heroPos ? parseCards(table.heroCards) : withHidden && p.cards ? parseCards(p.cards) : undefined;
      return { id: pos, stack: chips, cards };
    }),
  };
}

function boardFor(scenario: Scenario, street: HandState['street']): Card[] | null {
  const b = scenario.board;
  const next = street === 'preflop' ? b.flop : street === 'flop' ? b.turn : street === 'turn' ? b.river : undefined;
  return next ? parseCards(next) : null;
}

function dealIfNeeded(scenario: Scenario, state: HandState): { state: HandState; ok: boolean } {
  let s = state;
  while (s.awaitingBoard && !s.complete) {
    const cards = boardFor(scenario, s.street);
    if (!cards) return { state: s, ok: false };
    s = dealNextStreet(s, cards);
  }
  return { state: s, ok: true };
}

/** Convert a scripted action into a concrete engine action (amounts resolved against the live state). */
export function resolveScriptAction(scenario: Scenario, state: HandState, a: ScriptAction): PlayerAction {
  const legal = legalActions(state);
  if (!legal) throw new IllegalActionError('No action pending');
  const p = state.players[state.toAct]!;
  const bb = scenario.table.bigBlind;
  switch (a.type) {
    case 'fold':
    case 'check':
    case 'call':
      return { type: a.type };
    case 'allin':
      if (legal.canBet) return { type: 'bet', amount: legal.maxRaiseTo };
      if (legal.canRaise) return { type: 'raise', amount: legal.maxRaiseTo };
      return { type: 'call' };
    case 'bet':
    case 'raise': {
      let to: number;
      if (a.toBB !== undefined) to = Math.round(a.toBB * bb);
      else if (a.potFraction !== undefined)
        to = state.currentBet === 0 ? Math.round(a.potFraction * legal.pot) : Math.round(state.currentBet + a.potFraction * (legal.pot + legal.toCall));
      else throw new Error(`Scripted ${a.type} for ${a.pos} needs toBB or potFraction`);
      // Clamp into the legal window (continuations remain valid across a sizing band).
      to = Math.min(Math.max(to, legal.minRaiseTo), legal.maxRaiseTo);
      void p;
      return { type: state.currentBet === 0 ? 'bet' : 'raise', amount: to };
    }
  }
}

function autoFoldUntil(state: HandState, pos: string): HandState {
  let s = state;
  let guard = 0;
  while (!s.complete && !s.awaitingBoard && s.players[s.toAct]?.id !== pos) {
    const legal = legalActions(s)!;
    if (s.street !== 'preflop' && legal.canCheck) throw new Error(`Script must specify ${s.players[s.toAct]!.id}'s postflop action before ${pos}`);
    s = applyAction(s, legal.canFold ? { type: 'fold' } : { type: 'check' });
    if (++guard > 20) throw new Error('autoFold loop');
  }
  return s;
}

/** Advance from a node through script nodes until a decision/question/end is reached. */
export function advance(scenario: Scenario, cursor: RunCursor): RunCursor {
  let { nodeId, state } = cursor;
  for (let guard = 0; guard < 100; guard++) {
    const node = scenario.nodes[nodeId];
    if (!node) throw new Error(`Unknown node ${nodeId}`);
    if (node.kind === 'script') {
      for (const a of node.actions) {
        const dealt = dealIfNeeded(scenario, state);
        if (!dealt.ok) return { nodeId, state: dealt.state, terminated: 'noBoard' };
        state = dealt.state;
        if (node.autoFold) state = autoFoldUntil(state, a.pos);
        if (state.players[state.toAct]?.id !== a.pos) throw new Error(`Script expects ${a.pos} to act, but ${state.players[state.toAct]?.id ?? 'nobody'} is to act`);
        state = applyAction(state, resolveScriptAction(scenario, state, a));
      }
      const dealt = dealIfNeeded(scenario, state);
      state = dealt.state;
      nodeId = node.next;
      if (!dealt.ok && scenario.nodes[nodeId]?.kind === 'decision') return { nodeId, state, terminated: 'noBoard' };
      continue;
    }
    if (node.kind === 'decision') {
      const dealt = dealIfNeeded(scenario, state);
      if (!dealt.ok) return { nodeId, state: dealt.state, terminated: 'noBoard' };
      state = autoFoldUntil(dealt.state, heroId(scenario));
      if (state.complete) throw new Error(`Hand ended before decision ${nodeId}`);
      return { nodeId, state };
    }
    if (node.kind === 'question') return { nodeId, state };
    return { nodeId, state, terminated: 'end' };
  }
  throw new Error('Scenario advance exceeded step limit (cycle?)');
}

export function startScenario(scenario: Scenario, withHidden = true): RunCursor {
  const state = createHand(buildTable(scenario, withHidden));
  return advance(scenario, { nodeId: scenario.root, state });
}

/** Classify a Hero action against the node's options. Returns null if the action is outside the curated tree. */
export function matchOption(scenario: Scenario, node: DecisionNode, state: HandState, action: PlayerAction): DecisionOption | null {
  const legal = legalActions(state);
  if (!legal) return null;
  const hero = state.players[state.toAct]!;
  const bb = scenario.table.bigBlind;
  const goesAllIn =
    (action.type === 'call' && legal.callIsAllIn) || ((action.type === 'bet' || action.type === 'raise') && action.amount === legal.maxRaiseTo);
  if (goesAllIn) {
    const all = node.options.find((o) => o.match.action === 'allin');
    if (all) return all;
  }
  void hero;
  for (const o of node.options) {
    const m = o.match;
    if (m.action === 'allin') continue;
    if (m.action === 'fold' && action.type === 'fold') return o;
    if (m.action === 'check' && action.type === 'check') return o;
    if (m.action === 'call' && action.type === 'call') return o;
    if (m.action === 'raise' && (action.type === 'bet' || action.type === 'raise')) {
      const to = action.amount ?? 0;
      const toBB = to / bb;
      const frac = (to - state.currentBet) / (legal.pot + legal.toCall);
      if (m.minBB !== undefined && toBB < m.minBB - 1e-9) continue;
      if (m.maxBB !== undefined && toBB > m.maxBB + 1e-9) continue;
      if (m.minPot !== undefined && frac < m.minPot - 1e-9) continue;
      if (m.maxPot !== undefined && frac > m.maxPot + 1e-9) continue;
      return o;
    }
  }
  return null;
}

export interface HeroStep {
  option: DecisionOption | null;
  before: HandState;
  after: HandState;
  cursor: RunCursor;
}

/** Apply a Hero action at a decision node and advance the tree along the matched option. */
export function heroAct(scenario: Scenario, cursor: RunCursor, action: PlayerAction): HeroStep {
  const node = scenario.nodes[cursor.nodeId];
  if (!node || node.kind !== 'decision') throw new Error('Not at a decision node');
  if (cursor.state.players[cursor.state.toAct]?.id !== heroId(scenario)) throw new Error('Hero is not to act');
  const option = matchOption(scenario, node, cursor.state, action);
  const after = applyAction(cursor.state, action);
  if (!option) return { option, before: cursor.state, after, cursor: { nodeId: cursor.nodeId, state: after, terminated: 'offTree' } };
  if (!option.next) return { option, before: cursor.state, after, cursor: { nodeId: cursor.nodeId, state: after, terminated: 'end' } };
  if (after.complete) return { option, before: cursor.state, after, cursor: { nodeId: option.next, state: after, terminated: 'end' } };
  const next = advance(scenario, { nodeId: option.next, state: after });
  return { option, before: cursor.state, after, cursor: next };
}

/** Continue past a question node (villain mode). */
export function answerQuestion(scenario: Scenario, cursor: RunCursor): RunCursor {
  const node = scenario.nodes[cursor.nodeId] as QuestionNode;
  if (!node || node.kind !== 'question') throw new Error('Not at a question node');
  if (!node.next) return { ...cursor, terminated: 'end' };
  return advance(scenario, { nodeId: node.next, state: cursor.state });
}

/** Public, hidden-information-safe view of a hand state (villain hole cards removed). */
export function publicState(state: HandState, viewerId: string): HandState {
  const s = structuredClone(state);
  for (const p of s.players) if (p.id !== viewerId) delete p.cards;
  for (const p of s.config.players) if (p.id !== viewerId) delete p.cards;
  if (s.result?.scores) s.result.scores = Object.fromEntries(Object.entries(s.result.scores).filter(([id]) => id === viewerId));
  return s;
}

export function describeLegal(state: HandState): LegalActions | null {
  return legalActions(state);
}

export { totalPot };
