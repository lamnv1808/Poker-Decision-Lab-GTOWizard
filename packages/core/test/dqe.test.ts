import { describe, expect, it } from 'vitest';
import {
  CLASSES,
  RANGE_SCHEMA_VERSION,
  assertVerdictInvariants,
  canonicalKey,
  evaluateDecision,
  gradeGtoSpot,
  grid13,
  huPushFoldSource,
  rangeLibrarySource,
  rangeShare,
  recordChecksum,
  solvePushFold,
  validateRecord,
  type DqeDecision,
  type DqeVerdict,
  type EvidenceSource,
  type GtoSpot,
  type RangeRecord,
  type SituationKey,
} from '../src';

const dec = (over: Partial<DqeDecision> = {}): DqeDecision => ({
  scenarioId: 't',
  format: 'MTT',
  economics: 'chipEV',
  tableSize: 9,
  heroPos: 'SB',
  villainPositions: ['BB'],
  effStackBB: 10,
  deadBB: 1,
  street: 'preflop',
  board: null,
  node: 'unopened',
  history: ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN'].map((pos) => ({ pos, action: 'fold' as const, toBB: null })),
  legalActions: ['fold', 'call', 'raise', 'shove'],
  chosenAction: 'shove',
  heroClass: 'K7o',
  ...over,
});

function makeRecord(over: Partial<RangeRecord> & { key?: Partial<SituationKey> } = {}, fill: (c: string) => { f: number[]; ev: (number | null)[] } = () => ({ f: [0.5, 0.5], ev: [null, null] })): RangeRecord {
  const key: SituationKey = { format: 'MTT', economics: 'chipEV', tableSize: 6, activePlayers: 6, heroPos: 'CO', node: 'unopened', history: [{ pos: 'LJ', action: 'fold', toBB: null }, { pos: 'HJ', action: 'fold', toBB: null }], effStackBB: 20, sbBB: 0.5, bbBB: 1, deadBB: 1, opponentModel: null, rakePct: null, payout: null, bounty: null, ...(over.key ?? {}) };
  const hands = Object.fromEntries(CLASSES.map((c) => [c, fill(c)]));
  const r = {
    schema: RANGE_SCHEMA_VERSION,
    key,
    keyString: canonicalKey(key),
    actions: ['fold', 'shove'],
    hands,
    evidence: 'frequency',
    method: { generator: 'test', version: 't1', algorithm: 'n/a', iterations: null, exploitabilityBB: null, equitySource: 'n/a', approximation: null, runtimeMs: null },
    validation: { status: 'verified', checks: [] },
    source: { kind: 'licensed', id: 'test-chart', locator: null },
    licence: { id: 'test', redistributable: false },
    assumptions: [],
    ...over,
  } as Omit<RangeRecord, 'checksum'> as RangeRecord;
  r.key = key;
  r.keyString = canonicalKey(r.key);
  r.checksum = recordChecksum(r);
  return r;
}

