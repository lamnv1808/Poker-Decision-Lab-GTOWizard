/**
 * Audit Real Hand Source v2 against this project's engine.
 * Usage: npx tsx scripts/v2-audit.ts <real-hand-source dir> <out dir>
 * Writes <out>/v2-audit-report.json (counts + examples per reason) and <out>/v2-normalized.jsonl
 * (one line per hand: hand status + decision/quiz statuses). Never modifies the source files.
 */
import { createReadStream, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { type V2Decision, type V2HandRecord, type V2Quiz, auditDecision, auditHand, auditQuiz, snapshotForHeroAction } from '@pdl/core';

const [src, out] = [process.argv[2]!, process.argv[3]!];
mkdirSync(out, { recursive: true });
const lines = (f: string) => createInterface({ input: createReadStream(join(src, f)), crlfDelay: Infinity })[Symbol.asyncIterator]();
const hands = lines('hands.jsonl');
const decs = lines('decisions.jsonl');
const quizzes = lines('pot_odds_quizzes.jsonl');
let pendingDec: V2Decision | null = null;
let pendingQuiz: V2Quiz | null = null;
const nextDec = async () => { const r = await decs.next(); return r.done ? null : (JSON.parse(r.value) as V2Decision); };
const nextQuiz = async () => { const r = await quizzes.next(); return r.done ? null : (JSON.parse(r.value) as V2Quiz); };

const report = {
  source: src,
  hands: { total: 0, accepted: 0, quarantined: 0, byReason: {} as Record<string, number>, examples: {} as Record<string, string[]>, notes: {} as Record<string, number> },
  decisions: { total: 0, accepted: 0, quarantined: 0, byReason: {} as Record<string, number>, examples: {} as Record<string, string[]>, byStreet: {} as Record<string, { accepted: number; quarantined: number }>, orphan: 0 },
  quizzes: { total: 0, accepted: 0, quarantined: 0, byReason: {} as Record<string, number>, examples: {} as Record<string, string[]>, terminal: 0, nonterminal: 0 },
  formats: {} as Record<string, number>,
};
const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
const example = (o: Record<string, string[]>, k: string, v: string) => ((o[k] ??= []).length < 5 ? o[k]!.push(v) : 0);
const norm = createWriteStream(join(out, 'v2-normalized.jsonl'));

pendingDec = await nextDec();
pendingQuiz = await nextQuiz();
const t0 = Date.now();
for (let r = await hands.next(); !r.done; r = await hands.next()) {
  const h = JSON.parse(r.value) as V2HandRecord;
  report.hands.total++;
  const a = auditHand(h.raw);
  bump(report.formats, a.format);
  for (const n of a.notes) bump(report.hands.notes, n);
  if (a.ok) report.hands.accepted++;
  else {
    report.hands.quarantined++;
    for (const i of a.issues) { bump(report.hands.byReason, i.code); example(report.hands.examples, i.code, `${h.hand_id}: ${i.detail}`); }
  }
  const decOut: unknown[] = [];
  while (pendingDec && pendingDec.family_id === h.hand_id) {
    const d = pendingDec;
    report.decisions.total++;
    const bs = (report.decisions.byStreet[d.street] ??= { accepted: 0, quarantined: 0 });
    let issues: { code: string; detail: string }[];
    if (!a.ok || !a.rec) issues = [{ code: 'hand_invalid', detail: a.issues.map((i) => i.code).join(',') }];
    else issues = auditDecision(d, a.rec).issues;
    if (issues.length) { report.decisions.quarantined++; bs.quarantined++; for (const i of issues) { bump(report.decisions.byReason, i.code); example(report.decisions.examples, i.code, `${d.id}: ${i.detail}`); } }
    else { report.decisions.accepted++; bs.accepted++; }
    decOut.push({ id: d.id, ok: !issues.length, issues });
    pendingDec = await nextDec();
  }
  const quizOut: unknown[] = [];
  while (pendingQuiz && pendingQuiz.family_id === h.hand_id) {
    const q = pendingQuiz;
    report.quizzes.total++;
    let res: { ok: boolean; issues: { code: string; detail: string }[]; requiredEquity: number | null; terminal: boolean };
    const decId = q.id.replace(/-odds$/, '');
    const n = Number(decId.split('-').pop());
    const snap = a.rec ? snapshotForHeroAction(a.rec, n) : null;
    const decOk = (decOut as { id: string; ok: boolean }[]).find((x) => x.id === decId)?.ok;
    if (!a.ok || !snap || !decOk) res = { ok: false, issues: [{ code: 'decision_invalid', detail: 'underlying decision quarantined' }], requiredEquity: null, terminal: false };
    else res = auditQuiz(q, snap);
    if (res.ok) { report.quizzes.accepted++; res.terminal ? report.quizzes.terminal++ : report.quizzes.nonterminal++; }
    else { report.quizzes.quarantined++; for (const i of res.issues) { bump(report.quizzes.byReason, i.code); example(report.quizzes.examples, i.code, `${q.id}: ${i.detail}`); } }
    quizOut.push({ id: q.id, ok: res.ok, issues: res.issues, requiredEquity: res.requiredEquity, terminal: res.terminal });
    pendingQuiz = await nextQuiz();
  }
  norm.write(JSON.stringify({ hand: h.hand_id, ok: a.ok, issues: a.issues, notes: a.notes, format: a.format, tournamentId: a.tournamentId, playedAt: a.playedAt, decisions: decOut, quizzes: quizOut }) + '\n');
  if (report.hands.total % 10000 === 0) console.error(`${report.hands.total} hands, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
// anything left unmatched means the files are not aligned
for (; pendingDec; pendingDec = await nextDec()) report.decisions.orphan++;
norm.end();
writeFileSync(join(out, 'v2-audit-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ hands: { total: report.hands.total, accepted: report.hands.accepted, quarantined: report.hands.quarantined, byReason: report.hands.byReason }, decisions: { total: report.decisions.total, accepted: report.decisions.accepted, quarantined: report.decisions.quarantined, byReason: report.decisions.byReason, orphan: report.decisions.orphan }, quizzes: { total: report.quizzes.total, accepted: report.quizzes.accepted, quarantined: report.quizzes.quarantined, byReason: report.quizzes.byReason, terminal: report.quizzes.terminal, nonterminal: report.quizzes.nonterminal }, formats: report.formats }, null, 1));
