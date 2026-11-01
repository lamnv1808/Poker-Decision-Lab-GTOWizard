import {
  type Grade,
  GRADE_SCORE,
  type LeakKey,
  type RatingKey,
  type SkillKey,
  type SourceClass,
  computeRatingChanges,
  initialSrs,
  masteryEstimate,
  needsReview,
  observationsFor,
  reviewSrs,
  difficultyRating,
  FUNDAMENTALS_KEY,
  FUND_METHOD_VERSION,
  RATING_MODEL_VERSION,
  fundamentalsUpdate,
} from '@pdl/core';
import { Prisma } from '@prisma/client';
import { prisma } from './db';

export interface AttemptInput {
  userId: string;
  clientAttemptId: string;
  sessionId?: string | null;
  runId?: string | null;
  scenarioVersionId?: string | null;
  decisionNodeId?: string | null;
  attemptType: 'decision' | 'question' | 'quiz' | 'imported' | 'replay' | 'potodds';
  itemRef: string;
  reviewType: 'scenario' | 'quiz' | 'imported' | 'real';
  reviewRef: string;
  mode: 'practice' | 'rated';
  action: unknown;
  optionKey?: string | null;
  graded: boolean;
  grade?: Grade;
  gradeBasis: string;
  evLoss?: number;
  evUnit?: string;
  ratingEligible: boolean;
  isError: boolean;
  confidence?: 1 | 2 | 3;
  gradingMethodVersion: string;
  street?: string;
  heroPosition?: string;
  effectiveStackBB?: number;
  difficulty: number;
  skills: SkillKey[];
  concepts: string[];
  leakOpportunities: LeakKey[];
  optionLeaks: LeakKey[];
  sourceClass: SourceClass;
  /** fundamentals | replay | strategy. Only `strategy` attempts can change Elo. Default strategy. */
  track?: 'fundamentals' | 'replay' | 'strategy';
  familyId?: string | null;
  responseMs?: number | null;
  reasoning?: string | null;
  annotationId?: string | null;
  result: Record<string, unknown>;
}

export interface AttemptOutcome {
  attemptId: string;
  duplicate: boolean;
  ratingChanges: { skill: string; before: number; after: number; rdAfter: number }[];
  review: { dueAt: string; mastery: number } | null;
  result: Record<string, unknown>;
}

/**
 * Record one attempt atomically: immutable attempt row, rating updates (with history,
 * unique per attempt+skill so a retry can never double-apply), leak observations, and
 * the spaced-repetition schedule. Idempotent on (userId, clientAttemptId).
 */