describe('DQE: heads-up push/fold keeps the existing grading semantics exactly', () => {
  it('for every class, stack and ante level on the grid, and both roles, grade and EV loss equal the quiz/audit grader', () => {
    let n = 0;
    for (const S of [2, 5.5, 10, 15])
      for (const D of [0, 1, 1.5])
        for (const role of ['sbShove', 'bbCall'] as const)
          for (const cls of CLASSES) {
            const aggressive = role === 'sbShove' ? 'shove' : 'call';
            for (const chosen of ['fold', aggressive] as const) {
              const d =
                role === 'sbShove'
                  ? dec({ heroPos: 'SB', node: 'unopened', effStackBB: S, deadBB: D, heroClass: cls, chosenAction: chosen })
                  : dec({ heroPos: 'BB', node: 'facingShove', history: [{ pos: 'BTN', action: 'fold', toBB: null }, { pos: 'SB', action: 'shove', toBB: S }], effStackBB: S, deadBB: D, heroClass: cls, chosenAction: chosen });
              const v = evaluateDecision(d, [huPushFoldSource]);
              const ref = gradeGtoSpot({ seed: 0, role, stackBB: S, anteFormat: 'none', deadBB: D, heroCards: [] as unknown as GtoSpot['heroCards'], heroClass: cls } as GtoSpot, chosen, solvePushFold({ stackBB: S, deadBB: D }));
              expect(v.category).toBe('VERIFIED_SOLVER_EV');
              expect(v.matchStatus).toBe('exact');
              expect(v.grade).toBe(ref.grade);
              expect(v.evLossBB).toBeCloseTo(Math.round(ref.evLossBB * 1000) / 1000, 9);
              n++;
            }
          }
    expect(n).toBe(4 * 3 * 2 * 169 * 2);
  });

  it('off-grid stacks are rounded exactly like the audit and say so', () => {
    const v = evaluateDecision(dec({ effStackBB: 10.3, deadBB: 0.9 }), [huPushFoldSource]);
    expect(v.matchStatus).toBe('grid_rounded');
    expect(v.source!.referenceKey).toContain('S=10.5');
    expect(v.source!.referenceKey).toContain('D=1');
  });

  it('a stack above the solved grid is Unrated with the precise reason', () => {
    const v = evaluateDecision(dec({ effStackBB: 22 }), [huPushFoldSource]);
    expect(v.category).toBe('INSUFFICIENT_EVIDENCE');
    expect(v.missing!.reason).toBe('stack_off_grid');
    expect(v.grade).toBeNull();
    expect(v.evLossBB).toBeNull();
  });

  it('an action outside the push/fold model (limp) gets no grade and no EV loss', () => {
    const v = evaluateDecision(dec({ chosenAction: 'call' }), [huPushFoldSource]);
    expect(v.grade).toBeNull();
    expect(v.evLossBB).toBeNull();
    expect(v.missing!.reason).toBe('action_outside_model');
  });

  it('does not apply when someone already entered the pot', () => {
    const h = dec().history.slice();
    h[6] = { pos: 'BTN', action: 'raise', toBB: 2 };
    const v = evaluateDecision(dec({ history: h, node: 'facingOpen' }), [huPushFoldSource]);
    expect(v.category).toBe('INSUFFICIENT_EVIDENCE');
  });
});

describe('DQE: economic models are never mixed', () => {
  it('ICM spots get no chip-EV verdict', () => {
    const v = evaluateDecision(dec({ economics: 'ICM' }), [huPushFoldSource]);
    expect(v.category).toBe('INSUFFICIENT_EVIDENCE');
    expect(v.missing!.reason).toBe('economics_mismatch');
  });

  it('PKO: an aggressive chip-EV mistake is not graded (the bounty could overturn it)', () => {
    // (no 15 BB SB shove is a chip-EV mistake heads-up; BB calls with trash are) — pick by the real grade
    const sol = solvePushFold({ stackBB: 15, deadBB: 0 });
    const spot = (c: string) => ({ seed: 0, role: 'bbCall', stackBB: 15, anteFormat: 'none', deadBB: 0, heroCards: [] as unknown as GtoSpot['heroCards'], heroClass: c }) as GtoSpot;
    const cls = CLASSES.find((c) => ['mistake', 'major'].includes(gradeGtoSpot(spot(c), 'call', sol).grade));
    expect(cls).toBeDefined();
    const bb = dec({ economics: 'PKO', heroPos: 'BB', node: 'facingShove', history: [{ pos: 'BTN', action: 'fold', toBB: null }, { pos: 'SB', action: 'shove', toBB: 15 }], effStackBB: 15, deadBB: 0, heroClass: cls!, chosenAction: 'call' });
    expect(evaluateDecision({ ...bb, economics: 'chipEV' }, [huPushFoldSource]).grade).toMatch(/mistake|major/);
    const v = evaluateDecision(bb, [huPushFoldSource]);
    expect(v.category).toBe('INSUFFICIENT_EVIDENCE');
    expect(v.missing!.reason).toBe('bounty_could_overturn');
    expect(v.grade).toBeNull();
  });

  it('PKO: folding a chip-EV profitable shove stays a verified loss (bounty only adds EV to shoving)', () => {
    const v = evaluateDecision(dec({ economics: 'PKO', effStackBB: 10, deadBB: 1, heroClass: 'AA', chosenAction: 'fold' }), [huPushFoldSource]);
    expect(v.category).toBe('VERIFIED_SOLVER_EV');
    expect(['mistake', 'major']).toContain(v.grade);
  });
});

