import type { DqeDecision, DqeVerdict, Evidence, EvidenceCategory, EvidenceSource, MissingReason } from './types';

export const DQE_ENGINE_VERSION = 'dqe-1.0.0';

/** Evidence strength: the strongest applicable source decides the verdict. */
const RANK: Record<EvidenceCategory, number> = {
  VERIFIED_SOLVER_EV: 0,
  VERIFIED_REFERENCE_FREQUENCY: 1,
  MODEL_ESTIMATE: 2,
  EXACT_MATHEMATICAL_RESULT: 3,
  HEURISTIC_GUIDANCE: 4,
  INSUFFICIENT_EVIDENCE: 5,
};

/** Frequency thresholds for reference charts (frequency is NOT quality: these only describe the chart). */
export const IN_RANGE_MIN = 0.9;
export const OUTSIDE_RANGE_MAX = 0.1;

/** Exact maths available for any decision: price and required equity. Never ranks actions. */
export function mathFacts(d: DqeDecision): Record<string, number | null> | null {
  if (d.requiredEquity == null && d.potBB == null && d.toCallBB == null) return null;
  return { potBB: d.potBB ?? null, toCallBB: d.toCallBB ?? null, requiredEquity: d.requiredEquity ?? null };
}

function base(d: DqeDecision): DqeVerdict {
  return {
    engineVersion: DQE_ENGINE_VERSION,
    scenarioId: d.scenarioId,
    chosenAction: d.chosenAction,
    category: 'INSUFFICIENT_EVIDENCE',
    label: 'unrated',
    grade: null,
    evLossBB: null,
    modelEvLossBB: null,
    bestAction: null,
    frequencies: null,
    evByAction: null,
    source: null,
    matchStatus: null,
    confidence: null,
    economics: d.economics,
    assumptions: [],
    approximation: null,
    facts: mathFacts(d) ?? {},
    missing: null,
    notes: [],
  };
}

function fromEvidence(d: DqeDecision, e: Evidence): DqeVerdict {
  const v = base(d);
  v.category = e.category;
  v.source = { id: e.sourceId, version: e.sourceVersion, checksum: e.checksum, referenceKey: e.referenceKey };
  v.matchStatus = e.matchStatus;
  v.assumptions = e.assumptions;
  v.approximation = e.approximation;
  v.frequencies = e.frequencies;
  v.facts = { ...v.facts, ...e.facts };
  if (e.note) v.notes.push(e.note);
  switch (e.category) {
    case 'VERIFIED_SOLVER_EV': {
      const g = e.grade;
      v.evByAction = e.evByAction;
      if (!g) {
        // solver data applies, but the chosen action is outside its action set
        v.label = 'unrated';
        v.missing = { reason: 'action_outside_model', detail: `the reference has no EV for "${d.chosenAction}"` };
        v.confidence = null;
        break;
      }
      v.grade = g.grade;
      v.label = g.grade;
      v.evLossBB = g.evLossBB;
      v.bestAction = g.bestAction;
      const isMistake = g.grade === 'mistake' || g.grade === 'major';
      v.confidence = e.matchStatus === 'exact' ? 'high' : isMistake ? (g.robust ? 'high' : 'low') : 'high';
      if (e.matchStatus === 'grid_rounded' && g.evLossRangeBB) v.facts.evLossRangeBB = `${g.evLossRangeBB[0]}–${g.evLossRangeBB[1]}`;
      break;
    }
    case 'VERIFIED_REFERENCE_FREQUENCY': {
      // frequencies only: never an EV, never a grade
      const f = e.frequencies?.[d.chosenAction];
      if (f === undefined) {
        v.label = 'unrated';
        v.missing = { reason: 'action_outside_model', detail: `the chart has no frequency for "${d.chosenAction}"` };
        break;
      }
      v.label = f >= IN_RANGE_MIN ? 'inRange' : f <= OUTSIDE_RANGE_MAX ? 'outsideRange' : 'mixed';
      v.confidence = 'medium';
      break;
    }
    case 'MODEL_ESTIMATE': {
      v.label = 'modelEstimate';
      v.evByAction = e.evByAction;
      const ev = e.evByAction;
      if (ev && ev[d.chosenAction] != null) {
        const vals = Object.values(ev).filter((x): x is number => x != null);
        const best = Math.max(...vals);
        v.modelEvLossBB = Math.round((best - ev[d.chosenAction]!) * 1000) / 1000;
        v.bestAction = Object.entries(ev).find(([, x]) => x === best)?.[0] ?? null;
      }
      v.confidence = 'low';
      break;
    }
    case 'EXACT_MATHEMATICAL_RESULT':
      v.label = 'facts';
      v.confidence = 'high';
      break;
    case 'HEURISTIC_GUIDANCE':
      v.label = 'coaching';
      v.confidence = null;
      break;
  }
  assertVerdictInvariants(v);
  return v;
}

