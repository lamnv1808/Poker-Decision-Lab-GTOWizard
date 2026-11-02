import { CURRICULUM, FUNDAMENTALS_KEY, LEAK_LABELS, type LeakKey, SKILLS, rankLeaks, confidenceHalfWidth, overallProficiency, strengthsAndWeaknesses } from '@pdl/core';
import { ensureRatingModel } from './learning';
import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from './auth';
import { prisma } from './db';
import { parse } from './http';

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

function bucket<T>(rows: T[], key: (r: T) => string | null | undefined) {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
}

type A = { graded: boolean; isError: boolean; grade: string | null; evLoss: number | null; evUnit: string | null; createdAt: Date; street: string | null; heroPosition: string | null; effectiveStackBB: number | null; difficulty: number; concepts: string[]; attemptType: string; mode: string };

function summarize(rows: A[]) {
  const graded = rows.filter((r) => r.graded);
  const ok = graded.filter((r) => !r.isError).length;
  const ev = graded.filter((r) => r.evUnit === 'bb' && r.evLoss !== null);
  return {
    decisions: rows.length,
    graded: graded.length,
    accuracyPct: pct(ok, graded.length),
    avgEvLossBB: ev.length ? Math.round((ev.reduce((s, r) => s + r.evLoss!, 0) / ev.length) * 1000) / 1000 : null,
    evSamples: ev.length,
  };
}

function stackBand(bb: number | null) {
  if (bb === null) return null;
  if (bb <= 10) return '≤10';
  if (bb <= 20) return '10–20';
  if (bb <= 40) return '20–40';
  return '40+';
}

export const analyticsRouter = Router();

analyticsRouter.get('/dashboard', async (req, res) => {
  const userId = requireUser(req);
  await ensureRatingModel(userId);
  const [ratings, attempts, sessions, history] = await Promise.all([
    prisma.rating.findMany({ where: { userId } }),
    prisma.decisionAttempt.findMany({ where: { userId }, select: { graded: true, isError: true, grade: true, evLoss: true, evUnit: true, createdAt: true, street: true, heroPosition: true, effectiveStackBB: true, difficulty: true, concepts: true, attemptType: true, mode: true, gradeBasis: true } }),
    prisma.trainingSession.count({ where: { userId } }),
    prisma.ratingHistory.findMany({ where: { userId, skill: 'overall' }, orderBy: { createdAt: 'asc' }, select: { ratingBefore: true, ratingAfter: true, createdAt: true } }),
  ]);
  const overall = ratings.find((r) => r.skill === 'overall');
  const weekAgo = Date.now() - 7 * 86400000;
  const firstThisWeek = history.find((h) => h.createdAt.getTime() >= weekAgo);
  const fundamentals = ratings.find((r) => r.skill === FUNDAMENTALS_KEY);
  const skills = ratings.filter((r) => r.skill !== 'overall' && r.skill !== FUNDAMENTALS_KEY && r.games >= 1).map((r) => ({ skill: r.skill, rating: Math.round(r.rating), rd: Math.round(r.rd), games: r.games }));
  const reliable = skills.filter((s) => s.rd < 150);
  const obs = await prisma.leakObservation.findMany({ where: { userId }, select: { leakKey: true, isError: true, evLossBB: true, createdAt: true } });
  const leaks = rankLeaks(obs.map((o) => ({ leak: o.leakKey as LeakKey, isError: o.isError, evLossBB: o.evLossBB ?? undefined, at: o.createdAt.toISOString() }))).filter((l) => l.ranked).slice(0, 3);
  const due = await prisma.reviewItem.count({ where: { userId, dueAt: { lte: new Date() } } });
  res.json({
    rating: overall ? { rating: Math.round(overall.rating), rd: Math.round(overall.rd), interval95: Math.round(confidenceHalfWidth(overall.rd)), games: overall.games } : null,
    ratingChange7d: firstThisWeek && overall ? Math.round(overall.rating - firstThisWeek.ratingBefore) : null,
    sessions,
    ...summarize(attempts),
    ...(() => {
      const sw = strengthsAndWeaknesses(reliable);
      return { strengths: sw.strengths, weaknesses: sw.weaknesses, skillEvidence: sw.enough ? 'ok' : 'insufficient' };
    })(),
    competency: {
      ...overallProficiency(overall, fundamentals, { covered: skills.length + (fundamentals?.games ? 1 : 0), total: SKILLS.length + 1 }),
      strategy: overall ? { rating: Math.round(overall.rating), rd: Math.round(overall.rd), interval95: Math.round(confidenceHalfWidth(overall.rd)), games: overall.games } : null,
      fundamentals: fundamentals ? { rating: Math.round(fundamentals.rating), rd: Math.round(fundamentals.rd), interval95: Math.round(confidenceHalfWidth(fundamentals.rd)), games: fundamentals.games } : null,
      exploratory: { attempts: attempts.filter((a) => a.graded && a.gradeBasis === 'rubric').length },
    },
    provisionalSkills: skills.filter((s) => s.rd >= 150).map((s) => s.skill),
    topLeaks: leaks.map((l) => ({ ...l, label: LEAK_LABELS[l.leak] })),
    reviewDue: due,
  });
});

