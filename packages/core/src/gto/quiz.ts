import { type Card, fullDeck } from '../cards/cards';
import { classOfCombo } from '../cards/range';
import { createRng, pick } from '../cards/rng';
import { DEFAULT_THRESHOLDS, type Grade, gradeFromEvLoss } from '../scenario/grading';
import { type PushFoldSolution, classIndex, solvePushFold } from './pushfold';

/**
 * Random GTO push/fold spots (Poker Q'z–style endless quiz). Every spot is a pure function of its
 * seed, so the server can regenerate and grade it; answers come from the solved equilibrium.
 */
export type GtoRole = 'sbShove' | 'bbCall';
export type AnteFormat = 'none' | 'bbAnte' | 'classic8' | 'classic6';
export const ANTE_FORMATS: Record<AnteFormat, { deadBB: number; label: { en: string; vi: string } }> = {
  none: { deadBB: 0, label: { en: 'No ante', vi: 'Không ante' } },
  bbAnte: { deadBB: 1, label: { en: 'Big-blind ante (1BB)', vi: 'Ante BB (1BB)' } },
  classic8: { deadBB: 1, label: { en: '8-handed, 12.5% antes', vi: '8 người, ante 12.5%' } },
  classic6: { deadBB: 0.75, label: { en: '6-handed, 12.5% antes', vi: '6 người, ante 12.5%' } },
};

export interface GtoSpot {
  seed: number;
  role: GtoRole;
  stackBB: number;
  anteFormat: AnteFormat;
  deadBB: number;
  heroCards: [Card, Card];
  heroClass: string;
}

export interface GtoSpotFilter {
  minStack?: number;
  maxStack?: number;
  role?: GtoRole | 'any';
}

export const GTO_STACKS = Array.from({ length: 27 }, (_, k) => 2 + k * 0.5); // 2 .. 15 BB

/** Generate a spot. ~65% of spots are drawn from hands within 1.5BB of the indifference point (the instructive ones). */
export function generateGtoSpot(seed: number, filter: GtoSpotFilter = {}): GtoSpot {
  const rng = createRng(seed);
  const stacks = GTO_STACKS.filter((s) => s >= (filter.minStack ?? 2) && s <= (filter.maxStack ?? 15));
  if (!stacks.length) throw new Error('No stacks in range');
  const role: GtoRole = filter.role && filter.role !== 'any' ? filter.role : rng() < 0.5 ? 'sbShove' : 'bbCall';
  const stackBB = pick(rng, stacks);
  const anteFormat = pick(rng, Object.keys(ANTE_FORMATS) as AnteFormat[]);
  const deadBB = ANTE_FORMATS[anteFormat].deadBB;
  const sol = solvePushFold({ stackBB, deadBB });
  const ev = role === 'sbShove' ? sol.evShove : sol.evCall;
  const deck = fullDeck();
  const wantClose = rng() < 0.65;
  let cards: [Card, Card] = [deck[0]!, deck[1]!];
  for (let tries = 0; tries < 200; tries++) {
    const a = pick(rng, deck);
    let b = pick(rng, deck);
    while (b === a) b = pick(rng, deck);
    cards = [a, b];
    if (!wantClose || Math.abs(ev[classIndex(classOfCombo(a, b))]!) <= 1.5) break;
  }
  return { seed, role, stackBB, anteFormat, deadBB, heroCards: cards, heroClass: classOfCombo(cards[0], cards[1]) };
}

export type GtoAction = 'shove' | 'call' | 'fold';

export interface GtoGrade {
  grade: Grade;
  evLossBB: number;
  /** Equilibrium frequency of the aggressive action (shove / call) for the hero's hand class. */
  frequency: number;
  evAggressive: number;
  evFold: 0;
  bestAction: GtoAction | 'mixed';
  correctActions: GtoAction[];
}

export function gradeGtoSpot(spot: GtoSpot, action: GtoAction, sol: PushFoldSolution = solvePushFold({ stackBB: spot.stackBB, deadBB: spot.deadBB })): GtoGrade {
  const aggressive: GtoAction = spot.role === 'sbShove' ? 'shove' : 'call';
  if (action !== 'fold' && action !== aggressive) throw new Error(`Action ${action} is not available in this spot`);
  const i = classIndex(spot.heroClass);
  const evA = (spot.role === 'sbShove' ? sol.evShove : sol.evCall)[i]!;
  const freq = (spot.role === 'sbShove' ? sol.push : sol.call)[i]!;
  const best = Math.max(evA, 0);
  const chosen = action === 'fold' ? 0 : evA;
  const evLossBB = Math.max(0, best - chosen);
  const mixed = freq > 0 && freq < 1;
  // In a mixed strategy both actions are equilibrium actions (EVs equal up to solver precision).
  const grade = mixed ? 'excellent' : gradeFromEvLoss(evLossBB, DEFAULT_THRESHOLDS.bb);
  return {
    grade,
    evLossBB: mixed ? 0 : evLossBB,
    frequency: freq,
    evAggressive: evA,
    evFold: 0,
    bestAction: mixed ? 'mixed' : evA > 0 ? aggressive : 'fold',
    correctActions: mixed ? [aggressive, 'fold'] : evA > 0 ? [aggressive] : ['fold'],
  };
}

export const GTO_ASSUMPTIONS = {
  en: [
    'Heads-up subgame: action is folded to the small blind; everyone else has folded.',
    'Push/fold model: the small blind may only shove or fold (no limps or small raises). This is close to full GTO only at short stacks (≈15BB and below).',
    'Chip EV: no ICM, no bounties. Antes already posted are dead money.',
    'Equities from a precomputed 169×169 all-in table (seeded Monte Carlo, ≈±0.35% per matchup); exact card-removal weights.',
  ],
  vi: [
    'Tình huống đối đầu: mọi người bỏ bài tới small blind.',
    'Mô hình push/fold: small blind chỉ được all-in hoặc bỏ (không limp, không tố nhỏ). Chỉ gần với GTO đầy đủ ở stack ngắn (≈15BB trở xuống).',
    'Chip EV: không ICM, không bounty. Ante đã đặt là tiền chết trong pot.',
    'Equity từ bảng all-in 169×169 tính sẵn (Monte Carlo có seed, ≈±0.35% mỗi cặp); trọng số loại lá chính xác.',
  ],
};
