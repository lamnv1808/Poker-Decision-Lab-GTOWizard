import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DICTS, translate } from './i18n';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : [];
  });
}

describe('i18n', () => {
  it('EN and VI have exactly the same keys and no empty values', () => {
    expect(Object.keys(DICTS.vi).sort()).toEqual(Object.keys(DICTS.en).sort());
    for (const lang of ['en', 'vi'] as const) for (const [k, v] of Object.entries(DICTS[lang])) expect(v.trim(), `${lang}:${k}`).not.toBe('');
  });
  it('every static t("…") key used in components exists', () => {
    const src = files(join(import.meta.dirname)).map((f) => readFileSync(f, 'utf8')).join('\n');
    const keys = [...src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]!);
    const missing = [...new Set(keys)].filter((k) => !(k in DICTS.en));
    expect(missing).toEqual([]);
  });
  it('dynamic key families are complete', () => {
    const fam: Record<string, string[]> = {
      grade: ['excellent', 'good', 'acceptable', 'marginal', 'mistake', 'major'],
      street: ['preflop', 'flop', 'turn', 'river'],
      skill: ['overall', 'preflop', 'flop', 'turn', 'river', 'rangeReading', 'math', 'shortStack', 'icm', 'pko', 'exploit'],
      source: ['MATH_VERIFIED', 'SOLVER_VERIFIED', 'COACH_REVIEWED', 'HEURISTIC', 'EXPERIMENTAL'],
      quiz: ['potOdds', 'bluffBreakEven', 'mdf', 'bluffRatio', 'outs', 'combos', 'spr', 'callEv', 'shoveEv', 'icm', 'bounty'],
      qtype: ['multipleChoice', 'actionPrediction', 'sizingPrediction', 'rangeGrid', 'comboCount', 'percentEstimate'],
      stage: ['early', 'middle', 'bubble', 'itm', 'finalTable', 'headsUp'],
      moduleName: Array.from({ length: 18 }, (_, i) => String(i + 1).padStart(2, '0')),
    };
    for (const [prefix, items] of Object.entries(fam)) for (const i of items) expect(DICTS.en[`${prefix}.${i}`], `${prefix}.${i}`).toBeDefined();
  });
  it('interpolates variables', () => {
    expect(translate('en', 'dash.reviewDue', { n: 3 })).toBe('3 reviews due');
    expect(translate('vi', 'dash.reviewDue', { n: 3 })).toBe('3 mục cần ôn');
  });
});
