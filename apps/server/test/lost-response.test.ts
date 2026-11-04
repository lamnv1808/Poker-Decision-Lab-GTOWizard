import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { env } from '../src/env';
import { cid, ensureSeeded, newUser } from './helpers';

/**
 * F1: a decision whose response was lost after the server committed it must not be recorded or rated a
 * second time when the page retries — even if the retry carries a different clientAttemptId (an older
 * page, or a reload) — and a stale Full Hand action must never be applied to the next decision.
 * Everything is asserted on database rows.
 */
type Agent = Awaited<ReturnType<typeof newUser>>['agent'];

async function rows(userId: string) {
  const [attempts, history, ratings] = await Promise.all([
    prisma.decisionAttempt.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, select: { id: true, itemRef: true, optionKey: true, ratingApplied: true } }),
    prisma.ratingHistory.findMany({ where: { userId }, orderBy: { id: 'asc' }, select: { id: true, attemptId: true, skill: true, ratingAfter: true } }),
    prisma.rating.findMany({ where: { userId }, orderBy: { skill: 'asc' }, select: { skill: true, rating: true, rd: true, vol: true, games: true } }),
  ]);
  return { attempts, history, ratings };
}

const gtoSpot = async (a: Agent) => (await a.get('/api/gto/spot').expect(200)).body as { token: string; role: 'sbShove' | 'bbCall' };
const aggressive = (s: { role: string }) => (s.role === 'sbShove' ? 'shove' : 'call');

describe('F1 — GTO push/fold quiz: one spot is answered (and rated) once', () => {
  it('lost response, then a retry with a NEW clientAttemptId: the stored result comes back, nothing is recorded again', async () => {
    await ensureSeeded();
    const u = await newUser('f1a');
    const s = await gtoSpot(u.agent);
    // the server commits; the client never sees this response
    const lost = (await u.agent.post('/api/gto/answer').send({ token: s.token, action: aggressive(s), clientAttemptId: cid(), mode: 'rated' }).expect(200)).body;
    expect(lost.ratingChanges.length).toBeGreaterThan(0);
    const committed = await rows(u.id);
    expect(committed.attempts).toHaveLength(1);
    // retry from a page that generated another id
    const retry = (await u.agent.post('/api/gto/answer').send({ token: s.token, action: aggressive(s), clientAttemptId: cid(), mode: 'rated' }).expect(200)).body;
    expect(retry.grade).toBe(lost.grade);
    // the replayed result is the stored JSON (floats round-trip to ~1e-12); the database rows below are exact
    const round = (cs: { skill: string; before: number; after: number }[]) => cs.map((c) => [c.skill, c.before.toFixed(6), c.after.toFixed(6)]);
    expect(round(retry.ratingChanges)).toEqual(round(lost.ratingChanges));
    expect(await rows(u.id)).toEqual(committed);
  });

  it('a retry with a different action returns what was recorded, never a second grade', async () => {
    const u = await newUser('f1b');
    const s = await gtoSpot(u.agent);
    const first = (await u.agent.post('/api/gto/answer').send({ token: s.token, action: 'fold', clientAttemptId: cid(), mode: 'rated' }).expect(200)).body;
    const committed = await rows(u.id);
    const other = (await u.agent.post('/api/gto/answer').send({ token: s.token, action: aggressive(s), clientAttemptId: cid(), mode: 'rated' }).expect(200)).body;
    expect(other.action).toBe('fold');
    expect(other.grade).toBe(first.grade);
    expect(await rows(u.id)).toEqual(committed);
    expect(committed.attempts[0]!.optionKey).toBe('fold');
  });

  it('concurrent retries of one spot, each with its own id, record one attempt and move each rating once', async () => {
    const u = await newUser('f1c');
    const s = await gtoSpot(u.agent);
    const res = await Promise.all(Array.from({ length: 6 }, () => u.agent.post('/api/gto/answer').send({ token: s.token, action: aggressive(s), clientAttemptId: cid(), mode: 'rated' })));
    for (const r of res) expect(r.status).toBe(200);
    const after = await rows(u.id);
    expect(after.attempts).toHaveLength(1);
    expect(new Set(after.history.map((h) => h.attemptId))).toEqual(new Set([after.attempts[0]!.id]));
    expect(after.history.length).toBe(res[0]!.body.ratingChanges.length);
    for (const r of after.ratings) expect(r.games).toBeLessThanOrEqual(1);
  });

  it('every new spot is still its own decision', async () => {
    const u = await newUser('f1d');
    for (let i = 0; i < 4; i++) {
      const s = await gtoSpot(u.agent);
      await u.agent.post('/api/gto/answer').send({ token: s.token, action: 'fold', clientAttemptId: cid(), mode: 'rated' }).expect(200);
    }
    expect((await rows(u.id)).attempts).toHaveLength(4);
  });

  it('a token issued before the fix (no decision id) still works and keeps per-clientAttemptId idempotency', async () => {
    const u = await newUser('f1e');
    const payload = Buffer.from(JSON.stringify({ u: u.id, s: 12345, f: {} })).toString('base64url');
    const legacy = `${payload}.${createHmac('sha256', env.APP_SECRET).update(`gto:${payload}`).digest('base64url')}`;
    const id = cid();
    await u.agent.post('/api/gto/answer').send({ token: legacy, action: 'fold', clientAttemptId: id, mode: 'rated' }).expect(200);
    await u.agent.post('/api/gto/answer').send({ token: legacy, action: 'fold', clientAttemptId: id, mode: 'rated' }).expect(200);
    expect((await rows(u.id)).attempts).toHaveLength(1);
  });
});

