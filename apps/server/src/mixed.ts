import { type PlanItem, createRng, hashString } from '@pdl/core';
import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from './auth';
import { prisma } from './db';
import { HttpError, notFound, parse } from './http';
import { pickScenario } from './runs';
import { createSimHand } from './sim';
import { recordLeakDrills } from './leakMemory';

/**
 * Mixed Training: one timed session that interleaves item types, chosen adaptively. Each item is
 * answered through its own endpoint carrying the session id, so every attempt is recorded exactly
 * once (unique clientAttemptId) and ratings follow the same rules as everywhere else.
 */
export const mixedRouter = Router();

export const MIXED_TYPES = ['sim', 'solverFlop', 'scenario', 'villain', 'gto', 'gtopf', 'math', 'potodds', 'replay'] as const;
export type MixedType = (typeof MIXED_TYPES)[number];
const FOCUS: Record<string, MixedType[]> = {
  fullhand: ['sim', 'solverFlop', 'scenario'],
  preflop: ['gto'],
  postflop: ['gtopf', 'solverFlop'],
  math: ['math', 'potodds'],
  villain: ['villain'],
  replay: ['replay'],
};
const PREFIX: Partial<Record<MixedType, string>> = { sim: 'sim:', gto: 'gto:', gtopf: 'gtopf:', math: 'quiz:', potodds: 'potodds:', replay: 'real:' };
export const MIXES = ['balanced', 'heroFocus', 'newOnly', 'weak', 'due'] as const;
type Mix = (typeof MIXES)[number];
const HERO_TYPES: MixedType[] = ['sim', 'solverFlop', 'scenario'];

interface MixedConfig {
  durationMin: number;
  difficulty: 'easy' | 'medium' | 'hard' | 'adaptive';
  focus: (keyof typeof FOCUS)[];
  mix?: Mix;
  /** item types found exhausted in this session (e.g. no unseen scenarios left) */
  exhausted?: MixedType[];
  served: { type: MixedType; at: string; ref?: string; leakKey?: string; reason?: PlanItem['reason'] }[];
  /** Today's plan (Phase 1 D4): served in order first, then the session adapts as usual. */
  daily?: { version: string; items: PlanItem[]; focus: { leakKey: string; label: { en: string; vi: string }; evidence: string }[] };
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

/** Item type of an attempt; curated scenarios are told apart by their mode (hero / villain). */
async function typeResolver(): Promise<(itemRef: string) => MixedType | null> {
  const modes = new Map((await prisma.scenario.findMany({ select: { id: true, mode: true } })).map((x) => [x.id, x.mode]));
  return (itemRef) => {
    for (const t of MIXED_TYPES) if (PREFIX[t] && itemRef.startsWith(PREFIX[t]!)) return t;
    const m = modes.get(itemRef.split(':')[0]!);
    return m === 'hero' ? 'scenario' : m === 'villain' ? 'villain' : null;
  };
}

async function load(userId: string, id: string) {
  const s = await prisma.trainingSession.findFirst({ where: { id, userId, kind: 'mixed' } });
  if (!s) throw notFound('Session not found');
  return { s, cfg: s.config as unknown as MixedConfig };
}

const Create = z.object({
  durationMin: z.union([z.literal(5), z.literal(10), z.literal(20), z.literal(30)]).default(10),
  difficulty: z.enum(['easy', 'medium', 'hard', 'adaptive']).default('adaptive'),
  focus: z.array(z.enum(['fullhand', 'preflop', 'postflop', 'math', 'villain', 'replay'])).min(1).default(['fullhand', 'preflop', 'postflop', 'math', 'villain', 'replay']),
  mix: z.enum(MIXES).default('balanced'),
  mode: z.enum(['practice', 'rated']).default('rated'),
});

/** Item types a focus can serve for this user (imported-hand items need imported hands). */
export function servableTypes(focus: readonly string[], hasRealHands: boolean): MixedType[] {
  const out = new Set(focus.flatMap((f) => FOCUS[f] ?? []));
  if (!hasRealHands) {
    out.delete('potodds');
    out.delete('replay');
  }
  return [...out];
}

mixedRouter.post('/sessions', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(Create, req.body ?? {});
  // Refuse a session that could never serve an item (e.g. only "Real Hand Replay" without imported
  // hands) instead of creating it and failing on the first /next.
  const hasReal = (await prisma.realDecision.count({ where: { userId, status: 'accepted' }, take: 1 })) > 0;
  if (!servableTypes(body.focus, hasReal).length) throw new HttpError(400, 'focus_unavailable', 'Nothing in this focus can be served yet: Real Hand Replay needs imported hands. Add another focus or import hands first.');
  const cfg: MixedConfig = { durationMin: body.durationMin, difficulty: body.difficulty, focus: [...new Set(body.focus)], mix: body.mix, exhausted: [], served: [] };
  const s = await prisma.trainingSession.create({ data: { userId, kind: 'mixed', mode: body.mode, config: cfg as object } });
  res.status(201).json({ id: s.id, mode: s.mode, ...cfg });
});

