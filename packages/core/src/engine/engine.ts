import { type Card, assertDistinct } from '../cards/cards';
import { evaluate } from '../cards/evaluator';

/**
 * The single authoritative No-Limit Hold'em rules engine.
 * Every training mode (Hero, Villain, imported-hand replay) drives this engine,
 * so betting logic is never duplicated.
 *
 * Conventions:
 *  - All amounts are integer chips.
 *  - Bet/raise amounts are "raise-to" totals for the current street (what the
 *    player has in front of them after acting), never "additional chips".
 *  - Players are ordered clockwise starting from the small blind; the last
 *    player is the button. Heads-up: index 0 is SB+button, index 1 is BB.
 */

export type Street = 'preflop' | 'flop' | 'turn' | 'river';
export const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river'];
export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise';
export type AnteMode = 'none' | 'each' | 'bigBlind';

export interface TableConfig {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  anteMode: AnteMode;
  players: { id: string; stack: number; cards?: Card[] }[];
}

export interface PlayerState {
  id: string;
  seat: number;
  startingStack: number;
  stack: number;
  /** Chips committed on the current street (blinds included preflop). */
  streetCommitted: number;
  /** Chips committed across all streets, excluding antes. */
  totalCommitted: number;
  anteCommitted: number;
  folded: boolean;
  allIn: boolean;
  hasActed: boolean;
  /** currentBet at the moment of this player's last voluntary action this street. */
  betFacedAtLastAction: number;
  cards?: Card[];
}

export interface ActionRecord {
  street: Street;
  playerId: string;
  type: ActionType | 'postSB' | 'postBB' | 'postAnte' | 'returnUncalled';
  /** Raise-to total for bet/raise; amount added for call/post; returned amount for returnUncalled. */
  amount: number;
  /** Chips moved from stack by this action. */
  added: number;
  allIn: boolean;
}

export interface Pot {
  amount: number;
  eligible: string[];
}

export interface HandState {
  config: TableConfig;
  players: PlayerState[];
  street: Street;
  board: Card[];
  /** Index of the player to act; -1 when no action is pending. */
  toAct: number;
  currentBet: number;
  /** Size of the last full bet/raise increment on this street (min-raise basis). */
  lastFullRaise: number;
  deadAntes: number;
  history: ActionRecord[];
  /** Betting round finished and the next board card(s) must be dealt. */
  awaitingBoard: boolean;
  /** Hand is over (one player left, or showdown resolved). */
  complete: boolean;
  /** Set when complete via showdown or fold. */
  result?: HandResult;
}

export interface HandResult {
  pots: Pot[];
  /** Net chips won from pots per player (does not subtract contributions). */
  awards: Record<string, number>;
  showdown: boolean;
  /** Hand-strength scores at showdown, when relevant. */
  scores?: Record<string, number>;
}

export interface LegalActions {
  playerId: string;
  canFold: boolean;
  canCheck: boolean;
  /** Amount required to call (0 if checking); capped by stack. */
  callAmount: number;
  callIsAllIn: boolean;
  canBet: boolean;
  canRaise: boolean;
  /** Minimum and maximum raise-to (or bet) totals for this street. */
  minRaiseTo: number;
  maxRaiseTo: number;
  /** Total pot including all chips committed this street (before acting). */
  pot: number;
  toCall: number;
}

export interface PlayerAction {
  type: ActionType;
  /** Required for bet/raise: the raise-to total. */
  amount?: number;
}

export class IllegalActionError extends Error {}

function clone(state: HandState): HandState {
  return structuredClone(state);
}

export function isHeadsUp(state: HandState): boolean {
  return state.players.length === 2;
}

export function totalPot(state: HandState): number {
  return state.deadAntes + state.players.reduce((s, p) => s + p.totalCommitted, 0);
}

