import type { Localized, LeakKey } from '../scenario/schema';

/**
 * Leak detection. A leak is ranked only with enough evidence: rankings use the
 * Wilson lower bound of the error rate, and leaks with few opportunities are
 * reported as "insufficient evidence" rather than as top weaknesses.
 */
export const LEAK_METHOD_VERSION = 'leaks-v1';
export const MIN_OPPORTUNITIES = 6;
export const MIN_ERRORS = 2;

export interface LeakObservation {
  leak: LeakKey;
  isError: boolean;
  /** EV loss in BB when validated EV data exists. */
  evLossBB?: number;
  at: string; // ISO time
}

export interface LeakStats {
  leak: LeakKey;
  opportunities: number;
  errors: number;
  errorRate: number;
  /** Wilson 90% lower bound of the error rate. */
  errorRateLower: number;
  avgEvLossBB: number | null;
  evSamples: number;
  severity: 'low' | 'medium' | 'high';
  confidence: 'insufficient' | 'low' | 'medium' | 'high';
  /** Negative = improving (recent error rate lower than earlier). Null when too few data points. */
  trend: number | null;
  lastPracticed: string | null;
  priority: number;
  ranked: boolean;
}

/** Relative cost of each leak in typical MTT play (teaching weights, not measured EV). */
export const LEAK_WEIGHT: Record<LeakKey, number> = {
  excessivePreflopAllIns: 1.2,
  incorrect3betDefense: 1.1,
  excessiveLimpCall: 0.8,
  stackDepthAdjustments: 1.1,
  overcallingBounty: 1,
  potOdds: 1.2,
  comboCounting: 0.8,
  riverBluffCatching: 1.1,
  missedThinValue: 0.9,
  overbluffing: 1,
  underbluffing: 0.8,
  bluffSizing: 0.8,
  multiwayDiscipline: 0.9,
  icmAdjustments: 1.3,
  blockers: 0.8,
  resultOriented: 0.7,
};

export const LEAK_LABELS: Record<LeakKey, Localized> = {
  excessivePreflopAllIns: { en: 'Excessive preflop all-ins', vi: 'All-in preflop quá nhiều' },
  incorrect3betDefense: { en: 'Incorrect 3-bet defense', vi: 'Phòng thủ 3-bet sai' },
  excessiveLimpCall: { en: 'Excessive limp/call', vi: 'Limp/call quá nhiều' },
  stackDepthAdjustments: { en: 'Incorrect stack-depth adjustments', vi: 'Điều chỉnh theo độ sâu stack sai' },
  overcallingBounty: { en: 'Overcalling bounty spots', vi: 'Theo quá nhiều vì bounty' },
  potOdds: { en: 'Incorrect pot odds', vi: 'Tính pot odds sai' },
  comboCounting: { en: 'Miscounted combos', vi: 'Đếm combo sai' },
  riverBluffCatching: { en: 'Weak river bluff-catching', vi: 'Bắt bluff river yếu' },
  missedThinValue: { en: 'Missed thin value', vi: 'Bỏ lỡ value mỏng' },
  overbluffing: { en: 'Overbluffing', vi: 'Bluff quá nhiều' },
  underbluffing: { en: 'Underbluffing', vi: 'Bluff quá ít' },
  bluffSizing: { en: 'Incorrect bluff sizing', vi: 'Cỡ bluff sai' },
  multiwayDiscipline: { en: 'Poor multiway discipline', vi: 'Thiếu kỷ luật khi nhiều người' },
  icmAdjustments: { en: 'Incorrect ICM adjustments', vi: 'Điều chỉnh ICM sai' },
  blockers: { en: 'Misinterpreting blockers', vi: 'Hiểu sai blocker' },
  resultOriented: { en: 'Result-oriented reasoning', vi: 'Tư duy theo kết quả' },
};

export function wilsonLower(errors: number, n: number, z = 1.645): number {
  if (n === 0) return 0;
  const p = errors / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

export function leakStats(leak: LeakKey, observations: readonly LeakObservation[]): LeakStats {
  const obs = observations.filter((o) => o.leak === leak).sort((a, b) => a.at.localeCompare(b.at));
  const n = obs.length;
  const errors = obs.filter((o) => o.isError).length;
  const ev = obs.filter((o) => o.evLossBB !== undefined);
  const avgEv = ev.length ? ev.reduce((s, o) => s + o.evLossBB!, 0) / ev.length : null;
  const lower = wilsonLower(errors, n);
  let trend: number | null = null;
  if (n >= 8) {
    const half = Math.floor(n / 2);
    const rate = (xs: LeakObservation[]) => xs.filter((o) => o.isError).length / xs.length;
    trend = rate(obs.slice(half)) - rate(obs.slice(0, half));
  }
  const confidence: LeakStats['confidence'] = n < MIN_OPPORTUNITIES ? 'insufficient' : n < 12 ? 'low' : n < 25 ? 'medium' : 'high';
  const ranked = n >= MIN_OPPORTUNITIES && errors >= MIN_ERRORS;
  const evFactor = avgEv === null ? 1 : 1 + Math.min(2, avgEv);
  const priority = ranked ? lower * LEAK_WEIGHT[leak] * evFactor : 0;
  const severity: LeakStats['severity'] = priority >= 0.45 ? 'high' : priority >= 0.2 ? 'medium' : 'low';
  return {
    leak,
    opportunities: n,
    errors,
    errorRate: n ? errors / n : 0,
    errorRateLower: lower,
    avgEvLossBB: avgEv,
    evSamples: ev.length,
    severity,
    confidence,
    trend,
    lastPracticed: n ? obs[n - 1]!.at : null,
    priority,
    ranked,
  };
}

/** All leaks with observations, ranked leaks first by priority. */
export function rankLeaks(observations: readonly LeakObservation[]): LeakStats[] {
  const keys = [...new Set(observations.map((o) => o.leak))];
  return keys
    .map((k) => leakStats(k, observations))
    .sort((a, b) => Number(b.ranked) - Number(a.ranked) || b.priority - a.priority || b.opportunities - a.opportunities);
}

/** Observations generated by one graded decision. */
export function observationsFor(opportunities: readonly LeakKey[], optionLeaks: readonly LeakKey[], isError: boolean, at: string, evLossBB?: number): LeakObservation[] {
  const all = new Set<LeakKey>([...opportunities, ...optionLeaks]);
  return [...all].map((leak) => ({ leak, isError: isError && optionLeaks.includes(leak), evLossBB: optionLeaks.includes(leak) || opportunities.includes(leak) ? evLossBB : undefined, at }));
}
