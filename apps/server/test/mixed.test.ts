import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { cid, ensureSeeded, newUser } from './helpers';

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
    for (let i = 0; i < 15; i++) {
      const n = (await u.agent.post(`/api/mixed/sessions/${s.id}/next`).expect(200)).body;
      seq.push(n.type);
      // an unfinished full hand is resumed (by design); leave it so the next pick is a new item
      if (n.href.includes('/play/')) await prisma.simHand.update({ where: { id: n.href.split('/play/')[1].split('?')[0] }, data: { status: 'abandoned' } });
    }
    for (let i = 2; i < seq.length; i++) expect(seq[i] === seq[i - 1] && seq[i] === seq[i - 2]).toBe(false);
    expect(new Set(seq).size).toBeGreaterThan(1);
  });
});

describe('Mixed Training V3.1: all modules, mixes, history-aware', () => {
  it('Hero-focused mix serves full hands and Hero scenarios; scenario runs belong to the session and take its mode', async () => {
    await ensureSeeded();
    const u = await newUser('mix5');
    const s = (await u.agent.post('/api/mixed/sessions').send({ durationMin: 30, mix: 'heroFocus', mode: 'practice' }).expect(201)).body;
    const types: string[] = [];
    for (let i = 0; i < 12; i++) {
      const n = (await u.agent.post(`/api/mixed/sessions/${s.id}/next`).expect(200)).body;
      types.push(n.type);
      if (n.type === 'scenario') {
        const runId = n.href.split('/run/')[1].split('?')[0];
        const run = await prisma.scenarioRun.findUniqueOrThrow({ where: { id: runId } });
        expect(run.sessionId).toBe(s.id);
        expect(run.mode).toBe('practice');
      }
      // finish open full hands so the next item is not a resume
      if (n.type === 'sim' || n.type === 'solverFlop') {
        const id = n.href.split('/play/')[1].split('?')[0];
        await prisma.simHand.update({ where: { id }, data: { status: 'abandoned' } });
      }
    }
    const hero = types.filter((t) => ['sim', 'solverFlop', 'scenario'].includes(t)).length;
    expect(hero / types.length).toBeGreaterThan(0.5);
    expect(types).toContain('scenario');
  });

  it('New Only drops curated scenarios once they are exhausted instead of repeating them', async () => {
    const u = await newUser('mix6');
    const total = await prisma.scenario.count({ where: { published: true, mode: 'villain' } });
    const s = (await u.agent.post('/api/mixed/sessions').send({ durationMin: 30, mix: 'newOnly', focus: ['villain', 'math'] }).expect(201)).body;
    const runs = new Set<string>();
    for (let i = 0; i < total * 2 + 6; i++) {
      const n = (await u.agent.post(`/api/mixed/sessions/${s.id}/next`).expect(200)).body;
      if (n.type === 'villain') {
        const runId = n.href.split('/run/')[1].split('?')[0];
        const run = await prisma.scenarioRun.findUniqueOrThrow({ where: { id: runId }, include: { scenarioVersion: true } });
        expect(runs.has(run.scenarioVersion.scenarioId)).toBe(false);
        runs.add(run.scenarioVersion.scenarioId);
        // mark it completed so it is no longer "new"
        await prisma.scenarioRun.update({ where: { id: runId }, data: { status: 'completed' } });
        await prisma.scenarioHistory.update({ where: { userId_contentKey: { userId: u.id, contentKey: `scenario:${run.scenarioVersion.scenarioId}` } }, data: { timesCompleted: 1 } });
      }
    }
    expect(runs.size).toBe(total);
    const sum = (await u.agent.get(`/api/mixed/sessions/${s.id}/summary`).expect(200)).body;
    expect(sum.exhausted).toContain('villain');
    expect(sum).toHaveProperty('strategyRated');
    expect(sum).toHaveProperty('fundamentalsRated');
    expect(sum).toHaveProperty('ungraded');
  }, 60_000);
});
