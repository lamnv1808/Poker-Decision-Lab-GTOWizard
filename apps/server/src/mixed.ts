import { createRng, hashString } from '@pdl/core';
import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from './auth';
import { prisma } from './db';
import { HttpError, notFound, parse } from './http';
import { createSimHand } from './sim';

/**
 * Mixed Training: one timed session that interleaves item types, chosen adaptively. Each item is
 * answered through its own endpoint carrying the session id, so every attempt is recorded exactly
 * once (unique clientAttemptId) and ratings follow the same rules as everywhere else.
 */
export const mixedRouter = Router();

export const MIXED_TYPES = ['sim', 'gto', 'gtopf', 'math', 'potodds'] as const;
export type MixedType = (typeof MIXED_TYPES)[number];
const FOCUS: Record<string, MixedType[]> = { fullhand: ['sim'], preflop: ['gto'], postflop: ['gtopf'], math: ['math', 'potodds'] };
const PREFIX: Record<MixedType, string> = { sim: 'sim:', gto: 'gto:', gtopf: 'gtopf:', math: 'quiz:', potodds: 'potodds:' };

interface MixedConfig {
  durationMin: number;
  difficulty: 'easy' | 'medium' | 'hard' | 'adaptive';
  focus: (keyof typeof FOCUS)[];
  served: { type: MixedType; at: string; ref?: string }[];
}

/** Time allowed after the clock runs out to finish the item already on screen. */
const GRACE_SEC = 300;

/**
 * The caller's own Mixed session if it is still open (not ended, within its time + grace), with
 * the session's practice/rated mode — which overrides any mode the page sends. Otherwise null.
 */
export async function mixedSessionFor(userId: string, sessionId: string | undefined | null): Promise<{ id: string; mode: 'practice' | 'rated' } | null> {
  if (!sessionId) return null;
  const s = await prisma.trainingSession.findFirst({ where: { id: sessionId, userId, kind: 'mixed', endedAt: null }, select: { id: true, mode: true, startedAt: true, config: true } });
  if (!s) return null;
  const cfg = s.config as unknown as MixedConfig | null;
  if (cfg && Date.now() - s.startedAt.getTime() > (cfg.durationMin * 60 + GRACE_SEC) * 1000) return null;
  return { id: s.id, mode: s.mode as 'practice' | 'rated' };
}

const typeOf = (itemRef: string): MixedType | null => (MIXED_TYPES.find((t) => itemRef.startsWith(PREFIX[t])) ?? null);

async function load(userId: string, id: string) {
  const s = await prisma.trainingSession.findFirst({ where: { id, userId, kind: 'mixed' } });
  if (!s) throw notFound('Session not found');
  return { s, cfg: s.config as unknown as MixedConfig };
}

const Create = z.object({
  durationMin: z.union([z.literal(5), z.literal(10), z.literal(20), z.literal(30)]).default(10),
  difficulty: z.enum(['easy', 'medium', 'hard', 'adaptive']).default('adaptive'),
  focus: z.array(z.enum(['fullhand', 'preflop', 'postflop', 'math'])).min(1).default(['fullhand', 'preflop', 'postflop', 'math']),
  mode: z.enum(['practice', 'rated']).default('rated'),
});

mixedRouter.post('/sessions', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(Create, req.body ?? {});
  const cfg: MixedConfig = { durationMin: body.durationMin, difficulty: body.difficulty, focus: [...new Set(body.focus)], served: [] };
  const s = await prisma.trainingSession.create({ data: { userId, kind: 'mixed', mode: body.mode, config: cfg as object } });
  res.status(201).json({ id: s.id, mode: s.mode, ...cfg });
});

