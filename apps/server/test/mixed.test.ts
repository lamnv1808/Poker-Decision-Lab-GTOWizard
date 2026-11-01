import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { cid, newUser } from './helpers';

describe('Mixed Training', () => {
  it('serves only focused item types and records each attempt once in the session', async () => {
    const u = await newUser('mix1');
    const s = (await u.agent.post('/api/mixed/sessions').send({ durationMin: 10, focus: ['math'] }).expect(201)).body;
    const types = new Set<string>();
    for (let i = 0; i < 6; i++) types.add((await u.agent.post(`/api/mixed/sessions/${s.id}/next`).expect(200)).body.type);
    expect([...types]).toEqual(['math']); // no real hands → no pot-odds items either
    const quiz = (await u.agent.get('/api/math/quiz?level=1').expect(200)).body;
    const clientAttemptId = cid();
    await u.agent.post('/api/math/quiz/answer').send({ token: quiz.token, value: 1, clientAttemptId, sessionId: s.id }).expect(200);
    await u.agent.post('/api/math/quiz/answer').send({ token: quiz.token, value: 1, clientAttemptId, sessionId: s.id }).expect(200);
    const sum = (await u.agent.get(`/api/mixed/sessions/${s.id}/summary`).expect(200)).body;
    expect(sum.attempts).toBe(1);
    expect(sum.byType[0].type).toBe('math');
    expect(sum.served).toBe(6);
  });

  it('full-hand items resume an unfinished hand instead of dealing a new one', async () => {
    const u = await newUser('mix2');
    const s = (await u.agent.post('/api/mixed/sessions').send({ focus: ['fullhand'], difficulty: 'hard' }).expect(201)).body;
    let first;
    for (let i = 0; i < 10; i++) {
      first = (await u.agent.post(`/api/mixed/sessions/${s.id}/next`).expect(200)).body;
      const id = first.href.split('/play/')[1].split('?')[0];
      const h = await prisma.simHand.findUniqueOrThrow({ where: { id } });
      expect(h.sessionId).toBe(s.id);
      if (h.status === 'active') {
        const again = (await u.agent.post(`/api/mixed/sessions/${s.id}/next`).expect(200)).body;
        expect(again.href).toBe(first.href);
        expect(again.resumed).toBe(true);
        return;
      }
    }
    throw new Error('every hand ended before Hero acted');
  });

  it('ignores another user’s session id, and ends when time is up', async () => {
    const a = await newUser('mix3a');
    const b = await newUser('mix3b');
    const s = (await a.agent.post('/api/mixed/sessions').send({ durationMin: 5, focus: ['preflop'] }).expect(201)).body;
    await b.agent.get(`/api/mixed/sessions/${s.id}`).expect(404);
    const quiz = (await b.agent.get('/api/math/quiz?level=1').expect(200)).body;
    await b.agent.post('/api/math/quiz/answer').send({ token: quiz.token, value: 1, clientAttemptId: cid(), sessionId: s.id }).expect(200);
    expect(await prisma.decisionAttempt.count({ where: { sessionId: s.id } })).toBe(0);
    const n = (await a.agent.post(`/api/mixed/sessions/${s.id}/next`).expect(200)).body;
    expect(n.type).toBe('gto');
    await prisma.trainingSession.update({ where: { id: s.id }, data: { startedAt: new Date(Date.now() - 6 * 60000) } });
    expect((await a.agent.post(`/api/mixed/sessions/${s.id}/next`).expect(200)).body.done).toBe(true);
  });

  it('never serves the same type three times in a row when several are allowed', async () => {
    const u = await newUser('mix4');
    const s = (await u.agent.post('/api/mixed/sessions').send({ durationMin: 30, focus: ['preflop', 'postflop', 'math'] }).expect(201)).body;
    const seq: string[] = [];
    for (let i = 0; i < 15; i++) seq.push((await u.agent.post(`/api/mixed/sessions/${s.id}/next`).expect(200)).body.type);
    for (let i = 2; i < seq.length; i++) expect(seq[i] === seq[i - 1] && seq[i] === seq[i - 2]).toBe(false);
    expect(new Set(seq).size).toBeGreaterThan(1);
  });
});
