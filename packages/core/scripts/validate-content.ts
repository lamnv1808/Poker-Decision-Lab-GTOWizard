/**
 * Content validation workflow: `npm run validate:content`.
 * Every scenario must pass before it can be seeded/published. Exits non-zero on any error.
 */
import { ALL_SCENARIOS } from '../src/content';
import { validateScenario } from '../src/scenario';

let failed = 0;
const seen = new Set<string>();
const counts: Record<string, number> = {};
for (const s of ALL_SCENARIOS) {
  const r = validateScenario(s);
  if (seen.has(r.id)) {
    console.error(`✗ duplicate scenario id ${r.id}`);
    failed++;
  }
  seen.add(r.id);
  const cls = r.scenario?.source.classification ?? '?';
  counts[cls] = (counts[cls] ?? 0) + 1;
  const errors = r.issues.filter((i) => i.level === 'error');
  const warnings = r.issues.filter((i) => i.level === 'warning');
  console.log(`${errors.length ? '✗' : '✓'} ${r.id} [${cls}] decisions=${r.decisionCount} questions=${r.questionCount}${warnings.length ? ` (${warnings.length} warnings)` : ''}`);
  for (const i of [...errors, ...warnings]) console.log(`    ${i.level}: ${i.path}: ${i.message}`);
  for (const [node, m] of Object.entries(r.models))
    console.log(`    model ${node} [${m.unit}] ±${m.evStdErr.toFixed(3)}: ${m.outcomes.map((o) => `${o.key}=${o.ev.toFixed(3)}`).join(', ')}`);
  if (errors.length) failed++;
}
console.log(`\n${ALL_SCENARIOS.length} scenarios, ${failed} failing. By source: ${JSON.stringify(counts)}`);
process.exit(failed ? 1 : 0);
