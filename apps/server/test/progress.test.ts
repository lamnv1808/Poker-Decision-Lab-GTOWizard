import { describe, expect, it } from 'vitest';
import { cid, newUser } from './helpers';

describe('practice progress for every module (not Elo)', () => {
  it('a full hand moves practice progress even with no graded decision; ratings move only where eligible', async () => {
    const u = await newUser('prog1');
    let v;
    do v = (await u.agent.post('/api/sim/hands').send({ tableSize: 6, stackBB: 100 }).expect(201)).body;
    while (!v.legal);
    for (let i = 0; i < 30 && v.status === 'active' && v.legal; i++) v = (await u.agent.post(`/api/sim/hands/${v.id}/act`).send({ clientAttemptId: cid(), action: v.legal.canCheck ? { type: 'check' } : { type: 'fold' }, confidence: 2 }).expect(200)).body.view;
    const quiz = (await u.agent.get('/api/math/quiz?level=1').expect(200)).body;
    await u.agent.post('/api/math/quiz/answer').send({ token: quiz.token, value: 1, clientAttemptId: cid() }).expect(200);
    const spot = (await u.agent.get('/api/gto/spot').expect(200)).body;
    await u.agent.post('/api/gto/answer').send({ token: spot.token, action: 'fold', clientAttemptId: cid(), mode: 'practice' }).expect(200);
    const p = (await u.agent.get('/api/training-progress').expect(200)).body;
    const mod = (m: string) => p.modules.find((x: { module: string }) => x.module === m);
    expect(p.fullHands.completed).toBe(1);
    expect(mod('fullHand').decisions).toBeGreaterThan(0);
    expect(mod('fullHand').decisions).toBe(mod('fullHand').graded + mod('fullHand').ungraded);
    expect(mod('mathLab').fundamentalsDelta).not.toBe(0);
    expect(mod('gtoPushFold').decisions).toBe(1);
    expect(mod('gtoPushFold').strategyDelta).toBe(0); // practice never moves ratings
    expect(p.streakDays).toBe(1);
    expect(p.note.en).toMatch(/not a rating/);
  });
});
