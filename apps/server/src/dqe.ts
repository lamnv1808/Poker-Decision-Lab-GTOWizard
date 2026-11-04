import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { classOfCombo, dqeDecisionFromState, evaluateDecision, huPushFoldSource, rangeLibrarySource, type Card, type DqeVerdict, type EvidenceSource, type HandState, type PlayerAction, type RangeRecord } from '@pdl/core';
import { env } from './env';

/**
 * Decision Quality Engine in training feedback — behind the DQE_FEEDBACK flag (default OFF).
 * Read-only: never changes grades, ratings or stored decisions; failures never break the response.
 * Range data is loaded lazily on first use, so production memory is unchanged while the flag is off.
 */
export const dqeEnabled = () => env.DQE_FEEDBACK === 'on';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../data/ranges');
let sources: EvidenceSource[] | null = null;

export function dqeSources(): EvidenceSource[] {
  if (sources) return sources;
  const recs: RangeRecord[] = [];
  if (existsSync(DATA_DIR))
    for (const f of readdirSync(DATA_DIR).filter((x) => x.endsWith('.json.gz'))) recs.push(...(JSON.parse(gunzipSync(readFileSync(join(DATA_DIR, f))).toString()) as { records: RangeRecord[] }).records);
  const tol = { stackBB: (s: number) => (s <= 15.25 ? 0.25 : 1.25), deadBB: 0.25 };
  sources = [huPushFoldSource, rangeLibrarySource('pdl-pushfold-nmax', recs, tol)];
  return sources;
}

/** Verdict for a live simulator decision (state immediately before Hero acts). Null when off or on error. */
export function dqeForState(state: HandState, heroId: string, action: PlayerAction, scenarioId: string, economics: 'chipEV' | 'PKO' = 'chipEV'): DqeVerdict | null {
  if (!dqeEnabled()) return null;
  try {
    const hero = state.players.find((p) => p.id === heroId);
    const cards = hero?.cards;
    const heroClass = cards && cards.length === 2 ? classOfCombo(cards[0] as Card, cards[1] as Card) : null;
    const positions = Object.fromEntries(state.players.map((p) => [p.id, p.id]));
    return evaluateDecision(dqeDecisionFromState(state, heroId, { positions, chosen: action, heroClass, economics, scenarioId }), dqeSources());
  } catch {
    return null;
  }
}
