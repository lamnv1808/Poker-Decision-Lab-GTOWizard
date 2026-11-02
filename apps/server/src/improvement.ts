import { PATTERNS, PERIOD_DAYS, type DecisionRow, adjustForMultipleComparisons, analyzePatterns, classifySolver, compareRates, periodWindows } from '@pdl/core';
import { Router } from 'express';
import { requireUser } from './auth';
import { prisma } from './db';
import { loadDecisionRows } from './leakEngine';
import { patternLeakKey } from './leakMemory';

/**
 * Improvement over 7/30/60 days (Phase 1 D5). Two tracks that are never mixed:
 *  - realPlay: decision quality in the user's own tournaments, windowed by when the hands were
 *    PLAYED and anchored at the latest imported hand (imports arrive in batches);
 *  - training: what the user practised in the app, windowed by attempt time, anchored now.
 * Each metric compares the window with the equal window before it. Decisions are clustered by
 * tournament (cluster-robust test); the pattern comparisons of one period are corrected together
 * for multiple comparisons (Benjamini–Hochberg) and are labelled exploratory. Pattern changes are
 * reported as toward/away from a heuristic band — a behavioural change, not a verified error.
 */
/** k/n overall and per cluster, for rows passing `hit` among `rows`. */
function clustered(rows: DecisionRow[], hit: (d: DecisionRow) => boolean) {
  const by = new Map<string, { k: number; n: number }>();
  for (const d of rows) {
    const key = d.cluster ?? d.id;
    const c = by.get(key) ?? { k: 0, n: 0 };
    c.n++;
    if (hit(d)) c.k++;
    by.set(key, c);
  }
  const clusters = [...by.values()];
  return { k: clusters.reduce((a, c) => a + c.k, 0), n: rows.length, clusters };
}
const inWin = (at: string | null, w: { from: string; to: string }) => !!at && at >= w.from && at < w.to;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function realPlay(rows: DecisionRow[], memory: { leakKey: string; label: unknown; band: [number, number] | null; status: string }[]) {
  const latest = rows.reduce<string | null>((m, d) => (d.playedAt && (!m || d.playedAt > m) ? d.playedAt : m), null);
  if (!latest) return { anchor: null, periods: [] };
  // anchor just after the last hand so it falls inside the current window
  const anchor = new Date(new Date(latest).getTime() + 1000);
  const patternMem = memory.filter((m) => m.leakKey.startsWith('pattern:') && m.status !== 'resolved');
  const periods = PERIOD_DAYS.map((days) => {
    const w = periodWindows(anchor, days);
    const cur = rows.filter((d) => inWin(d.playedAt, w.current));
    const prev = rows.filter((d) => inWin(d.playedAt, w.previous));
    const solverSide = (xs: DecisionRow[]) => {
      const graded = xs.filter((d) => classifySolver(d) !== 'outsideModel');
      const verified = graded.filter((d) => classifySolver(d) === 'verified');
      return { ...clustered(graded, (d) => classifySolver(d) === 'verified'), evLossBB: r3(verified.reduce((s, d) => s + (d.pfAudit?.evLossBB ?? 0), 0)) };
    };
    const sc = solverSide(cur);
    const sp = solverSide(prev);
    const patterns = patternMem.map((m) => {
      const defKey = m.leakKey.slice('pattern:'.length);
      const def = PATTERNS.find((p) => defKey === p.key || defKey.startsWith(`${p.key}:`));
      if (!def) return null;
      const slice = defKey === def.key ? null : defKey.slice(def.key.length + 1);
      // the opportunities of this pattern (and slice) in a window, clustered by tournament
      const opp = (xs: DecisionRow[]) => {
        const one = (d: DecisionRow) => analyzePatterns([d], [def]).some((r) => r.n === 1 && patternLeakKey(r) === m.leakKey);
        return xs.filter((d) => def.filter(d) && (slice === null || one(d)));
      };
      const a = opp(cur);
      const b = opp(prev);
      return { leakKey: m.leakKey, label: m.label, band: def.band, exploratory: true, ...compareRates(clustered(a, def.hit), clustered(b, def.hit), def.band ? { target: def.band } : {}) };
    }).filter((x): x is NonNullable<typeof x> => !!x);
    adjustForMultipleComparisons(patterns);
    return {
      days,
      window: w,
      decisions: { current: cur.length, previous: prev.length },
      solver: { ...compareRates(sc, sp, { lowerIsBetter: true }), evLossBB: { current: sc.evLossBB, previous: sp.evLossBB } },
      patterns,
    };
  });
  return { anchor: anchor.toISOString(), periods };
}

