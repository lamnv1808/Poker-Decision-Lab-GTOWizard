import { CONTEXT_VERSION, LEAK_ENGINE_VERSION, LEAK_LABELS, type LeakKey, type PatternResult, type SolverFinding, analyzePatterns, analyzeSolver, classifySolver, rankLeaks, reviewSrs, initialSrs, type Grade } from '@pdl/core';
import { Router } from 'express';
import { requireUser } from './auth';
import { prisma } from './db';
import { loadDecisionRows } from './leakEngine';

/**
 * Persistent mistake memory (Phase 1 D3).
 *
 * A refresh re-runs the leak engine on the user's real decisions (and the training leak tracker) and
 * folds the result into one LeakMemory row per leak. Rows are never deleted by a refresh: a leak
 * that stops being detected becomes `improving` or `resolved` with its history kept as snapshots.
 *
 * Status rules (all from data, no guesses):
 *  - pattern: `active` while the full sample is outside the reference band; `improving` when the most
 *    recent 30 days of hands (n ≥ 30) are inside the band; `resolved` once the full sample is too.
 *  - solver: verified push/fold mistakes never disappear, so `improving` = no verified mistake in the
 *    recent window over enough spots that a clean run would be unlikely (≤ 10%) at the old mistake
 *    rate; `resolved` = ≤ 1%.
 *  - training: `improving` when the recent error rate is ≥ 10 points lower than the earlier one;
 *    `resolved` when the tracker no longer ranks it.
 * Severity is put on a common 0..1 scale: pattern = distance of the 90% interval from the band / 15
 * points; solver = conservative verified chip-EV loss / 10 BB (min 0.15); training = tracker priority / 0.6.
 * Solver evidence is CHIP EV against the heads-up push/fold equilibrium: ICM and payouts are not
 * modelled, so late in a tournament a chip-losing fold can still be the right tournament decision.
 */
export const LEAK_MEMORY_VERSION = 'memory-v1';
const RECENT_DAYS = 30;
const DAY = 86_400_000;

interface Candidate {
  leakKey: string;
  source: 'real' | 'training';
  evidence: 'solver' | 'pattern' | 'training';
  category: string;
  street: string | null;
  decisionType: string | null;
  label: { en: string; vi: string };
  drill: string;
  status: 'active' | 'improving' | 'resolved';
  severity: number;
  confidence: 'low' | 'medium' | 'high';
  n: number;
  rate: number | null;
  ci: [number, number] | null;
  band: [number, number] | null;
  evLossBB: number | null;
  evLossMinBB: number | null;
  notVerified: number;
  recentN: number;
  recentRate: number | null;
  recentVerdict: string | null;
  examples: string[];
  lastSeenAt: string | null;
  /** Detected as a leak now; undetected candidates can only resolve an existing memory. */
  detected: boolean;
}

export const patternLeakKey = (p: Pick<PatternResult, 'key' | 'slice'>) => `pattern:${p.key}${p.slice ? `:${p.slice}` : ''}`;
const gap = (p: PatternResult) => (!p.ci || !p.band ? 0 : p.ci[0] > p.band[1] ? p.ci[0] - p.band[1] : p.band[0] > p.ci[1] ? p.band[0] - p.ci[1] : 0);
const r4 = (x: number) => Math.round(x * 10000) / 10000;

const TRAINING_DRILL: Partial<Record<LeakKey, string>> = {
  potOdds: 'math:potodds',
  comboCounting: 'math:potodds',
  stackDepthAdjustments: 'gto:pushfold',
  excessivePreflopAllIns: 'gto:pushfold',
  riverBluffCatching: 'scenario:river',
  missedThinValue: 'scenario:river',
  multiwayDiscipline: 'scenario:multiway',
};

const SOLVER_LABEL = (f: SolverFinding) => {
  const role = f.role === 'sbShove' ? { en: 'SB shove', vi: 'SB đẩy all-in' } : { en: 'BB call vs shove', vi: 'BB theo all-in' };
  const dir = f.direction === 'tooTight' ? { en: 'too tight (folds that lose chips)', vi: 'quá chặt (bỏ bài mất chip)' } : { en: 'too loose', vi: 'quá rộng' };
  return { en: `${role.en} ${f.stackBand} BB: ${dir.en}`, vi: `${role.vi} ${f.stackBand} BB: ${dir.vi}` };
};

