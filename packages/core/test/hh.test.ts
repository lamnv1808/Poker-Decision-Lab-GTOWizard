import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectFormat, ggParser, parseHandHistoryText, reconstructHand, reviewSpots } from '../src/hh';

const text = readFileSync(new URL('./fixtures/gg-sample.txt', import.meta.url), 'utf8');

describe('GG hand-history parser', () => {
  it('detects the format and splits hands', () => {
    expect(detectFormat(text)?.format).toBe('GGPoker');
    expect(ggParser.split(text)).toHaveLength(3);
    expect(detectFormat('PokerStars Hand #1: Tournament')).toBeNull();
  });
  it('parses header, seats, posts and actions', () => {
    const h = ggParser.parse(ggParser.split(text)[0]!);
    expect(h.handId).toBe('TM5000000001');
    expect(h.tournamentId).toBe('210000001');
    expect([h.smallBlind, h.bigBlind, h.ante]).toEqual([1000, 2000, 250]);
    expect(h.heroName).toBe('Hero');
    expect(h.heroCards).toEqual(['Ah', 'Kd']);
    expect(h.seats).toHaveLength(6);
    expect(h.board).toEqual(['7s', '2c', '9d', 'Kh', '3s']);
    expect(h.actions.filter((a) => a.allIn)).toHaveLength(1);
    expect(h.totalPot).toBe(82000);
    expect(h.warnings).toEqual([]);
  });
  it('reconstructs a full hand on the engine and matches the pot', () => {
    const r = reconstructHand(ggParser.parse(ggParser.split(text)[0]!));
    expect(r.heroPosition).toBe('BB');
    expect(r.positions.villain4).toBe('HJ');
    expect(r.potComputed).toBe(82000);
    expect(r.final.complete).toBe(true);
    expect(r.final.result!.awards.Hero).toBe(82000);
    expect(r.allInSeen).toBe(true);
  });
  it('handles uncalled bets', () => {
    const r = reconstructHand(ggParser.parse(ggParser.split(text)[1]!));
    expect(r.potComputed).toBe(6500);
    expect(r.final.result!.awards.villain1).toBe(6500);
    expect(r.heroPosition).toBe('SB');
  });
  it('reports malformed hands instead of dropping them', () => {
    const res = parseHandHistoryText(text);
    expect(res.hands).toHaveLength(2);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.handId).toBe('TM5000000003');
    expect(res.errors[0]!.message).toMatch(/expected villain5 to act, history says villain6/);
  });
  it('rejects an out-of-order action', () => {
    const bad = ggParser.split(text)[1]!.replace('villain4: folds\nvillain5: folds', 'villain5: folds\nvillain4: folds');
    expect(() => reconstructHand(ggParser.parse(bad))).toThrow(/expected villain4 to act/);
  });
  it('rejects a wrong call amount', () => {
    const bad = ggParser.split(text)[0]!.replace('Hero: calls 2,400', 'Hero: calls 2,000');
    expect(() => reconstructHand(ggParser.parse(bad))).toThrow(/call amount/);
  });
  it('produces exact review facts at Hero decisions', () => {
    const r = reconstructHand(ggParser.parse(ggParser.split(text)[0]!));
    const spots = reviewSpots(r);
    const turnRaise = spots.find((s) => s.street === 'turn' && s.heroAction.type === 'raise')!;
    // pot before = antes 1500 + SB 1000 + 8800 + 6000 + 8000 bet = 25,300; required = 8000/33,300
    expect(turnRaise.facts.potBB).toBeCloseTo(12.65, 6);
    expect(turnRaise.facts.requiredEquityPct).toBeCloseTo(24, 1);
    expect(spots.map((s) => s.heroAction.type)).toEqual(['call', 'check', 'call', 'check', 'raise']);
  });
});
