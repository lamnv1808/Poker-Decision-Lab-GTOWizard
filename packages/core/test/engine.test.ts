import { describe, expect, it } from 'vitest';
import {
  applyAction,
  chipsInPlay,
  computePots,
  createHand,
  dealNextStreet,
  IllegalActionError,
  legalActions,
  playerById,
  totalPot,
  type HandState,
  type TableConfig,
  sizePresets,
  potFractionTarget,
} from '../src/engine';
import { parseCards } from '../src/cards';

function table(stacks: number[], extra: Partial<TableConfig> = {}): TableConfig {
  return {
    smallBlind: 500,
    bigBlind: 1000,
    ante: 0,
    anteMode: 'none',
    players: stacks.map((s, i) => ({ id: `p${i}`, stack: s })),
    ...extra,
  };
}
const act = (s: HandState, type: 'fold' | 'check' | 'call' | 'bet' | 'raise', amount?: number) => applyAction(s, { type, amount });
const toActId = (s: HandState) => s.players[s.toAct]?.id;

describe('blinds and antes', () => {
  it('posts blinds and each-player antes; UTG acts first 6-max', () => {
    const s = createHand(table([50000, 50000, 50000, 50000, 50000, 50000], { ante: 125, anteMode: 'each' }));
    expect(s.deadAntes).toBe(750);
    expect(totalPot(s)).toBe(750 + 1500);
    expect(toActId(s)).toBe('p2');
    expect(chipsInPlay(s)).toBe(300000);
  });
  it('posts a big-blind ante', () => {
    const s = createHand(table([50000, 50000, 50000], { ante: 1000, anteMode: 'bigBlind' }));
    expect(playerById(s, 'p1').stack).toBe(48000);
    expect(totalPot(s)).toBe(2500);
  });
  it('heads-up: button/SB acts first preflop, BB first postflop', () => {
    let s = createHand(table([20000, 20000]));
    expect(toActId(s)).toBe('p0');
    s = act(s, 'call');
    expect(toActId(s)).toBe('p1'); // BB option
    const l = legalActions(s)!;
    expect(l.canCheck).toBe(true);
    expect(l.canFold).toBe(false);
    s = act(s, 'check');
    expect(s.awaitingBoard).toBe(true);
    s = dealNextStreet(s, parseCards('2c7d9h'));
    expect(toActId(s)).toBe('p1');
  });
  it('short stack posting blind goes all-in', () => {
    const s = createHand(table([300, 700, 5000]));
    expect(playerById(s, 'p0').allIn).toBe(true);
    expect(playerById(s, 'p1').allIn).toBe(true);
    expect(s.currentBet).toBe(1000);
  });
});

