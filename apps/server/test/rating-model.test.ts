import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { ensureRatingModel } from '../src/learning';
import { cid, newUser } from './helpers';

const base = { attemptType: 'quiz', mode: 'rated', action: {}, gradeBasis: 'exact', ratingEligible: true, isError: false, gradingMethodVersion: 'test', difficulty: 3, skills: ['math'], concepts: [], leakKeys: [], result: {} };

describe('versioned rating migration (unified-v1)', () => {
  it('back-fills the Fundamentals subrating from history without touching strategy ratings, once', async () => {
    const u = await newUser('migr');
    await prisma.rating.create({ data: { userId: u.id, skill: 'overall', rating: 1234, rd: 90, vol: 0.06, games: 40 } });
    const t0 = Date.now() - 10 * 86400000;
    for (let i = 0; i < 12; i++)
      await prisma.decisionAttempt.create({ data: { ...base, userId: u.id, clientAttemptId: cid(), itemRef: `quiz:potOdds:1:${i % 10}`, graded: true, grade: 'excellent', score: 1, track: 'fundamentals', createdAt: new Date(t0 + i * 3600000) } });
    // practice-mode and heuristic/strategy attempts are not part of the Fundamentals subrating
    await prisma.decisionAttempt.create({ data: { ...base, userId: u.id, clientAttemptId: cid(), itemRef: 'quiz:x', mode: 'practice', graded: true, grade: 'excellent', score: 1, track: 'fundamentals' } });
    await prisma.decisionAttempt.create({ data: { ...base, userId: u.id, clientAttemptId: cid(), itemRef: 'scn:h', gradeBasis: 'rubric', graded: true, grade: 'good', score: 0.85, track: 'strategy' } });

    const dash = await u.agent.get('/api/dashboard').expect(200);
    const fund = await prisma.rating.findUniqueOrThrow({ where: { userId_skill: { userId: u.id, skill: 'fundamentals' } } });
    expect(fund.games).toBe(12);
    expect(fund.rating).toBeGreaterThan(1000);
    const overall = await prisma.rating.findUniqueOrThrow({ where: { userId_skill: { userId: u.id, skill: 'overall' } } });
    expect(overall.rating).toBe(1234);
    expect((await prisma.ratingModelState.findUniqueOrThrow({ where: { userId: u.id } })).version).toBe('unified-v1');
    expect(dash.body.competency.status).toBe('ok');
    expect(dash.body.competency.strategy.rating).toBe(1234);
    expect(dash.body.competency.fundamentals.games).toBe(12);
    expect(dash.body.competency.exploratory.attempts).toBe(1);

    await ensureRatingModel(u.id);
    expect(await prisma.ratingHistory.count({ where: { userId: u.id, skill: 'fundamentals' } })).toBe(12);
  });

  it('a new user gets "not enough evidence" and no duplicated strongest/weakest skill', async () => {
    const u = await newUser('fresh');
    await prisma.rating.create({ data: { userId: u.id, skill: 'preflop', rating: 1100, rd: 100, vol: 0.06, games: 30 } });
    const d = await u.agent.get('/api/dashboard').expect(200);
    expect(d.body.competency.status).toBe('insufficient');
    expect(d.body.competency.rating).toBeNull();
    expect(d.body.skillEvidence).toBe('insufficient');
    expect(d.body.strengths).toEqual([]);
    expect(d.body.weaknesses).toEqual([]);
  });
});
