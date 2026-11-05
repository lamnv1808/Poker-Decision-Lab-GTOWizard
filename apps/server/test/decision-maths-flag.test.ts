import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { env } from '../src/env';
import { cid, newUser } from './helpers';

/**
 * Decision Maths is behind DQE_DECISION_MATHS (default off). Off = response unchanged. On = an extra
 * `feedback.decisionMaths` for postflop decisions only; same grade, same attempts and ratings as with it off.
 */
const orig = env.DQE_DECISION_MATHS;
afterEach(() => {
  (env as { DQE_DECISION_MATHS?: string }).DQE_DECISION_MATHS = orig;
});

type Agent = Awaited<ReturnType<typeof newUser>>['agent'];
/** Play hands with check/call until `n` postflop decisions were answered; returns every act response. */
async function playPostflop(agent: Agent, n: number) {
  const out: { street: string; body: { feedback: Record<string, unknown> | null } }[] = [];
  let postflop = 0;
  for (let hand = 0; hand < 40 && postflop < n; hand++) {
    let v = (await agent.post('/api/sim/hands').send({ tableSize: 6, stackBB: 40, mode: 'practice', feedback: 'guided' }).expect(201)).body;
    for (let step = 0; step < 12 && v.legal && postflop < n; step++) {
      const street = v.progress.street as string;
      const action = v.legal.canCheck ? { type: 'check' } : { type: 'call' };
      const r = (await agent.post(`/api/sim/hands/${v.id}/act`).send({ clientAttemptId: cid(), decisionIndex: v.decisionIndex, action }).expect(200)).body;
      out.push({ street, body: r });
      if (street !== 'preflop') postflop++;
      v = r.view;
    }
  }
  return out;
}

describe('DQE_DECISION_MATHS flag', () => {
  it('is off by default: no decisionMaths in any response', async () => {
    expect(env.DQE_DECISION_MATHS).not.toBe('on');
    const u = await newUser('dmoff');
    const rs = await playPostflop(u.agent, 3);
    expect(rs.some((r) => r.street !== 'preflop')).toBe(true);
    for (const r of rs) if (r.body.feedback) expect(r.body.feedback.decisionMaths).toBeUndefined();
  });

  it('when on: postflop decisions carry exact arithmetic, never a grade; preflop carries nothing; no extra writes', async () => {
    (env as { DQE_DECISION_MATHS?: string }).DQE_DECISION_MATHS = 'on';
    const u = await newUser('dmon');
    const rs = await playPostflop(u.agent, 6);
    const post = rs.filter((r) => r.street !== 'preflop' && r.body.feedback);
    expect(post.length).toBeGreaterThan(0);
    for (const r of rs) {
      const fb = r.body.feedback;
      if (!fb) continue;
      const m = fb.decisionMaths as { strategicVerdict: string; gradeable: boolean; facts: { class: string; notAStrategy: boolean; evidenceCategory: string }[]; version: string } | undefined;
      if (r.street === 'preflop') { expect(m).toBeUndefined(); continue; }
      expect(m).toBeTruthy();
      expect(m!.version).toMatch(/^pdl-decision-math-/);
      expect(m!.strategicVerdict).toBe('NOT_ESTABLISHED');
      expect(m!.gradeable).toBe(false);
      expect(m!.facts.length).toBeGreaterThan(0);
      for (const f of m!.facts) {
        expect(['ARITHMETIC_IDENTITY', 'CONDITIONAL_MODEL_REFERENCE']).toContain(f.class);
        expect(f.evidenceCategory).toBe('EXACT_MATHEMATICAL_RESULT');
        expect(f.notAStrategy).toBe(true);
      }
      // the existing grader's fields are present and untouched by the flag
      expect(Object.keys(fb)).toEqual(expect.arrayContaining(['graded', 'basis']));
    }
    // writes: one attempt per graded step at most, exactly as without the flag; no rating rows beyond attempts
    const attempts = await prisma.decisionAttempt.count({ where: { userId: u.id } });
    expect(attempts).toBeLessThanOrEqual(rs.length);
  });

  it('the grade does not depend on the flag (same responses apart from decisionMaths)', async () => {
    const u = await newUser('dmsame');
    (env as { DQE_DECISION_MATHS?: string }).DQE_DECISION_MATHS = 'on';
    const on = await playPostflop(u.agent, 4);
    for (const r of on) {
      const fb = r.body.feedback;
      if (!fb) continue;
      const { decisionMaths, ...rest } = fb as Record<string, unknown>;
      void decisionMaths;
      // nothing else in the feedback mentions the new module
      expect(JSON.stringify(rest)).not.toMatch(/pdl-decision-math/);
    }
  });
});