describe('DQE: trust boundaries', () => {
  it('a reference chart without EV never yields Mistake/Blunder or an EV loss, only in/mixed/outside', () => {
    const lib = rangeLibrarySource('chart', [makeRecord({}, (c) => (c === '72o' ? { f: [1, 0], ev: [null, null] } : c === 'AA' ? { f: [0, 1], ev: [null, null] } : { f: [0.4, 0.6], ev: [null, null] }))]);
    const d = (cls: string, a: string) => dec({ tableSize: 6, heroPos: 'CO', node: 'unopened', history: [{ pos: 'LJ', action: 'fold', toBB: null }, { pos: 'HJ', action: 'fold', toBB: null }], effStackBB: 20, deadBB: 1, heroClass: cls, chosenAction: a });
    const out = evaluateDecision(d('72o', 'shove'), [lib]);
    expect(out.category).toBe('VERIFIED_REFERENCE_FREQUENCY');
    expect(out.label).toBe('outsideRange');
    expect(out.grade).toBeNull();
    expect(out.evLossBB).toBeNull();
    expect(out.evByAction).toBeNull();
    expect(evaluateDecision(d('AA', 'shove'), [lib]).label).toBe('inRange');
    // a low-frequency action is "mixed", not a mistake
    expect(evaluateDecision(d('K9s', 'fold'), [lib]).label).toBe('mixed');
  });

  it('an approximate model record is a MODEL_ESTIMATE: model EV difference shown, never a grade', () => {
    const lib = rangeLibrarySource('nmax', [makeRecord({ evidence: 'approximateModel', validation: { status: 'approximate', checks: [] }, method: { generator: 't', version: 't', algorithm: 'fp', iterations: 10, exploitabilityBB: 0.01, equitySource: 'x', approximation: 'restricted game: no overcalls', runtimeMs: 1 } }, () => ({ f: [1, 0], ev: [0, -0.8] }))]);
    const v = evaluateDecision(dec({ tableSize: 6, heroPos: 'CO', node: 'unopened', history: [{ pos: 'LJ', action: 'fold', toBB: null }, { pos: 'HJ', action: 'fold', toBB: null }], effStackBB: 20, deadBB: 1, heroClass: 'Q2o', chosenAction: 'shove' }), [lib]);
    expect(v.category).toBe('MODEL_ESTIMATE');
    expect(v.grade).toBeNull();
    expect(v.evLossBB).toBeNull();
    expect(v.modelEvLossBB).toBeCloseTo(0.8, 9);
    expect(v.approximation).toMatch(/no overcalls/);
  });

  it('a verified solver-EV library record grades by EV loss, and a mixed action grades excellent', () => {
    const lib = rangeLibrarySource('solved', [makeRecord({ evidence: 'solverEV', validation: { status: 'verified', checks: [] } }, (c) => (c === 'AA' ? { f: [0, 1], ev: [0, 3] } : c === 'K9s' ? { f: [0.5, 0.5], ev: [0, 0.001] } : { f: [1, 0], ev: [0, -0.3] }))]);
    const d = (cls: string, a: string) => dec({ tableSize: 6, heroPos: 'CO', node: 'unopened', history: [{ pos: 'LJ', action: 'fold', toBB: null }, { pos: 'HJ', action: 'fold', toBB: null }], effStackBB: 20, deadBB: 1, heroClass: cls, chosenAction: a });
    const fAA = evaluateDecision(d('AA', 'fold'), [lib]);
    expect(fAA.category).toBe('VERIFIED_SOLVER_EV');
    expect(fAA.evLossBB).toBe(3);
    expect(fAA.grade).toBe('major');
    expect(evaluateDecision(d('K9s', 'fold'), [lib]).grade).toBe('excellent');
    expect(evaluateDecision(d('72o', 'shove'), [lib]).grade).toBe('acceptable'); // 0.3 BB loss
  });

  it('library matching is exact: a nearby stack is Unrated (no interpolation)', () => {
    const lib = rangeLibrarySource('chart', [makeRecord()]);
    const v = evaluateDecision(dec({ tableSize: 6, heroPos: 'CO', node: 'unopened', history: [{ pos: 'LJ', action: 'fold', toBB: null }, { pos: 'HJ', action: 'fold', toBB: null }], effStackBB: 19.5, deadBB: 1 }), [lib]);
    expect(v.category).toBe('INSUFFICIENT_EVIDENCE');
    expect(v.missing!.reason).toBe('stack_off_grid');
  });

  it('without evidence: math facts stay facts (no recommended action), otherwise Unrated with a reason', () => {
    const facing = evaluateDecision(dec({ node: 'facingOpen', heroPos: 'BTN', effStackBB: 40, requiredEquity: 0.31, potBB: 5.5, toCallBB: 2.5 }), [huPushFoldSource]);
    expect(facing.category).toBe('EXACT_MATHEMATICAL_RESULT');
    expect(facing.bestAction).toBeNull();
    expect(facing.facts.requiredEquity).toBe(0.31);
    const none = evaluateDecision(dec({ street: 'turn', node: 'postflop', heroPos: 'BTN' }), [huPushFoldSource]);
    expect(none.category).toBe('INSUFFICIENT_EVIDENCE');
    expect(none.missing!.reason).toBe('postflop_unsupported');
  });

  it('a heuristic is coaching, never solver evidence', () => {
    const v = evaluateDecision(dec({ street: 'flop', node: 'postflop', heuristic: { sourceId: 'scenario:x', locator: 'node d-flop', text: 'Bet small on dry boards.' } }), [huPushFoldSource]);
    expect(v.category).toBe('HEURISTIC_GUIDANCE');
    expect(v.grade).toBeNull();
    expect(v.source!.id).toBe('scenario:x');
  });

  it('the strongest evidence wins and weaker evidence is only noted', () => {
    const weak: EvidenceSource = { id: 'weak', version: '1', evaluate: () => ({ evidence: { category: 'MODEL_ESTIMATE', sourceId: 'weak', sourceVersion: '1', checksum: null, matchStatus: 'exact', referenceKey: 'k', economics: 'chipEV', frequencies: null, evByAction: null, assumptions: [], approximation: 'toy', facts: {} } }) };
    const v = evaluateDecision(dec(), [weak, huPushFoldSource]);
    expect(v.category).toBe('VERIFIED_SOLVER_EV');
    expect(v.notes.join(' ')).toMatch(/MODEL_ESTIMATE from weak/);
  });

  it('invariants reject an EV loss or a grade without verified solver EV', () => {
    const v = evaluateDecision(dec({ street: 'river', node: 'postflop' }), []);
    expect(() => assertVerdictInvariants({ ...v, evLossBB: 1 } as DqeVerdict)).toThrow(/EV loss/);
    expect(() => assertVerdictInvariants({ ...v, grade: 'mistake', label: 'mistake' } as DqeVerdict)).toThrow(/grade/);
    expect(() => assertVerdictInvariants({ ...v, category: 'MODEL_ESTIMATE', label: 'modelEstimate', approximation: null, missing: null } as DqeVerdict)).toThrow(/approximation/);
  });

  it('is deterministic: identical input gives an identical verdict', () => {
    const a = JSON.stringify(evaluateDecision(dec({ heroClass: 'A5s', effStackBB: 12.2, deadBB: 0.6 }), [huPushFoldSource]));
    const b = JSON.stringify(evaluateDecision(dec({ heroClass: 'A5s', effStackBB: 12.2, deadBB: 0.6 }), [huPushFoldSource]));
    expect(a).toBe(b);
  });
});

