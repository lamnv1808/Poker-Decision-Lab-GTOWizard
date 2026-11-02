/**
 * Real-hand leak engine (v2). Aggregates normalized real decisions into evidence-labelled findings.
 *
 * Evidence classes — never mixed, always shown:
 *  - solver:      a heads-up push/fold equilibrium (chip EV) graded Hero's actual decision. In PKO the
 *                 bounty is not modelled, so only verdicts the bounty could not overturn count as
 *                 verified; the others are reported as inconclusive.
 *  - pattern:     Hero's frequency in a context vs a stated HEURISTIC reference band (typical MTT
 *                 practice, not solver output). A pattern is "suspected" only when the 90% Wilson
 *                 interval lies entirely outside the band, with at least MIN_SAMPLE observations.
 *  - descriptive: frequencies shown for self-review only (no verdict — e.g. calling all-ins, where
 *                 the opponent's range is unknown).
 * Results never come from showdown outcomes or money won/lost.
 */
export const LEAK_ENGINE_VERSION = 'leaks-v2';
export const MIN_SAMPLE = 30;

export interface DecisionRow {
  id: string;
  playedAt: string | null; // ISO
  street: string;
  position: string | null;
  actionContext: string | null;
  heroAction: string | null;
  stackBucket: string | null;
  formatGroup: string | null;
  facingBetPct: number | null;
  requiredEq: number | null;
  multiway: boolean;
  pfAudit: null | { role: 'sbShove' | 'bbCall'; stackBB: number; heroAction: 'shove' | 'call' | 'fold' | 'other'; grade: string | null; evLossBB: number | null; bestAction: string; heroClass: string; robust?: boolean; evLossRangeBB?: [number, number] | null };
  /** Tournament (or hand) id, used as the cluster for statistics: decisions in one tournament are not independent. */
  cluster?: string | null;
}

/** 90% Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = 1.645): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export type Verdict = 'insufficient' | 'within' | 'suspectedHigh' | 'suspectedLow' | 'descriptive';

export interface PatternDef {
  key: string;
  category: 'preflop' | 'postflop' | 'tournament';
  street: string;
  decisionType: string;
  /** Which decisions count as an opportunity. */
  filter: (d: DecisionRow) => boolean;
  /** Which opportunities count as the measured action. */
  hit: (d: DecisionRow) => boolean;
  /** Heuristic reference band for the rate; null = descriptive only. */
  band: [number, number] | null;
  /** Split the result by this dimension (each slice judged on its own sample). */
  splitBy?: 'position' | 'stackBucket' | 'formatGroup' | 'priceBucket';
  label: { en: string; vi: string };
  reference: { en: string; vi: string };
  /** The training that addresses it. */
  drill: string;
}

const isOpen = (d: DecisionRow) => d.heroAction === 'raise' || d.heroAction === 'allin' || d.heroAction === 'bet';
const deep = (d: DecisionRow) => d.stackBucket === '25-40' || d.stackBucket === '40+';
const REF = { en: 'Heuristic reference band from typical MTT practice — not solver output; positions/table sizes vary.', vi: 'Dải tham chiếu heuristic theo thực hành MTT phổ biến — không phải output solver; vị trí/số người bàn khác nhau.' };

/** Opening ranges vary with table size; bands are deliberately wide. */
const RFI_BANDS: Record<string, [number, number]> = { UTG: [0.1, 0.24], UTG1: [0.11, 0.25], UTG2: [0.12, 0.27], LJ: [0.14, 0.3], MP: [0.14, 0.3], HJ: [0.17, 0.34], CO: [0.24, 0.42], BTN: [0.36, 0.62], SB: [0.3, 0.65] };

