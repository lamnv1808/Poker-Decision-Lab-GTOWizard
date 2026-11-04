import { assertVerdictInvariants, type DqeVerdict } from '@pdl/core';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { env } from '../src/env';
import { cid, newUser } from './helpers';

/** DQE feedback is behind DQE_FEEDBACK (default off): off = response unchanged; on = verdict only, no writes. */
const orig = env.DQE_FEEDBACK;
afterEach(() => {
  (env as { DQE_FEEDBACK?: string }).DQE_FEEDBACK = orig;
});

async function playFirstDecision(agent: Awaited<ReturnType<typeof newUser>>['agent']) {
  let v;
  do v = (await agent.post('/api/sim/hands').send({ tableSize: 6, stackBB: 10, mode: 'rated', feedback: 'guided' }).expect(201)).body;
  while (!v.legal);
  const action = v.legal.canCheck ? { type: 'check' } : { type: 'fold' };
  return (await agent.post(`/api/sim/hands/${v.id}/act`).send({ clientAttemptId: cid(), decisionIndex: v.decisionIndex, action }).expect(200)).body;
}

describe('DQE_FEEDBACK flag', () => {
  it('is off by default: the feedback carries no DQE verdict', async () => {
    expect(env.DQE_FEEDBACK).not.toBe('on');
    const u = await newUser('dqeoff');
    const r = await playFirstDecision(u.agent);
    expect(r.feedback).toBeTruthy();
    expect(r.feedback.dqe).toBeUndefined();
  });

  it('when on: an evidence-labelled verdict obeying every trust boundary, and no extra writes', async () => {
    (env as { DQE_FEEDBACK?: string }).DQE_FEEDBACK = 'on';
    const u = await newUser('dqeon');
    const before = { attempts: await prisma.decisionAttempt.count({ where: { userId: u.id } }), ratings: await prisma.ratingHistory.count({ where: { userId: u.id } }) };
    const verdicts: DqeVerdict[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await playFirstDecision(u.agent);
      expect(r.feedback.dqe).toBeTruthy();
      verdicts.push(r.feedback.dqe);
    }
    for (const v of verdicts) {
      expect(() => assertVerdictInvariants(v)).not.toThrow();
      expect(v.engineVersion).toMatch(/^dqe-/);
      if (v.category !== 'VERIFIED_SOLVER_EV') {
        expect(v.grade).toBeNull();
        expect(v.evLossBB).toBeNull();
      }
      if (v.category === 'INSUFFICIENT_EVIDENCE') expect(v.missing?.detail).toBeTruthy();
    }
    // the DQE path writes nothing itself: attempts/ratings move only as the existing grader decides
    const after = { attempts: await prisma.decisionAttempt.count({ where: { userId: u.id } }), ratings: await prisma.ratingHistory.count({ where: { userId: u.id } }) };
    const control = await newUser('dqectl');
    (env as { DQE_FEEDBACK?: string }).DQE_FEEDBACK = 'off';
    expect(after.attempts - before.attempts).toBeLessThanOrEqual(6);
    for (let i = 0; i < 1; i++) await playFirstDecision(control.agent);
    expect(await prisma.decisionAttempt.count({ where: { userId: control.id } })).toBeLessThanOrEqual(1);
  });
});