/** Compute all leak candidates for a user (pure read). */
export async function leakCandidates(userId: string): Promise<{ candidates: Candidate[]; decisions: number; patterns: PatternResult[] }> {
  const rows = await loadDecisionRows(userId);
  const latest = rows.reduce<string | null>((m, d) => (d.playedAt && (!m || d.playedAt > m) ? d.playedAt : m), null);
  const recentFrom = latest ? new Date(new Date(latest).getTime() - RECENT_DAYS * DAY).toISOString() : null;
  const recent = recentFrom ? rows.filter((d) => d.playedAt && d.playedAt >= recentFrom) : [];
  const out: Candidate[] = [];

  // 1. Solver-verified push/fold mistakes
  const solver = analyzeSolver(rows);
  const recentSolver = analyzeSolver(recent);
  // findings with no verified mistake left can only resolve an existing memory (e.g. re-classified as near threshold)
  for (const f of solver.findings) {
    const rf = recentSolver.findings.find((x) => x.key === f.key);
    const [lo, hi] = f.stackBand === '≤6' ? [0, 6] : f.stackBand === '6.5–10' ? [6.5, 10] : [10.5, 15];
    const recentSpots = recent.filter((d) => d.pfAudit && d.pfAudit.role === f.role && d.pfAudit.stackBB >= lo && d.pfAudit.stackBB <= hi && classifySolver(d) !== 'outsideModel').length;
    // zero recent mistakes only counts when it would be unlikely at the old mistake rate:
    // P(0 mistakes in k spots | rate) = (1 - rate)^k ≤ 10% → improving, ≤ 1% → resolved
    const pZero = Math.pow(1 - f.n / Math.max(1, f.spots), recentSpots);
    const status = f.n === 0 ? 'resolved' : rf && rf.n > 0 ? 'active' : pZero <= 0.01 ? 'resolved' : pZero <= 0.1 ? 'improving' : 'active';
    out.push({
      leakKey: f.key,
      source: 'real',
      evidence: 'solver',
      category: 'tournament',
      street: 'preflop',
      decisionType: f.role,
      label: SOLVER_LABEL(f),
      drill: 'gto:pushfold',
      status,
      // severity from the conservative (grid-cell minimum) verified chip-EV loss
      severity: r4(Math.min(1, Math.max(0.15, f.evLossMinBB / 10))),
      confidence: f.confidence,
      n: f.spots,
      rate: f.spots ? r4(f.n / f.spots) : null,
      ci: null,
      band: null,
      evLossBB: f.evLossBB,
      evLossMinBB: f.evLossMinBB,
      notVerified: f.nearThreshold + f.inconclusive,
      recentN: recentSpots,
      recentRate: recentSpots ? r4((rf?.n ?? 0) / recentSpots) : null,
      recentVerdict: rf && rf.n > 0 ? 'mistakes' : recentSpots ? 'clean' : null,
      examples: f.examples,
      lastSeenAt: f.lastSeen,
      detected: f.n > 0,
    });
  }

  // 2. Frequency patterns outside their reference band (90% interval entirely outside)
  const patterns = analyzePatterns(rows);
  const recentPatterns = analyzePatterns(recent);
  for (const p of patterns) {
    if (p.evidence !== 'pattern') continue;
    const rp = recentPatterns.find((x) => x.key === p.key && x.slice === p.slice);
    const flagged = p.verdict === 'suspectedHigh' || p.verdict === 'suspectedLow';
    const recentOk = !!rp && rp.n >= 30 && rp.verdict === 'within';
    out.push({
      leakKey: patternLeakKey(p),
      source: 'real',
      evidence: 'pattern',
      category: p.category,
      street: p.street,
      decisionType: p.decisionType,
      label: p.label,
      drill: p.drill,
      // non-flagged patterns are candidates only so an existing memory can be marked resolved
      status: !flagged ? (p.verdict === 'within' ? 'resolved' : 'active') : recentOk ? 'improving' : 'active',
      severity: r4(Math.min(1, gap(p) / 0.15)),
      confidence: p.confidence ?? 'low',
      n: p.n,
      rate: p.rate,
      ci: p.ci,
      band: p.band,
      evLossBB: null,
      evLossMinBB: null,
      notVerified: 0,
      recentN: rp?.n ?? 0,
      recentRate: rp?.rate ?? null,
      recentVerdict: rp?.verdict ?? null,
      examples: p.examples,
      lastSeenAt: p.lastSeen,
      detected: flagged,
    });
  }

  // 3. Training leak tracker (graded training attempts)
  const obs = await prisma.leakObservation.findMany({ where: { userId }, select: { leakKey: true, isError: true, evLossBB: true, createdAt: true } });
  for (const s of rankLeaks(obs.map((o) => ({ leak: o.leakKey as LeakKey, isError: o.isError, evLossBB: o.evLossBB ?? undefined, at: o.createdAt.toISOString() })))) {
    out.push({
      leakKey: `training:${s.leak}`,
      source: 'training',
      evidence: 'training',
      category: 'training',
      street: null,
      decisionType: null,
      label: LEAK_LABELS[s.leak] ?? { en: s.leak, vi: s.leak },
      drill: TRAINING_DRILL[s.leak] ?? 'scenario:weak',
      status: !s.ranked ? 'resolved' : s.trend !== null && s.trend <= -0.1 ? 'improving' : 'active',
      severity: r4(Math.min(1, s.priority / 0.6)),
      confidence: s.confidence === 'insufficient' ? 'low' : s.confidence,
      n: s.opportunities,
      rate: r4(s.errorRate),
      ci: null,
      band: null,
      evLossBB: s.avgEvLossBB,
      evLossMinBB: null,
      notVerified: 0,
      recentN: 0,
      recentRate: null,
      recentVerdict: s.trend === null ? null : s.trend <= -0.1 ? 'better' : s.trend >= 0.1 ? 'worse' : 'flat',
      examples: [],
      lastSeenAt: s.lastPracticed,
      detected: s.ranked,
    });
  }
  return { candidates: out, decisions: rows.length, patterns };
}

