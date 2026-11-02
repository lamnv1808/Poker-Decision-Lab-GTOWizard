import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import {
  ANTE_FORMATS,
  CLASSES,
  GTO_ASSUMPTIONS,
  GTO_STACKS,
  GRADING_METHOD_VERSION,
  PUSHFOLD_DATA_INFO,
  type GtoAction,
  type GtoSpot,
  applyAction,
  createHand,
  generateGtoSpot,
  gradeGtoSpot,
  isError,
  legalActions,
  publicState,
  solvePushFold,
} from '@pdl/core';
import { classifySolver } from '@pdl/core';
import { loadDecisionRows } from './leakEngine';
import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from './auth';
import { mixedSessionFor } from './mixed';
import { prisma } from './db';
import { env } from './env';
import { HttpError, parse } from './http';
import { recordAttempt } from './learning';

const BB = 1000;

function sign(payload: string) {
  return createHmac('sha256', env.APP_SECRET).update(`gto:${payload}`).digest('base64url');
}
function issue(userId: string, seed: number, filter: object) {
  const payload = Buffer.from(JSON.stringify({ u: userId, s: seed, f: filter })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function read(userId: string, token: string): { s: number; f: Parameters<typeof generateGtoSpot>[1] } {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) throw new HttpError(400, 'invalid_token');
  const a = Buffer.from(sign(payload));
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(400, 'invalid_token');
  const d = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { u: string; s: number; f: Parameters<typeof generateGtoSpot>[1] };
  if (d.u !== userId) throw new HttpError(403, 'forbidden');
  return d;
}

/** Table state for the spot, built on the real engine (SB vs BB, dead antes posted as a BB-ante equivalent). */
export function spotState(spot: GtoSpot) {
  const dead = Math.round(spot.deadBB * BB);
  const stack = Math.round(spot.stackBB * BB);
  let s = createHand({
    smallBlind: BB / 2,
    bigBlind: BB,
    ante: dead,
    anteMode: dead > 0 ? 'bigBlind' : 'none',
    players: [
      { id: 'SB', stack, cards: spot.role === 'sbShove' ? spot.heroCards : undefined },
      { id: 'BB', stack: stack + dead, cards: spot.role === 'bbCall' ? spot.heroCards : undefined },
    ],
  });
  if (spot.role === 'bbCall') s = applyAction(s, { type: 'raise', amount: legalActions(s)!.maxRaiseTo });
  return s;
}

const grid13 = (freq: number[]) => Object.fromEntries(CLASSES.map((c, i) => [c, freq[i]!]));

export const gtoRouter = Router();

gtoRouter.get('/info', (_req, res) => {
  res.json({ ...PUSHFOLD_DATA_INFO, stacks: GTO_STACKS, anteFormats: ANTE_FORMATS, assumptions: GTO_ASSUMPTIONS });
});

gtoRouter.get('/spot', (req, res) => {
  const userId = requireUser(req);
  const q = parse(
    z.object({ minStack: z.coerce.number().min(2).max(15).default(2), maxStack: z.coerce.number().min(2).max(15).default(15), role: z.enum(['any', 'sbShove', 'bbCall']).default('any') }),
    req.query,
  );
  if (q.minStack > q.maxStack) throw new HttpError(400, 'invalid_input', 'minStack > maxStack');
  const filter = { minStack: q.minStack, maxStack: q.maxStack, role: q.role };
  const seed = randomInt(1, 2 ** 31 - 1);
  const spot = generateGtoSpot(seed, filter);
  const heroId = spot.role === 'sbShove' ? 'SB' : 'BB';
  res.json({
    token: issue(userId, seed, filter),
    role: spot.role,
    stackBB: spot.stackBB,
    deadBB: spot.deadBB,
    anteFormat: spot.anteFormat,
    anteLabel: ANTE_FORMATS[spot.anteFormat].label,
    heroId,
    heroCards: spot.heroCards,
    bigBlind: BB,
    state: publicState(spotState(spot), heroId),
  });
});

gtoRouter.post('/answer', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(z.object({ sessionId: z.string().uuid().optional(), token: z.string().min(10).max(1000), action: z.enum(['shove', 'call', 'fold']), clientAttemptId: z.string().min(8).max(100), mode: z.enum(['practice', 'rated']).default('rated') }), req.body);
  const t = read(userId, body.token);
  const spot = generateGtoSpot(t.s, t.f);
  let g;
  try {
    g = gradeGtoSpot(spot, body.action as GtoAction);
  } catch (e) {
    throw new HttpError(400, 'illegal_action', (e as Error).message);
  }
  const sol = solvePushFold({ stackBB: spot.stackBB, deadBB: spot.deadBB });
  const close = Math.abs(g.evAggressive) < 0.3 ? 4 : Math.abs(g.evAggressive) < 1 ? 3 : 2;
  const aggressive = spot.role === 'sbShove' ? 'shove' : 'call';
  const leak = spot.role === 'sbShove' ? (body.action === 'fold' ? 'stackDepthAdjustments' : 'excessivePreflopAllIns') : 'potOdds';
  const result = {
    role: spot.role,
    stackBB: spot.stackBB,
    deadBB: spot.deadBB,
    heroClass: spot.heroClass,
    heroCards: spot.heroCards,
    action: body.action,
    grade: g.grade,
    evLossBB: g.evLossBB,
    frequency: g.frequency,
    evAggressive: g.evAggressive,
    bestAction: g.bestAction,
    correctActions: g.correctActions,
    ranges: { push: grid13(sol.push), call: grid13(sol.call) },
    pushPct: sol.pushPct,
    callPct: sol.callPct,
    exploitabilityBB: sol.exploitabilityBB,
    assumptions: GTO_ASSUMPTIONS,
    source: { classification: 'SOLVER_VERIFIED', method: { en: `Push/fold Nash equilibrium computed by this app (${sol.methodVersion}, ${PUSHFOLD_DATA_INFO.iterations} fictitious-play iterations; exploitability ${sol.exploitabilityBB.toFixed(5)} BB).`, vi: `Cân bằng Nash push/fold do ứng dụng tính (${sol.methodVersion}, ${PUSHFOLD_DATA_INFO.iterations} vòng fictitious play; độ khai thác ${sol.exploitabilityBB.toFixed(5)} BB).` } },
  };
  // a Mixed session's practice/rated choice overrides the page's own toggle
  const mixed = await mixedSessionFor(userId, body.sessionId);
  const outcome = await recordAttempt({
    userId,
    clientAttemptId: body.clientAttemptId,
    sessionId: mixed?.id ?? null,
    attemptType: 'quiz',
    itemRef: `gto:${spot.role}:${spot.stackBB}:${spot.deadBB}:${spot.heroClass}`,
    reviewType: 'quiz',
    reviewRef: 'gto',
    mode: mixed?.mode ?? body.mode,
    action: { action: body.action },
    optionKey: body.action,
    graded: true,
    grade: g.grade,
    gradeBasis: 'solverEv',
    evLoss: g.evLossBB,
    evUnit: 'bb',
    ratingEligible: true,
    isError: isError(g.grade),
    gradingMethodVersion: GRADING_METHOD_VERSION,
    street: 'preflop',
    heroPosition: spot.role === 'sbShove' ? 'SB' : 'BB',
    effectiveStackBB: spot.stackBB,
    difficulty: close,
    skills: ['preflop', 'shortStack'],
    concepts: ['push-fold', spot.role === 'sbShove' ? 'shove-ranges' : 'calling-ranges'],
    leakOpportunities: spot.role === 'sbShove' ? ['stackDepthAdjustments', 'excessivePreflopAllIns'] : ['potOdds'],
    optionLeaks: isError(g.grade) ? [leak] : [],
    sourceClass: 'SOLVER_VERIFIED',
    result: { ...result, ranges: undefined },
  });
  void aggressive;
  res.json({ ...outcome.result, ranges: result.ranges });
});