export const PATTERNS: PatternDef[] = [
  ...Object.entries(RFI_BANDS).map(([pos, band]): PatternDef => ({
    key: `rfi:${pos}`,
    category: 'preflop',
    street: 'preflop',
    decisionType: 'open',
    filter: (d) => d.street === 'preflop' && d.actionContext === 'unopened' && d.position === pos && deep(d),
    hit: isOpen,
    band,
    label: { en: `Opening frequency from ${pos} (25BB+)`, vi: `Tần suất mở bài từ ${pos} (25BB+)` },
    reference: REF,
    drill: 'scenario:preflop',
  })),
  {
    key: 'openJam:15-25',
    category: 'preflop',
    street: 'preflop',
    decisionType: 'open size',
    // of the hands Hero opens unopened at 15–25BB (not SB), how many are all-in rather than a raise
    filter: (d) => d.street === 'preflop' && d.actionContext === 'unopened' && d.stackBucket === '15-25' && d.position !== 'SB' && isOpen(d),
    hit: (d) => d.heroAction === 'allin',
    band: [0, 0.35],
    label: { en: 'Open-jamming at 15–25BB (share of opens that are all-in)', vi: 'Mở bằng all-in ở 15–25BB (tỷ lệ lần mở là all-in)' },
    reference: { en: 'Heuristic: at 15–25BB most opens are raises; jams are a minority. Not solver output.', vi: 'Heuristic: ở 15–25BB phần lớn lần mở là raise; all-in là thiểu số. Không phải output solver.' },
    drill: 'gto:pushfold',
  },
  {
    key: 'bbDefend',
    category: 'preflop',
    street: 'preflop',
    decisionType: 'defend vs open',
    filter: (d) => d.street === 'preflop' && d.actionContext === 'vsOpen' && d.position === 'BB' && deep(d),
    hit: (d) => d.heroAction !== 'fold',
    band: [0.35, 0.7],
    label: { en: 'Big blind defence vs a single open (25BB+)', vi: 'Bảo vệ BB trước một lần mở (25BB+)' },
    reference: REF,
    drill: 'scenario:preflop',
  },
  {
    key: 'foldTo3bet',
    category: 'preflop',
    street: 'preflop',
    decisionType: 'respond to 3-bet',
    filter: (d) => d.street === 'preflop' && d.actionContext === 'vs3bet' && deep(d),
    hit: (d) => d.heroAction === 'fold',
    band: [0.35, 0.7],
    label: { en: 'Folding to a 3-bet (25BB+)', vi: 'Bỏ bài trước 3-bet (25BB+)' },
    reference: REF,
    drill: 'scenario:preflop',
  },
  {
    key: 'callAllIn',
    category: 'tournament',
    street: 'preflop',
    decisionType: 'call an all-in',
    filter: (d) => d.street === 'preflop' && d.actionContext === 'vsAllIn' && d.requiredEq !== null,
    hit: (d) => d.heroAction === 'call',
    band: null,
    splitBy: 'priceBucket',
    label: { en: 'Calling preflop all-ins, by the price you were getting', vi: 'Theo all-in preflop, theo mức giá bạn nhận được' },
    reference: { en: 'Descriptive only: without the shover’s range no verdict is possible. Push/fold spots are judged by the solver section.', vi: 'Chỉ mô tả: không biết range của người all-in thì không thể kết luận. Spot push/fold được chấm ở phần solver.' },
    drill: 'gto:pushfold',
  },
  {
    key: 'riverBluffCatch',
    category: 'postflop',
    street: 'river',
    decisionType: 'call vs big river bet',
    filter: (d) => d.street === 'river' && d.actionContext === 'vsBet' && (d.facingBetPct ?? 0) >= 0.6 && !d.multiway,
    hit: (d) => d.heroAction === 'call',
    band: [0.2, 0.55],
    label: { en: 'Calling big river bets heads-up (≥60% pot)', vi: 'Theo cược river lớn khi đối đầu (≥60% pot)' },
    reference: { en: 'Heuristic band; pot odds alone would suggest defending ~35–45%, but a range reached by passive lines is weaker. Not solver output.', vi: 'Dải heuristic; riêng pot odds gợi ý phòng thủ ~35–45%, nhưng range đi đến river bằng line thụ động thường yếu hơn. Không phải output solver.' },
    drill: 'scenario:river',
  },
  {
    key: 'riverValue',
    category: 'postflop',
    street: 'river',
    decisionType: 'bet when checked to',
    filter: (d) => d.street === 'river' && d.actionContext === 'checkedTo' && !d.multiway,
    hit: (d) => d.heroAction === 'bet' || d.heroAction === 'allin',
    band: [0.3, 0.65],
    label: { en: 'Betting the river when checked to (heads-up)', vi: 'Cược river khi được check (đối đầu)' },
    reference: REF,
    drill: 'scenario:river',
  },
  {
    key: 'flopCbetIP',
    category: 'postflop',
    street: 'flop',
    decisionType: 'bet when checked to',
    filter: (d) => d.street === 'flop' && d.actionContext === 'checkedTo' && !d.multiway,
    hit: (d) => d.heroAction === 'bet' || d.heroAction === 'allin',
    band: [0.35, 0.8],
    label: { en: 'Betting the flop when checked to (heads-up)', vi: 'Cược flop khi được check (đối đầu)' },
    reference: REF,
    drill: 'gto:postflop',
  },
  {
    key: 'multiwayRaise',
    category: 'postflop',
    street: 'postflop',
    decisionType: 'raise vs bet multiway',
    filter: (d) => d.street !== 'preflop' && d.actionContext === 'vsBet' && d.multiway,
    hit: (d) => d.heroAction === 'raise' || d.heroAction === 'allin',
    band: [0, 0.15],
    label: { en: 'Raising a bet in multiway pots', vi: 'Tố cược trong pot nhiều người' },
    reference: { en: 'Heuristic: multiway raises need strong ranges; frequent raises suggest over-aggression. Not solver output.', vi: 'Heuristic: tố trong pot nhiều người cần range mạnh; tố thường xuyên gợi ý quá hung hăng. Không phải output solver.' },
    drill: 'scenario:multiway',
  },
];