/** Re-run detection and fold it into the user's memory. Idempotent for unchanged data. */
export async function refreshLeakMemory(userId: string) {
  const { candidates, decisions } = await leakCandidates(userId);
  const existing = new Map((await prisma.leakMemory.findMany({ where: { userId } })).map((m) => [m.leakKey, m]));
  const now = new Date();
  let created = 0;
  let updated = 0;
  for (const c of candidates) {
    const m = existing.get(c.leakKey);
    if (!m && !c.detected) continue; // never-flagged patterns are not memories
    // an undetected candidate can only move an existing memory to resolved, never re-activate it
    const status = c.detected ? c.status : c.status === 'resolved' ? 'resolved' : m!.status;
    const data = {
      source: c.source,
      evidence: c.evidence,
      category: c.category,
      street: c.street,
      decisionType: c.decisionType,
      label: c.label,
      drill: c.drill,
      status,
      severity: c.severity,
      confidence: c.confidence,
      n: c.n,
      rate: c.rate,
      ciLo: c.ci?.[0] ?? null,
      ciHi: c.ci?.[1] ?? null,
      bandLo: c.band?.[0] ?? null,
      bandHi: c.band?.[1] ?? null,
      evLossBB: c.evLossBB,
      evLossMinBB: c.evLossMinBB,
      notVerified: c.notVerified,
      recentN: c.recentN,
      recentRate: c.recentRate,
      recentVerdict: c.recentVerdict,
      examples: c.examples,
      lastSeenAt: c.lastSeenAt ? new Date(c.lastSeenAt) : null,
    };
    let id: string;
    if (!m) {
      id = (await prisma.leakMemory.create({ data: { userId, leakKey: c.leakKey, ...data } })).id;
      created++;
    } else {
      // re-detected on a larger sample, or detected again after it had been resolved
      const again = c.detected && status !== 'resolved' && (c.n > m.n || m.status === 'resolved');
      const changed = again || status !== m.status || c.n !== m.n || c.rate !== m.rate;
      if (!changed) continue;
      await prisma.leakMemory.update({ where: { id: m.id }, data: { ...data, ...(again ? { timesDetected: { increment: 1 }, lastDetectedAt: now } : {}) } });
      id = m.id;
      updated++;
    }
    await prisma.leakSnapshot.create({ data: { memoryId: id, status, n: c.n, rate: c.rate, ciLo: c.ci?.[0] ?? null, ciHi: c.ci?.[1] ?? null, severity: c.severity, evLossBB: c.evLossBB, recentN: c.recentN, recentRate: c.recentRate } });
  }
  await prisma.leakMemoryState.upsert({ where: { userId }, create: { userId, refreshedAt: now, decisions, engine: `${LEAK_ENGINE_VERSION}/${LEAK_MEMORY_VERSION}` }, update: { refreshedAt: now, decisions, engine: `${LEAK_ENGINE_VERSION}/${LEAK_MEMORY_VERSION}` } });
  return { created, updated, decisions };
}

