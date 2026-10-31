import type { Scenario } from '@pdl/core';
import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from './auth';
import { prisma } from './db';
import { notFound, parse } from './http';

async function scenarioCards(ids: string[]) {
  if (!ids.length) return new Map<string, unknown>();
  const sc = await prisma.scenario.findMany({ where: { id: { in: ids }, published: true } });
  const versions = await prisma.scenarioVersion.findMany({ where: { OR: sc.map((s) => ({ scenarioId: s.id, version: s.currentVersion })) }, include: { source: true } });
  return new Map(
    versions.map((v) => {
      const d = v.definition as unknown as Scenario;
      return [v.scenarioId, { id: v.scenarioId, mode: d.mode, module: d.module, title: d.title, difficulty: v.difficulty, classification: v.source.classification }];
    }),
  );
}

export const reviewRouter = Router();

reviewRouter.get('/queue', async (req, res) => {
  const userId = requireUser(req);
  const q = parse(z.object({ filter: z.enum(['due', 'weak', 'bookmarked', 'missed', 'new', 'mixed']).default('due'), limit: z.coerce.number().int().min(1).max(50).default(20) }), req.query);
  const now = new Date();
  type Item = { kind: 'scenario' | 'quiz' | 'imported'; ref: string; reason: string; dueAt?: Date | null; mastery?: number | null; lastGrade?: string | null };
  const items: Item[] = [];
  const reviewRows = (where: object, orderBy: object) => prisma.reviewItem.findMany({ where: { userId, ...where }, orderBy, take: q.limit });
  if (q.filter === 'due' || q.filter === 'mixed')
    for (const r of await reviewRows({ dueAt: { lte: now } }, { dueAt: 'asc' })) items.push({ kind: r.itemType as Item['kind'], ref: r.itemRef, reason: 'due', dueAt: r.dueAt, mastery: r.mastery, lastGrade: r.lastGrade });
  if (q.filter === 'weak' || q.filter === 'mixed')
    for (const r of await reviewRows({ mastery: { lt: 0.6 } }, { mastery: 'asc' })) items.push({ kind: r.itemType as Item['kind'], ref: r.itemRef, reason: 'weak', dueAt: r.dueAt, mastery: r.mastery, lastGrade: r.lastGrade });
  if (q.filter === 'bookmarked' || q.filter === 'mixed')
    for (const b of await prisma.bookmark.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: q.limit })) items.push({ kind: 'scenario', ref: b.scenarioId, reason: 'bookmarked' });
  if (q.filter === 'missed' || q.filter === 'mixed') {
    const missed = await prisma.decisionAttempt.findMany({ where: { userId, isError: true }, orderBy: { createdAt: 'desc' }, take: 100, select: { itemRef: true, attemptType: true, grade: true } });
    for (const m of missed) {
      const kind: Item['kind'] = m.attemptType === 'quiz' ? 'quiz' : m.attemptType === 'imported' ? 'imported' : 'scenario';
      const ref = kind === 'scenario' ? m.itemRef.split(':')[0]! : kind === 'quiz' ? m.itemRef.split(':')[1]! : m.itemRef;
      items.push({ kind, ref, reason: 'missed', lastGrade: m.grade });
    }
  }
  if (q.filter === 'new' || q.filter === 'mixed') {
    const attempted = new Set((await prisma.decisionAttempt.findMany({ where: { userId, attemptType: { in: ['decision', 'question'] } }, select: { itemRef: true }, distinct: ['itemRef'] })).map((a) => a.itemRef.split(':')[0]));
    const all = await prisma.scenario.findMany({ where: { published: true }, orderBy: { module: 'asc' } });
    for (const s of all.filter((s) => !attempted.has(s.id)).slice(0, q.limit)) items.push({ kind: 'scenario', ref: s.id, reason: 'new' });
  }
  // de-duplicate, keep first reason
  const seen = new Set<string>();
  const unique = items.filter((i) => (seen.has(`${i.kind}:${i.ref}`) ? false : (seen.add(`${i.kind}:${i.ref}`), true)));
  const cards = await scenarioCards(unique.filter((i) => i.kind === 'scenario').map((i) => i.ref));
  const hands = await prisma.handHistory.findMany({ where: { userId, id: { in: unique.filter((i) => i.kind === 'imported').map((i) => i.ref.split(':')[0]!) } }, select: { id: true, externalHandId: true, heroPosition: true, playedAt: true } });
  const handMap = new Map(hands.map((h) => [h.id, h]));
  res.json(
    unique
      .filter((i) => i.kind !== 'scenario' || cards.has(i.ref))
      .slice(0, q.limit)
      .map((i) => ({ ...i, scenario: i.kind === 'scenario' ? cards.get(i.ref) : null, hand: i.kind === 'imported' ? (handMap.get(i.ref.split(':')[0]!) ?? null) : null })),
  );
});

export const bookmarksRouter = Router();
bookmarksRouter.get('/', async (req, res) => {
  const userId = requireUser(req);
  res.json(await prisma.bookmark.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }));
});
bookmarksRouter.put('/:scenarioId', async (req, res) => {
  const userId = requireUser(req);
  const scenarioId = String(req.params.scenarioId);
  if (!(await prisma.scenario.findUnique({ where: { id: scenarioId } }))) throw notFound('Scenario not found');
  await prisma.bookmark.upsert({ where: { userId_scenarioId: { userId, scenarioId } }, create: { userId, scenarioId }, update: {} });
  res.json({ ok: true });
});
bookmarksRouter.delete('/:scenarioId', async (req, res) => {
  const userId = requireUser(req);
  await prisma.bookmark.deleteMany({ where: { userId, scenarioId: String(req.params.scenarioId) } });
  res.json({ ok: true });
});

export const notesRouter = Router();
notesRouter.get('/', async (req, res) => {
  const userId = requireUser(req);
  const q = parse(z.object({ targetType: z.enum(['scenario', 'hand', 'attempt']).optional(), targetRef: z.string().optional() }), req.query);
  res.json(await prisma.userNote.findMany({ where: { userId, targetType: q.targetType, targetRef: q.targetRef }, orderBy: { updatedAt: 'desc' }, take: 200 }));
});
notesRouter.post('/', async (req, res) => {
  const userId = requireUser(req);
  const b = parse(z.object({ targetType: z.enum(['scenario', 'hand', 'attempt']), targetRef: z.string().min(1).max(200), body: z.string().trim().min(1).max(5000) }), req.body);
  res.status(201).json(await prisma.userNote.create({ data: { userId, ...b } }));
});
notesRouter.delete('/:id', async (req, res) => {
  const userId = requireUser(req);
  await prisma.userNote.deleteMany({ where: { id: String(req.params.id), userId } });
  res.json({ ok: true });
});