const priceBucket = (d: DecisionRow) => (d.requiredEq === null ? null : d.requiredEq < 0.3 ? '<30%' : d.requiredEq < 0.4 ? '30–40%' : d.requiredEq < 0.5 ? '40–50%' : '≥50%');

export interface PatternResult {
  key: string;
  slice: string | null;
  category: PatternDef['category'];
  street: string;
  decisionType: string;
  label: PatternDef['label'];
  reference: PatternDef['reference'];
  evidence: 'pattern' | 'descriptive';
  n: number;
  hits: number;
  rate: number | null;
  ci: [number, number] | null;
  band: [number, number] | null;
  verdict: Verdict;
  /** How far the interval sits outside the band × how often the spot occurs (pattern only). */
  severity: number;
  confidence: 'low' | 'medium' | 'high' | null;
  examples: string[];
  lastSeen: string | null;
  drill: string;
}

function judge(hits: number, n: number, band: [number, number] | null): { verdict: Verdict; ci: [number, number] | null; gap: number; confidence: PatternResult['confidence'] } {
  if (!band) return { verdict: 'descriptive', ci: n ? wilson(hits, n) : null, gap: 0, confidence: null };
  if (n < MIN_SAMPLE) return { verdict: 'insufficient', ci: n ? wilson(hits, n) : null, gap: 0, confidence: null };
  const ci = wilson(hits, n);
  if (ci[0] > band[1]) {
    const gap = ci[0] - band[1];
    return { verdict: 'suspectedHigh', ci, gap, confidence: gap > 0.1 && n >= 100 ? 'high' : gap > 0.04 ? 'medium' : 'low' };
  }
  if (ci[1] < band[0]) {
    const gap = band[0] - ci[1];
    return { verdict: 'suspectedLow', ci, gap, confidence: gap > 0.1 && n >= 100 ? 'high' : gap > 0.04 ? 'medium' : 'low' };
  }
  return { verdict: 'within', ci, gap: 0, confidence: null };
}

