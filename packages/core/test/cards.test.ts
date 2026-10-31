import { describe, expect, it } from 'vitest';
import {
  categoryOf,
  classCombos,
  comboCount,
  evaluate,
  equityVsRange,
  parseCards,
  parseRange,
  removeBlocked,
  handVsHand,
  ALL_CLASSES,
  rangeToClassWeights,
} from '../src/cards';

const ev = (s: string) => evaluate(parseCards(s));

describe('hand evaluator', () => {
  it('identifies categories', () => {
    expect(categoryOf(ev('AsKsQsJsTs'))).toBe('straightFlush');
    expect(categoryOf(ev('9c9d9h9s2c'))).toBe('quads');
    expect(categoryOf(ev('9c9d9h2s2c'))).toBe('fullHouse');
    expect(categoryOf(ev('Ah9h7h4h2h'))).toBe('flush');
    expect(categoryOf(ev('5c4d3h2sAc'))).toBe('straight');
    expect(categoryOf(ev('7c7d7h2sAc'))).toBe('trips');
    expect(categoryOf(ev('7c7d2h2sAc'))).toBe('twoPair');
    expect(categoryOf(ev('7c7d3h2sAc'))).toBe('pair');
    expect(categoryOf(ev('Kc7d3h2sAc'))).toBe('highCard');
  });
  it('orders hands correctly', () => {
    expect(ev('5c4d3h2sAc')).toBeLessThan(ev('6c5d4h3s2c')); // wheel is lowest straight
    expect(ev('AcAd5h4s3c')).toBeGreaterThan(ev('KcKdQhJsTd'));
    expect(ev('AcAdKhKs2c')).toBeGreaterThan(ev('AcAdQhQsKc'));
    expect(ev('AhKh9h4h2h')).toBeGreaterThan(ev('AhQhJh4h2h'));
  });
  it('picks the best 5 of 7', () => {
    expect(categoryOf(ev('AsKsQsJsTs9s8s'))).toBe('straightFlush');
    expect(ev('AsAdKcKd2c2d9h')).toBe(ev('AsAdKcKd9h3c4c'));
    // 7-card full house with two trips
    expect(categoryOf(ev('9c9d9hTcTdTh2s'))).toBe('fullHouse');
    expect(ev('9c9d9hTcTdTh2s')).toBeGreaterThan(ev('TcTdTh9c9d2h3s'.replace('2h3s', '2h3s')) - 1);
  });
  it('detects steel wheel flush', () => {
    expect(categoryOf(ev('Ah2h3h4h5hKd'))).toBe('straightFlush');
  });
  it('splits identical board plays', () => {
    expect(ev('2c3dAsKsQsJsTs')).toBe(ev('4c5dAsKsQsJsTs'));
  });
});

describe('ranges', () => {
  it('expands classes', () => {
    expect(classCombos('AA')).toHaveLength(6);
    expect(classCombos('AKs')).toHaveLength(4);
    expect(classCombos('AKo')).toHaveLength(12);
    expect(classCombos('AK')).toHaveLength(16);
    expect(ALL_CLASSES).toHaveLength(169);
  });
  it('parses notation', () => {
    expect(comboCount(parseRange('22+'))).toBe(78);
    expect(comboCount(parseRange('A2s+'))).toBe(48);
    expect(comboCount(parseRange('KTo+'))).toBe(36);
    expect(comboCount(parseRange('QQ-99'))).toBe(24);
    expect(comboCount(parseRange('K9s-K6s'))).toBe(16);
    expect(comboCount(parseRange('AKs:0.5'))).toBe(2);
    expect(comboCount(parseRange('AsKd'))).toBe(1);
    expect(comboCount(parseRange('22+,A2+,K2+,Q2+,J2+,T2+,92+,82+,72+,62+,52+,42+,32'))).toBe(1326);
  });
  it('rejects bad notation', () => {
    expect(() => parseRange('KAs')).toThrow();
    expect(() => parseRange('AKx')).toThrow();
    expect(() => parseRange('AA:2')).toThrow();
  });
  it('applies card removal', () => {
    const r = removeBlocked(parseRange('AA,AK'), parseCards('As'));
    expect(comboCount(r)).toBe(3 + 12);
  });
  it('collapses to class weights', () => {
    const w = rangeToClassWeights(removeBlocked(parseRange('AKs'), parseCards('As')));
    expect(w.get('AKs')).toBeCloseTo(0.75);
  });
});

describe('equity', () => {
  it('river equity is exact', () => {
    const r = equityVsRange(parseCards('AhKh'), parseRange('QQ,AsQs'), parseCards('Ad7c2s9dKc'));
    expect(r.method).toBe('exact');
    // QQ: 6 combos, all lose to AK two pair? AK makes two pair A K; QQ one pair -> hero wins. AsQs: pair of aces -> hero wins (two pair)
    expect(r.equity).toBe(1);
  });
  it('turn enumeration counts outs exactly', () => {
    // Hero flush draw vs set; 9 flush outs minus 1 that pairs board? board Kd 7d 2c 5s; villain 77 (no diamond 7 -> 7c7h)
    const r = equityVsRange(parseCards('AdQd'), parseRange('7c7h'), parseCards('Kd7d2c5s'));
    // rivers: 44 cards. Hero wins with any diamond except board-pairing ones: diamonds left 9 (Ad,Qd,Kd,7d used -> 13-4=9), pairing the board gives villain FH: 2d,5d -> 7 winners
    expect(r.win).toBeCloseTo(7 / 44, 10);
  });
  it('preflop Monte Carlo is deterministic and close to known value', () => {
    const a = handVsHand(parseCards('AsAh'), parseCards('KsKh'), [], { samples: 40000, seed: 1 });
    const b = handVsHand(parseCards('AsAh'), parseCards('KsKh'), [], { samples: 40000, seed: 1 });
    expect(a.equity).toBe(b.equity);
    expect(a.method).toBe('monteCarlo');
    expect(Math.abs(a.equity - 0.8236)).toBeLessThan(4 * a.stdErr + 0.002);
  });
});
