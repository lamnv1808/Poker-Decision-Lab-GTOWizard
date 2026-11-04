/**
 * DQE coverage audit + offline shadow grading over every accepted historical decision. READ-ONLY.
 *
 *   DATABASE_URL=<isolated restored copy> npx tsx scripts/dqe-audit.ts [--out <dir>] [--limit N]
 *
 * - Rebuilds each decision from its hand history exactly like the importer (auditHand +
 *   snapshotForHeroAction), evaluates it with the DQE sources, and aggregates coverage.
 * - Shadow grading: compares every DQE verdict with the stored existing push/fold grade (pfAudit).
 *   Nothing is written to the database. Per-decision verdicts go to <out>/shadow-verdicts.jsonl (local file).
 * - Prints aggregates only (no hands, cards, names or ids).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { auditHand, dqeDecisionFromReal, evaluateDecision, huPushFoldSource, rangeLibrarySource, snapshotForHeroAction, stackBucket, type DqeVerdict, type RangeRecord } from '@pdl/core';
import { prisma } from '../src/db';

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const OUT = arg('--out') ?? 'dqe-out';
const LIMIT = Number(arg('--limit') ?? Infinity);
const DATA = new URL('../data/ranges/', import.meta.url).pathname;

function loadLibrary(): RangeRecord[] {
  if (!existsSync(DATA)) return [];
  const recs: RangeRecord[] = [];
  for (const f of readdirSync(DATA).filter((x) => x.endsWith('.json.gz'))) recs.push(...(JSON.parse(gunzipSync(readFileSync(join(DATA, f))).toString()) as { records: RangeRecord[] }).records);
  return recs;
}

const inc = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const table = (m: Map<string, number>, total: number, top = 50) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, n]) => ({ key: k, n, pct: Math.round((n / Math.max(1, total)) * 10000) / 100 }));

async function main() {
  const t0 = Date.now();
  const library = loadLibrary();
  const tol = { stackBB: (s: number) => (s <= 15.25 ? 0.25 : 1.25), deadBB: 0.25 };
  const sources = [huPushFoldSource, rangeLibrarySource('pdl-pushfold-nmax', library, tol)];
  mkdirSync(OUT, { recursive: true });
  const jsonl: string[] = [];
  const contentLines: string[] = []; // id-free: comparable across database copies whose ids differ
  const byCat = new Map<string, number>();
  const byStreetCat = new Map<string, number>();
  const byPosCat = new Map<string, number>();
  const byStackCat = new Map<string, number>();
  const byNodeCat = new Map<string, number>();
  const byFormatCat = new Map<string, number>();
  const byActionCat = new Map<string, number>();
  const unsupported = new Map<string, number>();
  const missingReasons = new Map<string, number>();
  const shadow = { comparable: 0, gradeAgree: 0, evLossAgree: 0, disagree: [] as Record<string, unknown>[], pkoInconclusive: 0, existingOnly: 0, dqeOnlySolver: 0 };
  let total = 0;
  let failed = 0;
  let last = '';
  for (;;) {
    const page = await prisma.realHand.findMany({
      where: { status: 'accepted', id: { gt: last } },
      orderBy: { id: 'asc' },
      take: 400,
      select: { id: true, raw: true, format: true, decisions: { where: { status: 'accepted' }, orderBy: { id: 'asc' }, select: { id: true, heroActionNo: true, pfAudit: true, formatGroup: true } } },
    });
    if (!page.length || total >= LIMIT) break;
    last = page[page.length - 1]!.id;
    for (const h of page) {
      const a = auditHand(h.raw);
      const rawHash = createHash('sha256').update(h.raw).digest('hex');
      for (const d of h.decisions) {
        if (total >= LIMIT) break;
        total++;
        const snap = a.rec ? snapshotForHeroAction(a.rec, d.heroActionNo) : null;
        if (!a.rec || !snap) {
          failed++;
          inc(byCat, 'RECONSTRUCTION_FAILED');
          continue;
        }
        const dec = dqeDecisionFromReal(a.rec, snap, h.format, d.id);
        const v: DqeVerdict = evaluateDecision(dec, sources);
        const line = { category: v.category, label: v.label, grade: v.grade, evLossBB: v.evLossBB, modelEvLossBB: v.modelEvLossBB, source: v.source?.id ?? null, ref: v.source?.referenceKey ?? null, match: v.matchStatus, missing: v.missing?.reason ?? null, engine: v.engineVersion };
        jsonl.push(JSON.stringify({ id: d.id, ...line }));
        contentLines.push(`${createHash('sha256').update(`${rawHash}|${d.heroActionNo}`).digest('hex')}|${JSON.stringify(line)}`);
        const cat = v.category;
        inc(byCat, cat);
        inc(byStreetCat, `${dec.street}|${cat}`);
        if (dec.street === 'preflop') {
          inc(byPosCat, `${dec.heroPos}|${cat}`);
          inc(byStackCat, `${dec.effStackBB == null ? '?' : stackBucket(dec.effStackBB)}|${cat}`);
          inc(byNodeCat, `${dec.node}|${cat}`);
        }
        inc(byFormatCat, `${dec.economics}|${cat}`);
        inc(byActionCat, `${dec.street}:${dec.chosenAction}|${cat}`);
        if (v.missing) inc(missingReasons, v.missing.reason);
        if (cat !== 'VERIFIED_SOLVER_EV' && cat !== 'VERIFIED_REFERENCE_FREQUENCY' && cat !== 'MODEL_ESTIMATE') {
          const sb = dec.effStackBB == null ? '?' : stackBucket(dec.effStackBB);
          inc(unsupported, dec.street === 'preflop' ? `preflop|${dec.node}|${dec.tableSize}-max|${dec.heroPos}|${sb}` : `${dec.street}|${dec.node}|${dec.villainPositions.length + 1}-way|${sb}`);
        }
        // shadow grading vs the existing grader (stored pfAudit)
        const pf = d.pfAudit as { grade: string | null; evLossBB: number | null; heroAction: string } | null;
        if (pf && pf.grade && pf.heroAction !== 'other') {
          if (v.category === 'VERIFIED_SOLVER_EV' && v.grade) {
            shadow.comparable++;
            if (v.grade === pf.grade) shadow.gradeAgree++;
            if (v.evLossBB != null && pf.evLossBB != null && Math.abs(v.evLossBB - pf.evLossBB) < 1e-9) shadow.evLossAgree++;
            if (v.grade !== pf.grade && shadow.disagree.length < 50) shadow.disagree.push({ existing: pf.grade, dqe: v.grade, existingLoss: pf.evLossBB, dqeLoss: v.evLossBB, ref: v.source?.referenceKey });
          } else if (v.missing?.reason === 'bounty_could_overturn') shadow.pkoInconclusive++;
          else shadow.existingOnly++;
        } else if (v.category === 'VERIFIED_SOLVER_EV' && v.grade) shadow.dqeOnlySolver++;
      }
    }
  }
  const content = jsonl.join('\n');
  writeFileSync(join(OUT, 'shadow-verdicts.jsonl'), content);
  const report = {
    engine: 'dqe-1.0.0',
    generatedAt: new Date().toISOString(),
    libraryRecords: library.length,
    decisions: total,
    reconstructionFailed: failed,
    byCategory: table(byCat, total),
    byStreet: table(byStreetCat, total, 100),
    byPreflopPosition: table(byPosCat, total, 200),
    byPreflopStack: table(byStackCat, total, 100),
    byPreflopNode: table(byNodeCat, total, 100),
    byEconomics: table(byFormatCat, total, 50),
    byAction: table(byActionCat, total, 100),
    missingReasons: table(missingReasons, total, 30),
    topUnsupportedFamilies: table(unsupported, total, 40),
    shadow: { ...shadow, disagree: shadow.disagree },
    verdictsSha256: createHash('sha256').update(content).digest('hex'),
    // same verdicts keyed by (hand text, action number) instead of database ids: equal across copies of the same data
    contentVerdictsSha256: createHash('sha256').update(contentLines.sort().join('\n')).digest('hex'),
    runtimeMs: Date.now() - t0,
    peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
  };
  writeFileSync(join(OUT, 'coverage-report.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ decisions: total, reconstructionFailed: failed, byCategory: report.byCategory, shadow: { comparable: shadow.comparable, gradeAgree: shadow.gradeAgree, evLossAgree: shadow.evLossAgree, disagreements: shadow.disagree.length, pkoInconclusive: shadow.pkoInconclusive, existingOnly: shadow.existingOnly, dqeOnlySolver: shadow.dqeOnlySolver }, verdictsSha256: report.verdictsSha256, contentVerdictsSha256: report.contentVerdictsSha256, runtimeMs: report.runtimeMs, peakRssMB: report.peakRssMB }));
}
main().finally(() => prisma.$disconnect());
