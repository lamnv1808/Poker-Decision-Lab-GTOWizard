import { Router } from 'express';
import { requireUser } from './auth';
import { prisma } from './db';

/**
 * Practice progress for every training module — activity, coverage, calibration, streak.
 * These are NOT ratings: they move with every decision, graded or not. Rating changes are reported
 * separately per module (from the immutable rating history) so the user can see what counts where.
 */
export const MODULES = ['fullHand', 'heroScenarios', 'villainScenarios', 'gtoPushFold', 'gtoPostflop', 'mathLab', 'potOdds', 'realReplay'] as const;
type Module = (typeof MODULES)[number];

export const trainingProgressRouter = Router();

trainingProgressRouter.get('/', async (req, res) => {
  const userId = requireUser(req);
  const [attempts, scenarios, hands, dueReviews, hist] = await Promise.all([
    prisma.decisionAttempt.findMany({ where: { userId }, select: { id: true, itemRef: true, attemptType: true, graded: true, isError: true, grade: true, confidence: true, street: true, concepts: true, ratingApplied: true, track: true, createdAt: true } }),
    prisma.scenario.findMany({ select: { id: true, mode: true } }),
    prisma.simHand.findMany({ where: { userId, kind: 'play' }, select: { status: true, fingerprint: true, steps: true, createdAt: true, updatedAt: true } }),
    prisma.reviewItem.count({ where: { userId, dueAt: { lte: new Date() } } }),
    prisma.ratingHistory.findMany({ where: { userId }, select: { attemptId: true, skill: true, ratingBefore: true, ratingAfter: true } }),
  ]);
  const modeOf = new Map(scenarios.map((s) => [s.id, s.mode]));
  const moduleOf = (a: { itemRef: string; attemptType: string }): Module => {
    if (a.itemRef.startsWith('sim:')) return 'fullHand';
    if (a.itemRef.startsWith('gtopf:')) return 'gtoPostflop';
    if (a.itemRef.startsWith('gto:')) return 'gtoPushFold';
    if (a.itemRef.startsWith('quiz:')) return 'mathLab';
    if (a.itemRef.startsWith('potodds:')) return 'potOdds';
    if (a.itemRef.startsWith('real:')) return 'realReplay';
    return modeOf.get(a.itemRef.split(':')[0]!) === 'villain' ? 'villainScenarios' : 'heroScenarios';
  };
  type Row = { decisions: number; graded: number; ungraded: number; correct: number; ratedDecisions: number; strategyDelta: number; fundamentalsDelta: number };
  const blank = (): Row => ({ decisions: 0, graded: 0, ungraded: 0, correct: 0, ratedDecisions: 0, strategyDelta: 0, fundamentalsDelta: 0 });
  const by: Record<Module, Row> = Object.fromEntries(MODULES.map((m) => [m, blank()])) as Record<Module, Row>;
  const attModule = new Map<string, Module>();
  for (const a of attempts) {
    const m = moduleOf(a);
    attModule.set(a.id, m);
    const r = by[m];
    r.decisions++;
    if (a.graded) {
      r.graded++;
      if (!a.isError) r.correct++;
    } else r.ungraded++;
    if (a.ratingApplied) r.ratedDecisions++;
  }
  for (const h of hist) {
    const m = attModule.get(h.attemptId);
    if (!m) continue;
    if (h.skill === 'overall') by[m].strategyDelta += h.ratingAfter - h.ratingBefore;
    if (h.skill === 'fundamentals') by[m].fundamentalsDelta += h.ratingAfter - h.ratingBefore;
  }
  // full hands: ungraded simulator decisions are not attempts — count them from the hand steps
  type Step = { street?: string; graded?: boolean; grade?: string | null; confidence?: number; at?: string };
  const simSteps = hands.flatMap((h) => (h.steps as Step[]) ?? []);
  const fh = by.fullHand;
  const ungradedSim = simSteps.filter((s) => s.graded === false).length;
  fh.decisions += ungradedSim;
  fh.ungraded += ungradedSim;
  const streets: Record<string, number> = { preflop: 0, flop: 0, turn: 0, river: 0 };
  for (const s of simSteps) if (s.street) streets[s.street] = (streets[s.street] ?? 0) + 1;
  for (const a of attempts) if (!a.itemRef.startsWith('sim:') && a.street) streets[a.street] = (streets[a.street] ?? 0) + 1;
  // confidence calibration: accuracy per stated confidence, graded decisions only
  const calib = [1, 2, 3].map((c) => {
    const g = attempts.filter((a) => a.graded && a.confidence === c);
    return { confidence: c, n: g.length, accuracyPct: g.length ? Math.round((1000 * g.filter((a) => !a.isError).length) / g.length) / 10 : null };
  });
  // learning streak: consecutive days (UTC) with any training activity, ending today or yesterday
  const days = new Set<string>([...attempts.map((a) => a.createdAt.toISOString().slice(0, 10)), ...simSteps.filter((s) => s.at).map((s) => s.at!.slice(0, 10))]);
  let streak = 0;
  for (let d = new Date(); ; d = new Date(d.getTime() - 86400000)) {
    const k = d.toISOString().slice(0, 10);
    if (days.has(k)) streak++;
    else if (streak > 0 || k !== new Date().toISOString().slice(0, 10)) break;
  }
  const concepts = new Map<string, number>();
  for (const a of attempts) for (const c of a.concepts) concepts.set(c, (concepts.get(c) ?? 0) + 1);
  const complete = hands.filter((h) => h.status === 'complete');
  res.json({
    note: { en: 'Practice progress — not a rating. Every decision counts here; only validated decisions change ratings.', vi: 'Tiến độ luyện tập — không phải điểm xếp hạng. Mọi quyết định đều được tính ở đây; chỉ quyết định đã kiểm chứng mới thay đổi điểm.' },
    fullHands: { completed: complete.length, uniqueSituations: new Set(complete.map((h) => h.fingerprint)).size, inProgress: hands.filter((h) => h.status === 'active').length },
    totals: { decisions: MODULES.reduce((s, m) => s + by[m].decisions, 0), graded: MODULES.reduce((s, m) => s + by[m].graded, 0), ungraded: MODULES.reduce((s, m) => s + by[m].ungraded, 0) },
    modules: MODULES.map((m) => ({ module: m, ...by[m], strategyDelta: Math.round(by[m].strategyDelta), fundamentalsDelta: Math.round(by[m].fundamentalsDelta) })),
    streetCoverage: streets,
    calibration: calib,
    concepts: [...concepts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([concept, n]) => ({ concept, n })),
    reviewQueue: dueReviews,
    streakDays: streak,
  });
});
