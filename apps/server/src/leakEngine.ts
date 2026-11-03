import { type DecisionRow, LEAK_ENGINE_VERSION, analyzePatterns, analyzeSolver } from '@pdl/core';
import { Router } from 'express';
import { requireUser } from './auth';
import { prisma } from './db';

/** Load a user's accepted, contextualized real decisions in the shape the leak engine needs. */
/** The original Prisma implementation (two queries: decisions, then their hands by id). Kept for the equivalence test. */
export async function loadDecisionRowsPrisma(userId: string): Promise<DecisionRow[]> {
  const rows = await prisma.realDecision.findMany({
    where: { userId, status: 'accepted', contextV: { gte: 1 } },
    select: { id: true, playedAt: true, street: true, position: true, actionContext: true, heroAction: true, stackBucket: true, formatGroup: true, facingBetPct: true, requiredEq: true, multiway: true, pfAudit: true, realHandId: true, realHand: { select: { tournamentId: true } } },
  });
  // cluster = tournament: decisions in the same tournament are not independent observations
  return rows.map(({ realHand, realHandId, ...r }) => ({ ...r, playedAt: r.playedAt?.toISOString() ?? null, pfAudit: (r.pfAudit as DecisionRow['pfAudit']) ?? null, cluster: realHand.tournamentId ?? `hand:${realHandId}` }));
}

type RawDecisionRow = Omit<DecisionRow, 'playedAt' | 'cluster'> & { playedAt: Date | null; cluster: string };

/**
 * Every accepted, analysed decision of a user, in the shape the leak engine reads. One SQL join
 * instead of Prisma's decision query + a second query with tens of thousands of hand ids: same
 * rows and fields (see the equivalence test), several times faster on large imports.
 */
export async function loadDecisionRows(userId: string): Promise<DecisionRow[]> {
  const rows = await prisma.$queryRaw<RawDecisionRow[]>`
    SELECT d.id, d."playedAt", d.street, d.position, d."actionContext", d."heroAction", d."stackBucket", d."formatGroup",
           d."facingBetPct", d."requiredEq", d.multiway, d."pfAudit",
           COALESCE(h."tournamentId", 'hand:' || d."realHandId") AS cluster
    FROM "RealDecision" d JOIN "RealHand" h ON h.id = d."realHandId"
    WHERE d."userId" = ${userId} AND d.status = 'accepted' AND d."contextV" >= 1`;
  return rows.map((r) => ({ ...r, playedAt: r.playedAt?.toISOString() ?? null, pfAudit: (r.pfAudit as DecisionRow['pfAudit']) ?? null }));
}

export async function realLeakReport(userId: string) {
  const rows = await loadDecisionRows(userId);
  const solver = analyzeSolver(rows);
  const patterns = analyzePatterns(rows);
  const dates = rows.map((r) => r.playedAt).filter((x): x is string => !!x).sort();
  return {
    version: LEAK_ENGINE_VERSION,
    decisions: rows.length,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    solver,
    patterns,
  };
}

export const realLeaksRouter = Router();
realLeaksRouter.get('/', async (req, res) => {
  const userId = requireUser(req);
  res.json(await realLeakReport(userId));
});