/** Adaptive weights: recent error rate per type, due reviews, and in-session balance. */
async function weights(userId: string, cfg: MixedConfig, hasRealHands: boolean): Promise<Record<MixedType, number>> {
  const allowed = new Set(cfg.focus.flatMap((f) => FOCUS[f] ?? []));
  if (!hasRealHands) allowed.delete('potodds');
  const recent = await prisma.decisionAttempt.findMany({ where: { userId, graded: true }, orderBy: { createdAt: 'desc' }, take: 300, select: { itemRef: true, isError: true } });
  const due = new Set((await prisma.reviewItem.findMany({ where: { userId, itemType: 'quiz', dueAt: { lte: new Date() } }, select: { itemRef: true } })).map((r) => r.itemRef));
  const w = {} as Record<MixedType, number>;
  const last2 = cfg.served.slice(-2).map((x) => x.type);
  for (const t of MIXED_TYPES) {
    if (!allowed.has(t)) {
      w[t] = 0;
      continue;
    }
    const mine = recent.filter((a) => typeOf(a.itemRef) === t).slice(0, 40);
    const errRate = mine.length >= 5 ? mine.filter((a) => a.isError).length / mine.length : 0.3;
    const isDue = t === 'math' ? [...due].some((r) => !['gto', 'gtopf', 'potodds', 'sim'].includes(r)) : due.has(t);
    const servedHere = cfg.served.filter((x) => x.type === t).length;
    w[t] = ((1 + 2 * errRate) * (isDue ? 1.5 : 1)) / (1 + 0.3 * servedHere);
    if (allowed.size > 1 && last2.length === 2 && last2.every((x) => x === t)) w[t] = 0;
  }
  return w;
}

function pick(w: Record<MixedType, number>, seed: number): MixedType | null {
  const total = MIXED_TYPES.reduce((s, t) => s + w[t], 0);
  if (total <= 0) return null;
  let r = createRng(seed)() * total;
  for (const t of MIXED_TYPES) {
    r -= w[t];
    if (r < 0) return t;
  }
  return MIXED_TYPES.filter((t) => w[t] > 0).pop()!;
}

async function mathLevel(userId: string, d: MixedConfig['difficulty']) {
  if (d !== 'adaptive') return d === 'easy' ? 1 : d === 'medium' ? 2 : 3;
  const f = await prisma.rating.findUnique({ where: { userId_skill: { userId, skill: 'fundamentals' } } });
  return !f || f.rating < 1000 ? 1 : f.rating < 1200 ? 2 : 3;
}

const simOpts = (d: MixedConfig['difficulty'], seed: number) =>
  d === 'easy' ? { tableSize: 2, stackBB: 15 } : d === 'medium' ? { tableSize: 6 } : d === 'hard' ? { tableSize: 6, stackBB: 100 } : seed % 2 ? { tableSize: 6 } : { tableSize: 2 };

