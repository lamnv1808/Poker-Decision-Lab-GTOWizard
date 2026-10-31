import { positionsFor } from '../engine/positions';
import type { Localized, ScenarioInput } from '../scenario/schema';

/** Authoring helpers. Content is plain data validated by validateScenario(). */
export const L = (en: string, vi: string): Localized => ({ en, vi });

/** Players for a table: stacks in BB keyed by position; unspecified seats get `defaultBB`. */
export function seats(
  tableSize: number,
  stacks: Record<string, number>,
  defaultBB = 30,
  extra: Record<string, Partial<{ bounty: number; tendencies: Localized; name: string }>> = {},
): ScenarioInput['table']['players'] {
  return positionsFor(tableSize).map((pos) => ({ pos, stackBB: stacks[pos] ?? defaultBB, ...(extra[pos] ?? {}) }));
}

/** Standard MTT blind structure: blinds in chips, ante per player or BB ante. */
export function blinds(bb: number, ante: number, anteMode: 'each' | 'bigBlind' | 'none' = 'bigBlind') {
  return { bigBlind: bb, smallBlind: bb / 2, ante, anteMode } as const;
}

export const ANY_TWO = '22+,A2+,K2+,Q2+,J2+,T2+,92+,82+,72+,62+,52+,42+,32';

export function defineScenario(s: ScenarioInput): ScenarioInput {
  return s;
}
