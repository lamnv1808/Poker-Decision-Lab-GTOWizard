import { describe, expect, it } from 'vitest';
import { pushFoldChoiceVerdict } from '../src/gto';

describe('pushFoldChoiceVerdict (replay of an own push/fold spot)', () => {
  const spot = (heroClass: string) => ({ role: 'sbShove' as const, stackBB: 8, deadBB: 0, heroClass });
  it('folding a clear chip-EV shove is a verified loss, in PKO too', () => {
    for (const f of ['regular', 'PKO']) expect(pushFoldChoiceVerdict(spot('A8o'), 'fold', f)).toMatchObject({ class: 'verified', bestAction: 'shove' });
  });
  it('a chip-EV losing shove is inconclusive in PKO, and a small loss is not called a mistake', () => {
    const bad = pushFoldChoiceVerdict(spot('72o'), 'aggressive', 'regular');
    expect(bad.class === 'minor' || bad.class === 'verified').toBe(true);
    expect(bad.evLossBB).toBeGreaterThan(0);
    const worst = pushFoldChoiceVerdict({ role: 'bbCall', stackBB: 15, deadBB: 0, heroClass: '72o' }, 'aggressive', 'PKO');
    expect(worst.class).toBe('inconclusiveBounty');
    expect(pushFoldChoiceVerdict({ role: 'bbCall', stackBB: 15, deadBB: 0, heroClass: '72o' }, 'aggressive', 'regular').class).toBe('verified');
  });
  it('answers outside shove/fold are not judged', () => {
    expect(pushFoldChoiceVerdict(spot('A8o'), 'other', 'regular')).toMatchObject({ class: 'outsideModel', grade: null, evLossBB: null });
  });
  it('a correct answer is labelled correct', () => {
    expect(pushFoldChoiceVerdict(spot('A8o'), 'aggressive', 'regular')).toMatchObject({ class: 'correct', evLossBB: 0 });
  });
});