/**
 * Push/fold audit across the user's imported real hands (RealDecision.pfAudit, the same verdicts the
 * leak engine uses). Every spot is classified: verified chip-EV mistake, near threshold (the grid
 * rounding could produce the verdict), inconclusive in a bounty event, correct/small loss, or
 * outside the model. Totals sum VERIFIED mistakes only.
 */
gtoRouter.get('/audit', async (req, res) => {
  const userId = requireUser(req);
  let rows = (await loadDecisionRows(userId)).filter((r) => r.pfAudit);
  const hands = new Map((await prisma.realDecision.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, realHand: { select: { handId: true, tournamentName: true } } } })).map((d) => [d.id, d.realHand]));
  let source: 'realHands' | 'legacyUploads' = 'realHands';
  if (!rows.length) {
    // users who only uploaded hand files on the Hands page: older verdicts without the grid
    // robustness check, so any mistake there is shown as near threshold (never verified)
    const legacy = await prisma.handHistory.findMany({ where: { userId, hasGtoSpot: true }, select: { id: true, externalHandId: true, playedAt: true, gtoAudit: true, tournament: { select: { name: true } } }, orderBy: { playedAt: 'desc' } });
    source = 'legacyUploads';
    rows = legacy.map((h) => ({ id: h.id, playedAt: h.playedAt?.toISOString() ?? null, street: 'preflop', position: null, actionContext: null, heroAction: null, stackBucket: null, formatGroup: /PKO|bounty/i.test(h.tournament?.name ?? '') ? 'PKO' : 'regular', facingBetPct: null, requiredEq: null, multiway: false, pfAudit: h.gtoAudit as never }));
    for (const h of legacy) hands.set(h.id, { handId: h.externalHandId, tournamentName: h.tournament?.name ?? null });
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const spots = rows.map((r) => {
    const p = r.pfAudit as NonNullable<typeof r.pfAudit> & { exactStackBB?: number; exactDeadBB?: number; deadBB?: number; frequency?: number };
    return { decisionId: r.id, externalHandId: hands.get(r.id)?.handId ?? '', tournament: hands.get(r.id)?.tournamentName ?? null, playedAt: r.playedAt, format: r.formatGroup, cls: classifySolver(r), ...p };
  });
  const group = (role: 'sbShove' | 'bbCall') => {
    const g = spots.filter((s) => s.role === role);
    const of = (c: string) => g.filter((s) => s.cls === c);
    const verified = of('verified');
    const bands = [['≤6', 0, 6], ['6.5–10', 6.5, 10], ['10.5–15', 10.5, 15]].map(([band, lo, hi]) => {
      const b = g.filter((s) => s.cls !== 'outsideModel' && s.stackBB >= (lo as number) && s.stackBB <= (hi as number));
      const v = b.filter((s) => s.cls === 'verified');
      return { band, n: b.length, verified: v.length, evLossBB: r2(v.reduce((a, s) => a + (s.evLossBB ?? 0), 0)) };
    });
    return {
      spots: g.length,
      graded: g.filter((s) => s.cls !== 'outsideModel').length,
      outsideModel: of('outsideModel').length,
      verified: verified.length,
      nearThreshold: of('nearThreshold').length,
      inconclusiveBounty: of('inconclusiveBounty').length,
      evLossBB: r2(verified.reduce((a, s) => a + (s.evLossBB ?? 0), 0)),
      tooTight: verified.filter((s) => s.heroAction === 'fold').length,
      tooLoose: verified.filter((s) => s.heroAction !== 'fold').length,
      bands,
    };
  };
  const order = { verified: 0, nearThreshold: 1, inconclusiveBounty: 2 } as Record<string, number>;
  res.json({
    source,
    totalHands: source === 'realHands' ? await prisma.realHand.count({ where: { userId, status: 'accepted' } }) : await prisma.handHistory.count({ where: { userId } }),
    sbShove: group('sbShove'),
    bbCall: group('bbCall'),
    worst: spots.filter((s) => s.cls in order).sort((a, b) => order[a.cls]! - order[b.cls]! || (b.evLossBB ?? 0) - (a.evLossBB ?? 0)).slice(0, 60),
    assumptions: GTO_ASSUMPTIONS,
  });
});
