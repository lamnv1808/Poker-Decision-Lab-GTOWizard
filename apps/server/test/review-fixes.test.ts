import { dealSim, randomSimConfig, type SimConfig } from '@pdl/core';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { recordAttempt } from '../src/learning';
import { cid, newUser } from './helpers';

describe('fixes from the V3 code review', () => {
  it('the deal cannot be rebuilt from the seed or the public config (CSPRNG deal stored server-side)', async () => {
    const u = await newUser('fx1');
    for (let i = 0; i < 5; i++) {
      const v = (await u.agent.post('/api/sim/hands').send({ tableSize: 3 }).expect(201)).body;
      const row = await prisma.simHand.findUniqueOrThrow({ where: { id: v.id } });
      const cfg = row.config as unknown as SimConfig;
      const deal = row.deal as { holes: Record<string, string[]> };
      expect(v.heroCards).toEqual(deal.holes[cfg.heroPos]);
      // compare the whole deal (all hole cards + board): a 2-card match alone can coincide by chance
      expect(JSON.stringify(dealSim(row.seed, cfg))).not.toEqual(JSON.stringify(row.deal));
      expect(randomSimConfig(row.seed)).not.toEqual(cfg);
    }
  }, 30_000);

  it('two simultaneous actions on one decision record at most one attempt and one rating update', async () => {
    const u = await newUser('fx2');
    for (let i = 0; i < 30; i++) {
      const v = (await u.agent.post('/api/sim/hands').send({ tableSize: 2, stackBB: 10, mode: 'rated' }).expect(201)).body;
      const [a, b] = await Promise.all([
        u.agent.post(`/api/sim/hands/${v.id}/act`).send({ decisionIndex: v.decisionIndex ?? 0, clientAttemptId: cid(), action: { type: 'fold' } }),
        u.agent.post(`/api/sim/hands/${v.id}/act`).send({ decisionIndex: v.decisionIndex ?? 0, clientAttemptId: cid(), action: { type: 'fold' } }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const atts = await prisma.decisionAttempt.findMany({ where: { userId: u.id, itemRef: { startsWith: `sim:${v.id}:` } } });
      expect(atts.length).toBeLessThanOrEqual(1);
      if (atts.length) {
        expect(await prisma.ratingHistory.count({ where: { attemptId: atts[0]!.id, skill: 'overall' } })).toBeLessThanOrEqual(1);
        return;
      }
    }
  });

  it('sim hands only attach to the caller’s open Mixed session, and take its mode', async () => {
    const u = await newUser('fx3');
    const s = (await u.agent.post('/api/mixed/sessions').send({ mode: 'practice', focus: ['fullhand'] }).expect(201)).body;
    const v = (await u.agent.post('/api/sim/hands').send({ sessionId: s.id, mode: 'rated' }).expect(201)).body;
    expect(v.mode).toBe('practice');
    await u.agent.post(`/api/mixed/sessions/${s.id}/end`).expect(200);
    await u.agent.post('/api/sim/hands').send({ sessionId: s.id }).expect(404);
    const math = await prisma.trainingSession.create({ data: { userId: u.id, kind: 'math', mode: 'rated' } });
    await u.agent.post('/api/sim/hands').send({ sessionId: math.id }).expect(404);
  });

  it('a practice Mixed session never moves ratings, even if the page sends mode=rated', async () => {
    const u = await newUser('fx4');
    const s = (await u.agent.post('/api/mixed/sessions').send({ mode: 'practice', focus: ['preflop'] }).expect(201)).body;
    const spot = (await u.agent.get('/api/gto/spot').expect(200)).body;
    const r = await u.agent.post('/api/gto/answer').send({ token: spot.token, action: 'fold', clientAttemptId: cid(), mode: 'rated', sessionId: s.id }).expect(200);
    expect(r.body.ratingChanges).toEqual([]);
    const att = await prisma.decisionAttempt.findFirstOrThrow({ where: { userId: u.id } });
    expect(att.mode).toBe('practice');
    expect(att.sessionId).toBe(s.id);
  });

  it('a session past its time (plus grace) no longer collects answers', async () => {
    const u = await newUser('fx5');
    const s = (await u.agent.post('/api/mixed/sessions').send({ durationMin: 5, focus: ['math'] }).expect(201)).body;
    await prisma.trainingSession.update({ where: { id: s.id }, data: { startedAt: new Date(Date.now() - 11 * 60000) } });
    const quiz = (await u.agent.get('/api/math/quiz?level=1').expect(200)).body;
    await u.agent.post('/api/math/quiz/answer').send({ token: quiz.token, value: 1, clientAttemptId: cid(), sessionId: s.id }).expect(200);
    expect(await prisma.decisionAttempt.count({ where: { sessionId: s.id } })).toBe(0);
  });

  it('Fundamentals attempts in a hand family do not discount Strategy familiarity', async () => {
    const u = await newUser('fx6');
    const base = { userId: u.id, attemptType: 'quiz' as const, reviewType: 'quiz' as const, reviewRef: 'x', mode: 'rated' as const, action: {}, graded: true, grade: 'excellent' as const, ratingEligible: true, isError: false, gradingMethodVersion: 't', difficulty: 3, skills: ['preflop' as const], concepts: [], leakOpportunities: [], optionLeaks: [], familyId: 'F1', result: {} };
    await recordAttempt({ ...base, clientAttemptId: cid(), itemRef: 'potodds:F1:a', gradeBasis: 'exact', sourceClass: 'MATH_VERIFIED', track: 'fundamentals' });
    const r = await recordAttempt({ ...base, clientAttemptId: cid(), itemRef: 'real:F1:b', gradeBasis: 'solverEv', sourceClass: 'SOLVER_VERIFIED', track: 'strategy' });
    expect(r.ratingChanges.find((c) => c.skill === 'overall')).toBeDefined();
    const att = await prisma.decisionAttempt.findUniqueOrThrow({ where: { id: r.attemptId } });
    expect(att.ratingWeight).toBe(1);
  });
});

describe('production bug: spaced-repetition date overflow on shared review items', () => {
  it('another correct answer on an item with a runaway schedule records fine and is capped', async () => {
    const u = await newUser('srs');
    await prisma.reviewItem.create({ data: { userId: u.id, itemType: 'quiz', itemRef: 'sim', repetitions: 40, ease: 4.2, intervalDays: 3_000_000, dueAt: new Date('9000-01-01T00:00:00Z'), mastery: 1 } });
    const base = { userId: u.id, attemptType: 'decision' as const, reviewType: 'quiz' as const, reviewRef: 'sim', mode: 'rated' as const, action: {}, graded: true, grade: 'excellent' as const, ratingEligible: true, isError: false, gradingMethodVersion: 't', difficulty: 3, skills: ['preflop' as const], concepts: [], leakOpportunities: [], optionLeaks: [], result: {}, gradeBasis: 'solverEv', sourceClass: 'SOLVER_VERIFIED' as const, track: 'strategy' as const };
    await recordAttempt({ ...base, clientAttemptId: cid(), itemRef: 'sim:x:0' });
    const item = await prisma.reviewItem.findUniqueOrThrow({ where: { userId_itemType_itemRef: { userId: u.id, itemType: 'quiz', itemRef: 'sim' } } });
    expect(item.intervalDays).toBeLessThanOrEqual(365);
    expect(item.dueAt.getUTCFullYear()).toBeLessThanOrEqual(new Date().getUTCFullYear() + 1);
  });
});
