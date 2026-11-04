import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { assertVerdictInvariants, evaluateDecision, rangeLibrarySource, recordChecksum, validateRecord, type DqeDecision, type RangeRecord } from '@pdl/core';
import { describe, expect, it } from 'vitest';

/**
 * Integrity of the shipped N-player push/fold dataset (apps/server/data/ranges) and its trust class:
 * every file matches the manifest checksum, every configuration of the generated grid is present,
 * every record validates, and no record can ever produce a verified grade.
 */
const DIR = new URL('../data/ranges/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('pushfold-nmax-manifest.json', DIR), 'utf8')) as {
  evidence: string;
  approximation: string;
  configurations: number;
  records: number;
  files: { file: string; tableSize: number; records: number; sha256: string }[];
  configurationsList: { tableSize: number; stackBB: number; deadBB: number; nodes: number }[];
};
const records: RangeRecord[] = [];
for (const f of manifest.files) {
  const bytes = readFileSync(new URL(f.file, DIR));
  (f as { actual?: string }).actual = createHash('sha256').update(bytes).digest('hex');
  records.push(...(JSON.parse(gunzipSync(bytes).toString()) as { records: RangeRecord[] }).records);
}

describe('N-player push/fold dataset', () => {
  it('every file matches its manifest checksum and record count', () => {
    expect(manifest.files.map((f) => f.tableSize)).toEqual([6, 7, 8, 9]);
    for (const f of manifest.files) {
      expect((f as { actual?: string }).actual).toBe(f.sha256);
      expect(records.filter((r) => r.key.tableSize === f.tableSize)).toHaveLength(f.records);
    }
    expect(records).toHaveLength(manifest.records);
  });

  it('every configuration of the generated grid is present, with every decision node', () => {
    const stacks = [...Array.from({ length: 21 }, (_, i) => 5 + i * 0.5), 17.5, 20];
    const expected = [6, 7, 8, 9].flatMap((n) => stacks.flatMap((S) => [0, 1].map((D) => `${n}|${S}|${D}`)));
    const inData = new Map<string, number>();
    for (const r of records) inData.set(`${r.key.tableSize}|${r.key.effStackBB}|${r.key.deadBB}`, (inData.get(`${r.key.tableSize}|${r.key.effStackBB}|${r.key.deadBB}`) ?? 0) + 1);
    expect([...inData.keys()].sort()).toEqual([...expected].sort());
    expect(manifest.configurations).toBe(expected.length);
    // (n-1) first-in shove/fold nodes + one call/fold node for every (shover, later seat) pair
    const nodes: Record<number, number> = { 6: 20, 7: 27, 8: 35, 9: 44 };
    for (const [k, n] of inData) expect(n).toBe(nodes[Number(k.split('|')[0])]);
  });

  it('every record validates, its checksum verifies, and keys are unique', () => {
    expect(new Set(records.map((r) => r.keyString)).size).toBe(records.length);
    for (const r of records) {
      expect(validateRecord(r)).toEqual([]);
      expect(recordChecksum(r)).toBe(r.checksum);
    }
  });

  it('is APPROXIMATE everywhere: model-estimate evidence, never verified solver EV, never a grade', () => {
    expect(manifest.evidence).toBe('approximateModel');
    expect(manifest.approximation).toMatch(/no overcalls/);
    const src = rangeLibrarySource('pdl-pushfold-nmax', records);
    for (const r of records) {
      expect(r.evidence).toBe('approximateModel');
      expect(r.validation.status).toBe('approximate');
      expect(r.method.approximation).toMatch(/no overcalls/);
      for (const heroClass of ['AA', '72o']) {
        const d: DqeDecision = {
          scenarioId: 't', format: 'MTT', economics: 'chipEV', tableSize: r.key.tableSize, heroPos: r.key.heroPos, villainPositions: [],
          effStackBB: r.key.effStackBB, deadBB: r.key.deadBB, street: 'preflop', board: null, node: r.key.node, history: r.key.history,
          legalActions: ['fold', 'call', 'raise', 'shove'], chosenAction: r.actions[1]!, heroClass, potBB: null, toCallBB: null, requiredEquity: null, heuristic: null,
        };
        const v = evaluateDecision(d, [src]);
        expect(v.category).toBe('MODEL_ESTIMATE');
        expect(v.grade).toBeNull();
        expect(v.evLossBB).toBeNull();
        expect(v.approximation).toMatch(/no overcalls/);
        expect(() => assertVerdictInvariants(v)).not.toThrow();
        // a chip-EV model never answers a bounty (PKO) or ICM spot
        expect(evaluateDecision({ ...d, economics: 'PKO' }, [src]).category).not.toBe('MODEL_ESTIMATE');
        expect(evaluateDecision({ ...d, economics: 'ICM' }, [src]).category).not.toBe('MODEL_ESTIMATE');
      }
    }
  });
});
