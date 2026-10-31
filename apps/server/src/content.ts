import { createHash } from 'node:crypto';
import { ALL_SCENARIOS, SKILLS, Scenario, type ScenarioInput, validateScenario } from '@pdl/core';
import { prisma } from './db';

export const SKILL_NAMES: Record<string, [string, string]> = {
  overall: ['Overall', 'Tổng thể'],
  preflop: ['Preflop', 'Preflop'],
  flop: ['Flop', 'Flop'],
  turn: ['Turn', 'Turn'],
  river: ['River', 'River'],
  rangeReading: ['Range reading', 'Đọc range'],
  math: ['Mathematical reasoning', 'Tư duy toán học'],
  shortStack: ['Short stack', 'Stack ngắn'],
  icm: ['ICM', 'ICM'],
  pko: ['PKO', 'PKO'],
  exploit: ['Exploitative strategy', 'Chiến lược khai thác'],
};

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

export interface SeedReport {
  created: string[];
  unchanged: string[];
  rejected: { id: string; reason: string }[];
}

/**
 * Publish validated scenario versions. Invalid content is rejected; changing a published
 * version's content without bumping `version` is rejected (published versions are immutable).
 */
export async function seedContent(inputs: ScenarioInput[] = ALL_SCENARIOS): Promise<SeedReport> {
  const report: SeedReport = { created: [], unchanged: [], rejected: [] };
  for (const key of ['overall', ...SKILLS]) {
    const [en, vi] = SKILL_NAMES[key]!;
    await prisma.skillCategory.upsert({ where: { key }, create: { key, nameEn: en, nameVi: vi }, update: { nameEn: en, nameVi: vi } });
  }
  for (const input of inputs) {
    const v = validateScenario(input);
    const errors = v.issues.filter((i) => i.level === 'error');
    if (!v.ok || !v.scenario) {
      report.rejected.push({ id: v.id, reason: errors.map((e) => `${e.path}: ${e.message}`).join('; ') });
      continue;
    }
    const s = v.scenario;
    const hash = createHash('sha256').update(stableJson(s)).digest('hex');
    const existing = await prisma.scenarioVersion.findUnique({ where: { scenarioId_version: { scenarioId: s.id, version: s.version } } });
    if (existing) {
      if (existing.contentHash !== hash) report.rejected.push({ id: s.id, reason: `version ${s.version} already published with different content — bump the version` });
      else report.unchanged.push(s.id);
      continue;
    }
    await prisma.$transaction(async (tx) => {
      const source = await tx.sourceMetadata.create({
        data: { classification: s.source.classification, methodEn: s.source.method.en, methodVi: s.source.method.vi, reference: s.source.reference, reviewedBy: s.source.reviewedBy },
      });
      const nodes = Object.entries(s.nodes).filter(([, n]) => n.kind === 'decision' || n.kind === 'question');
      const skills = [...new Set(nodes.flatMap(([, n]) => ('skills' in n ? n.skills : [])))];
      const concepts = [...new Set(nodes.flatMap(([, n]) => ('concepts' in n ? n.concepts : [])))];
      await tx.scenario.upsert({
        where: { id: s.id },
        create: { id: s.id, mode: s.mode, module: s.module, currentVersion: s.version },
        update: { mode: s.mode, module: s.module, currentVersion: s.version },
      });
      const version = await tx.scenarioVersion.create({
        data: {
          scenarioId: s.id,
          version: s.version,
          contentHash: hash,
          definition: s as object,
          sourceId: source.id,
          difficulty: s.difficulty,
          skills,
          concepts,
          validationReport: { issues: v.issues, decisionCount: v.decisionCount, questionCount: v.questionCount } as object,
        },
      });
      for (const [key, n] of nodes) {
        if (n.kind === 'decision') {
          await tx.decisionNode.create({
            data: {
              scenarioVersionId: version.id,
              nodeKey: key,
              kind: 'decision',
              skills: n.skills,
              concepts: n.concepts,
              leakOpportunities: n.leakOpportunities,
              hasModel: !!n.model,
              options: {
                create: n.options.map((o) => ({
                  optionKey: o.id,
                  actionType: o.match.action,
                  sizingMinBB: o.match.minBB,
                  sizingMaxBB: o.match.maxBB,
                  sizingMinPot: o.match.minPot,
                  sizingMaxPot: o.match.maxPot,
                  modelKey: o.modelKey,
                  rubricGrade: o.grade,
                  solverFrequency: s.source.classification === 'SOLVER_VERIFIED' ? o.frequency : undefined,
                  solverEv: s.source.classification === 'SOLVER_VERIFIED' ? o.ev : undefined,
                })),
              },
            },
          });
        } else if (n.kind === 'question') {
          await tx.decisionNode.create({
            data: {
              scenarioVersionId: version.id,
              nodeKey: key,
              kind: 'question',
              skills: n.skills,
              concepts: n.concepts,
              leakOpportunities: n.leakOpportunities,
              options: { create: (n.choices ?? []).map((c) => ({ optionKey: c.id, actionType: 'choice', correct: c.correct, rubricGrade: c.grade })) },
            },
          });
        }
      }
    });
    report.created.push(s.id);
  }
  return report;
}

const cache = new Map<string, { id: string; scenario: Scenario; sourceClass: string }>();

export async function loadVersion(versionId: string) {
  const hit = cache.get(versionId);
  if (hit) return hit;
  const row = await prisma.scenarioVersion.findUnique({ where: { id: versionId }, include: { source: true } });
  if (!row) return null;
  const entry = { id: row.id, scenario: Scenario.parse(row.definition), sourceClass: row.source.classification };
  cache.set(versionId, entry);
  return entry;
}

export async function currentVersion(scenarioId: string) {
  const sc = await prisma.scenario.findUnique({ where: { id: scenarioId } });
  if (!sc || !sc.published) return null;
  const row = await prisma.scenarioVersion.findUnique({ where: { scenarioId_version: { scenarioId, version: sc.currentVersion } } });
  return row ? loadVersion(row.id) : null;
}
