import { CLASSES } from '../gto/pushfold';
import { DEFAULT_THRESHOLDS, gradeFromEvLoss } from '../scenario/grading';
import { checksumNumbers, fnv1a } from './checksum';
import type { DqeDecision, Economics, EvidenceSource, PreflopNode, PriorAction } from './types';

/**
 * Canonical preflop range library.
 *
 * A record is one exact decision situation: the same stack depth with a different position, table size,
 * ante, prior action or economic model is a DIFFERENT record — never merged, never interpolated.
 * Per hand class (all 169) and legal action it stores the frequency, and the EV only when it was computed.
 */
export const RANGE_SCHEMA_VERSION = 'pdl-range-schema-1';

export interface SituationKey {
  format: 'MTT' | 'cash';
  economics: Economics;
  tableSize: number;
  /** players dealt in (equals tableSize unless seats are empty) */
  activePlayers: number;
  heroPos: string;
  node: PreflopNode;
  /** prior actions before Hero, in order (folds included) */
  history: PriorAction[];
  effStackBB: number;
  /** blinds in BB */
  sbBB: number;
  bbBB: number;
  /** dead money from antes in BB */
  deadBB: number;
  /** the opponent model a model-based record assumes (null for equilibrium records) */
  opponentModel: string | null;
  rakePct: number | null;
  payout: string | null;
  bounty: string | null;
}

export function canonicalKey(k: SituationKey): string {
  const h = k.history.map((a) => `${a.pos}:${a.action}${a.toBB != null ? `@${a.toBB}` : ''}`).join(',');
  return [k.format, k.economics, `${k.tableSize}max`, `n${k.activePlayers}`, k.heroPos, k.node, `[${h}]`, `S${k.effStackBB}`, `b${k.sbBB}/${k.bbBB}`, `D${k.deadBB}`, `opp:${k.opponentModel ?? '-'}`, `rake:${k.rakePct ?? '-'}`, `payout:${k.payout ?? '-'}`, `bounty:${k.bounty ?? '-'}`].join('|');
}

export type RecordEvidence = 'solverEV' | 'frequency' | 'approximateModel';
export type ValidationStatus = 'verified' | 'approximate' | 'unverified' | 'unsolved';

export interface RangeRecord {
  schema: typeof RANGE_SCHEMA_VERSION;
  key: SituationKey;
  keyString: string;
  /** legal actions, in a fixed order; frequencies and EVs are indexed by this order */
  actions: string[];
  /** hand class → per-action frequency (sums to 1) and EV in BB relative to folding (null = not computed) */
  hands: Record<string, { f: number[]; ev: (number | null)[] }>;
  evidence: RecordEvidence;
  method: {
    generator: string;
    version: string;
    algorithm: string;
    iterations: number | null;
    /** best-response gain of the record's own strategy, in BB, within its model */
    exploitabilityBB: number | null;
    equitySource: string;
    approximation: string | null;
    runtimeMs: number | null;
  };
  validation: { status: ValidationStatus; checks: string[] };
  source: { kind: 'computed' | 'licensed' | 'book'; id: string; locator: string | null };
  licence: { id: string; redistributable: boolean };
  assumptions: string[];
  checksum: string;
}

export const FREQ_TOLERANCE = 1e-6;

export function classComboCount(cls: string): number {
  return cls.length === 2 ? 6 : cls.endsWith('s') ? 4 : 12;
}

export function recordChecksum(r: Omit<RangeRecord, 'checksum'>): string {
  const parts: number[][] = [];
  for (const c of CLASSES) {
    const h = r.hands[c];
    if (h) parts.push(h.f, h.ev.map((x) => (x == null ? -1e9 : x)));
  }
  return fnv1a(`${r.keyString}|${r.actions.join(',')}|${r.evidence}|${checksumNumbers(...parts)}`);
}

/** Integrity validation. Returns a list of problems (empty = valid). */
export function validateRecord(r: RangeRecord): string[] {
  const p: string[] = [];
  if (r.schema !== RANGE_SCHEMA_VERSION) p.push(`schema ${r.schema}`);
  if (r.keyString !== canonicalKey(r.key)) p.push('keyString does not match the canonical key');
  if (!r.actions.length || new Set(r.actions).size !== r.actions.length) p.push('actions empty or duplicated');
  const missing = CLASSES.filter((c) => !r.hands[c]);
  if (missing.length) p.push(`${missing.length} of 169 classes missing (e.g. ${missing.slice(0, 3).join(', ')})`);
  const extra = Object.keys(r.hands).filter((c) => !CLASSES.includes(c));
  if (extra.length) p.push(`unknown classes: ${extra.slice(0, 3).join(', ')}`);
  for (const [c, h] of Object.entries(r.hands)) {
    if (h.f.length !== r.actions.length || h.ev.length !== r.actions.length) {
      p.push(`${c}: arity mismatch`);
      continue;
    }
    const s = h.f.reduce((a, b) => a + b, 0);
    if (Math.abs(s - 1) > FREQ_TOLERANCE) p.push(`${c}: frequencies sum to ${s}`);
    if (h.f.some((x) => !(x >= 0 && x <= 1))) p.push(`${c}: frequency outside [0,1]`);
    if (h.ev.some((x) => x !== null && !Number.isFinite(x))) p.push(`${c}: non-finite EV`);
    if (r.evidence === 'frequency' && h.ev.some((x) => x !== null)) p.push(`${c}: a frequency-only record carries EV`);
  }
  if (r.evidence === 'solverEV' && r.method.approximation) p.push('solverEV record declares an approximation');
  if (r.evidence === 'approximateModel' && !r.method.approximation) p.push('approximate record without a stated approximation');
  if (r.evidence === 'solverEV' && r.validation.status !== 'verified') p.push('solverEV record not verified');
  if (r.checksum !== recordChecksum(r)) p.push('checksum mismatch');
  return p;
}

