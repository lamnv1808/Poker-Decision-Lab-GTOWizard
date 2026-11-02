import { createRng } from '../cards/rng';

/**
 * Personal daily plan (Phase 1 D4). Pure and deterministic for a given seed so it can be tested and
 * explained: every item says WHY it is in the plan (which leak, a due review, or new material).
 *
 * Budget split (by estimated seconds): ~60% the user's highest-priority leaks, ~25% due spaced-
 * repetition reviews, ~15% new material. Unused shares roll over (no leaks → more reviews/new).
 */
export const DAILY_PLAN_VERSION = 'daily-v1';
export const DAILY_MINUTES = [5, 10, 20] as const;
export type DailyMinutes = (typeof DAILY_MINUTES)[number];

/** Item types the Mixed runner can serve. */
export type PlanItemType = 'sim' | 'solverFlop' | 'scenario' | 'villain' | 'gto' | 'gtopf' | 'math' | 'potodds' | 'replay';

/** Rough time per item, used only to size the plan (the session clock is the real limit). */
export const ITEM_SECONDS: Record<PlanItemType, number> = { gto: 25, gtopf: 45, math: 30, potodds: 40, replay: 60, scenario: 75, villain: 75, solverFlop: 90, sim: 120 };

export interface PlanLeak {
  leakKey: string;
  label: { en: string; vi: string };
  evidence: 'solver' | 'pattern' | 'training';
  status: 'active' | 'improving' | 'resolved';
  /** 0..1, comparable across evidence classes. */
  severity: number;
  confidence: 'low' | 'medium' | 'high';
  timesDetected: number;
  /** Matching real decisions in the most recent 30 days of hand data. */
  recentN: number;
  drill: string;
  examples: string[];
  drillCount: number;
  lastDrilledAt: string | null;
  lastDrillAccuracy: number | null;
  /** Spaced-repetition due date of the leak drill (null = never drilled → due now). */
  reviewDueAt: string | null;
}

export interface PlanItem {
  type: PlanItemType;
  reason: 'leak' | 'review' | 'new';
  leakKey?: string;
  /** GTO push/fold filter or a specific real decision to replay. */
  params?: { role?: 'sbShove' | 'bbCall'; range?: '2-7' | '7-11' | '11-15' | '2-15'; decisionId?: string; pool?: 'weak' | 'newDue' | 'new'; tableSize?: number; stackBB?: number };
}

export interface PriorityParts {
  severity: number;
  /** Strength of the evidence class: solver-verified 1, graded training 0.8, heuristic pattern 0.6. */
  evidence: number;
  confidence: number;
  recurrence: number;
  learning: number;
  score: number;
}

const CONF = { low: 0.55, medium: 0.8, high: 1 } as const;
const EVIDENCE = { solver: 1, training: 0.8, pattern: 0.6 } as const;

/**
 * priority = severity × evidence × confidence × recurrence × learning, each factor shown to the user.
 *  - evidence: a solver-verified mistake outranks a heuristic suspicion of the same size;
 *  - recurrence: grows (log) with the times a leak was re-detected and its recent occurrences;
 *  - learning: due/never-drilled leaks first; a leak drilled well recently waits its turn;
 *  - resolved leaks are kept in memory but not planned.
 */
export function leakPriority(l: PlanLeak, now: Date): PriorityParts {
  const severity = Math.max(0, Math.min(1, l.severity));
  const confidence = CONF[l.confidence];
  const recurrence = 1 + 0.25 * Math.log2(1 + Math.max(0, l.timesDetected - 1)) + 0.15 * Math.log10(1 + l.recentN);
  const due = !l.reviewDueAt || new Date(l.reviewDueAt) <= now;
  let learning = due ? (l.drillCount === 0 ? 1.25 : 1.1) : 0.45;
  if (l.lastDrillAccuracy !== null && !due) learning *= l.lastDrillAccuracy >= 0.85 ? 0.7 : 1.2;
  if (l.status === 'improving') learning *= 0.75;
  const evidence = EVIDENCE[l.evidence];
  const score = l.status === 'resolved' ? 0 : severity * evidence * confidence * recurrence * learning;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { severity: r(severity), evidence: r(evidence), confidence: r(confidence), recurrence: r(recurrence), learning: r(learning), score: r(score) };
}