/** Create a hand: post antes and blinds and set the first actor. */
export function createHand(config: TableConfig): HandState {
  const n = config.players.length;
  if (n < 2 || n > 10) throw new Error('Table needs 2-10 players');
  if (!(config.bigBlind > 0) || config.smallBlind < 0 || config.ante < 0) throw new Error('Invalid blinds');
  const ids = new Set(config.players.map((p) => p.id));
  if (ids.size !== n) throw new Error('Duplicate player ids');
  const known = config.players.flatMap((p) => p.cards ?? []);
  assertDistinct(known, 'hole cards');
  const state: HandState = {
    config: structuredClone(config),
    players: config.players.map((p, i) => {
      if (!Number.isInteger(p.stack) || p.stack <= 0) throw new Error(`Invalid stack for ${p.id}`);
      return {
        id: p.id,
        seat: i,
        startingStack: p.stack,
        stack: p.stack,
        streetCommitted: 0,
        totalCommitted: 0,
        anteCommitted: 0,
        folded: false,
        allIn: false,
        hasActed: false,
        betFacedAtLastAction: 0,
        cards: p.cards ? [...p.cards] : undefined,
      };
    }),
    street: 'preflop',
    board: [],
    toAct: -1,
    currentBet: 0,
    lastFullRaise: config.bigBlind,
    deadAntes: 0,
    history: [],
    awaitingBoard: false,
    complete: false,
  };

  const bbIndex = n === 2 ? 1 : 1;
  const sbIndex = 0;
  // Antes (dead money, main pot)
  if (config.ante > 0 && config.anteMode !== 'none') {
    const payers = config.anteMode === 'each' ? state.players : [state.players[bbIndex]!];
    for (const p of payers) {
      const paid = Math.min(config.ante, p.stack);
      p.stack -= paid;
      p.anteCommitted += paid;
      state.deadAntes += paid;
      if (p.stack === 0) p.allIn = true;
      state.history.push({ street: 'preflop', playerId: p.id, type: 'postAnte', amount: paid, added: paid, allIn: p.stack === 0 });
    }
  }
  const post = (idx: number, amount: number, type: 'postSB' | 'postBB') => {
    const p = state.players[idx]!;
    const paid = Math.min(amount, p.stack);
    p.stack -= paid;
    p.streetCommitted += paid;
    p.totalCommitted += paid;
    if (p.stack === 0) p.allIn = true;
    state.history.push({ street: 'preflop', playerId: p.id, type, amount: paid, added: paid, allIn: p.allIn });
  };
  if (config.smallBlind > 0) post(sbIndex, config.smallBlind, 'postSB');
  post(bbIndex, config.bigBlind, 'postBB');
  state.currentBet = config.bigBlind;
  state.lastFullRaise = config.bigBlind;
  const first = n === 2 ? 0 : 2 % n;
  state.toAct = nextToAct(state, first, true);
  settleIfRoundOver(state);
  return state;
}

function canStillAct(p: PlayerState): boolean {
  return !p.folded && !p.allIn;
}

/**
 * The amount this player must have in front of them to stay in: the current bet, capped at
 * the most any live opponent can put in. Nobody has to match chips an opponent cannot cover
 * (e.g. facing only a big blind that is all-in for less, a call matches that amount).
 */
function matchTarget(state: HandState, p: PlayerState): number {
  const cover = Math.max(0, ...state.players.filter((o) => o !== p && !o.folded).map((o) => o.streetCommitted + o.stack));
  return Math.min(state.currentBet, cover);
}

/** Find the next player (starting at `from`, inclusive if `inclusive`) who must act. */
function nextToAct(state: HandState, from: number, inclusive: boolean): number {
  const n = state.players.length;
  for (let k = inclusive ? 0 : 1; k <= n; k++) {
    const idx = (from + k) % n;
    const p = state.players[idx]!;
    if (!canStillAct(p)) continue;
    if (p.streetCommitted < matchTarget(state, p)) return idx;
    // Unacted but already matched (e.g. the BB option): only a decision if someone else can still act.
    if (!p.hasActed && state.players.some((o) => o !== p && canStillAct(o))) return idx;
  }
  return -1;
}

export function activePlayers(state: HandState): PlayerState[] {
  return state.players.filter((p) => !p.folded);
}