/** Combo-weighted share of a range (suited 4, offsuit 12, pairs 6 of 1326). */
export function rangeShare(r: RangeRecord, action: string): number {
  const i = r.actions.indexOf(action);
  if (i < 0) return 0;
  let s = 0;
  for (const c of CLASSES) s += (r.hands[c]?.f[i] ?? 0) * classComboCount(c);
  return s / 1326;
}

/** 13×13 grid (rows/cols A..2; suited above the diagonal) of one action's frequency. */
export function grid13(r: RangeRecord, action: string): number[][] {
  const R = 'AKQJT98765432';
  const i = r.actions.indexOf(action);
  return Array.from({ length: 13 }, (_, a) =>
    Array.from({ length: 13 }, (_, b) => {
      const cls = a === b ? R[a]! + R[b]! : a < b ? `${R[a]}${R[b]}s` : `${R[b]}${R[a]}o`;
      return r.hands[cls]?.f[i] ?? 0;
    }),
  );
}

function historyMatches(a: PriorAction[], b: PriorAction[]): boolean {
  return a.length === b.length && a.every((x, i) => x.pos === b[i]!.pos && x.action === b[i]!.action);
}

/**
 * Evidence source over a set of records. Matching is exact on every key field except that the
 * stack and dead money must equal a record's grid values exactly (no rounding, no interpolation).
 */
export function rangeLibrarySource(id: string, records: readonly RangeRecord[]): EvidenceSource {
  const byNode = new Map<string, RangeRecord[]>();
  for (const r of records) {
    const k = `${r.key.economics}|${r.key.tableSize}|${r.key.heroPos}|${r.key.node}`;
    byNode.set(k, [...(byNode.get(k) ?? []), r]);
  }
  return {
    id,
    version: RANGE_SCHEMA_VERSION,
    evaluate(d: DqeDecision) {
      if (d.street !== 'preflop' || d.node === 'postflop' || !d.tableSize || !d.heroPos) return null;
      const cands = byNode.get(`${d.economics}|${d.tableSize}|${d.heroPos}|${d.node}`);
      if (!cands) return null;
      const sameHistory = cands.filter((r) => historyMatches(r.key.history, d.history));
      if (!sameHistory.length) return null;
      const r = sameHistory.find((x) => d.effStackBB !== null && d.deadBB !== null && x.key.effStackBB === d.effStackBB && x.key.deadBB === d.deadBB);
      if (!r) {
        const grid = [...new Set(sameHistory.map((x) => x.key.effStackBB))].sort((a, b) => a - b);
        return { missing: { reason: 'stack_off_grid', detail: `${id}: this situation is solved only at ${grid.join(', ')} BB (exact match required); spot is ${d.effStackBB} BB, ${d.deadBB} BB dead` } };
      }
      if (!d.heroClass) return { missing: { reason: 'hand_unknown', detail: 'hero hand class unknown' } };
      if (r.validation.status === 'unsolved' || r.validation.status === 'unverified') return null;
      const h = r.hands[d.heroClass]!;
      const freqs = Object.fromEntries(r.actions.map((a, i) => [a, h.f[i]!]));
      const evs = Object.fromEntries(r.actions.map((a, i) => [a, h.ev[i] ?? null]));
      const category = r.evidence === 'solverEV' ? 'VERIFIED_SOLVER_EV' : r.evidence === 'frequency' ? 'VERIFIED_REFERENCE_FREQUENCY' : 'MODEL_ESTIMATE';
      // solver EV records grade exactly like the existing quiz: EV loss vs the best action; a mixed
      // equilibrium action (0 < f < 1) is an equilibrium action and grades excellent
      let grade = null;
      if (category === 'VERIFIED_SOLVER_EV' && d.chosenAction in evs && evs[d.chosenAction] != null) {
        const vals = Object.values(evs).filter((x): x is number => x != null);
        const best = Math.max(...vals);
        const f = freqs[d.chosenAction]!;
        const mixed = f > 0 && f < 1;
        const loss = mixed ? 0 : Math.max(0, best - evs[d.chosenAction]!);
        const bestAction = Object.entries(evs).find(([, x]) => x === best)![0];
        grade = { grade: mixed ? ('excellent' as const) : gradeFromEvLoss(loss, DEFAULT_THRESHOLDS.bb), evLossBB: Math.round(loss * 1000) / 1000, bestAction: mixed ? 'mixed' : bestAction, robust: null, evLossRangeBB: null };
      }
      return {
        evidence: {
          category,
          sourceId: id,
          sourceVersion: r.method.version,
          checksum: r.checksum,
          matchStatus: 'exact',
          referenceKey: r.keyString,
          economics: r.key.economics,
          frequencies: freqs,
          evByAction: category === 'VERIFIED_REFERENCE_FREQUENCY' ? null : evs,
          assumptions: r.assumptions,
          approximation: r.method.approximation,
          facts: { exploitabilityBB: r.method.exploitabilityBB },
          grade,
          note: null,
        },
      };
    },
  };
}