mixedRouter.post('/sessions/:id/next', async (req, res) => {
  const userId = requireUser(req);
  await load(userId, String(req.params.id));
  // Serialise /next per session (double clicks, StrictMode) so no item is lost or dealt twice.
  const out = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "TrainingSession" WHERE id = ${String(req.params.id)} FOR UPDATE`;
    const s = (await tx.trainingSession.findUniqueOrThrow({ where: { id: String(req.params.id) } }));
    const cfg = s.config as unknown as MixedConfig;
    return nextItem(tx, userId, s, cfg);
  }, { timeout: 20_000 });
  res.json(out);
});

async function nextItem(tx: Prisma.TransactionClient, userId: string, s: { id: string; mode: string; startedAt: Date; endedAt: Date | null }, cfg: MixedConfig) {
  const elapsedSec = Math.floor((Date.now() - s.startedAt.getTime()) / 1000);
  const remainingSec = Math.max(0, cfg.durationMin * 60 - elapsedSec);
  if (s.endedAt || remainingSec === 0) return { done: true, remainingSec: 0 };
  // an unfinished full hand from this session is resumed, not replaced
  const open = await tx.simHand.findFirst({ where: { userId, sessionId: s.id, status: 'active' } });
  if (open) return { done: false, type: 'sim', href: `/play/${open.id}?mixed=${s.id}`, remainingSec, served: cfg.served.length, resumed: true };
  const hasReal = (await tx.realDecision.count({ where: { userId, status: 'accepted' }, take: 1 })) > 0;
  const w = await weights(userId, cfg, hasReal);
  const type = pick(w, hashString(`${s.id}:${cfg.served.length}`));
  if (!type) throw new HttpError(409, 'no_items', 'No item types available for this focus');
  let href: string;
  let ref: string | undefined;
  const q = `mixed=${s.id}`;
  if (type === 'sim') {
    const h = await createSimHand(userId, { ...simOpts(cfg.difficulty, cfg.served.length), mode: s.mode as 'practice' | 'rated', feedback: 'guided', sessionId: s.id }, tx);
    href = `/play/${h.id}?${q}`;
    ref = h.id;
  } else if (type === 'gto') href = `/gto?${q}`;
  else if (type === 'gtopf') href = `/gto?street=postflop&${q}`;
  else if (type === 'math') href = `/math?level=${await mathLevel(userId, cfg.difficulty)}&${q}`;
  else href = `/fundamentals?${q}`;
  cfg.served.push({ type, at: new Date().toISOString(), ref });
  await tx.trainingSession.update({ where: { id: s.id }, data: { config: cfg as object } });
  return { done: false, type, href, remainingSec, served: cfg.served.length, weights: w };
}

mixedRouter.post('/sessions/:id/end', async (req, res) => {
  const userId = requireUser(req);
  const { s } = await load(userId, String(req.params.id));
  if (!s.endedAt) await prisma.trainingSession.update({ where: { id: s.id }, data: { endedAt: new Date() } });
  res.json({ ok: true });
});

mixedRouter.get('/sessions/:id', async (req, res) => {
  const userId = requireUser(req);
  const { s, cfg } = await load(userId, String(req.params.id));
  // recorded answers + full-hand decisions that were not graded (and so not recorded as attempts)
  const sims = await prisma.simHand.findMany({ where: { userId, sessionId: s.id }, select: { steps: true } });
  const ungraded = sims.reduce((n, h) => n + ((h.steps as { attemptId?: string }[]) ?? []).filter((x) => !x.attemptId).length, 0);
  const answered = (await prisma.decisionAttempt.count({ where: { userId, sessionId: s.id } })) + ungraded;
  const remainingSec = s.endedAt ? 0 : Math.max(0, cfg.durationMin * 60 - Math.floor((Date.now() - s.startedAt.getTime()) / 1000));
  res.json({ id: s.id, mode: s.mode, ...cfg, served: cfg.served.length, answered, remainingSec, ended: !!s.endedAt || remainingSec === 0 });
});

/** Session summary: every attempt counted once (they are unique rows tagged with this session). */
mixedRouter.get('/sessions/:id/summary', async (req, res) => {
  const userId = requireUser(req);
  const { s, cfg } = await load(userId, String(req.params.id));
  const atts = await prisma.decisionAttempt.findMany({ where: { userId, sessionId: s.id }, orderBy: { createdAt: 'asc' }, select: { id: true, itemRef: true, graded: true, isError: true, grade: true, evLoss: true, evUnit: true, track: true, createdAt: true } });
  const hist = await prisma.ratingHistory.findMany({ where: { userId, attemptId: { in: atts.map((a) => a.id) } }, select: { skill: true, ratingBefore: true, ratingAfter: true } });
  const delta = (skill: string) => {
    const h = hist.filter((x) => x.skill === skill);
    return h.length ? Math.round(h.reduce((sum, x) => sum + x.ratingAfter - x.ratingBefore, 0)) : null;
  };
  const byType = MIXED_TYPES.map((t) => {
    const rows = atts.filter((a) => typeOf(a.itemRef) === t);
    const graded = rows.filter((a) => a.graded);
    const ev = graded.filter((a) => a.evUnit === 'bb' && a.evLoss !== null);
    return {
      type: t,
      attempts: rows.length,
      graded: graded.length,
      accuracyPct: graded.length ? Math.round((1000 * graded.filter((a) => !a.isError).length) / graded.length) / 10 : null,
      avgEvLossBB: ev.length ? Math.round((1000 * ev.reduce((sum, a) => sum + a.evLoss!, 0)) / ev.length) / 1000 : null,
    };
  }).filter((x) => x.attempts > 0);
  const graded = atts.filter((a) => a.graded);
  const weakest = [...byType].filter((x) => x.graded >= 2 && x.accuracyPct !== null).sort((a, b) => a.accuracyPct! - b.accuracyPct!)[0];
  res.json({
    id: s.id,
    mode: s.mode,
    durationMin: cfg.durationMin,
    served: cfg.served.length,
    attempts: atts.length,
    graded: graded.length,
    accuracyPct: graded.length ? Math.round((1000 * graded.filter((a) => !a.isError).length) / graded.length) / 10 : null,
    minutes: atts.length ? Math.max(1, Math.round((atts[atts.length - 1]!.createdAt.getTime() - s.startedAt.getTime()) / 60000)) : 0,
    byType,
    ratingDelta: { strategy: delta('overall'), fundamentals: delta('fundamentals') },
    mistakes: atts.filter((a) => a.isError).sort((a, b) => (b.evLoss ?? 0) - (a.evLoss ?? 0)).slice(0, 8).map((a) => ({ type: typeOf(a.itemRef), grade: a.grade, evLossBB: a.evLoss, at: a.createdAt })),
    recommendation: weakest ? weakest.type : null,
  });
});