/** Refresh if never done, the data changed size, or the last refresh is older than a day. */
export async function ensureFreshMemory(userId: string) {
  // while decisions are still being (re)analysed after an update, keep the last memory as it is
  if (await prisma.realDecision.count({ where: { userId, status: 'accepted', contextV: { lt: CONTEXT_VERSION } }, take: 1 })) return;
  const st = await prisma.leakMemoryState.findUnique({ where: { userId } });
  const decisions = await prisma.realDecision.count({ where: { userId, status: 'accepted', contextV: { gte: 1 } } });
  const obs = await prisma.leakObservation.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (!st || st.decisions !== decisions || Date.now() - st.refreshedAt.getTime() > DAY || (obs && obs.createdAt > st.refreshedAt)) await refreshLeakMemory(userId);
}

const DRILL_GRADE = (acc: number): Grade => (acc >= 0.85 ? 'good' : acc >= 0.6 ? 'acceptable' : acc >= 0.4 ? 'mistake' : 'major');

/**
 * After a daily session: record how each drilled leak went and schedule its next review (SM-2 on
 * ReviewItem itemType 'leak'). Only graded attempts count; a leak with none keeps its schedule.
 * `results` maps leakKey → graded attempts { correct, total }.
 */
export async function recordLeakDrills(userId: string, results: Map<string, { correct: number; total: number }>, now = new Date()) {
  for (const [leakKey, r] of results) {
    if (!r.total) continue;
    const acc = r.correct / r.total;
    const m = await prisma.leakMemory.findUnique({ where: { userId_leakKey: { userId, leakKey } } });
    if (!m) continue;
    const prev = await prisma.reviewItem.findUnique({ where: { userId_itemType_itemRef: { userId, itemType: 'leak', itemRef: leakKey } } });
    const state = reviewSrs(prev ? { repetitions: prev.repetitions, ease: prev.ease, intervalDays: prev.intervalDays, dueAt: prev.dueAt.toISOString(), lastQuality: prev.lastQuality, lapses: prev.lapses } : initialSrs(now), DRILL_GRADE(acc), now);
    const srs = { repetitions: state.repetitions, ease: state.ease, intervalDays: state.intervalDays, dueAt: new Date(state.dueAt), lastQuality: state.lastQuality, lapses: state.lapses, lastAttemptAt: now, lastGrade: DRILL_GRADE(acc), mastery: acc };
    await prisma.reviewItem.upsert({ where: { userId_itemType_itemRef: { userId, itemType: 'leak', itemRef: leakKey } }, create: { userId, itemType: 'leak', itemRef: leakKey, ...srs }, update: srs });
    await prisma.leakMemory.update({ where: { id: m.id }, data: { drillCount: { increment: 1 }, lastDrilledAt: now, lastDrillAccuracy: Math.round(acc * 1000) / 1000 } });
    await prisma.leakSnapshot.create({ data: { memoryId: m.id, status: m.status, n: m.n, rate: m.rate, ciLo: m.ciLo, ciHi: m.ciHi, severity: m.severity, evLossBB: m.evLossBB, recentN: m.recentN, recentRate: m.recentRate, drillAccuracy: Math.round(acc * 1000) / 1000 } });
  }
}

/** Memory rows with their review schedule, most important first. */
export async function listMemory(userId: string) {
  const [mem, reviews, st] = await Promise.all([
    prisma.leakMemory.findMany({ where: { userId }, include: { snapshots: { orderBy: { at: 'asc' }, take: 60 } } }),
    prisma.reviewItem.findMany({ where: { userId, itemType: 'leak' }, select: { itemRef: true, dueAt: true } }),
    prisma.leakMemoryState.findUnique({ where: { userId } }),
  ]);
  const due = new Map(reviews.map((r) => [r.itemRef, r.dueAt]));
  const order = { active: 0, improving: 1, resolved: 2 } as Record<string, number>;
  const pendingContext = await prisma.realDecision.count({ where: { userId, status: 'accepted', contextV: { lt: CONTEXT_VERSION } } });
  return {
    // decisions still being analysed after an update (the memory refreshes when they are done)
    pendingContext,
    refreshedAt: st?.refreshedAt ?? null,
    engine: st?.engine ?? null,
    leaks: mem
      .map((m) => ({ ...m, reviewDueAt: due.get(m.leakKey) ?? null }))
      .sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || b.severity - a.severity),
  };
}

export const memoryRouter = Router();
memoryRouter.get('/', async (req, res) => {
  const userId = requireUser(req);
  await ensureFreshMemory(userId);
  res.json(await listMemory(userId));
});
memoryRouter.post('/refresh', async (req, res) => {
  const userId = requireUser(req);
  const r = await refreshLeakMemory(userId);
  res.json({ ...r, ...(await listMemory(userId)) });
});
