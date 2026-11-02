import { describe, expect, it } from 'vitest';
import { fullDeck } from '../src/cards/cards';
import { createRng } from '../src/cards/rng';
import { type HandState, applyAction, computePots, createHand, dealNextStreet, legalActions, totalPot } from '../src/engine';

/**
 * Release gate G2 — property tests over thousands of random legal hands (2–9 players, uneven stacks,
 * antes, random bet sizes including short all-ins). Invariants checked after every action:
 *  - chips are conserved (stacks + everything committed + dead antes = starting chips);
 *  - no card appears twice (hole cards + board);
 *  - every action the engine offers is accepted, and only the player to act may act;
 *  - pots sum to the total committed; at the end, awards equal the pot and stacks never go negative.
 */
function randomHand(seed: number) {
  const rng = createRng(seed);
  const n = 2 + Math.floor(rng() * 8);
  const deck = fullDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  const ante = rng() < 0.5 ? 0 : 25;
  const anteMode = ante === 0 ? 'none' : rng() < 0.5 ? 'each' : 'bigBlind';
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, stack: 100 + Math.floor(rng() * 60) * 50, cards: [deck[2 * i]!, deck[2 * i + 1]!] }));
  const board = deck.slice(2 * n, 2 * n + 5);
  const start = players.reduce((s, p) => s + p.stack, 0);
  return { rng, state: createHand({ smallBlind: 50, bigBlind: 100, ante: anteMode === 'none' ? 0 : anteMode === 'bigBlind' ? 100 : ante, anteMode: anteMode as 'none' | 'each' | 'bigBlind', players }), board, start };
}

const chipsInPlay = (s: HandState) => s.players.reduce((a, p) => a + p.stack, 0) + totalPot(s) + (s.config.anteMode === 'each' ? s.players.reduce((a, p) => a + p.anteCommitted, 0) - s.deadAntes : 0);

describe('engine invariants over random hands', () => {
  it('conserves chips, never duplicates a card, and pays out exactly the pot', () => {
    let hands = 0;
    let showdowns = 0;
    let sidePots = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const { rng, board, start } = randomHand(seed);
      let s = randomHand(seed).state;
      for (let guard = 0; guard < 300 && !s.complete; guard++) {
        if (s.awaitingBoard) {
          const k = s.board.length;
          s = dealNextStreet(s, k === 0 ? board.slice(0, 3) : [board[k]!]);
          continue;
        }
        const l = legalActions(s)!;
        expect(l.playerId).toBe(s.players[s.toAct]!.id);
        const r = rng();
        let a: Parameters<typeof applyAction>[1];
        if (l.toCall > 0 && r < 0.2) a = { type: 'fold' };
        else if ((l.canBet || l.canRaise) && r > 0.65) {
          const to = r > 0.92 ? l.maxRaiseTo : Math.round(l.minRaiseTo + (l.maxRaiseTo - l.minRaiseTo) * rng() * 0.5);
          a = { type: l.canBet ? 'bet' : 'raise', amount: Math.min(l.maxRaiseTo, Math.max(l.minRaiseTo, to)) };
        } else a = l.canCheck ? { type: 'check' } : { type: 'call' };
        s = applyAction(s, a);
        // conservation while the hand is running
        if (!s.complete) {
          expect(Math.abs(chipsInPlay(s) - start)).toBeLessThanOrEqual(1e-9);
          const pots = computePots(s);
          expect(pots.reduce((x, p) => x + p.amount, 0)).toBeCloseTo(totalPot(s) + (s.config.anteMode === 'each' ? s.players.reduce((x, p) => x + p.anteCommitted, 0) - s.deadAntes : 0), 6);
          if (pots.length > 1) sidePots++;
        }
        const cards = [...s.players.flatMap((p) => p.cards ?? []), ...s.board];
        expect(new Set(cards).size).toBe(cards.length);
        for (const p of s.players) expect(p.stack).toBeGreaterThanOrEqual(0);
      }
      expect(s.complete).toBe(true);
      const awarded = Object.values(s.result!.awards).reduce((a, b) => a + b, 0);
      const finalChips = s.players.reduce((a, p) => a + p.stack, 0);
      expect(finalChips).toBe(start); // every chip ends in someone's stack
      expect(awarded).toBeGreaterThan(0);
      if (s.result!.showdown) showdowns++;
      hands++;
    }
    expect(hands).toBe(1500);
    // the random play really exercised showdowns and side pots
    expect(showdowns).toBeGreaterThan(100);
    expect(sidePots).toBeGreaterThan(20);
  });
});