describe('range schema validation', () => {
  it('accepts a complete record and rejects every integrity violation', () => {
    const ok = makeRecord();
    expect(validateRecord(ok)).toEqual([]);
    const missing = makeRecord();
    delete missing.hands['AA'];
    missing.checksum = recordChecksum(missing);
    expect(validateRecord(missing).join()).toMatch(/1 of 169 classes missing/);
    const badSum = makeRecord({}, () => ({ f: [0.5, 0.6], ev: [null, null] }));
    expect(validateRecord(badSum).join()).toMatch(/sum to/);
    const freqWithEv = makeRecord({}, () => ({ f: [1, 0], ev: [0, 1] }));
    expect(validateRecord(freqWithEv).join()).toMatch(/frequency-only record carries EV/);
    const tampered = makeRecord();
    tampered.hands['AA']!.f = [0, 1];
    expect(validateRecord(tampered).join()).toMatch(/checksum/);
    const approxNoNote = makeRecord({ evidence: 'approximateModel' });
    expect(validateRecord(approxNoNote).join()).toMatch(/approximation/);
  });

  it('weights combos correctly (pairs 6, suited 4, offsuit 12 of 1326) and builds a 13×13 grid', () => {
    const all = makeRecord({}, () => ({ f: [0, 1], ev: [null, null] }));
    expect(rangeShare(all, 'shove')).toBeCloseTo(1, 12);
    const pairs = makeRecord({}, (c) => (c.length === 2 ? { f: [0, 1], ev: [null, null] } : { f: [1, 0], ev: [null, null] }));
    expect(rangeShare(pairs, 'shove')).toBeCloseTo(78 / 1326, 12);
    const g = grid13(pairs, 'shove');
    expect(g[0]![0]).toBe(1); // AA
    expect(g[0]![1]).toBe(0); // AKs
    expect(g[12]![12]).toBe(1); // 22
  });
});
