/**
 * Regression guard: the client bundle must never contain scenario answers
 * (option feedback, explanations, model ranges). Run after `vite build`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_SCENARIOS } from '@pdl/core';

const dir = join(import.meta.dirname, '../dist/assets');
const bundle = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
const needles = new Set<string>();
for (const s of ALL_SCENARIOS) {
  for (const n of Object.values(s.nodes)) {
    if (n.kind === 'decision') {
      n.options.forEach((o) => needles.add(o.feedback.en));
      needles.add(n.explanation.keyReason.en);
      if (n.model?.type === 'call') needles.add(n.model.villainRange);
    }
    if (n.kind === 'question') needles.add(n.explanation.keyReason.en);
  }
}
const leaks = [...needles].filter((x) => x.length > 12 && bundle.includes(x));
if (leaks.length) {
  console.error(`✗ ${leaks.length} scenario answer strings found in the client bundle, e.g.:`, leaks.slice(0, 3));
  process.exit(1);
}
console.log(`✓ client bundle contains none of ${needles.size} scenario answer strings`);
