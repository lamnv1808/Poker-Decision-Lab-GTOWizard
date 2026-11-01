import { type Card, rankOf, suitOf } from '../cards/cards';
import { categoryOf, evaluate } from '../cards/evaluator';
import type { HandState } from '../engine';
import { legalActions, totalPot } from '../engine';

/**
 * Curriculum review topics, computed ONLY from information available at the decision
 * (Hero's cards, the current board, bets faced, stacks, players in the pot). Never from the
 * observed action, future cards or showdown. A topic marks something worth studying — it is
 * not a judgement that the hand was misplayed.
 */
export const TOPICS = [
  'callingShove',
  'initiatingShove',
  'topPairVsAggression',
  'turnChangesBoard',
  'drawsAndOuts',
  'valueBetting',
  'bluffing',
  'multiwayOrBounty',
  'blockingAces',
] as const;
export type Topic = (typeof TOPICS)[number];

export const TOPIC_LABELS: Record<Topic, { en: string; vi: string }> = {
  callingShove: { en: 'Calling a shove', vi: 'Theo một lần all-in' },
  initiatingShove: { en: 'Initiating a shove', vi: 'Chủ động all-in' },
  topPairVsAggression: { en: 'Top pair / overpair facing strong action', vi: 'Đôi lớn nhất / overpair trước hành động mạnh' },
  turnChangesBoard: { en: 'Reassessing ranges when the turn changes the board', vi: 'Đánh giá lại range khi lá turn thay đổi board' },
  drawsAndOuts: { en: 'Draws, dirty outs and equity realization', vi: 'Bài hút, outs bẩn và hiện thực hóa equity' },
  valueBetting: { en: 'Value betting: which worse hands call?', vi: 'Cược value: tay yếu hơn nào sẽ theo?' },
  bluffing: { en: 'Bluffing: which better hands fold?', vi: 'Bluff: tay mạnh hơn nào sẽ bỏ?' },
  multiwayOrBounty: { en: 'Multiway and bounty decisions', vi: 'Quyết định nhiều người và bounty' },
  blockingAces: { en: 'Opponents blocking each other’s aces is not enough to call', vi: 'Đối thủ chặn Át của nhau không đủ để theo' },
};

function hasFlushDraw(hero: Card[], board: Card[]): boolean {
  const cards = [...hero, ...board];
  for (let s = 0; s < 4; s++) {
    const n = cards.filter((c) => suitOf(c) === s).length;
    if (n === 4 && hero.some((c) => suitOf(c) === s)) return true;
  }
  return false;
}

function hasStraightDraw(hero: Card[], board: Card[]): boolean {
  const ranks = new Set([...hero, ...board].map(rankOf));
  if (ranks.has(12)) ranks.add(-1);
  // any 5-rank window holding 4 distinct ranks, using at least one hole card
  for (let lo = -1; lo <= 8; lo++) {
    const win = [0, 1, 2, 3, 4].map((k) => lo + k);
    const have = win.filter((r) => ranks.has(r));
    if (have.length === 4 && hero.some((c) => win.includes(rankOf(c)) || (rankOf(c) === 12 && win.includes(-1)))) return true;
  }
  return false;
}

/**
 * Players contesting the pot. Preflop: Hero plus opponents who have voluntarily called, bet or
 * raised (posting a blind alone does not count). Postflop: every player still in the hand.
 */
export function contenders(state: HandState, heroId: string) {
  if (state.street !== 'preflop') return state.players.filter((p) => !p.folded);
  const voluntary = new Set(state.history.filter((h) => h.street === 'preflop' && (h.type === 'call' || h.type === 'raise' || h.type === 'bet')).map((h) => h.playerId));
  return state.players.filter((p) => !p.folded && (p.id === heroId || voluntary.has(p.id)));
}

export function topicsFor(state: HandState, heroId: string, heroCards: Card[], format: string): Topic[] {
  const t = new Set<Topic>();
  const legal = legalActions(state);
  if (!legal) return [];
  const hero = state.players.find((p) => p.id === heroId)!;
  const live = contenders(state, heroId);
  // stacks and all-ins are measured against everyone still in the hand (incl. players yet to act)
  const opps = state.players.filter((p) => !p.folded && p.id !== heroId);
  const bb = state.config.bigBlind;
  const eff = Math.min(hero.stack + hero.streetCommitted, Math.max(0, ...opps.map((p) => p.stack + p.streetCommitted))) / bb;
  const facingAllIn = legal.toCall > 0 && opps.some((p) => p.allIn);
  const board = state.board;
  const pot = totalPot(state);

  if (state.street === 'preflop') {
    if (facingAllIn || (legal.toCall > 0 && legal.callIsAllIn)) t.add('callingShove');
    if (state.currentBet <= bb && eff <= 15) t.add('initiatingShove');
  } else {
    const cat = categoryOf(evaluate([...heroCards, ...board]));
    const topBoard = Math.max(...board.map(rankOf));
    const pocketPair = rankOf(heroCards[0]!) === rankOf(heroCards[1]!);
    const topPair = heroCards.some((c) => rankOf(c) === topBoard) && cat === 'pair';
    const overpair = pocketPair && rankOf(heroCards[0]!) > topBoard;
    const strongAction = legal.toCall > 0 && (legal.toCall >= 0.5 * (pot - legal.toCall) || state.history.some((h) => h.street === state.street && h.type === 'raise'));
    if ((topPair || overpair) && strongAction) t.add('topPairVsAggression');
    if (state.street === 'turn') {
      const flop = board.slice(0, 3);
      const turn = board[3]!;
      const suitsOnFlop = flop.filter((c) => suitOf(c) === suitOf(turn)).length;
      const pairs = flop.some((c) => rankOf(c) === rankOf(turn));
      const over = rankOf(turn) > Math.max(...flop.map(rankOf));
      const conn = flop.filter((c) => Math.abs(rankOf(c) - rankOf(turn)) <= 2).length >= 2;
      if (suitsOnFlop === 2 || pairs || over || conn) t.add('turnChangesBoard');
    }
    if (state.street !== 'river' && (hasFlushDraw(heroCards, board) || hasStraightDraw(heroCards, board)) && (cat === 'highCard' || cat === 'pair')) t.add('drawsAndOuts');
    if (legal.toCall === 0 && (state.street === 'river' || state.street === 'turn')) {
      if (cat !== 'highCard') t.add('valueBetting');
      else t.add('bluffing');
    }
  }
  if (live.length > 2 || (format === 'PKO' && (facingAllIn || opps.some((p) => p.allIn)))) t.add('multiwayOrBounty');
  if (live.length > 2 && facingAllIn && heroCards.some((c) => c[0] === 'A')) t.add('blockingAces');
  return [...t];
}