/**
 * Evaluate one decision against the registered sources. Deterministic: the result depends only on the
 * decision and the (versioned) sources. The strongest applicable evidence wins; if none applies, the
 * verdict is Unrated with the most specific missing-reference reason any source reported.
 */
export function evaluateDecision(d: DqeDecision, sources: readonly EvidenceSource[]): DqeVerdict {
  const found: Evidence[] = [];
  const missing: { reason: MissingReason; detail: string }[] = [];
  for (const s of sources) {
    const r = s.evaluate(d);
    if (!r) continue;
    if ('evidence' in r) found.push(r.evidence);
    else missing.push(r.missing);
  }
  if (found.length) {
    found.sort((a, b) => RANK[a.category] - RANK[b.category] || a.sourceId.localeCompare(b.sourceId));
    const v = fromEvidence(d, found[0]!);
    // keep weaker evidence as context only (never upgraded)
    for (const e of found.slice(1)) v.notes.push(`also available: ${e.category} from ${e.sourceId}`);
    if (v.category === 'VERIFIED_SOLVER_EV' && v.missing) {
      // the solver applies but cannot judge this action; fall back to math facts, still unrated
      v.facts = { ...v.facts, ...(mathFacts(d) ?? {}) };
    }
    return v;
  }
  const v = base(d);
  const facts = mathFacts(d);
  if (d.heuristic) {
    v.category = 'HEURISTIC_GUIDANCE';
    v.label = 'coaching';
    v.source = { id: d.heuristic.sourceId, version: 'n/a', checksum: null, referenceKey: d.heuristic.locator };
    v.notes.push(d.heuristic.text);
  } else if (facts && facts.requiredEquity != null) {
    v.category = 'EXACT_MATHEMATICAL_RESULT';
    v.label = 'facts';
    v.confidence = 'high';
  }
  v.missing = missing[0] ?? { reason: d.street === 'preflop' ? 'no_reference_for_node' : 'postflop_unsupported', detail: describeMissing(d) };
  assertVerdictInvariants(v);
  return v;
}

export function describeMissing(d: DqeDecision): string {
  const parts = [d.format, d.economics, d.tableSize ? `${d.tableSize}-max` : 'table size unknown', d.heroPos ?? 'position unknown', d.node, d.effStackBB != null ? `${d.effStackBB} BB` : 'stack unknown'];
  return `no validated reference for ${parts.join(' · ')}`;
}

/** Trust boundaries. Violations are programming errors and throw. */
export function assertVerdictInvariants(v: DqeVerdict): void {
  const fail = (m: string) => {
    throw new Error(`DQE invariant violated (${v.scenarioId}): ${m}`);
  };
  const qualityLabels = ['excellent', 'good', 'acceptable', 'marginal', 'mistake', 'major'];
  if (v.evLossBB !== null && v.category !== 'VERIFIED_SOLVER_EV') fail('EV loss without verified solver EV');
  if (v.grade !== null && v.category !== 'VERIFIED_SOLVER_EV') fail('grade without verified solver EV');
  if (qualityLabels.includes(v.label) && v.category !== 'VERIFIED_SOLVER_EV') fail(`quality label ${v.label} without verified solver EV`);
  if (v.category === 'VERIFIED_REFERENCE_FREQUENCY' && v.evByAction !== null) fail('reference frequency carrying EV');
  if (v.category === 'VERIFIED_REFERENCE_FREQUENCY' && !['inRange', 'mixed', 'outsideRange', 'unrated'].includes(v.label)) fail('frequency verdict outside in/mixed/outside');
  if (v.category === 'MODEL_ESTIMATE' && (v.grade !== null || v.evLossBB !== null)) fail('model estimate carrying a grade');
  if (v.category === 'MODEL_ESTIMATE' && !v.approximation) fail('model estimate without a stated approximation');
  if (v.modelEvLossBB !== null && v.category !== 'MODEL_ESTIMATE') fail('model EV loss outside a model estimate');
  if (v.category === 'INSUFFICIENT_EVIDENCE' && !v.missing) fail('unrated verdict without a missing-reference reason');
  if (v.category === 'VERIFIED_SOLVER_EV' && v.economics !== 'chipEV' && v.economics !== 'PKO') fail(`chip-EV solver verdict on ${v.economics}`);
  // PKO: a bounty only adds EV to shoving/calling, so chip EV is a lower bound for the aggressive action.
  // Folding a chip-EV +EV shove stays a verified loss; an aggressive chip-EV "mistake" could be overturned.
  if (v.category === 'VERIFIED_SOLVER_EV' && v.economics === 'PKO' && (v.grade === 'mistake' || v.grade === 'major') && v.chosenAction !== 'fold')
    fail('PKO: aggressive chip-EV mistake graded although the bounty could overturn it');
}
