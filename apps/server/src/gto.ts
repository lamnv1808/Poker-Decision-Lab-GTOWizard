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
  type PushFoldAudit,
  applyAction,
  createHand,
  generateGtoSpot,
  gradeGtoSpot,
  isError,
  legalActions,
  publicState,
  solvePushFold,
} from '@pdl/core';
import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from './auth';
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
  const body = parse(z.object({ token: z.string().min(10).max(1000), action: z.enum(['shove', 'call', 'fold']), clientAttemptId: z.string().min(8).max(100), mode: z.enum(['practice', 'rated']).default('rated') }), req.body);
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
  const outcome = await recordAttempt({
    userId,
    clientAttemptId: body.clientAttemptId,
    attemptType: 'quiz',
    itemRef: `gto:${spot.role}:${spot.stackBB}:${spot.deadBB}:${spot.heroClass}`,
    reviewType: 'quiz',
    reviewRef: 'gto',
    mode: body.mode,
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

/** Push/fold audit across the user's imported hands. */
gtoRouter.get('/audit', async (req, res) => {
  const userId = requireUser(req);
  const rows = await prisma.handHistory.findMany({
    where: { userId, hasGtoSpot: true },
    select: { id: true, externalHandId: true, playedAt: true, gtoAudit: true, tournament: { select: { name: true } } },
    orderBy: { playedAt: 'desc' },
  });
  const spots = rows.map((r) => ({ handId: r.id, externalHandId: r.externalHandId, playedAt: r.playedAt, tournament: r.tournament?.name ?? null, ...(r.gtoAudit as unknown as PushFoldAudit) }));
  const graded = spots.filter((s) => s.grade);
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  const group = (role: string) => {
    const g = graded.filter((s) => s.role === role);
    const tight = g.filter((s) => s.heroAction === 'fold' && s.bestAction !== 'fold' && s.bestAction !== 'mixed');
    const loose = g.filter((s) => s.heroAction !== 'fold' && s.bestAction === 'fold');
    const bands = [[1, 6], [6.5, 10], [10.5, 15]].map(([lo, hi]) => {
      const b = g.filter((s) => s.stackBB >= lo! && s.stackBB <= hi!);
      return { band: `${lo}–${hi}`, n: b.length, accuracyPct: b.length ? Math.round((100 * b.filter((s) => (s.evLossBB ?? 0) < 0.2).length) / b.length) : null, evLossBB: sum(b.map((s) => s.evLossBB ?? 0)) };
    });
    return {
      spots: spots.filter((s) => s.role === role).length,
      graded: g.length,
      outsideModel: spots.filter((s) => s.role === role && !s.grade).length,
      mistakes: g.filter((s) => s.grade === 'mistake' || s.grade === 'major').length,
      evLossBB: sum(g.map((s) => s.evLossBB ?? 0)),
      tooTight: { n: tight.length, evLossBB: sum(tight.map((s) => s.evLossBB ?? 0)) },
      tooLoose: { n: loose.length, evLossBB: sum(loose.map((s) => s.evLossBB ?? 0)) },
      bands,
    };
  };
  res.json({
    totalHands: await prisma.handHistory.count({ where: { userId } }),
    sbShove: group('sbShove'),
    bbCall: group('bbCall'),
    worst: [...graded].sort((a, b) => (b.evLossBB ?? 0) - (a.evLossBB ?? 0)).slice(0, 40),
    assumptions: GTO_ASSUMPTIONS,
  });
});
