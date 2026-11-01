import { DAILY_MINUTES, type DailyMinutes, type PlanItemType, type PlanLeak, buildDailyPlan, hashString, leakPriority } from '@pdl/core';
import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from './auth';
import { prisma } from './db';
import { parse } from './http';
import { ensureFreshMemory, listMemory } from './leakMemory';

/**
 * Today (Phase 1 D4): a personal 5/10/20-minute plan built from the user's leak memory, due reviews
 * and new material, served through a Mixed session that follows the plan item by item.
 */
const reviewType = (itemType: string, itemRef: string, hasReal: boolean): PlanItemType | null => {
  if (itemType === 'scenario') return 'scenario';
  if (itemType === 'quiz') return itemRef === 'gto' ? 'gto' : itemRef === 'gtopf' ? 'gtopf' : itemRef === 'potodds' ? (hasReal ? 'potodds' : null) : itemRef === 'sim' ? 'sim' : 'math';
  if ((itemType === 'concept' || itemType === 'real') && hasReal) return 'replay';
  return null;
};

export async function dailyPlan(userId: string, minutes: DailyMinutes, now = new Date()) {
  await ensureFreshMemory(userId);
  const mem = await listMemory(userId);
  const hasReal = (await prisma.realDecision.count({ where: { userId, status: 'accepted' }, take: 1 })) > 0;
  const due = await prisma.reviewItem.findMany({ where: { userId, dueAt: { lte: now }, itemType: { not: 'leak' } }, orderBy: { dueAt: 'asc' }, take: 30, select: { itemType: true, itemRef: true } });
  const dueReviews = due.map((r) => reviewType(r.itemType, r.itemRef, hasReal)).filter((x): x is PlanItemType => !!x);
  const leaks: PlanLeak[] = mem.leaks.map((m) => ({
    leakKey: m.leakKey,
    label: m.label as PlanLeak['label'],
    evidence: m.evidence as PlanLeak['evidence'],
    status: m.status as PlanLeak['status'],
    severity: m.severity,
    confidence: m.confidence as PlanLeak['confidence'],
    timesDetected: m.timesDetected,
    recentN: m.recentN,
    drill: m.drill,
    examples: m.examples,
    drillCount: m.drillCount,
    lastDrilledAt: m.lastDrilledAt?.toISOString() ?? null,
    lastDrillAccuracy: m.lastDrillAccuracy,
    reviewDueAt: m.reviewDueAt?.toISOString() ?? null,
  }));
  const newTypes: PlanItemType[] = ['sim', 'solverFlop', 'scenario', 'gtopf'];
  const plan = buildDailyPlan({ minutes, leaks, dueReviews, newTypes, hasRealHands: hasReal, now, seed: hashString(`${userId}:${now.toISOString().slice(0, 10)}:${minutes}`) });
  return {
    ...plan,
    refreshedAt: mem.refreshedAt,
    // every leak with its priority breakdown, so the order is explainable
    ranking: leaks.map((l) => ({ leakKey: l.leakKey, label: l.label, evidence: l.evidence, status: l.status, priority: leakPriority(l, now) })).sort((a, b) => b.priority.score - a.priority.score),
  };
}

export const dailyRouter = Router();
const Minutes = z.coerce.number().refine((x): x is DailyMinutes => (DAILY_MINUTES as readonly number[]).includes(x), 'minutes must be 5, 10 or 20');

dailyRouter.get('/plan', async (req, res) => {
  const userId = requireUser(req);
  const q = parse(z.object({ minutes: Minutes.default(10) }), req.query);
  res.json(await dailyPlan(userId, q.minutes as DailyMinutes));
});

/** Start today's plan as a Mixed session (the session follows the plan, then adapts if time remains). */
dailyRouter.post('/start', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(z.object({ minutes: Minutes.default(10), mode: z.enum(['practice', 'rated']).default('rated') }), req.body ?? {});
  const plan = await dailyPlan(userId, body.minutes as DailyMinutes);
  const cfg = {
    durationMin: plan.minutes,
    difficulty: 'adaptive',
    focus: ['fullhand', 'preflop', 'postflop', 'math', 'villain', 'replay'],
    mix: 'balanced',
    exhausted: [],
    served: [],
    daily: { version: plan.version, items: plan.items, focus: plan.focus.map((f) => ({ leakKey: f.leakKey, label: f.label, evidence: f.evidence })) },
  };
  const s = await prisma.trainingSession.create({ data: { userId, kind: 'mixed', mode: body.mode, config: cfg as object } });
  res.status(201).json({ id: s.id, mode: s.mode, items: plan.items.length, focus: plan.focus });
});