describe('legal actions and min-raise', () => {
  it('open raise min is 2BB, BB facing raise can re-raise by the increment', () => {
    let s = createHand(table([100000, 100000, 100000, 100000, 100000, 100000]));
    let l = legalActions(s)!;
    expect(l.minRaiseTo).toBe(2000);
    expect(l.maxRaiseTo).toBe(100000);
    expect(() => act(s, 'raise', 1500)).toThrow(IllegalActionError);
    expect(() => act(s, 'check')).toThrow(IllegalActionError);
    s = act(s, 'raise', 2500); // increment 1500
    l = legalActions(s)!;
    expect(l.minRaiseTo).toBe(4000);
    expect(l.toCall).toBe(2500);
  });
  it('postflop bet min is 1BB and raise min doubles the increment', () => {
    let s = createHand(table([50000, 50000]));
    s = act(s, 'call');
    s = act(s, 'check');
    s = dealNextStreet(s, parseCards('2c7d9h'));
    expect(legalActions(s)!.minRaiseTo).toBe(1000);
    s = act(s, 'bet', 1500);
    expect(legalActions(s)!.minRaiseTo).toBe(3000);
    expect(() => act(s, 'bet', 2000)).toThrow(IllegalActionError);
  });
  it('a short all-in raise does not reopen action for players who already acted', () => {
    // p2 (UTG) opens to 3000, p3 calls, p4 shoves 4000 total (increment 1000 < 2000 full raise)
    let s = createHand(table([50000, 50000, 50000, 50000, 4000]));
    s = act(s, 'raise', 3000);
    s = act(s, 'call');
    s = act(s, 'raise', 4000); // all-in short
    expect(playerById(s, 'p4').allIn).toBe(true);
    s = act(s, 'fold'); // SB
    s = act(s, 'fold'); // BB
    expect(toActId(s)).toBe('p2');
    const l = legalActions(s)!;
    expect(l.canRaise).toBe(false);
    expect(l.toCall).toBe(1000);
  });
  it('cumulative short raises that total a full raise reopen action', () => {
    // UTG opens 2000 (increment 1000); two short all-ins (+600, +600) total +1200 >= 1000
    let s = createHand(table([50000, 50000, 50000, 2600, 3200]));
    s = act(s, 'raise', 2000);
    s = act(s, 'raise', 2600);
    s = act(s, 'raise', 3200);
    s = act(s, 'fold'); // SB
    s = act(s, 'call'); // BB stays in with chips behind
    expect(toActId(s)).toBe('p2');
    expect(legalActions(s)!.canRaise).toBe(true);
  });
  it('a single short raise below a full raise leaves the opener call/fold only', () => {
    let s = createHand(table([50000, 50000, 50000, 2600, 50000]));
    s = act(s, 'raise', 2000);
    s = act(s, 'raise', 2600);
    s = act(s, 'call');
    s = act(s, 'fold');
    s = act(s, 'call');
    expect(toActId(s)).toBe('p2');
    expect(legalActions(s)!.canRaise).toBe(false);
  });
  it('a player facing an all-in larger than their stack can only call all-in or fold', () => {
    let s = createHand(table([5000, 5000, 20000]));
    s = act(s, 'raise', 20000);
    const l = legalActions(s)!;
    expect(l.canRaise).toBe(false);
    expect(l.callIsAllIn).toBe(true);
    expect(l.callAmount).toBe(4500);
  });
  it('cannot bet when every opponent is already all-in', () => {
    let s = createHand(table([3000, 50000, 50000]));
    s = act(s, 'fold'); // BTN p2
    s = act(s, 'raise', 3000); // SB all-in
    const l = legalActions(s)!;
    expect(l.canRaise).toBe(false);
    expect(l.callAmount).toBe(2000);
  });
});

describe('round closure, uncalled bets and folds', () => {
  it('returns an uncalled bet and awards the pot', () => {
    let s = createHand(table([50000, 50000, 50000], { ante: 100, anteMode: 'each' }));
    s = act(s, 'raise', 2500); // BTN
    s = act(s, 'fold'); // SB
    s = act(s, 'fold'); // BB
    expect(s.complete).toBe(true);
    expect(s.result!.awards.p2).toBe(300 + 500 + 1000 + 1000); // antes + blinds + own 1000 matched by BB's 1000? see below
    // BTN gets back 1500 uncalled (2500 - 1000 BB) and wins antes 300 + SB 500 + BB 1000 + own 1000
    expect(playerById(s, 'p2').stack).toBe(50000 - 100 + 300 + 500 + 1000);
    expect(chipsInPlay(s)).toBe(150000);
  });
  it('closes the round when the BB checks the option', () => {
    let s = createHand(table([50000, 50000, 50000]));
    s = act(s, 'call');
    s = act(s, 'call');
    expect(s.awaitingBoard).toBe(false);
    s = act(s, 'check');
    expect(s.awaitingBoard).toBe(true);
    expect(totalPot(s)).toBe(3000);
  });
  it('checks around to the river then showdown', () => {
    const cfg = table([10000, 10000]);
    cfg.players[0]!.cards = parseCards('AsAh');
    cfg.players[1]!.cards = parseCards('KsKh');
    let s = createHand(cfg);
    s = act(s, 'call');
    s = act(s, 'check');
    s = dealNextStreet(s, parseCards('2c7d9h'));
    s = act(s, 'check');
    s = act(s, 'check');
    s = dealNextStreet(s, parseCards('Tc'));
    s = act(s, 'check');
    s = act(s, 'check');
    s = dealNextStreet(s, parseCards('3d'));
    s = act(s, 'check');
    s = act(s, 'check');
    expect(s.complete).toBe(true);
    expect(s.result!.showdown).toBe(true);
    expect(playerById(s, 'p0').stack).toBe(11000);
    expect(() => dealNextStreet(s, parseCards('4d'))).toThrow();
  });
  it('rejects duplicate board cards', () => {
    const cfg = table([10000, 10000]);
    cfg.players[0]!.cards = parseCards('AsAh');
    let s = createHand(cfg);
    s = act(s, 'call');
    s = act(s, 'check');
    expect(() => dealNextStreet(s, parseCards('As7d9h'))).toThrow();
    expect(() => dealNextStreet(s, parseCards('7d9h'))).toThrow();
  });
});