export function legalActions(state: HandState): LegalActions | null {
  if (state.complete || state.awaitingBoard || state.toAct < 0) return null;
  const p = state.players[state.toAct]!;
  const toCall = Math.max(0, matchTarget(state, p) - p.streetCommitted);
  const callAmount = Math.min(toCall, p.stack);
  const maxRaiseTo = p.streetCommitted + p.stack;
  const othersCanAct = state.players.some((o) => o !== p && canStillAct(o));
  const othersNotAllIn = othersCanAct;
  // Re-raise rights: reopened if the player has not acted, or the bet has grown by a full
  // raise (cumulatively) since their last action.
  const reopened = !p.hasActed || state.currentBet - p.betFacedAtLastAction >= state.lastFullRaise;
  const fullMin = state.currentBet === 0 ? Math.min(state.config.bigBlind, maxRaiseTo) : state.currentBet + state.lastFullRaise;
  const canBet = state.currentBet === 0 && p.stack > 0 && othersNotAllIn;
  const canRaise = state.currentBet > 0 && reopened && p.stack > toCall && othersNotAllIn;
  return {
    playerId: p.id,
    canFold: toCall > 0,
    canCheck: toCall === 0,
    callAmount,
    callIsAllIn: toCall > 0 && callAmount === p.stack,
    canBet,
    canRaise,
    minRaiseTo: canBet || canRaise ? Math.min(fullMin, maxRaiseTo) : 0,
    maxRaiseTo: canBet || canRaise ? maxRaiseTo : 0,
    pot: totalPot(state),
    toCall,
  };
}

/** Apply an action for the player to act. Throws IllegalActionError on any illegal input. */
export function applyAction(prev: HandState, action: PlayerAction): HandState {
  const legal = legalActions(prev);
  if (!legal) throw new IllegalActionError('No action is pending');
  const state = clone(prev);
  const idx = state.toAct;
  const p = state.players[idx]!;
  const rec = (type: ActionType, amount: number, added: number) =>
    state.history.push({ street: state.street, playerId: p.id, type, amount, added, allIn: p.stack === 0 });

  switch (action.type) {
    case 'fold': {
      if (!legal.canFold) throw new IllegalActionError('Cannot fold when checking is free');
      p.folded = true;
      rec('fold', 0, 0);
      break;
    }
    case 'check': {
      if (!legal.canCheck) throw new IllegalActionError('Cannot check facing a bet');
      rec('check', 0, 0);
      break;
    }
    case 'call': {
      if (legal.toCall === 0) throw new IllegalActionError('Nothing to call');
      const add = legal.callAmount;
      p.stack -= add;
      p.streetCommitted += add;
      p.totalCommitted += add;
      if (p.stack === 0) p.allIn = true;
      rec('call', add, add);
      break;
    }
    case 'bet':
    case 'raise': {
      const isBet = action.type === 'bet';
      if (isBet && !legal.canBet) throw new IllegalActionError('Betting is not allowed here');
      if (!isBet && !legal.canRaise) throw new IllegalActionError('Raising is not allowed here');
      const to = action.amount;
      if (to === undefined || !Number.isInteger(to)) throw new IllegalActionError('Bet/raise needs an integer raise-to amount');
      if (to > legal.maxRaiseTo) throw new IllegalActionError(`Amount ${to} exceeds stack (max ${legal.maxRaiseTo})`);
      const allIn = to === legal.maxRaiseTo;
      if (to < legal.minRaiseTo && !allIn) throw new IllegalActionError(`Minimum ${isBet ? 'bet' : 'raise-to'} is ${legal.minRaiseTo}`);
      if (to <= state.currentBet) throw new IllegalActionError('Raise must exceed the current bet');
      const increment = to - state.currentBet;
      const add = to - p.streetCommitted;
      p.stack -= add;
      p.streetCommitted = to;
      p.totalCommitted += add;
      if (p.stack === 0) p.allIn = true;
      // A full bet (>= 1BB) or full raise (>= last full increment) becomes the new min-raise
      // basis. Short all-ins do not change it and do not reopen action (see legalActions).
      if (isBet ? to >= state.config.bigBlind : increment >= state.lastFullRaise) state.lastFullRaise = increment;
      state.currentBet = to;
      rec(isBet ? 'bet' : 'raise', to, add);
      break;
    }
    default:
      throw new IllegalActionError(`Unknown action ${(action as PlayerAction).type}`);
  }
  p.hasActed = true;
  p.betFacedAtLastAction = state.currentBet;
  state.toAct = nextToAct(state, idx, false);
  settleIfRoundOver(state);
  return state;
}