describe('F1 — math and postflop quizzes', () => {
  it('math quiz: lost response + retry with a new id records once', async () => {
    const u = await newUser('f1m');
    const q = (await u.agent.get('/api/math/quiz?level=1').expect(200)).body;
    await u.agent.post('/api/math/quiz/answer').send({ token: q.token, value: 1, clientAttemptId: cid(), mode: 'rated' }).expect(200);
    const committed = await rows(u.id);
    await u.agent.post('/api/math/quiz/answer').send({ token: q.token, value: 2, clientAttemptId: cid(), mode: 'rated' }).expect(200);
    expect(await rows(u.id)).toEqual(committed);
    expect(committed.attempts).toHaveLength(1);
  });

  it('postflop library quiz: lost response + retry with a new id records once', async () => {
    const u = await newUser('f1p');
    const r = await u.agent.get('/api/gto/postflop/spot');
    if (r.status !== 200) return; // no postflop library in this environment
    await u.agent.post('/api/gto/postflop/answer').send({ token: r.body.token, actionIndex: 0, clientAttemptId: cid(), mode: 'rated' }).expect(200);
    const committed = await rows(u.id);
    await u.agent.post('/api/gto/postflop/answer').send({ token: r.body.token, actionIndex: 0, clientAttemptId: cid(), mode: 'rated' }).expect(200);
    expect(await rows(u.id)).toEqual(committed);
    expect(committed.attempts).toHaveLength(1);
  });
});

/** A rated heads-up hand where Hero, after one passive action, has to act again (a second decision). */
async function twoDecisionHand(a: Agent) {
  for (let i = 0; i < 60; i++) {
    const v = (await a.post('/api/sim/hands').send({ tableSize: 2, stackBB: 40, mode: 'rated', feedback: 'guided' }).expect(201)).body;
    if (!v.legal) continue;
    const action = v.legal.canCheck ? { type: 'check' } : { type: 'call' };
    const id = cid();
    const r = await a.post(`/api/sim/hands/${v.id}/act`).send({ clientAttemptId: id, decisionIndex: v.decisionIndex, action });
    if (r.status === 200 && r.body.view.status === 'active' && r.body.view.legal) return { first: v, id, action, firstRes: r.body, next: r.body.view };
  }
  throw new Error('no two-decision hand in 60 deals');
}
const handRow = (id: string) => prisma.simHand.findUniqueOrThrow({ where: { id }, select: { steps: true, version: true, status: true } });

