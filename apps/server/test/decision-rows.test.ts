import { analyzePatterns, analyzeSolver } from '@pdl/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { loadDecisionRows, loadDecisionRowsPrisma } from '../src/leakEngine';
import { backfillContexts, importV2 } from '../src/realhands/import';
import { ensureSeeded, newUser } from './helpers';
import { buildV2Fixture } from './v2fixture';

/** The single-query decision loader must return exactly what the original Prisma loader returned. */
const canon = (rows: object[]) => [...rows].map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();
const byKey = (ps: ReturnType<typeof analyzePatterns>) => [...ps].sort((a, b) => `${a.key}|${a.slice}`.localeCompare(`${b.key}|${b.slice}`)).map(({ examples, ...p }) => ({ ...p, examples: [...examples].sort() }));

let user: Awaited<ReturnType<typeof newUser>>;
beforeAll(async () => {
  await ensureSeeded();
  user = await newUser('rows');
  await importV2(user.id, buildV2Fixture().dir);
  await backfillContexts(user.id);
  // one hand outside any tournament, so the hand-id cluster fallback is exercised too
  const h = await prisma.realHand.findFirstOrThrow({ where: { userId: user.id } });
  await prisma.realHand.update({ where: { id: h.id }, data: { tournamentId: null } });
});

describe('loadDecisionRows (single SQL join)', () => {
  it('returns the same rows, fields and clusters as the Prisma loader', async () => {
    const [a, b] = await Promise.all([loadDecisionRowsPrisma(user.id), loadDecisionRows(user.id)]);
    expect(b.length).toBeGreaterThan(0);
    expect(b.length).toBe(a.length);
    expect(canon(b)).toEqual(canon(a));
    expect(b.some((r) => r.cluster?.startsWith('hand:'))).toBe(true);
    for (const r of b) {
      expect(typeof r.multiway).toBe('boolean');
      expect(r.playedAt === null || !Number.isNaN(Date.parse(r.playedAt))).toBe(true);
      expect(r.facingBetPct === null || typeof r.facingBetPct === 'number').toBe(true);
    }
  });

  it('gives the leak engine identical statistics', async () => {
    const [a, b] = await Promise.all([loadDecisionRowsPrisma(user.id), loadDecisionRows(user.id)]);
    expect(byKey(analyzePatterns(b))).toEqual(byKey(analyzePatterns(a)));
    expect(analyzeSolver(b)).toEqual(analyzeSolver(a));
  });

  it('only returns accepted, analysed decisions of that user', async () => {
    const other = await newUser('rows2');
    expect(await loadDecisionRows(other.id)).toEqual([]);
    const accepted = await prisma.realDecision.count({ where: { userId: user.id, status: 'accepted', contextV: { gte: 1 } } });
    expect((await loadDecisionRows(user.id)).length).toBe(accepted);
    expect(await prisma.realDecision.count({ where: { userId: user.id, status: 'quarantined' } })).toBeGreaterThan(0);
  });
});
