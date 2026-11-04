import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { cid, newUser } from './helpers';

type View = {
  decisionIndex: number | null;
  id: string;
  status: string;
  legal: { canCheck: boolean; canFold: boolean } | null;
  state: { board: string[]; street: string; players: { id: string; cards?: string[] }[] };
  config: { heroPos: string };
  heroCards: string[];
  decisions: { feedback?: unknown }[];
  review: { netBB: Record<string, number>; timeline: unknown[] } | null;
  progress: { decisionNumber: number; complete: boolean };
};
type Agent = Awaited<ReturnType<typeof newUser>>['agent'];

async function playToEnd(agent: Agent, v: View) {
  let view = v;
  let last: { feedback: unknown } | null = null;
  for (let i = 0; i < 30 && view.status === 'active' && view.legal; i++) {
    const action = view.legal.canCheck ? { type: 'check' } : { type: 'call' };
    const r = await agent.post(`/api/sim/hands/${view.id}/act`).send({ decisionIndex: view.decisionIndex ?? 0, clientAttemptId: cid(), action, confidence: 2, reasoning: 'test' }).expect(200);
    view = r.body.view;
    last = r.body;
  }
  return { view, last };
}

describe('Hero simulator API', () => {
  it('starts a hand without leaking Villain cards, the seed or future board cards', async () => {
    const u = await newUser('sim1');
    const r = await u.agent.post('/api/sim/hands').send({ tableSize: 6, stackBB: 40 }).expect(201);
    const v = r.body as View;
    const s = JSON.stringify(v);
    expect(s).not.toMatch(/"seed"|"holes"|"deal"|modelEquity/);
    for (const p of v.state.players) if (p.id !== v.config.heroPos) expect(p.cards).toBeUndefined();
    expect(v.heroCards).toHaveLength(2);
    const row = await prisma.simHand.findUniqueOrThrow({ where: { id: v.id } });
    expect(s).not.toContain(String(row.seed));
  });

  it('plays to the end, then shows the review; finished hands accept no more actions', async () => {
    const u = await newUser('sim2');
    const v = (await u.agent.post('/api/sim/hands').send({ tableSize: 3, stackBB: 30 }).expect(201)).body as View;
    let mid = v;
    if (v.legal) {
      mid = (await u.agent.post(`/api/sim/hands/${v.id}/act`).send({ decisionIndex: v.decisionIndex ?? 0, clientAttemptId: cid(), action: v.legal.canCheck ? { type: 'check' } : { type: 'call' } }).expect(200)).body.view;
      if (mid.status === 'active') for (const d of mid.decisions as { legal?: unknown }[]) expect(d.legal).toBeUndefined();
    }
    const { view } = await playToEnd(u.agent, mid);
    expect(view.status).toBe('complete');
    for (const d of view.decisions as { legal?: unknown }[]) expect(d.legal).toBeDefined();
    expect(view.review).not.toBeNull();
    expect(Object.values(view.review!.netBB).reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6);
    await u.agent.post(`/api/sim/hands/${view.id}/act`).send({ decisionIndex: view.decisionIndex ?? 0, clientAttemptId: cid(), action: { type: 'fold' } }).expect(409);
  });

  it('exam mode withholds feedback until the hand is over', async () => {
    const u = await newUser('sim3');
    for (let tries = 0; tries < 15; tries++) {
      const v = (await u.agent.post('/api/sim/hands').send({ tableSize: 2, stackBB: 100, feedback: 'exam' }).expect(201)).body as View;
      if (!v.legal) continue;
      const r = await u.agent.post(`/api/sim/hands/${v.id}/act`).send({ decisionIndex: v.decisionIndex ?? 0, clientAttemptId: cid(), action: v.legal.canCheck ? { type: 'check' } : { type: 'call' } }).expect(200);
      if (r.body.view.status === 'complete') continue;
      expect(r.body.feedback).toBeNull();
      expect(r.body.view.decisions[0].feedback).toBeUndefined();
      const { view } = await playToEnd(u.agent, r.body.view);
      expect(view.decisions[0]!.feedback).toBeDefined();
      return;
    }
    throw new Error('no multi-decision hand found');
  });

  it('is idempotent per clientAttemptId, rejects illegal actions, and is private to its owner', async () => {
    const u = await newUser('sim4');
    const other = await newUser('sim4b');
    let v: View;
    do v = (await u.agent.post('/api/sim/hands').send({ tableSize: 2, stackBB: 100 }).expect(201)).body;
    while (!v.legal || v.legal.canCheck);
    await u.agent.post(`/api/sim/hands/${v.id}/act`).send({ decisionIndex: v.decisionIndex ?? 0, clientAttemptId: cid(), action: { type: 'check' } }).expect(400);
    const id = cid();
    const a = await u.agent.post(`/api/sim/hands/${v.id}/act`).send({ decisionIndex: v.decisionIndex ?? 0, clientAttemptId: id, action: { type: 'call' } }).expect(200);
    const b = await u.agent.post(`/api/sim/hands/${v.id}/act`).send({ decisionIndex: v.decisionIndex ?? 0, clientAttemptId: id, action: { type: 'call' } }).expect(200);
    expect(b.body.duplicate).toBe(true);
    expect(b.body.view.decisions.length).toBe(a.body.view.decisions.length);
    await other.agent.get(`/api/sim/hands/${v.id}`).expect(404);
    await other.agent.post(`/api/sim/hands/${v.id}/act`).send({ decisionIndex: v.decisionIndex ?? 0, clientAttemptId: cid(), action: { type: 'fold' } }).expect(404);
  });

  it('always deals a hand in which Hero has at least one decision', async () => {
    const u = await newUser('sim8');
    for (let i = 0; i < 25; i++) {
      const v = (await u.agent.post('/api/sim/hands').send({ tableSize: 6 }).expect(201)).body as View;
      expect(v.status).toBe('active');
      expect(v.legal).not.toBeNull();
    }
  });

  it('lists unfinished hands for resuming on another device', async () => {
    const u = await newUser('sim5');
    let v: View;
    do v = (await u.agent.post('/api/sim/hands').send({ tableSize: 6 }).expect(201)).body;
    while (v.status !== 'active');
    const list = await u.agent.get('/api/sim/hands/active').expect(200);
    expect(list.body.map((x: { id: string }) => x.id)).toContain(v.id);
  });

  it('records solver-graded push/fold decisions on the strategy track; replays and branches are never recorded', async () => {
    const u = await newUser('sim6');
    let found: string | null = null;
    for (let i = 0; i < 40 && !found; i++) {
      const v = (await u.agent.post('/api/sim/hands').send({ tableSize: 2, stackBB: 10, mode: 'rated' }).expect(201)).body as View;
      if (!v.legal) continue;
      const r = await u.agent.post(`/api/sim/hands/${v.id}/act`).send({ decisionIndex: v.decisionIndex ?? 0, clientAttemptId: cid(), action: { type: 'fold' } }).expect(200);
      if (r.body.feedback?.basis === 'solverEv') {
        expect(r.body.feedback.track).toBe('strategy');
        found = v.id;
      }
    }
    expect(found).not.toBeNull();
    const att = await prisma.decisionAttempt.findMany({ where: { userId: u.id, itemRef: { startsWith: `sim:${found}:` } } });
    expect(att).toHaveLength(1);
    expect(att[0]!.track).toBe('strategy');
    expect(att[0]!.ratingApplied).toBe(true);
    const before = await prisma.decisionAttempt.count({ where: { userId: u.id } });
    const rep = (await u.agent.post(`/api/sim/hands/${found}/replay`).expect(201)).body as View;
    if (rep.legal) await u.agent.post(`/api/sim/hands/${rep.id}/act`).send({ decisionIndex: rep.decisionIndex ?? 0, clientAttemptId: cid(), action: { type: 'fold' } }).expect(200);
    const br = await u.agent.post(`/api/sim/hands/${found}/branch`).send({ decisionIndex: 0, action: { type: 'call' } });
    expect([201, 400]).toContain(br.status); // calling may be illegal if the SB folded first
    expect(await prisma.decisionAttempt.count({ where: { userId: u.id } })).toBe(before);
    const fam = await u.agent.get(`/api/sim/hands/${found}/family`).expect(200);
    expect(fam.body.length).toBeGreaterThanOrEqual(2);
  });

  it('Tier 2: heads-up river decisions get an exact model evaluation, recorded but never rated; reasons are checked', async () => {
    const u = await newUser('simtier');
    let seen: { fb: { tier: string; track: string; model?: { options: { key: string; evBB: number }[]; bestKey: string }; explain?: { recommended: { en: string } }; reasoning?: { checks: { key: string; verdict: string }[] } }; id: string } | null = null;
    for (let h = 0; h < 30 && !seen; h++) {
      let v = (await u.agent.post('/api/sim/hands').send({ tableSize: 2, stackBB: 50, mode: 'rated' }).expect(201)).body as View;
      for (let i = 0; i < 20 && v.status === 'active' && v.legal && !seen; i++) {
        const river = v.state.board.length === 5;
        const action = v.legal.canCheck ? { type: 'check' } : { type: 'call' };
        const r = await u.agent.post(`/api/sim/hands/${v.id}/act`).send({ decisionIndex: v.decisionIndex ?? 0, clientAttemptId: cid(), action, ...(river ? { reasons: ['protection', 'potOdds'] } : {}) }).expect(200);
        if (river && r.body.feedback?.tier === 'model') seen = { fb: r.body.feedback, id: v.id };
        v = r.body.view;
      }
    }
    expect(seen).not.toBeNull();
    const fb = seen!.fb;
    expect(fb.track).toBe('model');
    expect(fb.model!.options.length).toBeGreaterThanOrEqual(2);
    expect(fb.model!.options.find((o) => o.key === fb.model!.bestKey)!.evBB).toBe(Math.max(...fb.model!.options.map((o) => o.evBB)));
    expect(fb.explain!.recommended.en.length).toBeGreaterThan(0);
    // "protection" on the river is contradicted by the facts of the spot
    expect(fb.reasoning!.checks.find((c) => c.key === 'protection')!.verdict).toBe('contradicted');
    const att = await prisma.decisionAttempt.findMany({ where: { userId: u.id, track: 'model' } });
    expect(att.length).toBeGreaterThanOrEqual(1);
    expect(att.every((a) => !a.ratingApplied)).toBe(true);
    // the stored feedback is what a rebuild shows (cached, identical)
    const again = (await u.agent.get(`/api/sim/hands/${seen!.id}`).expect(200)).body;
    const dv = again.decisions.find((d: { feedback?: { tier?: string } }) => d.feedback?.tier === 'model');
    expect(dv.feedback.model.bestKey).toBe(fb.model!.bestKey);
  });

  it('a finished hand reveals every opponent and labels never-dealt cards as hypothetical', async () => {
    const u = await newUser('simreveal');
    const v = (await u.agent.post('/api/sim/hands').send({ tableSize: 6, stackBB: 40 }).expect(201)).body as View;
    // fold at once: the hand ends early for Hero, the simulator plays on without Hero
    const r = await u.agent.post(`/api/sim/hands/${v.id}/act`).send({ decisionIndex: v.decisionIndex ?? 0, clientAttemptId: cid(), action: v.legal!.canCheck ? { type: 'check' } : { type: 'fold' } }).expect(200);
    let view = r.body.view;
    for (let i = 0; i < 30 && view.status === 'active' && view.legal; i++) view = (await u.agent.post(`/api/sim/hands/${view.id}/act`).send({ decisionIndex: view.decisionIndex ?? 0, clientAttemptId: cid(), action: view.legal.canCheck ? { type: 'check' } : { type: 'fold' } }).expect(200)).body.view;
    expect(view.review.revealed.opponents).toHaveLength(5);
    const dealt = view.state.board.length;
    expect(view.review.revealed.runout.length).toBe(5 - dealt); // hypothetical only for undealt streets
    expect(new Set([...view.review.revealed.runout, ...view.state.board]).size).toBe(5);
  });

  it('refuses branching or replaying a hand that is still in progress', async () => {
    const u = await newUser('sim7');
    let v: View;
    do v = (await u.agent.post('/api/sim/hands').send({ tableSize: 6, stackBB: 100 }).expect(201)).body;
    while (v.status !== 'active');
    await u.agent.post(`/api/sim/hands/${v.id}/replay`).expect(409);
    await u.agent.post(`/api/sim/hands/${v.id}/branch`).send({ decisionIndex: 0, action: { type: 'fold' } }).expect(409);
  });
});
