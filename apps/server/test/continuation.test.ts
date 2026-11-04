import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { cid, ensureSeeded, newUser } from './helpers';

type Agent = Awaited<ReturnType<typeof newUser>>['agent'];
type View = { id: string; decisionIndex: number | null; status: string; legal: { canCheck: boolean; canFold: boolean } | null; state: { board: string[]; players: { id: string; cards?: string[] }[] }; config: { heroPos: string }; origin: { kind: string; flop: string | null }; review: null | { timeline: { villain?: { source: string } }[]; winners: unknown[]; endedBy: string }; decisions: { feedback?: { assessment?: string; graded: boolean; basis: string; track: string | null } }[] };

async function playOut(agent: Agent, v: View, pick: (l: NonNullable<View['legal']>) => object = (l) => (l.canCheck ? { type: 'check' } : { type: 'call' })) {
  let view = v;
  for (let i = 0; i < 30 && view.status === 'active' && view.legal; i++) view = (await agent.post(`/api/sim/hands/${view.id}/act`).send({ decisionIndex: view.decisionIndex ?? 0, clientAttemptId: cid(), action: pick(view.legal) }).expect(200)).body.view;
  return view;
}

describe('continuation, Branch Challenge, hidden info, solver-flop table', () => {
  it('a finished curated scenario continues as a full hand to a terminal state', async () => {
    await ensureSeeded();
    const u = await newUser('cont1');
    let continued = 0;
    for (let i = 0; i < 12 && continued < 2; i++) {
      const r = await u.agent.post('/api/runs/next').send({ kind: 'hero', pool: 'new' });
      if (r.status !== 201) break;
      let run = r.body;
      for (let k = 0; k < 10 && run.status !== 'complete'; k++) {
        if (run.status === 'decision') run = (await u.agent.post(`/api/runs/${run.runId}/act`).send({ nodeKey: run.nodeKey, clientAttemptId: cid(), action: run.legal.canCheck ? { type: 'check' } : { type: 'call' } }).expect(200)).body.view;
        else run = (await u.agent.post(`/api/runs/${run.runId}/answer`).send({ nodeKey: run.nodeKey, clientAttemptId: cid(), answer: run.question.choices ? { choiceId: run.question.choices[0].id } : run.question.type === 'rangeGrid' ? { classes: ['AA'] } : { value: 10 } }).expect(200)).body.view;
      }
      const c = await u.agent.post(`/api/sim/from-run/${run.runId}`);
      if (c.status === 409) continue; // the hand was already over
      expect(c.status).toBe(201);
      const v = c.body as View;
      expect(v.origin.kind).toBe('scenario');
      for (const p of v.state.players) if (p.id !== v.config.heroPos) expect(p.cards).toBeUndefined();
      const end = await playOut(u.agent, v);
      expect(end.status).toBe('complete');
      expect(end.review!.winners.length).toBeGreaterThan(0);
      // the same run continues to the same hand (no duplicates)
      const again = await u.agent.post(`/api/sim/from-run/${run.runId}`).expect(200);
      expect(again.body.id).toBe(v.id);
      continued++;
    }
    expect(continued).toBeGreaterThan(0);
  }, 60_000);

  it('hidden cards and runout are only available after the hand, and Villain branches are never recorded', async () => {
    const u = await newUser('cont2');
    let v: View;
    do v = (await u.agent.post('/api/sim/hands').send({ tableSize: 2, stackBB: 100 }).expect(201)).body;
    while (v.status !== 'active');
    await u.agent.get(`/api/sim/hands/${v.id}/hidden`).expect(409);
    const end = await playOut(u.agent, v, (l) => (l.canFold ? { type: 'fold' } : { type: 'check' }));
    const hidden = (await u.agent.get(`/api/sim/hands/${end.id}/hidden`).expect(200)).body;
    expect(hidden.opponents[0].cards).toHaveLength(2);
    expect(hidden.runout.length).toBe(5 - end.state.board.length);
    expect(hidden.label.en).toMatch(/hypothetical/);
    const row = await prisma.simHand.findUniqueOrThrow({ where: { id: end.id } });
    const ev = ((await u.agent.get(`/api/sim/hands/${end.id}`).expect(200)).body as View).review!.timeline.findIndex((x) => x.villain && x.villain.source !== 'scripted');
    const before = await prisma.decisionAttempt.count({ where: { userId: u.id } });
    if (ev >= 0) {
      const tl = ((await u.agent.get(`/api/sim/hands/${end.id}`).expect(200)).body as View).review!.timeline;
      const chosen = (tl[ev]!.villain as unknown as { chosen: string }).chosen;
      const alt = ['fold', 'passive', 'aggressive'].find((c) => c !== chosen)!;
      const b = await u.agent.post(`/api/sim/hands/${end.id}/branch-villain`).send({ historyIndex: ev, choice: alt });
      expect([201, 400]).toContain(b.status);
      if (b.status === 201) {
        expect(b.body.kind).toBe('branch');
        await playOut(u.agent, b.body);
      }
    }
    expect(await prisma.decisionAttempt.count({ where: { userId: u.id } })).toBe(before);
    expect(row.status).toBe('complete');
  });

  it('solver-flop table: flop decisions are solver-verified (strategy track) when the exact spot is reached', async () => {
    const u = await newUser('cont3');
    let solverGraded = 0;
    for (let i = 0; i < 4; i++) {
      const v = (await u.agent.post('/api/sim/hands').send({ table: 'solverFlop', heroPos: 'BB', mode: 'rated' }).expect(201)).body as View;
      expect(v.origin.kind).toBe('solverFlop');
      expect(v.state.board).toHaveLength(3); // scripted preflop, Hero acts first on the flop
      // the solved tree's sizes are offered up front — structure only, never frequencies or EVs
      const opts = (v as unknown as { current: { solverOptions: { key: string; action: { type: string; amount?: number } }[] } }).current.solverOptions;
      expect(opts.map((o) => o.key)).toContain('Check');
      expect(JSON.stringify(opts)).not.toMatch(/"f"|"ev"|freq/);
      const bet = opts.find((o) => o.action.type === 'bet')!;
      const choice = i % 2 ? bet.action : { type: 'check' };
      const r = await u.agent.post(`/api/sim/hands/${v.id}/act`).send({ decisionIndex: v.decisionIndex ?? 0, clientAttemptId: cid(), action: choice }).expect(200);
      const fb = r.body.feedback;
      if (fb?.assessment === 'solverVerified') {
        expect(fb.track).toBe('strategy');
        expect(fb.graded).toBe(true);
        solverGraded++;
        const att = await prisma.decisionAttempt.findFirstOrThrow({ where: { userId: u.id, itemRef: { startsWith: `sim:${v.id}:` } } });
        expect(att.familyId).toMatch(/^pfl:/);
        expect(att.ratingApplied).toBe(true);
      }
    }
    expect(solverGraded).toBeGreaterThanOrEqual(1);
  });
});