/**
 * Adaptive weights: recent error rate per type, due reviews, in-session balance, and the chosen mix.
 * No single large source (e.g. tens of thousands of real hands) may dominate: a type that already
 * makes up 40%+ of a session is heavily down-weighted.
 */
async function weights(userId: string, cfg: MixedConfig, hasRealHands: boolean): Promise<Record<MixedType, number>> {
  const allowed = new Set(cfg.focus.flatMap((f) => FOCUS[f] ?? []));
  if (!hasRealHands) {
    allowed.delete('potodds');
    allowed.delete('replay');
  }
  for (const t of cfg.exhausted ?? []) allowed.delete(t);
  const typeOf = await typeResolver();
  const recent = await prisma.decisionAttempt.findMany({ where: { userId, graded: true }, orderBy: { createdAt: 'desc' }, take: 400, select: { itemRef: true, isError: true } });
  const due = await prisma.reviewItem.findMany({ where: { userId, dueAt: { lte: new Date() } }, select: { itemType: true, itemRef: true } });
  const mix = cfg.mix ?? 'balanced';
  const w = {} as Record<MixedType, number>;
  const last2 = cfg.served.slice(-2).map((x) => x.type);
  const n = cfg.served.length;
  for (const t of MIXED_TYPES) {
    if (!allowed.has(t)) {
      w[t] = 0;
      continue;
    }
    const mine = recent.filter((a) => typeOf(a.itemRef) === t).slice(0, 40);
    const errRate = mine.length >= 5 ? mine.filter((a) => a.isError).length / mine.length : 0.3;
    const isDue =
      t === 'scenario' || t === 'villain'
        ? due.some((r) => r.itemType === 'scenario')
        : t === 'math'
          ? due.some((r) => r.itemType === 'quiz' && !['gto', 'gtopf', 'potodds', 'sim'].includes(r.itemRef))
          : due.some((r) => r.itemRef === t);
    const servedHere = cfg.served.filter((x) => x.type === t).length;
    let x = (1 + 2 * errRate) / (1 + 0.3 * servedHere);
    if (mix === 'weak') x *= 1 + 4 * errRate * errRate;
    if (mix === 'due') x *= isDue ? 3 : 0.5;
    else if (isDue) x *= 1.5;
    if (mix === 'heroFocus') x *= HERO_TYPES.includes(t) ? 3 : 0.6;
    if (mix === 'newOnly' && (t === 'scenario' || t === 'villain')) x *= 2; // unseen curated content first
    if (n >= 5 && servedHere / n >= 0.4) x *= 0.2;
    if (allowed.size > 1 && last2.length === 2 && last2.every((y) => y === t)) x = 0;
    w[t] = x;
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
    // NO KEY UPDATE: serialises /next but still lets runs/hands that reference the session be inserted
    await tx.$queryRaw`SELECT id FROM "TrainingSession" WHERE id = ${String(req.params.id)} FOR NO KEY UPDATE`;
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
  const q = `mixed=${s.id}`;
  const planned = cfg.daily?.items[cfg.served.length];
  if (planned) {
    const r = await servePlanned(tx, userId, s, cfg, planned, hasReal, q);
    if (r) {
      cfg.served.push({ type: r.type, at: new Date().toISOString(), ref: r.ref, leakKey: planned.leakKey, reason: planned.reason });
      await tx.trainingSession.update({ where: { id: s.id }, data: { config: cfg as object } });
      return { done: false, type: r.type, href: r.href, remainingSec, served: cfg.served.length, planned: { reason: planned.reason, leakKey: planned.leakKey ?? null, index: cfg.served.length, of: cfg.daily!.items.length } };
    }
  }
  let w = await weights(userId, cfg, hasReal);
  let type: MixedType | null = null;
  let href = '';
  let ref: string | undefined;
  // curated scenarios honour the user's history (New Only etc.); an exhausted pool drops out
  for (let tries = 0; tries < MIXED_TYPES.length; tries++) {
    type = pick(w, hashString(`${s.id}:${cfg.served.length}:${tries}`));
    if (!type) break;
    if (type !== 'scenario' && type !== 'villain') break;
    const pool = cfg.mix === 'weak' ? 'weak' : cfg.mix === 'due' ? 'newDue' : cfg.mix === 'newOnly' ? 'new' : 'newDue';
    const r = await pickScenario(userId, { kind: type === 'scenario' ? 'hero' : 'villain', mode: s.mode as 'practice' | 'rated', pool, sessionId: s.id });
    if (r.ok) {
      href = `/run/${r.view.runId}?${q}`;
      ref = r.view.runId;
      break;
    }
    cfg.exhausted = [...new Set([...(cfg.exhausted ?? []), type])];
    // recompute: with one type gone, variety rules may no longer exclude the remaining ones
    w = await weights(userId, cfg, hasReal);
    type = null;
  }
  if (!type) throw new HttpError(409, 'no_items', 'No item types available for this focus');
  if (href) {
    /* scenario run already started */
  } else if (type === 'solverFlop') {
    const h = await createSimHand(userId, { table: 'solverFlop', mode: s.mode as 'practice' | 'rated', feedback: 'guided', sessionId: s.id }, tx);
    href = `/play/${h.id}?${q}`;
    ref = h.id;
  } else if (type === 'replay') href = `/replay?${q}`;
  else if (type === 'sim') {
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

/** One planned item → where to go. Null when it cannot be served (e.g. no scenario left in the pool). */
async function servePlanned(tx: Prisma.TransactionClient, userId: string, s: { id: string; mode: string }, cfg: MixedConfig, it: PlanItem, hasReal: boolean, q: string): Promise<{ type: MixedType; href: string; ref?: string } | null> {
  const mode = s.mode as 'practice' | 'rated';
  const p = it.params ?? {};
  switch (it.type) {
    case 'scenario':
    case 'villain': {
      const pools = it.reason === 'new' ? (['new'] as const) : ([p.pool ?? 'newDue', 'newDue', 'all'] as const);
      for (const pool of [...new Set(pools)]) {
        const r = await pickScenario(userId, { kind: it.type === 'scenario' ? 'hero' : 'villain', mode, pool, sessionId: s.id });
        if (r.ok) return { type: it.type, href: `/run/${r.view.runId}?${q}`, ref: r.view.runId };
      }
      return null;
    }
    case 'sim': {
      const h = await createSimHand(userId, { ...(p.tableSize ? { tableSize: p.tableSize, stackBB: p.stackBB } : simOpts(cfg.difficulty, cfg.served.length)), mode, feedback: 'guided', sessionId: s.id }, tx);
      return { type: 'sim', href: `/play/${h.id}?${q}`, ref: h.id };
    }
    case 'solverFlop': {
      const h = await createSimHand(userId, { table: 'solverFlop', mode, feedback: 'guided', sessionId: s.id }, tx);
      return { type: 'solverFlop', href: `/play/${h.id}?${q}`, ref: h.id };
    }
    case 'gto': {
      const f = new URLSearchParams();
      if (p.role) f.set('role', p.role);
      if (p.range) f.set('range', p.range);
      return { type: 'gto', href: `/gto?${f.toString() ? `${f.toString()}&` : ''}${q}` };
    }
    case 'gtopf':
      return { type: 'gtopf', href: `/gto?street=postflop&${q}` };
    case 'replay':
      if (!hasReal) return null;
      return { type: 'replay', href: p.decisionId ? `/replay?decision=${encodeURIComponent(p.decisionId)}&${q}` : `/replay?${q}`, ref: p.decisionId };
    case 'potodds':
      return hasReal ? { type: 'potodds', href: `/fundamentals?${q}` } : null;
    case 'math':
      return { type: 'math', href: `/math?level=${await mathLevel(userId, cfg.difficulty)}&${q}` };
  }
}

/**
 * Graded results per drilled leak in a daily session. Each attempt belongs to the item that was on
 * screen when it was made: the last item served at or before the attempt.
 */
export async function dailyLeakResults(userId: string, sessionId: string, cfg: MixedConfig) {
  const out = new Map<string, { correct: number; total: number; served: number }>();
  for (const x of cfg.served) if (x.leakKey) out.set(x.leakKey, { correct: 0, total: 0, served: (out.get(x.leakKey)?.served ?? 0) + 1 });
  if (!out.size) return out;
  const atts = await prisma.decisionAttempt.findMany({ where: { userId, sessionId, graded: true }, select: { isError: true, createdAt: true } });
  const served = cfg.served.map((x) => ({ ...x, t: new Date(x.at).getTime() }));
  for (const a of atts) {
    let owner: (typeof served)[number] | undefined;
    for (const x of served) if (x.t <= a.createdAt.getTime()) owner = x;
    if (!owner?.leakKey) continue;
    const r = out.get(owner.leakKey)!;
    r.total++;
    if (!a.isError) r.correct++;
  }
  return out;
}

mixedRouter.post('/sessions/:id/end', async (req, res) => {
  const userId = requireUser(req);
  const { s, cfg } = await load(userId, String(req.params.id));
  // exactly one caller ends the session (and records leak drills) even with concurrent requests
  const ended = await prisma.trainingSession.updateMany({ where: { id: s.id, endedAt: null }, data: { endedAt: new Date() } });
  if (ended.count === 1 && cfg.daily) await recordLeakDrills(userId, await dailyLeakResults(userId, s.id, cfg));
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
  const typeOf = await typeResolver();
  const atts = await prisma.decisionAttempt.findMany({ where: { userId, sessionId: s.id }, orderBy: { createdAt: 'asc' }, select: { id: true, itemRef: true, graded: true, isError: true, grade: true, evLoss: true, evUnit: true, track: true, ratingApplied: true, createdAt: true } });
  const sims = await prisma.simHand.findMany({ where: { userId, sessionId: s.id }, select: { steps: true } });
  const ungradedSim = sims.reduce((n, h) => n + ((h.steps as { attemptId?: string }[]) ?? []).filter((x) => !x.attemptId).length, 0);
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
      attempts: rows.length + (t === 'sim' ? ungradedSim : 0),
      graded: graded.length,
      strategyRated: rows.filter((a) => a.ratingApplied && a.track === 'strategy').length,
      fundamentalsRated: rows.filter((a) => a.ratingApplied && a.track === 'fundamentals').length,
      ungraded: rows.length - graded.length + (t === 'sim' ? ungradedSim : 0),
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
    attempts: atts.length + ungradedSim,
    graded: graded.length,
    strategyRated: atts.filter((a) => a.ratingApplied && a.track === 'strategy').length,
    fundamentalsRated: atts.filter((a) => a.ratingApplied && a.track === 'fundamentals').length,
    ungraded: atts.filter((a) => !a.graded).length + ungradedSim,
    mix: cfg.mix ?? 'balanced',
    exhausted: cfg.exhausted ?? [],
    accuracyPct: graded.length ? Math.round((1000 * graded.filter((a) => !a.isError).length) / graded.length) / 10 : null,
    minutes: atts.length ? Math.max(1, Math.round((atts[atts.length - 1]!.createdAt.getTime() - s.startedAt.getTime()) / 60000)) : 0,
    byType,
    ratingDelta: { strategy: delta('overall'), fundamentals: delta('fundamentals') },
    mistakes: atts.filter((a) => a.isError).sort((a, b) => (b.evLoss ?? 0) - (a.evLoss ?? 0)).slice(0, 8).map((a) => ({ type: typeOf(a.itemRef), grade: a.grade, evLossBB: a.evLoss, at: a.createdAt })),
    recommendation: weakest ? weakest.type : null,
    daily: cfg.daily
      ? {
          planned: cfg.daily.items.length,
          done: Math.min(cfg.served.length, cfg.daily.items.length),
          leaks: await (async () => {
            const r = await dailyLeakResults(userId, s.id, cfg);
            return cfg.daily!.focus.map((f) => ({ ...f, ...(r.get(f.leakKey) ?? { served: 0, total: 0, correct: 0 }) }));
          })(),
        }
      : null,
  });
});