describe('F1 — Full Hand: an action belongs to exactly one decision', () => {
  it('the view exposes the open decision index (= recorded Hero steps), null when Hero is not to act', async () => {
    const u = await newUser('f1s0');
    const { first, next } = await twoDecisionHand(u.agent);
    expect(first.decisionIndex).toBe(0);
    expect(next.decisionIndex).toBe(1);
    expect(((await handRow(next.id)).steps as unknown[]).length).toBe(1);
  });

  it('lost response after commit: a retry with the same id returns the stored feedback and changes nothing', async () => {
    const u = await newUser('f1s1');
    const { first, id, action, firstRes } = await twoDecisionHand(u.agent);
    const hand = await handRow(first.id);
    const db = await rows(u.id);
    const retry = (await u.agent.post(`/api/sim/hands/${first.id}/act`).send({ clientAttemptId: id, decisionIndex: 0, action }).expect(200)).body;
    expect(retry.duplicate).toBe(true);
    expect(retry.feedback?.grade ?? null).toBe(firstRes.feedback?.grade ?? null);
    expect(retry.view.decisionIndex).toBe(1);
    expect(await handRow(first.id)).toEqual(hand);
    expect(await rows(u.id)).toEqual(db);
  });

  it('a delayed retry with a NEW id after the next decision began is refused (409 stale_decision), not applied to the next decision', async () => {
    const u = await newUser('f1s2');
    const { first, action } = await twoDecisionHand(u.agent);
    const hand = await handRow(first.id);
    const db = await rows(u.id);
    await new Promise((r) => setTimeout(r, 200));
    const r = await u.agent.post(`/api/sim/hands/${first.id}/act`).send({ clientAttemptId: cid(), decisionIndex: 0, action });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('stale_decision');
    expect(await handRow(first.id)).toEqual(hand);
    expect(await rows(u.id)).toEqual(db);
  });

  it('an id reused for another decision, or a decision that is not open yet, is refused without changes', async () => {
    const u = await newUser('f1s3');
    const { first, id, action } = await twoDecisionHand(u.agent);
    const hand = await handRow(first.id);
    const db = await rows(u.id);
    const mismatch = await u.agent.post(`/api/sim/hands/${first.id}/act`).send({ clientAttemptId: id, decisionIndex: 1, action });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error).toBe('attempt_mismatch');
    const future = await u.agent.post(`/api/sim/hands/${first.id}/act`).send({ clientAttemptId: cid(), decisionIndex: 5, action });
    expect(future.status).toBe(409);
    expect(future.body.error).toBe('stale_decision');
    const missing = await u.agent.post(`/api/sim/hands/${first.id}/act`).send({ clientAttemptId: cid(), action });
    expect(missing.status).toBe(400);
    expect(await handRow(first.id)).toEqual(hand);
    expect(await rows(u.id)).toEqual(db);
  });

  it('concurrent retries of one action (same id) all succeed, and record one step and at most one attempt', async () => {
    const u = await newUser('f1s4');
    let v;
    do v = (await u.agent.post('/api/sim/hands').send({ tableSize: 2, stackBB: 10, mode: 'rated', feedback: 'guided' }).expect(201)).body;
    while (!v.legal);
    const id = cid();
    const action = v.legal.canCheck ? { type: 'check' } : { type: 'call' };
    const res = await Promise.all(Array.from({ length: 6 }, () => u.agent.post(`/api/sim/hands/${v.id}/act`).send({ clientAttemptId: id, decisionIndex: v.decisionIndex, action })));
    for (const r of res) expect(r.status).toBe(200);
    expect(res.filter((r) => !r.body.duplicate)).toHaveLength(1);
    const st = (await handRow(v.id)).steps as { clientAttemptId: string }[];
    expect(st.filter((s) => s.clientAttemptId === id)).toHaveLength(1);
    const atts = await prisma.decisionAttempt.findMany({ where: { userId: u.id, itemRef: { startsWith: `sim:${v.id}:` } } });
    expect(atts.length).toBeLessThanOrEqual(1);
    if (atts.length) expect(await prisma.ratingHistory.count({ where: { attemptId: atts[0]!.id, skill: 'overall' } })).toBeLessThanOrEqual(1);
  });

  it('concurrent different actions on one decision: exactly one wins, the others change nothing', async () => {
    const u = await newUser('f1s5');
    let v;
    do v = (await u.agent.post('/api/sim/hands').send({ tableSize: 2, stackBB: 10, mode: 'rated' }).expect(201)).body;
    while (!v.legal);
    const res = await Promise.all(['fold', 'fold', 'fold'].map((t) => u.agent.post(`/api/sim/hands/${v.id}/act`).send({ clientAttemptId: cid(), decisionIndex: v.decisionIndex, action: { type: t } })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of res.filter((x) => x.status !== 200)) expect(r.status).toBe(409);
    expect(((await handRow(v.id)).steps as unknown[]).length).toBe(1);
  });
});
