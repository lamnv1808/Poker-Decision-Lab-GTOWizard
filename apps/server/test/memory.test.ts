import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { importV2 } from '../src/realhands/import';
import { cid, ensureSeeded, newUser } from './helpers';
import { buildV2Fixture } from './v2fixture';

/**
 * Leak memory (D3) + Today plan (D4). The V2 fixture is too small for any pattern verdict, so the
 * test adds synthetic decisions (cloned from a real fixture decision, only context columns changed):
 * 100 unopened UTG spots at 25–40BB with 60 opens (far above the 10–24% band) and 5 solver-verified
 * SB push/fold folds at 8BB.
 */
let a: Awaited<ReturnType<typeof newUser>>;

async function clone(userId: string, n: number, set: string, where: object = {}) {
  const src = await prisma.realDecision.findFirstOrThrow({ where: { userId, status: 'accepted', ...where } });
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RealDecision" SELECT (jsonb_populate_record(null::"RealDecision", to_jsonb(d) || ${set})).* FROM "RealDecision" d, generate_series(1, ${n}) g WHERE d.id = $1`,
    src.id,
  );
}

beforeAll(async () => {
  await ensureSeeded();
  a = await newUser('memA');
  await importV2(a.id, buildV2Fixture().dir);
  await clone(
    a.id,
    100,
    `jsonb_build_object('id', gen_random_uuid()::text, 'externalId', 'syn-rfi-' || g, 'street', 'preflop', 'position', 'UTG', 'actionContext', 'unopened', 'stackBucket', '25-40', 'heroAction', CASE WHEN g <= 60 THEN 'raise' ELSE 'fold' END, 'formatGroup', 'regular', 'multiway', false, 'pfAudit', null, 'contextV', 2, 'status', 'accepted', 'playedAt', to_jsonb(timestamp '2026-10-01' + g * interval '1 hour'))`,
  );
  await clone(
    a.id,
    5,
    `jsonb_build_object('id', gen_random_uuid()::text, 'externalId', 'syn-pf-' || g, 'street', 'preflop', 'position', 'SB', 'actionContext', 'unopened', 'stackBucket', '<=10', 'heroAction', 'fold', 'formatGroup', 'regular', 'contextV', 2, 'status', 'accepted', 'playedAt', to_jsonb(timestamp '2026-10-02' + g * interval '1 hour'), 'pfAudit', jsonb_build_object('role', 'sbShove', 'stackBB', 8, 'deadBB', 0, 'exactStackBB', 8, 'heroClass', 'A8o', 'heroAction', 'fold', 'grade', 'mistake', 'evLossBB', 0.4, 'bestAction', 'shove', 'frequency', 1, 'evAggressive', 0.4))`,
    { requiredEq: { not: null } }, // a spot facing a bet, so fold is a legal replay answer
  );
});

const memory = async () => (await a.agent.get('/api/memory').expect(200)).body as { leaks: { leakKey: string; status: string; evidence: string; timesDetected: number; snapshots: unknown[]; examples: string[]; severity: number }[] };

describe('leak memory (D3)', () => {
  it('remembers detected leaks with their evidence class; refreshes are idempotent', async () => {
    const m = await memory();
    const rfi = m.leaks.find((l) => l.leakKey === 'pattern:rfi:UTG')!;
    const pf = m.leaks.find((l) => l.leakKey === 'pf:sbShove:tooTight:6.5–10')!;
    expect(rfi).toMatchObject({ status: 'active', evidence: 'pattern', timesDetected: 1 });
    expect(pf).toMatchObject({ status: 'active', evidence: 'solver' });
    expect(rfi.examples.length).toBeGreaterThan(0);
    // patterns that were never flagged are not memories
    expect(m.leaks.every((l) => l.evidence !== 'pattern' || l.leakKey === 'pattern:rfi:UTG')).toBe(true);
    for (const l of m.leaks) expect(l.severity).toBeGreaterThanOrEqual(0), expect(l.severity).toBeLessThanOrEqual(1);
    const snaps = await prisma.leakSnapshot.count({ where: { memory: { userId: a.id } } });
    await a.agent.post('/api/memory/refresh').expect(200);
    await a.agent.post('/api/memory/refresh').expect(200);
    expect(await prisma.leakSnapshot.count({ where: { memory: { userId: a.id } } })).toBe(snaps);
    expect((await memory()).leaks.find((l) => l.leakKey === 'pattern:rfi:UTG')!.timesDetected).toBe(1);
  });

  it('is private to its owner', async () => {
    const b = await newUser('memB');
    const m = (await b.agent.get('/api/memory').expect(200)).body;
    expect(m.leaks).toEqual([]);
    const plan = (await b.agent.get('/api/daily/plan?minutes=5').expect(200)).body;
    expect(plan.focus).toEqual([]);
    expect(plan.items.length).toBeGreaterThan(0); // new material only, no replays (no real hands)
    expect(plan.items.some((i: { type: string }) => i.type === 'replay')).toBe(false);
  });
});