analyticsRouter.get('/progress', async (req, res) => {
  const userId = requireUser(req);
  await ensureRatingModel(userId);
  const [history, ratings, attempts] = await Promise.all([
    prisma.ratingHistory.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, select: { skill: true, ratingAfter: true, rdAfter: true, createdAt: true } }),
    prisma.rating.findMany({ where: { userId } }),
    prisma.decisionAttempt.findMany({ where: { userId }, select: { graded: true, isError: true, grade: true, evLoss: true, evUnit: true, createdAt: true, street: true, heroPosition: true, effectiveStackBB: true, difficulty: true, concepts: true, attemptType: true, mode: true, gradeBasis: true, track: true, confidence: true, optionKey: true } }),
  ]);
  /** Evidence tier of an attempt: solver-verified, model-based, or limited (no grade). Never mixed. */
  const tierOf = (a: { graded: boolean; gradeBasis: string | null; track: string }) => (!a.graded ? 'limited' : a.gradeBasis === 'solverEv' ? 'solver' : 'model');
  const breakdown = (m: Map<string, A[]>) => [...m].map(([key, rows]) => ({ key, ...summarize(rows) })).sort((a, b) => a.key.localeCompare(b.key));
  const conceptRows = attempts.flatMap((a) => a.concepts.map((c) => ({ ...a, concept: c })));
  res.json({
    ratingHistory: history.map((h) => ({ skill: h.skill, rating: Math.round(h.ratingAfter), rd: Math.round(h.rdAfter), at: h.createdAt })),
    ratings: ratings.map((r) => ({ skill: r.skill, rating: Math.round(r.rating), rd: Math.round(r.rd), interval95: Math.round(confidenceHalfWidth(r.rd)), games: r.games })),
    byStreet: breakdown(bucket(attempts.filter((a) => a.attemptType === 'decision'), (a) => a.street)),
    byPosition: breakdown(bucket(attempts.filter((a) => a.attemptType === 'decision'), (a) => a.heroPosition)),
    byStackDepth: breakdown(bucket(attempts.filter((a) => a.attemptType === 'decision'), (a) => stackBand(a.effectiveStackBB))),
    byDifficulty: breakdown(bucket(attempts, (a) => String(a.difficulty))),
    byType: breakdown(bucket(attempts, (a) => a.attemptType)),
    // decision quality by evidence tier, and by the action chosen — tiers are never pooled
    byTier: breakdown(bucket(attempts, (a) => tierOf(a))),
    byActionTier: breakdown(bucket(attempts.filter((a) => a.graded && a.optionKey), (a) => `${tierOf(a)}:${['fold', 'check', 'call', 'bet', 'raise'].includes(a.optionKey!) ? a.optionKey : 'other'}`)),
    // confidence vs correctness, per tier (well calibrated: "sure" answers are right more often)
    calibration: (['solver', 'model'] as const).flatMap((tier) =>
      ([3, 2, 1] as const).map((c) => {
        const xs = attempts.filter((a) => a.graded && tierOf(a) === tier && a.confidence === c);
        return { tier, confidence: c, n: xs.length, accuracyPct: xs.length ? Math.round((1000 * xs.filter((x) => !x.isError).length) / xs.length) / 10 : null };
      }),
    ),
    byConcept: [...bucket(conceptRows, (a) => a.concept)].map(([key, rows]) => ({ key, ...summarize(rows) })).sort((a, b) => (b.avgEvLossBB ?? -1) - (a.avgEvLossBB ?? -1)),
  });
});

