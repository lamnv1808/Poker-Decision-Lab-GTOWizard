import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from './auth';
import { prisma } from './db';
import { HttpError, parse } from './http';

/**
 * Per-user scenario history: what has been played, completed, answered correctly — persisted
 * server-side (so it follows the user across devices) and never deleted. "Reset" only moves a
 * marker; rating history and attempts are untouched.
 */
export type ContentStatus = 'new' | 'inProgress' | 'played' | 'mastered' | 'due';

export async function resetAt(userId: string): Promise<Date | null> {
  return (await prisma.userPreference.findUnique({ where: { userId }, select: { historyResetAt: true } }))?.historyResetAt ?? null;
}

/** A run / hand started (counts as played; "in progress" until completed). */
export async function touchPlayed(userId: string, contentKey: string, module: string, refId: string) {
  await prisma.scenarioHistory.upsert({
    where: { userId_contentKey: { userId, contentKey } },
    create: { userId, contentKey, module, timesPlayed: 1, firstRefId: refId, lastRefId: refId },
    update: { timesPlayed: { increment: 1 }, lastPlayedAt: new Date(), lastRefId: refId },
  });
}

/** A run / hand finished. `result` is only 'correct'/'incorrect' when an answer was validated. */
export async function markCompleted(userId: string, contentKey: string, module: string, refId: string, o: { result: 'correct' | 'incorrect' | 'ungraded'; ratingEligible: boolean; confidence?: number | null }) {
  const inc = o.result === 'correct' ? { correct: { increment: 1 } } : o.result === 'incorrect' ? { incorrect: { increment: 1 } } : {};
  await prisma.scenarioHistory.upsert({
    where: { userId_contentKey: { userId, contentKey } },
    create: { userId, contentKey, module, timesPlayed: 1, timesCompleted: 1, lastResult: o.result, ratingEligible: o.ratingEligible, lastConfidence: o.confidence ?? null, firstRefId: refId, lastRefId: refId, ...(o.result === 'correct' ? { correct: 1 } : o.result === 'incorrect' ? { incorrect: 1 } : {}) },
    update: { timesCompleted: { increment: 1 }, lastPlayedAt: new Date(), lastResult: o.result, ratingEligible: o.ratingEligible || undefined, lastConfidence: o.confidence ?? undefined, lastRefId: refId, ...inc },
  });
}

export interface ScenarioState {
  status: ContentStatus;
  timesPlayed: number;
  timesCompleted: number;
  lastPlayedAt: Date | null;
  lastResult: string | null;
  mastery: number | null;
  dueAt: Date | null;
}

/** Status of curated scenarios (ids) for a user, honouring a history reset. */
export async function scenarioStates(userId: string, scenarioIds: string[]): Promise<Map<string, ScenarioState>> {
  const since = await resetAt(userId);
  const [hist, reviews] = await Promise.all([
    prisma.scenarioHistory.findMany({ where: { userId, contentKey: { in: scenarioIds.map((id) => `scenario:${id}`) } } }),
    prisma.reviewItem.findMany({ where: { userId, itemType: 'scenario', itemRef: { in: scenarioIds } } }),
  ]);
  const h = new Map(hist.map((x) => [x.contentKey.slice('scenario:'.length), x]));
  const r = new Map(reviews.map((x) => [x.itemRef, x]));
  const now = new Date();
  return new Map(
    scenarioIds.map((id) => {
      const x = h.get(id);
      const rv = r.get(id);
      const visible = x && (!since || x.lastPlayedAt > since);
      let status: ContentStatus = 'new';
      if (visible) {
        if (x.timesCompleted === 0) status = 'inProgress';
        else if (rv && rv.dueAt <= now) status = 'due';
        else if ((rv && rv.mastery >= 0.85) || (x.timesCompleted >= 2 && x.incorrect === 0 && x.lastResult === 'correct')) status = 'mastered';
        else status = 'played';
      }
      return [id, { status, timesPlayed: visible ? x.timesPlayed : 0, timesCompleted: visible ? x.timesCompleted : 0, lastPlayedAt: visible ? x.lastPlayedAt : null, lastResult: visible ? x.lastResult : null, mastery: rv?.mastery ?? null, dueAt: rv?.dueAt ?? null }];
    }),
  );
}

export const historyRouter = Router();

/** Progress counts: unique curated scenarios completed vs available; generated hands separately. */
historyRouter.get('/summary', async (req, res) => {
  const userId = requireUser(req);
  const since = await resetAt(userId);
  const scenarios = await prisma.scenario.findMany({ where: { published: true }, select: { id: true, mode: true } });
  const states = await scenarioStates(userId, scenarios.map((s) => s.id));
  const by = (mode: string) => {
    const list = scenarios.filter((s) => s.mode === mode).map((s) => states.get(s.id)!);
    return { available: list.length, completed: list.filter((x) => x.timesCompleted > 0).length, mastered: list.filter((x) => x.status === 'mastered').length, due: list.filter((x) => x.status === 'due').length, new: list.filter((x) => x.status === 'new').length };
  };
  const where = { userId, kind: 'play', status: 'complete', ...(since ? { completedAt: { gt: since } } : {}) };
  const [handsCompleted, unique] = await Promise.all([
    prisma.simHand.count({ where }),
    prisma.simHand.findMany({ where: { ...where, fingerprint: { not: null } }, select: { fingerprint: true }, distinct: ['fingerprint'] }),
  ]);
  res.json({ hero: by('hero'), villain: by('villain'), generated: { handsCompleted, uniqueSituations: unique.length }, resetAt: since });
});

/** Reset personal completion history (selection only). Requires explicit confirmation. */
historyRouter.post('/reset', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(z.object({ confirm: z.literal(true) }), req.body);
  if (!body.confirm) throw new HttpError(400, 'confirm_required');
  const at = new Date();
  await prisma.userPreference.upsert({ where: { userId }, create: { userId, historyResetAt: at }, update: { historyResetAt: at } });
  res.json({ ok: true, resetAt: at });
});
