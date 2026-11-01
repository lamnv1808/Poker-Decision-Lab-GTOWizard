import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type V2Decision, type V2Quiz, auditDecision, auditHand, auditQuiz, computePots, legalActions, snapshotForHeroAction, tournamentFormat } from '../src';

/** Real (anonymised) GG/Natural8 hands: player names, hand/tournament IDs and dates replaced; cards, stacks and actions exact. */
const fx = Object.fromEntries(
  readFileSync(new URL('./fixtures/real-anon.txt', import.meta.url), 'utf8')
    .split(/^# fixture: /m)
    .filter(Boolean)
    .map((chunk) => {
      const [tag, ...rest] = chunk.split('\n');
      return [tag!.trim(), rest.join('\n').trim()];
    }),
) as Record<string, string>;

const audit = (tag: string) => {
  const a = auditHand(fx[tag]!);
  expect(a.issues, JSON.stringify(a.issues)).toEqual([]);
  return a;
};

describe('real-hand audit fixtures', () => {
  it('every fixture reconstructs, reconciles pots and collected amounts', () => {
    for (const tag of Object.keys(fx)) expect(auditHand(fx[tag]!).ok, tag).toBe(true);
    expect(Object.keys(fx)).toHaveLength(8);
  });

  it('multiway side pots: Hero is eligible for the main pot but not every side pot', () => {
    const a = audit('sidePotsMultiway');
    const pots = a.rec!.final.result!.pots;
    expect(pots.length).toBeGreaterThanOrEqual(3);
    expect(pots[0]!.eligible).toContain('Hero');
    expect(pots.some((p) => !p.eligible.includes('Hero'))).toBe(true);
    const total = pots.reduce((s, p) => s + p.amount, 0);
    expect(total).toBe(a.rec!.potComputed);
  });

  it('a short all-in raise does not reopen raising for a player who already acted', () => {
    const a = audit('shortAllInNoReopen');
    const spot = a.rec!.statesBefore.find((s) => {
      const p = s.players[s.toAct];
      const l = legalActions(s);
      return p && l && p.hasActed && !l.canRaise && p.stack > l.toCall;
    });
    expect(spot).toBeDefined();
    const l = legalActions(spot!)!;
    expect(l.canRaise).toBe(false);
    expect(l.toCall).toBeGreaterThan(0);
  });

  it('uncalled bet returns match the history exactly', () => {
    const a = audit('uncalledReturn');
    const engine = a.rec!.final.history.filter((h) => h.type === 'returnUncalled').map((h) => h.amount);
    expect(engine).toEqual(a.rec!.parsed.uncalled.map((u) => u.amount));
  });

  it('short big blind + all-in caller: Hero must call the full big blind (V2 snapshot quarantined)', () => {
    const a = audit('shortBigBlindCall');
    const snap = snapshotForHeroAction(a.rec!, 1)!;
    expect(snap.callAmountBB).toBe(1);
    const v2 = { id: 'TM9000000008-1', family_id: 'TM9000000008', street: 'preflop', tags: [], solver_verified: false, grading_status: 'unreviewed', question: { hero_cards: a.rec!.parsed.heroCards!, board: [], button_seat: 3, pot_at_decision_bb: snap.potBB, call_bb: 13173 / 16000, players: [], history: [] }, review_only: { actual_action: 'raises', actual_increment_bb: 0, is_all_in: true }, answer: null } as V2Decision;
    const r = auditDecision(v2, a.rec!);
    expect(r.issues.map((i) => i.code)).toEqual(['call_mismatch']);
  });

  it('pot odds when Hero is all-in for less: only the winnable pot counts (34.8%, not 19.3%)', () => {
    const a = audit('potOddsAllInForLess');
    const snap = snapshotForHeroAction(a.rec!, 2)!;
    // Hero 54,524 behind the ante faces a 152,252 shove after raising to 12,000:
    // call 42,524; winnable = 54,524 × 2 + BB 6,000 + antes 7,200 = 122,248
    const q = { id: 'x', family_id: 'x', question: {} as V2Quiz['question'], answer: { required_equity: 0.19332, formula: '', scope: '' } } as V2Quiz;
    const r = auditQuiz(q, snap);
    expect(r.requiredEquity!).toBeCloseTo(42524 / 122248, 6);
    expect(r.terminal).toBe(true);
    expect(r.issues.map((i) => i.code)).toEqual(['winnable_pot_differs']);
    expect(computePots(snap.state).length).toBeGreaterThan(0);
  });

  it('Hero voluntarily showing one card is valid', () => {
    audit('heroShowsOneCard');
  });

  it('duplicated "shows" lines are merged per player', () => {
    const a = audit('duplicateShowLines');
    const players = a.rec!.parsed.shown.map((s) => s.player);
    expect(new Set(players).size).toBe(players.length);
  });

  it('a fold recorded for an all-in player is treated as a forfeit and noted', () => {
    const a = audit('allInForfeitFold');
    expect(a.notes.join()).toMatch(/fold by an all-in player/);
  });

  it('classifies tournament formats from the title', () => {
    expect(tournamentFormat('Bounty Hunters Special $10.80')).toBe('PKO');
    expect(tournamentFormat('Midnight Madness III $8.88 [Hyper]')).toBe('Hyper');
    expect(tournamentFormat('Daily Freeroll to $100K Weekly')).toBe('Freeroll');
    expect(tournamentFormat('Daily Main')).toBe('MTT');
  });
});