describe('side pots and all-ins', () => {
  it('builds main and side pots with three stack sizes and awards correctly', () => {
    const cfg = table([5000, 15000, 30000]);
    cfg.players[0]!.cards = parseCards('AsAh'); // shortest, best
    cfg.players[1]!.cards = parseCards('KsKh'); // middle, second
    cfg.players[2]!.cards = parseCards('QsQh'); // biggest, worst
    let s = createHand(cfg);
    s = act(s, 'raise', 30000); // BTN p2 all-in
    s = act(s, 'call'); // SB p0 all-in 5000
    s = act(s, 'call'); // BB p1 all-in 15000
    // p2 had 15000 uncalled returned
    expect(playerById(s, 'p2').stack).toBe(15000);
    const pots = computePots(s);
    expect(pots).toEqual([
      { amount: 15000, eligible: ['p0', 'p1', 'p2'] },
      { amount: 20000, eligible: ['p1', 'p2'] },
    ]);
    expect(s.awaitingBoard).toBe(true);
    s = dealNextStreet(s, parseCards('2c7d9h'));
    expect(s.awaitingBoard).toBe(true); // runout, no betting
    s = dealNextStreet(s, parseCards('3c'));
    s = dealNextStreet(s, parseCards('4d'));
    expect(s.complete).toBe(true);
    expect(s.result!.awards).toEqual({ p0: 15000, p1: 20000 });
    expect(playerById(s, 'p2').stack).toBe(15000);
    expect(chipsInPlay(s)).toBe(50000);
  });
  it('folded players contribute dead money but are not eligible', () => {
    const cfg = table([20000, 3000, 20000, 20000]);
    let s = createHand(cfg);
    s = act(s, 'raise', 3000); // CO p2
    s = act(s, 'call'); // BTN p3
    s = act(s, 'fold'); // SB p0 folds 500
    s = act(s, 'call'); // BB p1 all-in 3000
    const pots = computePots(s);
    expect(pots[0]).toEqual({ amount: 9500, eligible: ['p1', 'p2', 'p3'] });
    expect(pots).toHaveLength(1);
  });
  it('splits a pot with odd chips deterministically', () => {
    const cfg = table([10001, 10001, 10001], { smallBlind: 1, bigBlind: 2 });
    cfg.players[0]!.cards = parseCards('2c3d');
    cfg.players[1]!.cards = parseCards('2d3c');
    cfg.players[2]!.cards = parseCards('4c5d');
    let s = createHand(cfg);
    s = act(s, 'fold');
    s = act(s, 'raise', 5);
    s = act(s, 'call');
    s = dealNextStreet(s, parseCards('AsKsQsJsTs'.slice(0, 6)));
    s = act(s, 'check');
    s = act(s, 'check');
    s = dealNextStreet(s, parseCards('Js'));
    s = act(s, 'check');
    s = act(s, 'check');
    s = dealNextStreet(s, parseCards('Ts'));
    s = act(s, 'check');
    s = act(s, 'check');
    // board plays (royal flush) — split 10 between p0 and p1
    expect(s.result!.awards).toEqual({ p0: 5, p1: 5 });
  });
});

describe('sizing helpers', () => {
  it('offers legal preflop BB presets and all-in', () => {
    const s = createHand(table([35000, 42000, 30000, 30000, 30000, 30000], { ante: 125, anteMode: 'each' }));
    const l = legalActions(s)!;
    const p = sizePresets(l, 'preflop', s.currentBet, 1000);
    expect(p.map((x) => x.key)).toEqual(['2bb', '2.2bb', '2.5bb', '3bb', 'allin']);
  });
  it('computes pot-fraction targets for bets and raises', () => {
    let s = createHand(table([50000, 50000]));
    s = act(s, 'call');
    s = act(s, 'check');
    s = dealNextStreet(s, parseCards('2c7d9h'));
    let l = legalActions(s)!;
    expect(potFractionTarget(l, 0, 0.5)).toBe(1000);
    expect(potFractionTarget(l, 0, 0.33)).toBe(1000); // clamped to 1BB minimum
    s = act(s, 'bet', 2000);
    l = legalActions(s)!;
    // pot = 2000 + 2000 = 4000; toCall 2000 -> pot raise to 2000 + (4000+2000) = 8000
    expect(potFractionTarget(l, 2000, 1)).toBe(8000);
  });
});