/** What to practise for a leak. Solver leaks get solver-verified quiz items; every real-hand leak also replays the user's own hands. */
export function drillItems(l: PlanLeak, hasRealHands: boolean): PlanItem[] {
  const base = { reason: 'leak' as const, leakKey: l.leakKey };
  const own: PlanItem[] = hasRealHands ? l.examples.map((id) => ({ ...base, type: 'replay' as const, params: { decisionId: id } })) : [];
  const pf = /^pf:(sbShove|bbCall):\w+:(.+)$/.exec(l.leakKey);
  if (pf) {
    const range = pf[2] === '≤6' ? '2-7' : pf[2] === '6.5–10' ? '7-11' : '11-15';
    const quiz: PlanItem = { ...base, type: 'gto', params: { role: pf[1] as 'sbShove' | 'bbCall', range } };
    // 3 solver quiz spots per replay of an own mistake
    return interleave([quiz, quiz, quiz], own);
  }
  switch (l.drill) {
    case 'gto:pushfold':
      return interleave([{ ...base, type: 'gto', params: { range: '2-15' } }], own);
    case 'gto:postflop':
      return interleave([{ ...base, type: 'gtopf' }, { ...base, type: 'solverFlop' }], own);
    case 'scenario:river':
    case 'scenario:multiway':
      return interleave([{ ...base, type: 'scenario', params: { pool: 'weak' } }, { ...base, type: 'sim', params: { tableSize: 6 } }], own);
    case 'scenario:preflop':
      return interleave([{ ...base, type: 'sim', params: { tableSize: 6, stackBB: 40 } }], own);
    case 'math:potodds':
      return [{ ...base, type: hasRealHands ? 'potodds' : 'math' }, { ...base, type: 'math' }];
    default:
      return [{ ...base, type: 'scenario', params: { pool: 'weak' } }];
  }
}

function interleave(a: PlanItem[], b: PlanItem[]): PlanItem[] {
  // own hands first (they are the evidence), then alternate
  const out: PlanItem[] = [];
  for (let i = 0; i < Math.max(a.length * 3, b.length); i++) {
    if (i < b.length) out.push(b[i]!);
    out.push(a[i % a.length]!);
  }
  return out;
}

export interface DailyPlan {
  version: string;
  minutes: DailyMinutes;
  items: PlanItem[];
  estimatedSec: number;
  focus: { leakKey: string; label: { en: string; vi: string }; evidence: PlanLeak['evidence']; priority: PriorityParts; items: number; seconds: number }[];
  reviews: number;
  fresh: number;
}

/**
 * Build the plan. `dueReviews` are item types of due SRS reviews (most overdue first); `newTypes` are
 * item types with unseen content.
 */