async function training(userId: string, now: Date) {
  const since = new Date(now.getTime() - 2 * Math.max(...PERIOD_DAYS) * 86_400_000);
  const [atts, hist, sessions, drills] = await Promise.all([
    prisma.decisionAttempt.findMany({ where: { userId, createdAt: { gte: since } }, select: { graded: true, isError: true, evLoss: true, evUnit: true, track: true, createdAt: true } }),
    prisma.ratingHistory.findMany({ where: { userId, createdAt: { gte: since }, skill: { in: ['overall', 'fundamentals'] } }, orderBy: { createdAt: 'asc' }, select: { skill: true, ratingBefore: true, ratingAfter: true, createdAt: true } }),
    prisma.trainingSession.findMany({ where: { userId, kind: 'mixed', startedAt: { gte: since } }, select: { startedAt: true, config: true } }),
    prisma.leakSnapshot.findMany({ where: { memory: { userId }, drillAccuracy: { not: null }, at: { gte: since } }, select: { at: true, drillAccuracy: true, memory: { select: { leakKey: true, label: true } } } }),
  ]);
  return PERIOD_DAYS.map((days) => {
    const w = periodWindows(now, days);
    const side = (win: { from: string; to: string }) => {
      const xs = atts.filter((a) => inWin(a.createdAt.toISOString(), win));
      const graded = xs.filter((a) => a.graded);
      const ev = graded.filter((a) => a.evUnit === 'bb' && a.evLoss !== null);
      // training attempts cluster by day (one sitting is not independent answers)
      const byDay = new Map<string, { k: number; n: number }>();
      for (const a of graded) {
        const d = a.createdAt.toISOString().slice(0, 10);
        const c = byDay.get(d) ?? { k: 0, n: 0 };
        c.n++;
        if (a.isError) c.k++;
        byDay.set(d, c);
      }
      return { attempts: xs.length, graded: graded.length, errors: graded.filter((a) => a.isError).length, days: [...byDay.values()], avgEvLossBB: ev.length ? r3(ev.reduce((s, a) => s + a.evLoss!, 0) / ev.length) : null };
    };
    const c = side(w.current);
    const p = side(w.previous);
    const ratingDelta = (skill: string) => {
      const h = hist.filter((x) => x.skill === skill && inWin(x.createdAt.toISOString(), w.current));
      return h.length ? Math.round(h[h.length - 1]!.ratingAfter - h[0]!.ratingBefore) : null;
    };
    const daily = sessions.filter((s) => inWin(s.startedAt.toISOString(), w.current) && (s.config as { daily?: unknown } | null)?.daily).length;
    const drillRows = drills.filter((d) => inWin(d.at.toISOString(), w.current));
    const byLeak = new Map<string, { label: unknown; acc: number[] }>();
    for (const d of drillRows) byLeak.set(d.memory.leakKey, { label: d.memory.label, acc: [...(byLeak.get(d.memory.leakKey)?.acc ?? []), d.drillAccuracy!] });
    return {
      days,
      window: w,
      attempts: { current: c.attempts, previous: p.attempts },
      // error rate of graded attempts, lower is better
      errors: compareRates({ k: c.errors, n: c.graded, clusters: c.days }, { k: p.errors, n: p.graded, clusters: p.days }, { lowerIsBetter: true }),
      avgEvLossBB: { current: c.avgEvLossBB, previous: p.avgEvLossBB },
      ratingDelta: { strategy: ratingDelta('overall'), fundamentals: ratingDelta('fundamentals') },
      dailySessions: daily,
      drills: [...byLeak].map(([leakKey, v]) => ({ leakKey, label: v.label, sessions: v.acc.length, first: v.acc[0]!, last: v.acc[v.acc.length - 1]! })),
    };
  });
}

export async function improvementReport(userId: string, now = new Date()) {
  const [rows, mem] = await Promise.all([loadDecisionRows(userId), prisma.leakMemory.findMany({ where: { userId }, select: { leakKey: true, label: true, bandLo: true, bandHi: true, status: true } })]);
  return {
    generatedAt: now.toISOString(),
    realPlay: realPlay(rows, mem.map((m) => ({ ...m, band: m.bandLo !== null && m.bandHi !== null ? [m.bandLo, m.bandHi] : null }))),
    training: { anchor: now.toISOString(), periods: await training(userId, now) },
  };
}

export const improvementRouter = Router();
improvementRouter.get('/', async (req, res) => {
  const userId = requireUser(req);
  res.json(await improvementReport(userId));
});