analyticsRouter.get('/leaks', async (req, res) => {
  const userId = requireUser(req);
  const obs = await prisma.leakObservation.findMany({ where: { userId }, select: { leakKey: true, isError: true, evLossBB: true, createdAt: true } });
  const ranked = rankLeaks(obs.map((o) => ({ leak: o.leakKey as LeakKey, isError: o.isError, evLossBB: o.evLossBB ?? undefined, at: o.createdAt.toISOString() })));
  // Recommend scenarios whose nodes test the leak, preferring unmastered ones.
  const nodes = await prisma.decisionNode.findMany({ where: { scenarioVersion: { scenario: { published: true } } }, select: { leakOpportunities: true, scenarioVersion: { select: { scenarioId: true, version: true, scenario: { select: { currentVersion: true } }, definition: true } } } });
  const reviews = new Map((await prisma.reviewItem.findMany({ where: { userId, itemType: 'scenario' } })).map((r) => [r.itemRef, r.mastery]));
  const items = await Promise.all(
    ranked.map(async (l) => {
      const recs = [
        ...new Map(
          nodes
            .filter((n) => n.leakOpportunities.includes(l.leak) && n.scenarioVersion.version === n.scenarioVersion.scenario.currentVersion)
            .map((n) => {
              const def = n.scenarioVersion.definition as { title: unknown; id: string };
              return [n.scenarioVersion.scenarioId, { id: n.scenarioVersion.scenarioId, title: def.title, mastery: reviews.get(n.scenarioVersion.scenarioId) ?? null }];
            }),
        ).values(),
      ]
        .sort((a, b) => (a.mastery ?? 0) - (b.mastery ?? 0))
        .slice(0, 3);
      const nextReview = await prisma.reviewItem.findFirst({ where: { userId, itemType: 'scenario', itemRef: { in: recs.map((r) => r.id) } }, orderBy: { dueAt: 'asc' } });
      return { ...l, label: LEAK_LABELS[l.leak], recommended: recs, nextReview: nextReview?.dueAt ?? null };
    }),
  );
  res.json(items);
});

analyticsRouter.get('/history', async (req, res) => {
  const userId = requireUser(req);
  const q = parse(z.object({ filter: z.enum(['all', 'incorrect', 'reattempts']).default('all'), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  const sessions = await prisma.trainingSession.findMany({ where: { userId }, orderBy: { startedAt: 'desc' }, take: 20, include: { _count: { select: { attempts: true } } } });
  let attempts = await prisma.decisionAttempt.findMany({
    where: { userId, ...(q.filter === 'incorrect' ? { isError: true } : {}) },
    orderBy: { createdAt: 'desc' },
    take: q.filter === 'reattempts' ? 500 : q.limit,
    select: { id: true, attemptType: true, itemRef: true, grade: true, graded: true, isError: true, evLoss: true, evUnit: true, mode: true, ratingApplied: true, createdAt: true, street: true, heroPosition: true, gradeBasis: true, result: true },
  });
  if (q.filter === 'reattempts') {
    const counts = bucket(attempts, (a) => a.itemRef);
    attempts = attempts.filter((a) => (counts.get(a.itemRef)?.length ?? 0) > 1).slice(0, q.limit);
  }
  res.json({
    sessions: sessions.map((s) => ({ id: s.id, kind: s.kind, mode: s.mode, startedAt: s.startedAt, attempts: s._count.attempts })),
    attempts: attempts.map((a) => {
      const r = a.result as { prompt?: unknown; chosen?: unknown; kind?: string };
      return { ...a, result: undefined, prompt: r?.prompt ?? null, chosen: r?.chosen ?? null };
    }),
  });
});

analyticsRouter.get('/curriculum', async (req, res) => {
  const userId = requireUser(req);
  const versions = await prisma.scenarioVersion.findMany({ where: { scenario: { published: true } }, select: { scenarioId: true, version: true, difficulty: true, scenario: { select: { module: true, mode: true, currentVersion: true } }, source: { select: { classification: true } } } });
  const current = versions.filter((v) => v.version === v.scenario.currentVersion);
  const reviews = new Map((await prisma.reviewItem.findMany({ where: { userId, itemType: 'scenario' } })).map((r) => [r.itemRef, r]));
  const attempted = new Set((await prisma.decisionAttempt.findMany({ where: { userId, attemptType: { in: ['decision', 'question'] } }, select: { itemRef: true }, distinct: ['itemRef'] })).map((a) => a.itemRef.split(':')[0]));
  const ratings = new Map((await prisma.rating.findMany({ where: { userId } })).map((r) => [r.skill, r]));
  const now = new Date();
  res.json(
    CURRICULUM.map((m) => {
      const sc = current.filter((v) => v.scenario.module === m.id);
      const done = sc.filter((v) => attempted.has(v.scenarioId));
      // Mastery: attempted scenarios count by their review mastery; clean first attempts (no review item) count as 0.8.
      const mastery = sc.length ? sc.reduce((s, v) => s + (attempted.has(v.scenarioId) ? (reviews.get(v.scenarioId)?.mastery ?? 0.8) : 0), 0) / sc.length : null;
      return {
        ...m,
        scenarioCount: sc.length,
        ratedScenarioCount: sc.filter((v) => ['SOLVER_VERIFIED', 'COACH_REVIEWED'].includes(v.source.classification)).length,
        attempted: done.length,
        masteryPct: mastery === null ? null : Math.round(mastery * 100),
        reviewDue: sc.filter((v) => (reviews.get(v.scenarioId)?.dueAt ?? now) < now && reviews.has(v.scenarioId)).length,
        skillRatings: m.skills.map((s) => ({ skill: s, rating: ratings.get(s) ? Math.round(ratings.get(s)!.rating) : null })),
        scenarios: sc.map((v) => v.scenarioId),
      };
    }),
  );
});
