import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { cid, ensureSeeded, newUser } from './helpers';

/**
 * Retrying the exact same rated answer (same clientAttemptId) — sequentially, after a delay with other
 * answers in between, or concurrently — must never create a second attempt, add rating history, or move a
 * rating again. Asserted on database rows, not only on HTTP responses.
 */
async function snapshot(userId: string) {
  const [attempts, history, ratings] = await Promise.all([
    prisma.decisionAttempt.count({ where: { userId } }),
    prisma.ratingHistory.count({ where: { userId } }),
    prisma.rating.findMany({ where: { userId }, orderBy: { skill: 'asc' }, select: { skill: true, rating: true, rd: true, vol: true, games: true } }),
  ]);
  return { attempts, history, ratings };
}

const spot = async (agent: Awaited<ReturnType<typeof newUser>>['agent']) => (await agent.get('/api/gto/spot').expect(200)).body as { token: string; role: 'sbShove' | 'bbCall' };
const answerBody = (s: { token: string; role: string }, clientAttemptId: string) => ({ token: s.token, action: s.role === 'sbShove' ? 'shove' : 'call', clientAttemptId, mode: 'rated' });

describe('rated answers are applied exactly once per clientAttemptId', () => {
  it('GTO quiz: an immediate retry changes nothing', async () => {
    await ensureSeeded();
    const u = await newUser('retry1');
    const s = await spot(u.agent);
    const id = cid();
    const first = (await u.agent.post('/api/gto/answer').send(answerBody(s, id)).expect(200)).body;
    expect(first.ratingChanges.length).toBeGreaterThan(0); // the answer really was rated
    const after1 = await snapshot(u.id);
    expect(after1.attempts).toBe(1);
    const retry = await u.agent.post('/api/gto/answer').send(answerBody(s, id)).expect(200);
    expect(retry.body.grade).toBe(first.grade);
    expect(await snapshot(u.id)).toEqual(after1);
    expect(await prisma.ratingHistory.count({ where: { attempt: { userId: u.id, clientAttemptId: id } } })).toBe(first.ratingChanges.length);
  });

  it('GTO quiz: a delayed retry, after other rated answers, changes nothing', async () => {
    const u = await newUser('retry2');
    const s1 = await spot(u.agent);
    const id1 = cid();
    await u.agent.post('/api/gto/answer').send(answerBody(s1, id1)).expect(200);
    for (let k = 0; k < 2; k++) {
      const s = await spot(u.agent);
      await u.agent.post('/api/gto/answer').send(answerBody(s, cid())).expect(200);
    }
    await new Promise((r) => setTimeout(r, 300));
    const before = await snapshot(u.id);
    expect(before.attempts).toBe(3);
    await u.agent.post('/api/gto/answer').send(answerBody(s1, id1)).expect(200);
    expect(await snapshot(u.id)).toEqual(before);
  });

  it('GTO quiz: concurrent retries of one answer apply it once', async () => {
    const u = await newUser('retry3');
    const s = await spot(u.agent);
    const id = cid();
    const before = await snapshot(u.id);
    const res = await Promise.all(Array.from({ length: 6 }, () => u.agent.post('/api/gto/answer').send(answerBody(s, id))));
    // every caller gets an answer; none of them may apply it a second time
    for (const r of res) expect([200, 409]).toContain(r.status);
    const ok = res.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThan(0);
    const after = await snapshot(u.id);
    expect(after.attempts - before.attempts).toBe(1);
    const applied = await prisma.ratingHistory.count({ where: { attempt: { userId: u.id, clientAttemptId: id } } });
    expect(applied).toBeGreaterThan(0);
    expect(after.history - before.history).toBe(applied);
    // each rated skill moved exactly once
    const games = (rs: typeof after.ratings) => Object.fromEntries(rs.map((r) => [r.skill, r.games]));
    const g0 = games(before.ratings);
    for (const [skill, n] of Object.entries(games(after.ratings))) expect(n - (g0[skill] ?? 0)).toBeLessThanOrEqual(1);
    expect(Object.entries(games(after.ratings)).filter(([skill, n]) => n - (g0[skill] ?? 0) === 1).length).toBe(applied);
  });

  it('full hand: concurrent and delayed retries of one action record one decision and one attempt', async () => {
    const u = await newUser('retry4');
    let v;
    do v = (await u.agent.post('/api/sim/hands').send({ tableSize: 2, stackBB: 10, mode: 'rated' }).expect(201)).body;
    while (!v.legal);
    const id = cid();
    const action = v.legal.canCheck ? { type: 'check' } : { type: 'call' };
    const before = await snapshot(u.id);
    const res = await Promise.all(Array.from({ length: 5 }, () => u.agent.post(`/api/sim/hands/${v.id}/act`).send({ clientAttemptId: id, action })));
    for (const r of res) expect([200, 409]).toContain(r.status);
    const hand = await prisma.simHand.findUniqueOrThrow({ where: { id: v.id } });
    const steps = (hand.steps as { clientAttemptId?: string }[]).filter((x) => x.clientAttemptId === id);
    expect(steps).toHaveLength(1);
    const mid = await snapshot(u.id);
    expect(mid.attempts - before.attempts).toBeLessThanOrEqual(1);
    // delayed retry of the same action: still recorded once, nothing else changes
    await new Promise((r) => setTimeout(r, 300));
    const again = await u.agent.post(`/api/sim/hands/${v.id}/act`).send({ clientAttemptId: id, action });
    expect([200, 409]).toContain(again.status);
    const hand2 = await prisma.simHand.findUniqueOrThrow({ where: { id: v.id } });
    expect((hand2.steps as { clientAttemptId?: string }[]).filter((x) => x.clientAttemptId === id)).toHaveLength(1);
    expect(await snapshot(u.id)).toEqual(mid);
  });
});