export async function recordAttempt(input: AttemptInput): Promise<AttemptOutcome> {
  await ensureRatingModel(input.userId);
  const existing = await prisma.decisionAttempt.findUnique({ where: { userId_clientAttemptId: { userId: input.userId, clientAttemptId: input.clientAttemptId } }, include: { ratingHistory: true } });
  if (existing) return fromExisting(existing);
  try {
    return await prisma.$transaction(async (tx) => {
      const now = new Date();
      const score = input.grade ? GRADE_SCORE[input.grade] : undefined;
      const track = input.track ?? 'strategy';
      // Arithmetic (fundamentals) and unreviewed replays never move strategy ratings.
      const rated = track === 'strategy' && input.mode === 'rated' && input.graded && input.ratingEligible && score !== undefined;
      const priorExposures = rated
        ? await tx.decisionAttempt.count({ where: { userId: input.userId, ratingApplied: true, track: 'strategy', ...(input.familyId ? { familyId: input.familyId } : { itemRef: input.itemRef }) } })
        : 0;
      const keys: RatingKey[] = ['overall', ...input.skills];
      const current = rated ? await tx.rating.findMany({ where: { userId: input.userId, skill: { in: keys } } }) : [];
      const curMap = Object.fromEntries(current.map((r) => [r.skill, { rating: r.rating, rd: r.rd, vol: r.vol }]));
      const daysSince = Object.fromEntries(current.map((r) => [r.skill, Math.floor((now.getTime() - r.updatedAt.getTime()) / 86400000)]));
      const { changes, weight, methodVersion } = rated
        ? computeRatingChanges(curMap, { score: score!, difficulty: input.difficulty, source: input.sourceClass, priorExposures, rated: true, skills: input.skills, daysSince })
        : { changes: [], weight: 0, methodVersion: '' };
      // Fundamentals subrating: exact maths / assumed-range-model decisions (never heuristic content).
      const fundRated = track === 'fundamentals' && input.graded && score !== undefined && input.mode === 'rated';
      let fund: ReturnType<typeof fundamentalsUpdate> = null;
      if (fundRated) {
        const prior = await tx.ratingHistory.count({ where: { userId: input.userId, skill: FUNDAMENTALS_KEY, attempt: input.familyId ? { familyId: input.familyId } : { itemRef: input.itemRef } } });
        const cur = await tx.rating.findUnique({ where: { userId_skill: { userId: input.userId, skill: FUNDAMENTALS_KEY } } });
        fund = fundamentalsUpdate(cur ? { rating: cur.rating, rd: cur.rd, vol: cur.vol } : undefined, {
          score: score!,
          difficulty: input.difficulty,
          priorExposures: prior,
          // RD inflation from the last Fundamentals update itself (not the row's write time, which a back-fill resets)
          daysSince: await (async () => {
            const last = await tx.ratingHistory.findFirst({ where: { userId: input.userId, skill: FUNDAMENTALS_KEY }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
            return last ? Math.floor((now.getTime() - last.createdAt.getTime()) / 86400000) : 0;
          })(),
        });
      }
      const attempt = await tx.decisionAttempt.create({
        data: {
          userId: input.userId,
          clientAttemptId: input.clientAttemptId,
          sessionId: input.sessionId ?? null,
          runId: input.runId ?? null,
          scenarioVersionId: input.scenarioVersionId ?? null,
          decisionNodeId: input.decisionNodeId ?? null,
          attemptType: input.attemptType,
          itemRef: input.itemRef,
          mode: input.mode,
          action: input.action as object,
          optionKey: input.optionKey ?? null,
          graded: input.graded,
          grade: input.grade ?? null,
          gradeBasis: input.gradeBasis,
          evLoss: input.evLoss ?? null,
          evUnit: input.evUnit ?? null,
          score: score ?? null,
          ratingEligible: input.ratingEligible,
          ratingApplied: changes.length > 0 || !!fund,
          ratingWeight: fund ? fund.weight : weight,
          isError: input.isError,
          confidence: input.confidence ?? null,
          gradingMethodVersion: input.gradingMethodVersion,
          street: input.street ?? null,
          heroPosition: input.heroPosition ?? null,
          effectiveStackBB: input.effectiveStackBB ?? null,
          difficulty: input.difficulty,
          skills: input.skills,
          concepts: input.concepts,
          leakKeys: input.optionLeaks,
          result: input.result as object,
          track,
          familyId: input.familyId ?? null,
          responseMs: input.responseMs ?? null,
          reasoning: input.reasoning ?? null,
          annotationId: input.annotationId ?? null,
        },
      });
      const opp = difficultyRating(input.difficulty);
      for (const c of changes) {
        await tx.rating.upsert({
          where: { userId_skill: { userId: input.userId, skill: c.key } },
          create: { userId: input.userId, skill: c.key, rating: c.after.rating, rd: c.after.rd, vol: c.after.vol, games: 1 },
          update: { rating: c.after.rating, rd: c.after.rd, vol: c.after.vol, games: { increment: 1 } },
        });
        await tx.ratingHistory.create({
          data: {
            userId: input.userId,
            attemptId: attempt.id,
            skill: c.key,
            ratingBefore: c.before.rating,
            rdBefore: c.before.rd,
            volBefore: c.before.vol,
            ratingAfter: c.after.rating,
            rdAfter: c.after.rd,
            volAfter: c.after.vol,
            weight: c.weight,
            score: score!,
            opponentRating: opp.rating,
            methodVersion,
          },
        });
      }
      if (fund) {
        await tx.rating.upsert({
          where: { userId_skill: { userId: input.userId, skill: FUNDAMENTALS_KEY } },
          create: { userId: input.userId, skill: FUNDAMENTALS_KEY, rating: fund.after.rating, rd: fund.after.rd, vol: fund.after.vol, games: 1 },
          update: { rating: fund.after.rating, rd: fund.after.rd, vol: fund.after.vol, games: { increment: 1 } },
        });
        await tx.ratingHistory.create({
          data: { userId: input.userId, attemptId: attempt.id, skill: FUNDAMENTALS_KEY, ratingBefore: fund.before.rating, rdBefore: fund.before.rd, volBefore: fund.before.vol, ratingAfter: fund.after.rating, rdAfter: fund.after.rd, volAfter: fund.after.vol, weight: fund.weight, score: score!, opponentRating: opp.rating, methodVersion: FUND_METHOD_VERSION },
        });
        changes.push({ key: FUNDAMENTALS_KEY as RatingKey, before: fund.before, after: fund.after, weight: fund.weight });
      }
      if (input.graded) {
        const evBB = input.evUnit === 'bb' ? input.evLoss : undefined;
        const obs = observationsFor(input.leakOpportunities, input.optionLeaks, input.isError, now.toISOString(), evBB);
        if (obs.length)
          await tx.leakObservation.createMany({ data: obs.map((o) => ({ userId: input.userId, attemptId: attempt.id, leakKey: o.leak, isError: o.isError, evLossBB: o.evLossBB ?? null })) });
      }
      let review: AttemptOutcome['review'] = null;
      if (input.graded && input.grade) {
        const where = { userId_itemType_itemRef: { userId: input.userId, itemType: input.reviewType, itemRef: input.reviewRef } };
        const item = await tx.reviewItem.findUnique({ where });
        if (item || needsReview(input.grade, input.confidence)) {
          const prev = item
            ? { repetitions: item.repetitions, ease: item.ease, intervalDays: item.intervalDays, dueAt: item.dueAt.toISOString(), lastQuality: item.lastQuality, lapses: item.lapses }
            : initialSrs(now);
          const next = reviewSrs(prev, input.grade, now, input.confidence);
          const data = {
            repetitions: next.repetitions,
            ease: next.ease,
            intervalDays: next.intervalDays,
            dueAt: new Date(next.dueAt),
            lastQuality: next.lastQuality,
            lapses: next.lapses,
            mastery: masteryEstimate(next),
            lastAttemptAt: now,
            lastGrade: input.grade,
          };
          await tx.reviewItem.upsert({ where, create: { userId: input.userId, itemType: input.reviewType, itemRef: input.reviewRef, ...data }, update: data });
          review = { dueAt: next.dueAt, mastery: data.mastery };
        }
      }
      const result = { ...input.result, ratingChanges: changes.map((c) => ({ skill: c.key, before: c.before.rating, after: c.after.rating, rdAfter: c.after.rd })), review };
      await tx.decisionAttempt.update({ where: { id: attempt.id }, data: { result: result as object } });
      return { attemptId: attempt.id, duplicate: false, ratingChanges: result.ratingChanges, review, result };
    });
  } catch (e) {
    // A concurrent retry with the same clientAttemptId won the race: return its result.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const again = await prisma.decisionAttempt.findUnique({ where: { userId_clientAttemptId: { userId: input.userId, clientAttemptId: input.clientAttemptId } }, include: { ratingHistory: true } });
      if (again) return fromExisting(again);
    }
    throw e;
  }
}

function fromExisting(a: { id: string; result: unknown }): AttemptOutcome {
  const result = (a.result ?? {}) as Record<string, unknown>;
  return {
    attemptId: a.id,
    duplicate: true,
    ratingChanges: (result.ratingChanges as AttemptOutcome['ratingChanges']) ?? [],
    review: (result.review as AttemptOutcome['review']) ?? null,
    result,
  };
}

/**
 * Bring a user's ratings to the current rating model (versioned, idempotent, no reset).
 * unified-v1 adds the Fundamentals subrating, back-filled deterministically from the user's
 * immutable fundamentals attempts in time order; strategy ratings are not touched.
 */
export async function ensureRatingModel(userId: string): Promise<void> {
  const st = await prisma.ratingModelState.findUnique({ where: { userId } });
  if (st?.version === RATING_MODEL_VERSION) return;
  try {
    await prisma.$transaction(
      async (tx) => {
        // The state row doubles as a lock: a concurrent migration fails on the primary key / version check.
        if (st) {
          const n = await tx.ratingModelState.updateMany({ where: { userId, version: st.version }, data: { version: RATING_MODEL_VERSION, migratedAt: new Date() } });
          if (n.count === 0) return;
        } else await tx.ratingModelState.create({ data: { userId, version: RATING_MODEL_VERSION } });
        if (await tx.ratingHistory.findFirst({ where: { userId, skill: FUNDAMENTALS_KEY } })) return;
        const atts = await tx.decisionAttempt.findMany({
          where: { userId, track: 'fundamentals', graded: true, score: { not: null }, OR: [{ mode: 'rated' }, { attemptType: 'potodds' }] },
          orderBy: { createdAt: 'asc' },
          select: { id: true, score: true, difficulty: true, familyId: true, itemRef: true, createdAt: true },
        });
        let cur: { rating: number; rd: number; vol: number } | undefined;
        let last: Date | undefined;
        const seen = new Map<string, number>();
        const rows: Prisma.RatingHistoryCreateManyInput[] = [];
        for (const a of atts) {
          const key = a.familyId ?? a.itemRef;
          const prior = seen.get(key) ?? 0;
          const u = fundamentalsUpdate(cur, { score: a.score!, difficulty: a.difficulty, priorExposures: prior, daysSince: last ? Math.floor((a.createdAt.getTime() - last.getTime()) / 86400000) : 0 });
          if (!u) continue;
          seen.set(key, prior + 1);
          rows.push({ userId, attemptId: a.id, skill: FUNDAMENTALS_KEY, ratingBefore: u.before.rating, rdBefore: u.before.rd, volBefore: u.before.vol, ratingAfter: u.after.rating, rdAfter: u.after.rd, volAfter: u.after.vol, weight: u.weight, score: a.score!, opponentRating: difficultyRating(a.difficulty).rating, methodVersion: `${FUND_METHOD_VERSION}-backfill`, createdAt: a.createdAt });
          cur = u.after;
          last = a.createdAt;
        }
        if (rows.length) {
          await tx.ratingHistory.createMany({ data: rows, skipDuplicates: true });
          await tx.rating.upsert({
            where: { userId_skill: { userId, skill: FUNDAMENTALS_KEY } },
            create: { userId, skill: FUNDAMENTALS_KEY, rating: cur!.rating, rd: cur!.rd, vol: cur!.vol, games: rows.length },
            update: { rating: cur!.rating, rd: cur!.rd, vol: cur!.vol, games: rows.length },
          });
        }
        await tx.ratingModelState.update({ where: { userId }, data: { backfilled: rows.length } });
      },
      { timeout: 60_000 },
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return;
    throw e;
  }
}