describe('hand review integration', () => {
  it('replaying an own push/fold spot shows the solver chip-EV verdict without rating it', async () => {
    const d = await prisma.realDecision.findFirstOrThrow({ where: { userId: a.id, externalId: 'syn-pf-1' } });
    const r = (await a.agent.post(`/api/real/decisions/${d.id}/answer`).send({ clientAttemptId: cid(), action: { type: 'fold' }, reasoning: 'too weak', confidence: 2 }).expect(200)).body;
    expect(r.pushFold).toMatchObject({ class: 'verified', role: 'sbShove', stackBB: 8, heroClass: 'A8o', bestAction: 'shove' });
    expect(r.pushFold.evLossBB).toBeGreaterThan(0);
    const att = await prisma.decisionAttempt.findFirstOrThrow({ where: { userId: a.id, itemRef: { endsWith: d.id } } });
    expect(att.ratingApplied).toBe(false);
  });
});

describe('Today plan (D4)', () => {
  it('builds 5/10/20-minute plans from the memory and rejects other lengths', async () => {
    const mine = new Set((await prisma.realDecision.findMany({ where: { userId: a.id }, select: { id: true } })).map((d) => d.id));
    for (const minutes of [5, 10, 20]) {
      const p = (await a.agent.get(`/api/daily/plan?minutes=${minutes}`).expect(200)).body;
      expect(p.minutes).toBe(minutes);
      expect(p.focus.length).toBe(minutes === 5 ? 1 : 2); // only two leaks exist
      expect(p.items[0].reason).toBe('leak');
      for (const i of p.items) if (i.params?.decisionId) expect(mine.has(i.params.decisionId)).toBe(true);
      expect(p.ranking[0].priority.score).toBeGreaterThan(0);
    }
    const p20 = (await a.agent.get('/api/daily/plan?minutes=20').expect(200)).body;
    expect(p20.items.some((i: { type: string; params?: { role?: string; range?: string } }) => i.type === 'gto' && i.params?.role === 'sbShove' && i.params?.range === '7-11')).toBe(true);
    await a.agent.get('/api/daily/plan?minutes=7').expect(400);
  });

  it('a daily session serves the plan in order and schedules a review of each drilled leak', async () => {
    const plan = (await a.agent.get('/api/daily/plan?minutes=20').expect(200)).body;
    const s = (await a.agent.post('/api/daily/start').send({ minutes: 20, mode: 'practice' }).expect(201)).body;
    let answered = false;
    for (let i = 0; i < plan.items.length && !answered; i++) {
      const r = (await a.agent.post(`/api/mixed/sessions/${s.id}/next`).expect(200)).body;
      expect(r.planned.index).toBe(i + 1);
      expect(r.planned.leakKey ?? undefined).toBe(plan.items[i].leakKey);
      if (r.type !== plan.items[i].type) expect(['scenario', 'villain']).toContain(plan.items[i].type); // only an empty scenario pool may fall back
      if (plan.items[i].params?.decisionId) expect(r.href).toContain(`decision=${plan.items[i].params.decisionId}`);
      // finish any dealt hand so the next call moves on
      await prisma.simHand.updateMany({ where: { sessionId: s.id, status: 'active' }, data: { status: 'abandoned' } });
      if (r.type === 'gto' && r.planned.leakKey === 'pf:sbShove:tooTight:6.5–10') {
        expect(r.href).toContain('role=sbShove');
        const spot = (await a.agent.get('/api/gto/spot?minStack=7&maxStack=11&role=sbShove').expect(200)).body;
        await a.agent.post('/api/gto/answer').send({ token: spot.token, action: 'shove', clientAttemptId: cid(), sessionId: s.id }).expect(200);
        answered = true;
      }
    }
    expect(answered).toBe(true);
    await a.agent.post(`/api/mixed/sessions/${s.id}/end`).expect(200);
    await a.agent.post(`/api/mixed/sessions/${s.id}/end`).expect(200); // second end records nothing more
    const rev = await prisma.reviewItem.findUniqueOrThrow({ where: { userId_itemType_itemRef: { userId: a.id, itemType: 'leak', itemRef: 'pf:sbShove:tooTight:6.5–10' } } });
    expect(rev.dueAt.getTime()).toBeGreaterThan(Date.now());
    const mem = await prisma.leakMemory.findUniqueOrThrow({ where: { userId_leakKey: { userId: a.id, leakKey: 'pf:sbShove:tooTight:6.5–10' } } });
    expect(mem.drillCount).toBe(1);
    const sum = (await a.agent.get(`/api/mixed/sessions/${s.id}/summary`).expect(200)).body;
    const leak = sum.daily.leaks.find((l: { leakKey: string }) => l.leakKey === 'pf:sbShove:tooTight:6.5–10');
    expect(leak.total).toBe(1);
  });

  it('a pattern back inside its band is marked resolved, not deleted', async () => {
    await prisma.$executeRawUnsafe(`UPDATE "RealDecision" SET "heroAction" = 'fold' WHERE "userId" = $1 AND "externalId" LIKE 'syn-rfi-%' AND substring("externalId" from 9)::int > 15`, a.id);
    await a.agent.post('/api/memory/refresh').expect(200);
    const rfi = (await memory()).leaks.find((l) => l.leakKey === 'pattern:rfi:UTG')!;
    expect(rfi.status).toBe('resolved');
    expect(rfi.snapshots.length).toBeGreaterThanOrEqual(2);
    const plan = (await a.agent.get('/api/daily/plan?minutes=20').expect(200)).body;
    expect(plan.focus.some((f: { leakKey: string }) => f.leakKey === 'pattern:rfi:UTG')).toBe(false);
  });
});