export function analyzePatterns(rows: readonly DecisionRow[], defs: readonly PatternDef[] = PATTERNS): PatternResult[] {
  const out: PatternResult[] = [];
  const total = Math.max(1, rows.length);
  for (const def of defs) {
    const opp = rows.filter(def.filter);
    const groups = new Map<string | null, DecisionRow[]>();
    for (const d of opp) {
      const k = def.splitBy === 'priceBucket' ? priceBucket(d) : def.splitBy ? ((d[def.splitBy] as string | null) ?? '?') : null;
      groups.set(k, [...(groups.get(k) ?? []), d]);
    }
    if (!groups.size) groups.set(null, []);
    for (const [slice, g] of groups) {
      const hits = g.filter(def.hit);
      const j = judge(hits.length, g.length, def.band);
      const sorted = [...hits].sort((a, b) => (b.playedAt ?? '').localeCompare(a.playedAt ?? ''));
      out.push({
        key: def.key,
        slice,
        category: def.category,
        street: def.street,
        decisionType: def.decisionType,
        label: def.label,
        reference: def.reference,
        evidence: def.band ? 'pattern' : 'descriptive',
        n: g.length,
        hits: hits.length,
        rate: g.length ? hits.length / g.length : null,
        ci: j.ci,
        band: def.band,
        verdict: j.verdict,
        // weight by how often the spot comes up, so frequent small deviations rank above rare big ones
        severity: Math.round(j.gap * Math.sqrt(g.length / total) * 10000) / 10000,
        confidence: j.confidence,
        examples: (j.verdict === 'suspectedHigh' ? sorted : [...g].filter((d) => !def.hit(d)).sort((a, b) => (b.playedAt ?? '').localeCompare(a.playedAt ?? ''))).slice(0, 8).map((d) => d.id),
        lastSeen: g.reduce<string | null>((m, d) => (d.playedAt && (!m || d.playedAt > m) ? d.playedAt : m), null),
        drill: def.drill,
      });
    }
  }
  return out;
}

export type SolverClass = 'verified' | 'inconclusiveBounty' | 'nearThreshold' | 'correct' | 'outsideModel';

