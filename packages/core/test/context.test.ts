import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { auditHand, decisionContext, snapshotForHeroAction, stackBucket } from '../src';

const fixtures = Object.fromEntries(
  readFileSync(new URL('./fixtures/real-anon.txt', import.meta.url), 'utf8')
    .split(/^# fixture: /m)
    .filter((x) => x.trim())
    .map((p) => {
      const [tag, ...rest] = p.split('\n');
      return [tag!.trim(), rest.join('\n').trim()];
    }),
);
const ctx = (tag: string, n: number) => {
  const a = auditHand(fixtures[tag]!);
  return decisionContext(a.rec!, snapshotForHeroAction(a.rec!, n)!, a.format);
};

describe('decision context from real hands (checked by hand against the histories)', () => {
  it('preflop: unopened, facing an all-in, short stacks, hand class', () => {
    expect(ctx('uncalledReturn', 1)).toMatchObject({ street: 'preflop', position: 'LJ', actionContext: 'unopened', heroAction: 'fold', requiredEquity: null, heroClass: 'J6o' });
    expect(ctx('shortBigBlindCall', 1)).toMatchObject({ actionContext: 'vsAllIn', heroAction: 'allin', stackBucket: '<=10', heroClass: 'AKo' });
    const c = ctx('potOddsAllInForLess', 2);
    expect(c).toMatchObject({ actionContext: 'vsAllIn', heroAction: 'fold' });
    expect(c.requiredEquity!).toBeGreaterThan(0.3);
  });
  it('postflop: checked to, facing a bet with its size, SPR', () => {
    expect(ctx('duplicateShowLines', 2)).toMatchObject({ street: 'flop', actionContext: 'checkedTo', heroAction: 'check', facingBetPct: null });
    const t = ctx('duplicateShowLines', 4);
    expect(t).toMatchObject({ street: 'turn', actionContext: 'vsBet', heroAction: 'fold', facingBetPct: 0.33 });
    expect(t.spr).toBeGreaterThan(1);
    expect(ctx('headsUpPostflopCall', 3)).toMatchObject({ actionContext: 'vsBet', facingBetPct: 0.5, requiredEquity: 0.25 });
  });
  it('format and stack buckets', () => {
    expect(ctx('headsUpPostflopCall', 1).formatGroup).toBe('PKO');
    expect([5, 12, 20, 30, 80].map(stackBucket)).toEqual(['<=10', '10-15', '15-25', '25-40', '40+']);
  });
});
