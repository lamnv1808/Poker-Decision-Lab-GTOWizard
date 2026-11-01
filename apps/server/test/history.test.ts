import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { cid, ensureSeeded, newUser } from './helpers';

type Agent = Awaited<ReturnType<typeof newUser>>['agent'];
type RunView = { runId: string; status: 'decision' | 'question' | 'complete'; legal: { canCheck: boolean; canFold: boolean } | null; question: { type: string; choices: { id: string }[] | null } | null; scenario?: { id: string } };

/** Play a scenario run to its end with simple legal answers. */
async function finish(agent: Agent, v: RunView) {
  let view = v;
  for (let i = 0; i < 20 && view.status !== 'complete'; i++) {
    if (view.status === 'decision') {
      const action = view.legal!.canCheck ? { type: 'check' } : { type: 'fold' };
      view = (await agent.post(`/api/runs/${view.runId}/act`).send({ clientAttemptId: cid(), action }).expect(200)).body.view;
    } else {
      const q = view.question!;
      const answer = q.choices ? { choiceId: q.choices[0]!.id } : q.type === 'rangeGrid' ? { classes: ['AA'] } : { value: 10 };
      view = (await agent.post(`/api/runs/${view.runId}/answer`).send({ clientAttemptId: cid(), answer }).expect(200)).body.view;
    }
  }
  return view;
}

describe('scenario history and New Only selection', () => {
  it('New Only never repeats a completed scenario while unseen ones exist, then says the pool is exhausted', async () => {
    await ensureSeeded();
    const u = await newUser('hist1');
    const total = await prisma.scenario.count({ where: { published: true, mode: 'hero' } });
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const r = await u.agent.post('/api/runs/next').send({ kind: 'hero', pool: 'new' });
      if (r.status === 409) {
        expect(r.body.error).toBe('pool_exhausted');
        expect(r.body.counts.completed).toBe(total);
        break;
      }
      expect(r.status).toBe(201);
      const run = await prisma.scenarioRun.findUniqueOrThrow({ where: { id: r.body.runId }, include: { scenarioVersion: true } });
      const sid = run.scenarioVersion.scenarioId;
      expect(seen.has(sid)).toBe(false);
      seen.add(sid);
      const end = await finish(u.agent, r.body);
      expect(end.status).toBe('complete');
    }
    expect(seen.size).toBe(total);
    // status persists server-side (any device): the summary and the list both see it
    const sum = (await u.agent.get('/api/history/summary').expect(200)).body;
    expect(sum.hero.completed).toBe(total);
    const list = (await u.agent.get('/api/scenarios?mode=hero').expect(200)).body as { status: string }[];
    expect(list.every((x) => x.status !== 'new')).toBe(true);
  }, 120_000);

  it('replaying a completed scenario is practice: it never adds rated Elo', async () => {
    const u = await newUser('hist2');
    const first = (await u.agent.post('/api/runs/next').send({ kind: 'hero', pool: 'new', mode: 'rated' }).expect(201)).body;
    await finish(u.agent, first);
    const run = await prisma.scenarioRun.findUniqueOrThrow({ where: { id: first.runId }, include: { scenarioVersion: true } });
    const again = (await u.agent.post('/api/runs').send({ scenarioId: run.scenarioVersion.scenarioId, mode: 'rated' }).expect(201)).body;
    expect(again.mode).toBe('practice');
    expect(again.replay).toBe(true);
    expect(again.ratedBlocked).toBe(true);
    const before = await prisma.ratingHistory.count({ where: { userId: u.id } });
    await finish(u.agent, again);
    expect(await prisma.ratingHistory.count({ where: { userId: u.id } })).toBe(before);
  });

  it('reset hides completion history for selection but keeps attempts and ratings', async () => {
    const u = await newUser('hist3');
    const first = (await u.agent.post('/api/runs/next').send({ kind: 'villain', pool: 'new' }).expect(201)).body;
    await finish(u.agent, first);
    const attempts = await prisma.decisionAttempt.count({ where: { userId: u.id } });
    await u.agent.post('/api/history/reset').send({}).expect(400);
    await u.agent.post('/api/history/reset').send({ confirm: true }).expect(200);
    const sum = (await u.agent.get('/api/history/summary').expect(200)).body;
    expect(sum.villain.completed).toBe(0);
    expect(await prisma.decisionAttempt.count({ where: { userId: u.id } })).toBe(attempts);
    expect(await prisma.scenarioHistory.count({ where: { userId: u.id } })).toBeGreaterThan(0);
  });

  it('simulated hands: no exact repeats, and strategic situations do not repeat within the recent window', async () => {
    const u = await newUser('hist4');
    const fps: string[] = [];
    for (let i = 0; i < 30; i++) {
      const v = (await u.agent.post('/api/sim/hands').send({ tableSize: 6, stackBB: 40, archetype: 'tag' }).expect(201)).body;
      const row = await prisma.simHand.findUniqueOrThrow({ where: { id: v.id } });
      fps.push(row.fingerprint!);
    }
    const keys = await prisma.simHand.findMany({ where: { userId: u.id }, select: { exactKey: true } });
    expect(new Set(keys.map((k) => k.exactKey)).size).toBe(keys.length);
    // with 6 seats x 169 hand classes available, 30 deals should be (nearly) all distinct situations
    expect(new Set(fps).size).toBeGreaterThanOrEqual(29);
  });
});