export interface SolverFinding {
  key: string; // e.g. pf:sbShove:tooTight:10-15
  role: 'sbShove' | 'bbCall';
  direction: 'tooTight' | 'tooLoose';
  stackBand: string;
  n: number; // verified mistakes
  spots: number; // all solver-graded spots in this role/band
  /** SUM of chip-EV loss (BB) over the verified mistakes, at the solved grid point (not an average). */
  evLossBB: number;
  /** Conservative sum: each mistake's smallest loss over the grid cell around its exact stack/antes. */
  evLossMinBB: number;
  /** Average chip-EV loss per verified mistake (BB). */
  avgEvLossBB: number;
  inconclusive: number; // PKO verdicts the bounty could overturn
  /** Same-direction mistakes that the stack/ante rounding could have produced (not counted as verified). */
  nearThreshold: number;
  examples: string[];
  lastSeen: string | null;
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Classify one push/fold verdict. Folding where chip EV says shove/call can only get worse with a
 * bounty on the table (it adds EV to the aggressive option), so it stays verified in PKO. Shoving or
 * calling where chip EV says fold could be justified by the bounty → inconclusive in PKO.
 */
export function classifySolver(d: DecisionRow): SolverClass {
  const p = d.pfAudit;
  if (!p || !p.grade || p.heroAction === 'other') return 'outsideModel';
  const mistake = p.grade === 'mistake' || p.grade === 'major';
  if (!mistake) return 'correct';
  const aggressive = p.heroAction !== 'fold';
  if (aggressive && d.formatGroup === 'PKO') return 'inconclusiveBounty';
  // the stack/ante rounding to the solved grid could have produced the verdict → not verified
  if (p.robust !== true) return 'nearThreshold';
  return 'verified';
}

const PF_BANDS: [string, number, number][] = [['≤6', 0, 6], ['6.5–10', 6.5, 10], ['10.5–15', 10.5, 15]];

export function analyzeSolver(rows: readonly DecisionRow[]): { findings: SolverFinding[]; graded: number; verifiedMistakes: number; inconclusive: number; nearThreshold: number; evLossBB: number } {
  const spots = rows.filter((d) => d.pfAudit && d.pfAudit.grade && d.pfAudit.heroAction !== 'other');
  const findings: SolverFinding[] = [];
  for (const role of ['sbShove', 'bbCall'] as const)
    for (const [band, lo, hi] of PF_BANDS)
      for (const direction of ['tooTight', 'tooLoose'] as const) {
        const inBand = spots.filter((d) => d.pfAudit!.role === role && d.pfAudit!.stackBB >= lo && d.pfAudit!.stackBB <= hi);
        const wrongWay = inBand.filter((d) => {
          const c = classifySolver(d);
          const fold = d.pfAudit!.heroAction === 'fold';
          return (c === 'verified' || c === 'inconclusiveBounty' || c === 'nearThreshold') && (direction === 'tooTight' ? fold : !fold);
        });
        const verified = wrongWay.filter((d) => classifySolver(d) === 'verified');
        if (!wrongWay.length) continue;
        const ev = verified.reduce((s, d) => s + (d.pfAudit!.evLossBB ?? 0), 0);
        const evMin = verified.reduce((s, d) => s + (d.pfAudit!.evLossRangeBB?.[0] ?? d.pfAudit!.evLossBB ?? 0), 0);
        const sorted = [...verified].sort((a, b) => (b.pfAudit!.evLossBB ?? 0) - (a.pfAudit!.evLossBB ?? 0));
        findings.push({
          key: `pf:${role}:${direction}:${band}`,
          role,
          direction,
          stackBand: band,
          n: verified.length,
          spots: inBand.length,
          evLossBB: Math.round(ev * 100) / 100,
          evLossMinBB: Math.round(evMin * 100) / 100,
          avgEvLossBB: verified.length ? Math.round((ev / verified.length) * 100) / 100 : 0,
          inconclusive: wrongWay.filter((d) => classifySolver(d) === 'inconclusiveBounty').length,
          nearThreshold: wrongWay.filter((d) => classifySolver(d) === 'nearThreshold').length,
          examples: sorted.slice(0, 8).map((d) => d.id),
          lastSeen: verified.reduce<string | null>((m, d) => (d.playedAt && (!m || d.playedAt > m) ? d.playedAt : m), null),
          confidence: verified.length >= 10 ? 'high' : verified.length >= 4 ? 'medium' : 'low',
        });
      }
  findings.sort((a, b) => b.evLossBB - a.evLossBB);
  return {
    findings,
    graded: spots.length,
    verifiedMistakes: spots.filter((d) => classifySolver(d) === 'verified').length,
    inconclusive: spots.filter((d) => classifySolver(d) === 'inconclusiveBounty').length,
    nearThreshold: spots.filter((d) => classifySolver(d) === 'nearThreshold').length,
    evLossBB: Math.round(spots.filter((d) => classifySolver(d) === 'verified').reduce((s, d) => s + (d.pfAudit!.evLossBB ?? 0), 0) * 100) / 100,
  };
}

/** Rate of a pattern's measured action per time window (for trends and recurrence). */
export function patternTrend(rows: readonly DecisionRow[], def: PatternDef, windows: { label: string; from: string; to: string }[]) {
  return windows.map((w) => {
    const g = rows.filter((d) => d.playedAt && d.playedAt >= w.from && d.playedAt < w.to && def.filter(d));
    const hits = g.filter(def.hit).length;
    return { label: w.label, n: g.length, rate: g.length ? hits / g.length : null, ci: g.length ? wilson(hits, g.length) : null };
  });
}
