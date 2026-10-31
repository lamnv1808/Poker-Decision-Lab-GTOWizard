import type { Grade } from '../scenario/grading';

/**
 * Spaced repetition (SM-2 variant). Mastery and scheduling are tracked separately
 * from ratings: repeated review improves mastery but never inflates ratings
 * (ratings apply a familiarity discount).
 */
export const SRS_METHOD_VERSION = 'sm2-v1';

export interface SrsState {
  repetitions: number;
  ease: number;
  intervalDays: number;
  dueAt: string; // ISO
  lastQuality: number;
  lapses: number;
}

export const GRADE_QUALITY: Record<Grade, number> = { excellent: 5, good: 4, acceptable: 3, marginal: 2, mistake: 1, major: 0 };

export function initialSrs(now: Date): SrsState {
  return { repetitions: 0, ease: 2.5, intervalDays: 0, dueAt: now.toISOString(), lastQuality: 0, lapses: 0 };
}

/** confidence: user's self-rated recall confidence 1 (guess) .. 3 (sure). A guess caps quality at 3. */
export function reviewSrs(prev: SrsState, grade: Grade, now: Date, confidence?: 1 | 2 | 3): SrsState {
  let q = GRADE_QUALITY[grade];
  if (confidence === 1 && q > 3) q = 3;
  const ease = Math.max(1.3, prev.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  let repetitions: number;
  let intervalDays: number;
  let lapses = prev.lapses;
  if (q < 3) {
    repetitions = 0;
    intervalDays = 1;
    if (prev.repetitions > 0) lapses++;
  } else {
    repetitions = prev.repetitions + 1;
    intervalDays = repetitions === 1 ? 1 : repetitions === 2 ? 3 : Math.round(prev.intervalDays * ease);
  }
  const due = new Date(now.getTime() + intervalDays * 86400000);
  return { repetitions, ease, intervalDays, dueAt: due.toISOString(), lastQuality: q, lapses };
}

/** Whether an attempt should create/keep a review item. Incorrect or uncertain answers are scheduled. */
export function needsReview(grade: Grade, confidence?: 1 | 2 | 3): boolean {
  return GRADE_QUALITY[grade] < 4 || confidence === 1;
}

/** Mastery estimate in [0,1]: grows with successful spaced repetitions, drops with lapses. */
export function masteryEstimate(s: SrsState): number {
  if (s.repetitions === 0) return Math.max(0, (s.lastQuality / 5) * 0.2);
  const retention = 1 - Math.exp(-s.intervalDays / 10);
  return Math.min(1, Math.max(0, 0.3 + 0.7 * retention - 0.05 * s.lapses));
}

export function isDue(s: SrsState, now: Date): boolean {
  return new Date(s.dueAt).getTime() <= now.getTime();
}
