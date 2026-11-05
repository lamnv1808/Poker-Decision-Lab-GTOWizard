import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { cid, newUser } from './helpers';

/** Phase 1 acceptance, Solver tier through the real API (the path production uses). */
type Legal = { canFold: boolean; canCheck: boolean; toCall: number; maxRaiseTo: number; minRaiseTo: number };
type View = { id: string; status: string; bigBlind: number; legal: Legal | null; config: { heroPos: string; tableSize: number }; state: { street: string } };

describe('Solver tier through the API: short-stack heads-up push/fold', () => {
  it('an SB shove at 10 BB is solver-verified, labelled, recorded on the strategy track; a limp is not', async () => {
    const u = await newUser('pf');
    let shoves = 0;
    let limps = 0;
    for (let i = 0; i < 40 && (shoves < 3 || limps < 1); i++) {
      const v = (await u.agent.post('/api/sim/hands').send({ tableSize: 2, stackBB: 10, mode: 'rated' }).expect(201)).body as View;
      if (v.status !== 'active' || !v.legal || v.config.heroPos !== 'SB' || v.state.street !== 'preflop') continue;
      expect(v.legal.toCall).toBe(v.bigBlind / 2);
      expect(v.legal.maxRaiseTo / v.bigBlind).toBe(10);
      const limp = limps < 1 && shoves >= 1;
      const action = limp ? { type: 'call' } : { type: 'raise', amount: v.legal.maxRaiseTo };
      const r = await u.agent.post(`/api/sim/hands/${v.id}/act`).send({ clientAttemptId: cid(), action }).expect(200);
      const fb = r.body.feedback;
      if (limp) {
        expect(fb.tier).not.toBe('solver');
        expect(fb.assessment).not.toBe('solverVerified');
        limps++;
        continue;
      }
      expect(fb.tier).toBe('solver');
      expect(fb.assessment).toBe('solverVerified');
      expect(fb.track).toBe('strategy');
      expect(fb.note.en).toMatch(/Heads-up push\/fold equilibrium \((\d+(\.5)?) BB, ([\d.]+) BB dead\)/);
      expect(Object.keys(fb.evByAction).sort()).toEqual(['fold', 'shove']);
      expect(fb.evLossBB).toBeCloseTo(Math.max(0, Math.max(fb.evByAction.shove, 0) - fb.evByAction.shove), 2);
      const att = await prisma.decisionAttempt.findFirstOrThrow({ where: { userId: u.id, itemRef: { startsWith: `sim:${v.id}:` } } });
      expect(att.ratingApplied).toBe(true); // solver-verified decisions are the only sim decisions that move a rating
      shoves++;
    }
    expect(shoves).toBeGreaterThanOrEqual(3);
    expect(limps).toBe(1);
  }, 120_000);
});