/**
 * Forfeit by a player who is already all-in (hand histories record this, e.g. a player
 * all-in from posting a blind who then "folds"). Their chips stay in the pot as dead money.
 */
export function forfeitAllIn(prev: HandState, playerId: string): HandState {
  const state = clone(prev);
  const p = state.players.find((x) => x.id === playerId);
  if (!p || !p.allIn || p.folded) throw new IllegalActionError('Only an all-in player can forfeit out of turn');
  p.folded = true;
  state.history.push({ street: state.street, playerId, type: 'fold', amount: 0, added: 0, allIn: true });
  if (state.toAct < 0 || !legalActions(state)) {
    state.toAct = nextToAct(state, 0, true);
  }
  settleIfRoundOver(state);
  return state;
}

function returnUncalled(state: HandState): void {
  const commits = state.players.map((p) => p.streetCommitted);
  const max = Math.max(...commits);
  const holders = state.players.filter((p) => p.streetCommitted === max);
  if (holders.length !== 1) return;
  const top = holders[0]!;
  const second = Math.max(0, ...state.players.filter((p) => p !== top).map((p) => p.streetCommitted));
  const excess = max - second;
  if (excess <= 0) return;
  top.stack += excess;
  top.streetCommitted -= excess;
  top.totalCommitted -= excess;
  if (top.stack > 0) top.allIn = false;
  state.history.push({ street: state.street, playerId: top.id, type: 'returnUncalled', amount: excess, added: -excess, allIn: false });
}

function settleIfRoundOver(state: HandState): void {
  const live = activePlayers(state);
  if (live.length === 1) {
    returnUncalled(state);
    finishByFold(state, live[0]!);
    return;
  }
  if (state.toAct >= 0) return;
  // Betting round complete.
  returnUncalled(state);
  const canAct = live.filter((p) => !p.allIn);
  if (state.street === 'river') {
    showdown(state);
    return;
  }
  state.awaitingBoard = true;
  // If at most one player can still act, no more betting: the board runs out.
  void canAct;
}

/** Whether remaining streets will be dealt without further betting (all-in runout). */
export function isRunout(state: HandState): boolean {
  return activePlayers(state).filter((p) => !p.allIn).length <= 1;
}

const BOARD_SIZE: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };

/** Deal the next street's card(s) and open the next betting round. */
export function dealNextStreet(prev: HandState, cards: readonly Card[]): HandState {
  if (!prev.awaitingBoard) throw new IllegalActionError('Betting round is not complete');
  const state = clone(prev);
  const next = STREETS[STREETS.indexOf(state.street) + 1];
  if (!next) throw new IllegalActionError('No street after the river');
  const need = BOARD_SIZE[next] - state.board.length;
  if (cards.length !== need) throw new IllegalActionError(`${next} needs ${need} card(s)`);
  const known = [...state.board, ...cards, ...state.players.flatMap((p) => p.cards ?? [])];
  assertDistinct(known, 'board and hole cards');
  state.board.push(...cards);
  state.street = next;
  state.awaitingBoard = false;
  state.currentBet = 0;
  state.lastFullRaise = state.config.bigBlind;
  for (const p of state.players) {
    p.streetCommitted = 0;
    p.hasActed = false;
    p.betFacedAtLastAction = 0;
  }
  if (isRunout(state)) {
    state.toAct = -1;
    if (next === 'river') showdown(state);
    else state.awaitingBoard = true;
    return state;
  }
  const n = state.players.length;
  const first = isHeadsUp(state) ? 1 : 0;
  state.toAct = nextToAct(state, first % n, true);
  settleIfRoundOver(state);
  return state;
}

