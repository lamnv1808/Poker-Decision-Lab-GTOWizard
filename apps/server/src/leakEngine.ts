import { type DecisionRow, LEAK_ENGINE_VERSION, analyzePatterns, analyzeSolver } from '@pdl/core';
import { Router } from 'express';
import { requireUser } from './auth';
import { prisma } from './db';

/** Load a user's accepted, contextualized real decisions in the shape the leak engine needs. */
export async function loadDecisionRows(userId: string): Promise<DecisionRow[]> {
  const rows = await prisma.realDecision.findMany({
    where: { userId, status: 'accepted', contextV: { gte: 1 } },
    select: { id: true, playedAt: true, street: true, position: true, actionContext: true, heroAction: true, stackBucket: true, formatGroup: true, facingBetPct: true, requiredEq: true, multiway: true, pfAudit: true },
  });
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
