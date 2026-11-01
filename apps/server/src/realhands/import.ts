import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import {
  type ReconstructedHand,
  type V2Decision,
  type V2HandRecord,
  type V2Quiz,
  PUSHFOLD_DATA_INFO,
  auditDecision,
  auditHand,
  auditPushFold,
  auditQuiz,
  contenders,
  publicState,
  snapshotForHeroAction,
  solvePushFold,
  topicsFor,
} from '@pdl/core';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';

/** Share of tournaments (latest by start time) held out for rated assessment. */
export const ASSESSMENT_SHARE = 0.2;

const lines = (f: string) => createInterface({ input: createReadStream(f), crlfDelay: Infinity })[Symbol.asyncIterator]();

/** Pass 1: tournament start times → split. All decisions of a tournament (and so of a hand) share a split. */
export async function computeSplits(handsFile: string): Promise<Map<string, 'training' | 'assessment'>> {
  const first = new Map<string, string>();
  for (let it = lines(handsFile), r = await it.next(); !r.done; r = await it.next()) {
    const raw = (JSON.parse(r.value) as V2HandRecord).raw;
    const tid = /Tournament #(\d+)/.exec(raw)?.[1];
    const at = /(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/.exec(raw)?.[1] ?? '';
    if (!tid) continue;
    if (!first.has(tid) || at < first.get(tid)!) first.set(tid, at);
  }
  const ordered = [...first].sort((a, b) => a[1].localeCompare(b[1]));
  const cut = Math.floor(ordered.length * (1 - ASSESSMENT_SHARE));
  return new Map(ordered.map(([t], i) => [t, i >= cut ? 'assessment' : 'training']));
}

function effectiveStackBB(rec: ReconstructedHand, snapState: ReturnType<typeof snapshotForHeroAction>) {
  const s = snapState!.state;
  const hero = s.players.find((p) => p.id === snapState!.heroId)!;
  const opps = s.players.filter((p) => !p.folded && p.id !== hero.id);
  return Math.min(hero.stack + hero.streetCommitted, Math.max(0, ...opps.map((p) => p.stack + p.streetCommitted))) / rec.parsed.bigBlind;
}

/** Draft solver annotation for exact heads-up push/fold spots (our own equilibrium). Never auto-verified. */
function pushFoldDraft(rec: ReconstructedHand, actionIndex: number) {
  const pf = auditPushFold(rec);
  if (!pf || pf.actionIndex !== actionIndex) return null;
  const sol = solvePushFold({ stackBB: pf.stackBB, deadBB: pf.deadBB });
  const aggressive = pf.role === 'sbShove' ? 'allin' : 'call';
  return {
    source: 'solver',
    authorKind: 'system',
    status: 'draft',
    infoAvailable: { heroCards: pf.heroCards, positions: pf.role === 'sbShove' ? 'Hero SB, folded to Hero' : 'Hero BB facing SB all-in', effectiveStackBB: pf.exactStackBB, deadAntesBB: pf.exactDeadBB },
    assumedRanges: [{ player: 'both', range: 'Push/fold Nash equilibrium ranges', justification: 'Solved heads-up subgame after all other players folded' }],
    economics: { chipEV: true, icm: 'not modelled', bounty: 'not modelled' },
    missingInfo: ['payout structure (ICM)', 'bounty values', 'opponent tendencies'],
    evaluated: [
      { action: aggressive, sizeToBB: aggressive === 'allin' ? 'all-in' : null, ev: Math.round(pf.evAggressive * 1000) / 1000, freq: pf.frequency },
      { action: 'fold', ev: 0, freq: Math.round((1 - pf.frequency) * 1000) / 1000 },
    ],
    recommendation: pf.bestAction === 'mixed' ? `mixed (${Math.round(pf.frequency * 100)}% ${aggressive})` : pf.bestAction === 'fold' ? 'fold' : aggressive,
    explanationVi: `Cân bằng push/fold đối đầu ở ${pf.stackBB}BB (ante chết ${pf.deadBB}BB): ${aggressive === 'allin' ? 'all-in' : 'theo'} có EV ${pf.evAggressive.toFixed(2)}BB so với bỏ bài (0). Tần suất cân bằng ${Math.round(pf.frequency * 100)}%.`,
    explanationEn: `Heads-up push/fold equilibrium at ${pf.stackBB}BB (${pf.deadBB}BB dead antes): ${aggressive === 'allin' ? 'shoving' : 'calling'} has EV ${pf.evAggressive.toFixed(2)}BB vs folding (0). Equilibrium frequency ${Math.round(pf.frequency * 100)}%.`,
    confidence: 'medium',
    scope: `Heads-up push/fold model only: SB may only shove or fold; chip EV; stack rounded from ${pf.exactStackBB} to ${pf.stackBB}BB and dead antes from ${pf.exactDeadBB} to ${pf.deadBB}BB.`,
    solverMeta: { name: 'pdl push/fold solver', version: sol.methodVersion, config: { stackBB: pf.stackBB, deadBB: pf.deadBB, iterations: PUSHFOLD_DATA_INFO.iterations }, convergence: { exploitabilityBB: sol.exploitabilityBB }, equity: PUSHFOLD_DATA_INFO.equityMethod },
    toleranceBB: 0.05,
  };
}

export interface ImportSummary {
  hands: { accepted: number; quarantined: number };
  decisions: { accepted: number; quarantined: number };
  quizzes: { accepted: number; quarantined: number };
  solverDrafts: number;
  splits: { training: number; assessment: number };
}

/** Import a Real Hand Source v2 directory for one user. Idempotent (existing rows are skipped). */
export async function importV2(userId: string, dir: string, log: (m: string) => void = () => {}): Promise<ImportSummary> {
  const splits = await computeSplits(join(dir, 'hands.jsonl'));
  const sum: ImportSummary = { hands: { accepted: 0, quarantined: 0 }, decisions: { accepted: 0, quarantined: 0 }, quizzes: { accepted: 0, quarantined: 0 }, solverDrafts: 0, splits: { training: 0, assessment: 0 } };
  const hands = lines(join(dir, 'hands.jsonl'));
  const decs = lines(join(dir, 'decisions.jsonl'));
  const quizzes = lines(join(dir, 'pot_odds_quizzes.jsonl'));
  const nextDec = async () => { const r = await decs.next(); return r.done ? null : (JSON.parse(r.value) as V2Decision); };
  const nextQuiz = async () => { const r = await quizzes.next(); return r.done ? null : (JSON.parse(r.value) as V2Quiz); };
  let pd = await nextDec();
  let pq = await nextQuiz();
  let handBatch: Prisma.RealHandCreateManyInput[] = [];
  let decBatch: Prisma.RealDecisionCreateManyInput[] = [];
  let annBatch: { externalId: string; data: ReturnType<typeof pushFoldDraft> }[] = [];
  const flush = async () => {
    if (handBatch.length) await prisma.realHand.createMany({ data: handBatch, skipDuplicates: true });
    if (decBatch.length) await prisma.realDecision.createMany({ data: decBatch, skipDuplicates: true });
    if (annBatch.length) {
      const rows = await prisma.realDecision.findMany({ where: { userId, externalId: { in: annBatch.map((a) => a.externalId) } }, select: { id: true, externalId: true, annotations: { select: { id: true } } } });
      const byExt = new Map(rows.map((r) => [r.externalId, r]));
      const data = annBatch
        .filter((a) => byExt.get(a.externalId) && byExt.get(a.externalId)!.annotations.length === 0)
        .map((a) => ({ ...a.data!, decisionId: byExt.get(a.externalId)!.id, userId, version: 1, evaluated: a.data!.evaluated as object, infoAvailable: a.data!.infoAvailable as object, assumedRanges: a.data!.assumedRanges as object, economics: a.data!.economics as object, solverMeta: a.data!.solverMeta as object }));
      if (data.length) await prisma.annotation.createMany({ data, skipDuplicates: true });
      sum.solverDrafts += data.length;
    }
    handBatch = [];
    decBatch = [];
    annBatch = [];
  };
  let n = 0;
  for (let r = await hands.next(); !r.done; r = await hands.next()) {
    const h = JSON.parse(r.value) as V2HandRecord;
    const a = auditHand(h.raw);
    const split = (a.tournamentId && splits.get(a.tournamentId)) || 'training';
    const realHandId = crypto.randomUUID();
    handBatch.push({ id: realHandId, userId, handId: h.hand_id, tournamentId: a.tournamentId, tournamentName: a.tournamentName, format: a.format, playedAt: a.playedAt ? new Date(`${a.playedAt}Z`) : null, raw: h.raw, status: a.ok ? 'accepted' : 'quarantined', issues: a.issues as object, notes: a.notes, split, source: 'v2' });
    a.ok ? sum.hands.accepted++ : sum.hands.quarantined++;
    const quizFor = new Map<string, V2Quiz>();
    const decsHere: V2Decision[] = [];
    while (pd && pd.family_id === h.hand_id) { decsHere.push(pd); pd = await nextDec(); }
    while (pq && pq.family_id === h.hand_id) { quizFor.set(pq.id.replace(/-odds$/, ''), pq); pq = await nextQuiz(); }
    for (const d of decsHere) {
      const res = a.ok && a.rec ? auditDecision(d, a.rec) : { ok: false, issues: [{ code: 'hand_invalid', detail: a.issues.map((i) => i.code).join(',') }], snap: null };
      const snap = res.snap;
      let potOdds: object | undefined;
      const q = quizFor.get(d.id);
      if (q) {
        const qa = res.ok && snap ? auditQuiz(q, snap) : { ok: false, issues: [{ code: 'decision_invalid', detail: 'underlying decision quarantined' }], requiredEquity: null, terminal: false };
        qa.ok ? sum.quizzes.accepted++ : sum.quizzes.quarantined++;
        potOdds = { status: qa.ok ? 'accepted' : 'quarantined', issues: qa.issues, requiredEquity: qa.requiredEquity, terminal: qa.terminal, supplied: q.answer.required_equity };
      }
      res.ok ? sum.decisions.accepted++ : sum.decisions.quarantined++;
      sum.splits[split]++;
      const bb = a.rec?.parsed.bigBlind ?? 1;
      const st = snap?.state;
      const hero = st?.players.find((p) => p.id === snap!.heroId);
      const parsedAction = snap ? a.rec!.parsed.actions[snap.actionIndex]! : null;
      decBatch.push({
        userId,
        externalId: d.id,
        realHandId,
        familyId: d.family_id,
        heroActionNo: Number(d.id.split('-').pop()),
        street: d.street,
        status: res.ok ? 'accepted' : 'quarantined',
        issues: res.issues as object,
        split,
        format: a.format,
        stackDepthBB: snap && a.rec ? effectiveStackBB(a.rec, snap) : 0,
        potBB: snap?.potBB ?? d.question.pot_at_decision_bb,
        toCallBB: snap?.callAmountBB ?? d.question.call_bb,
        investedBB: hero ? (hero.totalCommitted + hero.anteCommitted) / bb : 0,
        playersInPot: st ? contenders(st, snap!.heroId).length : 0,
        multiway: st ? contenders(st, snap!.heroId).length > 2 : false,
        facingAllIn: !!(st && snap!.toCallBB > 0 && st.players.some((p) => !p.folded && p.allIn && p.id !== snap!.heroId)),
        topics: res.ok && st && a.rec?.parsed.heroCards ? topicsFor(st, snap!.heroId, a.rec.parsed.heroCards, a.format) : [],
        reviewTags: d.tags,
        observed: parsedAction ? { type: parsedAction.type, amountBB: parsedAction.amount / bb, allIn: parsedAction.allIn, supplied: d.review_only } : { supplied: d.review_only },
        potOdds,
        playedAt: a.playedAt ? new Date(`${a.playedAt}Z`) : null,
      });
      if (res.ok && a.rec && snap) {
        const draft = pushFoldDraft(a.rec, snap.actionIndex);
        if (draft) annBatch.push({ externalId: d.id, data: draft });
      }
    }
    if (++n % 500 === 0) await flush();
    if (n % 10000 === 0) log(`${n} hands`);
  }
  await flush();
  void publicState;
  return sum;
}