/**
 * Build main/side pots from contributions.
 * Per-player antes count toward each player's contribution (as on GGPoker), so a short
 * all-in stack wins at most its own total from each opponent. A big-blind ante is posted
 * on behalf of the whole table and goes to the main pot as dead money.
 */
export function computePots(state: HandState): Pot[] {
  const antesInLevels = state.config.anteMode === 'each';
  const contrib = state.players.map((p) => ({ id: p.id, amt: p.totalCommitted + (antesInLevels ? p.anteCommitted : 0), folded: p.folded }));
  const levels = [...new Set(contrib.filter((c) => !c.folded && c.amt > 0).map((c) => c.amt))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const c of contrib) amount += Math.max(0, Math.min(c.amt, level) - prev);
    const eligible = contrib.filter((c) => !c.folded && c.amt >= level).map((c) => c.id);
    pots.push({ amount, eligible });
    prev = level;
  }
  // Folded players' chips above the top live level (cannot happen after returnUncalled, but be safe)
  const leftover = contrib.reduce((s, c) => s + Math.max(0, c.amt - prev), 0);
  if (pots.length === 0) {
    const live = contrib.filter((c) => !c.folded).map((c) => c.id);
    pots.push({ amount: 0, eligible: live });
  }
  if (!antesInLevels) pots[0]!.amount += state.deadAntes;
  pots[pots.length - 1]!.amount += leftover;
  // merge adjacent pots with identical eligibility
  const merged: Pot[] = [];
  for (const pot of pots) {
    const last = merged[merged.length - 1];
    if (last && last.eligible.join() === pot.eligible.join()) last.amount += pot.amount;
    else merged.push({ ...pot, eligible: [...pot.eligible] });
  }
  return merged;
}

function finishByFold(state: HandState, winner: PlayerState): void {
  const pots = computePots(state);
  const amount = pots.reduce((s, p) => s + p.amount, 0);
  winner.stack += amount;
  state.result = { pots, awards: { [winner.id]: amount }, showdown: false };
  state.complete = true;
  state.toAct = -1;
  state.awaitingBoard = false;
}

function showdown(state: HandState): void {
  const live = activePlayers(state);
  if (state.board.length !== 5) throw new Error('Showdown requires a full board');
  const scores: Record<string, number> = {};
  for (const p of live) {
    if (!p.cards || p.cards.length !== 2) {
      // Cards unknown: cannot resolve — leave the hand complete without awards.
      state.result = { pots: computePots(state), awards: {}, showdown: true };
      state.complete = true;
      state.toAct = -1;
      state.awaitingBoard = false;
      return;
    }
    scores[p.id] = evaluate([...p.cards, ...state.board]);
  }
  const pots = computePots(state);
  const awards: Record<string, number> = {};
  const n = state.players.length;
  for (const pot of pots) {
    const best = Math.max(...pot.eligible.map((id) => scores[id]!));
    const winners = pot.eligible.filter((id) => scores[id] === best);
    // odd chips go to the first winner clockwise from the button (index 0 = SB)
    winners.sort((a, b) => seatOrder(state, a) - seatOrder(state, b));
    const share = Math.floor(pot.amount / winners.length);
    let odd = pot.amount - share * winners.length;
    for (const id of winners) {
      const extra = odd > 0 ? 1 : 0;
      odd -= extra;
      awards[id] = (awards[id] ?? 0) + share + extra;
    }
  }
  for (const p of state.players) p.stack += awards[p.id] ?? 0;
  void n;
  state.result = { pots, awards, showdown: true, scores };
  state.complete = true;
  state.toAct = -1;
  state.awaitingBoard = false;
}

function seatOrder(state: HandState, id: string): number {
  return state.players.findIndex((p) => p.id === id);
}

/** Total chips on the table — invariant: equals the sum of starting stacks. */
export function chipsInPlay(state: HandState): number {
  const onTable = state.players.reduce((s, p) => s + p.stack, 0);
  if (state.complete) return onTable;
  return onTable + totalPot(state);
}

export function playerById(state: HandState, id: string): PlayerState {
  const p = state.players.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown player ${id}`);
  return p;
}