export function buildDailyPlan(input: { minutes: DailyMinutes; leaks: PlanLeak[]; dueReviews: PlanItemType[]; newTypes: PlanItemType[]; hasRealHands: boolean; now: Date; seed: number }): DailyPlan {
  const budget = input.minutes * 60;
  const secs = (xs: PlanItem[]) => xs.reduce((s, x) => s + ITEM_SECONDS[x.type], 0);
  const ranked = input.leaks
    .map((l) => ({ l, p: leakPriority(l, input.now) }))
    .filter((x) => x.p.score > 0)
    .sort((a, b) => b.p.score - a.p.score || a.l.leakKey.localeCompare(b.l.leakKey));
  const maxLeaks = input.minutes === 5 ? 1 : input.minutes === 10 ? 2 : 3;
  // variety: at most two focus leaks share a drill family (e.g. push/fold), when others exist
  const family = (x: PlanLeak) => (x.leakKey.startsWith('pf:') ? 'gto:pushfold' : x.drill);
  const top: typeof ranked = [];
  for (const x of ranked) if (top.length < maxLeaks && top.filter((y) => family(y.l) === family(x.l)).length < 2) top.push(x);
  for (const x of ranked) if (top.length < maxLeaks && !top.includes(x)) top.push(x);
  const leakBudget = top.length ? budget * 0.6 : 0;
  const reviewBudget = input.dueReviews.length ? (budget - leakBudget) * (input.newTypes.length ? 0.625 : 1) : 0;
  const focus: DailyPlan['focus'] = [];
  const leakBlocks: PlanItem[][] = [];
  const total = top.reduce((s, x) => s + x.p.score, 0);
  const replayed = new Set<string>();
  for (const { l, p } of top) {
    const share = leakBudget * (p.score / total);
    const pool = drillItems(l, input.hasRealHands);
    const block: PlanItem[] = [];
    for (let i = 0; i < 200 && pool.length && (block.length === 0 || secs(block) + ITEM_SECONDS[pool[i % pool.length]!.type] <= share); i++) {
      const it = pool[i % pool.length]!;
      // a specific own hand is replayed once per plan
      if (it.params?.decisionId) {
        if (replayed.has(it.params.decisionId)) continue;
        replayed.add(it.params.decisionId);
      }
      block.push(it);
    }
    // every focus leak gets at least one graded drill (own-hand replays are reflection only)
    const graded = pool.find((x) => !x.params?.decisionId);
    if (graded && !block.some((x) => !x.params?.decisionId)) block.push(graded);
    leakBlocks.push(block);
    focus.push({ leakKey: l.leakKey, label: l.label, evidence: l.evidence, priority: p, items: block.length, seconds: secs(block) });
  }
  const reviews: PlanItem[] = [];
  for (const t of input.dueReviews) {
    if (secs(reviews) + ITEM_SECONDS[t] > reviewBudget) break;
    reviews.push({ type: t, reason: 'review', params: t === 'scenario' || t === 'villain' ? { pool: 'newDue' } : undefined });
  }
  const rng = createRng(input.seed);
  const fresh: PlanItem[] = [];
  const used = () => secs(leakBlocks.flat()) + secs(reviews) + secs(fresh);
  for (let guard = 0; input.newTypes.length && guard < 40; guard++) {
    const t = input.newTypes[Math.floor(rng() * input.newTypes.length)]!;
    if (used() + ITEM_SECONDS[t] > budget) {
      if (fresh.length || used() > 0) break;
    }
    fresh.push({ type: t, reason: 'new', params: t === 'scenario' || t === 'villain' ? { pool: 'new' } : undefined });
  }
  // Interleave blocks: lead with the top leak, spread reviews/new between leak items (variety
  // helps retention), but never three items of the same type in a row when avoidable.
  const queues = [...leakBlocks.map((b) => [...b]), [...reviews], [...fresh]].filter((q) => q.length);
  const items: PlanItem[] = [];
  let turn = 0;
  const left = () => queues.reduce((s, q) => s + q.length, 0);
  while (left()) {
    const lastTwo = items.slice(-2).map((x) => x.type);
    const blocked = (x: PlanItem) => lastTwo.length === 2 && lastTwo.every((y) => y === x.type);
    let took = false;
    // rotate through the queues; take the first item that does not make a third in a row
    for (let k = 0; k < queues.length && !took; k++) {
      const q = queues[(turn + k) % queues.length]!;
      const i = q.findIndex((x) => !blocked(x));
      if (i >= 0) {
        items.push(q.splice(i, 1)[0]!);
        took = true;
      }
    }
    if (!took) items.push(queues.find((q) => q.length)!.shift()!); // only one type is left
    turn++;
  }
  return { version: DAILY_PLAN_VERSION, minutes: input.minutes, items, estimatedSec: secs(items), focus, reviews: reviews.length, fresh: fresh.length };
}
