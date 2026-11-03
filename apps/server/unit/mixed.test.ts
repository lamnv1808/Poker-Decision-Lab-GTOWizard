import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  trainingSession: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
  simHand: { findFirst: vi.fn() }, realDecision: { count: vi.fn() },
  scenario: { findMany: vi.fn() }, decisionAttempt: { findMany: vi.fn() }, reviewItem: { findMany: vi.fn() },
  $queryRaw: vi.fn(), $transaction: vi.fn(),
}));
vi.mock('../src/db', () => ({ prisma: db }));
vi.mock('../src/auth', () => ({ requireUser: () => 'user' }));
vi.mock('../src/runs', () => ({ pickScenario: vi.fn() }));
vi.mock('../src/sim', () => ({ createSimHand: vi.fn() }));
vi.mock('../src/leakMemory', () => ({ recordLeakDrills: vi.fn() }));
import { errorHandler } from '../src/http';
import { mixedRouter } from '../src/mixed';
const app = express(); app.use(express.json()); app.use('/mixed', mixedRouter); app.use(errorHandler);
beforeEach(() => {
  vi.resetAllMocks();
  db.trainingSession.findFirst.mockResolvedValue({ config: {} });
  db.trainingSession.findUniqueOrThrow.mockResolvedValue({ id: 's', mode: 'practice', startedAt: new Date(), endedAt: null, config: { durationMin: 10, focus: ['replay'], served: [] } });
  db.simHand.findFirst.mockResolvedValue(null);
  db.realDecision.count.mockResolvedValue(0);
  db.scenario.findMany.mockResolvedValue([]);
  db.decisionAttempt.findMany.mockResolvedValue([]);
  db.reviewItem.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation((fn) => fn(db));
});
// Ported from the Codex P0 patch (mocked persistence; never touches a database).
it('ends an unavailable replay-only session without a red no_items error', async () => {
  const r = await request(app).post('/mixed/sessions/s/next').expect(200);
  expect(r.body).toMatchObject({ done: true, reason: 'no_items' });
  expect(db.trainingSession.update).toHaveBeenCalledOnce();
});
it('resumes an active hand without advancing the plan or losing history', async () => {
  db.simHand.findFirst.mockResolvedValue({ id: 'hand1' });
  const r = await request(app).post('/mixed/sessions/s/next').expect(200);
  expect(r.body).toMatchObject({ resumed: true, href: '/play/hand1?mixed=s', served: 0 });
  expect(db.trainingSession.update).not.toHaveBeenCalled();
});

it('refuses to create a replay-only session for a user without imported hands', async () => {
  db.trainingSession.create = vi.fn();
  const r = await request(app).post('/mixed/sessions').send({ focus: ['replay'] }).expect(400);
  expect(r.body.error).toBe('focus_unavailable');
  expect(db.trainingSession.create).not.toHaveBeenCalled();
});
