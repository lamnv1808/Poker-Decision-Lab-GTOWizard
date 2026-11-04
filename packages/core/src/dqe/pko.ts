/**
 * PKO / progressive-knockout decision model — PROTOTYPE (Phase 4A). Not wired into grading or feedback.
 *
 * Separates four things that are often conflated:
 *  1. chip EV                — the existing calculations, unchanged;
 *  2. bounty FACE value      — the cash amount on a player's head ($);
 *  3. bounty DECISION value  — what winning that bounty is worth now, in chips. Only the immediate cash part
 *                              is certain. The part added to Hero's own head is paid to whoever later busts
 *                              Hero (or to Hero if Hero wins), so it is worth only a fraction (futureFactor)
 *                              of cash. Cash is converted to chips with a $/chip rate that needs prize-pool
 *                              and chips-in-play information;
 *  4. tournament equity (ICM) — not modelled here. If the stage is close to the money or a final table, the
 *                              chip↔$ conversion is not linear and the result is UNSUPPORTED.
 *
 * What the hand histories contain (measured on the restored copy): stacks, blinds, antes, actions, and the
 * buy-in only inside the tournament name. They do NOT contain current bounty amounts, the field size,
 * players remaining, the prize pool or the payout table. Every decision value is therefore a band over
 * stated assumptions, never a point, and the evidence class is at most MODEL_ESTIMATE.
 */

export const PKO_MODEL_VERSION = 'pdl-pko-model-v0-prototype';

export interface PkoAssumptions {
  /** share of the buy-in that funds bounties (many PKOs: 0.5) */
  bountyShare: number;
  /** share of a collected bounty paid in cash immediately (progressive KO: usually 0.5) */
  cashShare: number;
  /** present value of the part added to Hero's own bounty, per $ (0 = worthless, 1 = as good as cash) */
  futureFactor: number;
  /** target's current bounty as a multiple of the starting bounty (unknown in the histories) */
  bountyMultiple: number;
}

export const PKO_SCENARIOS: Record<'low' | 'mid' | 'high', PkoAssumptions> = {
  low: { bountyShare: 0.5, cashShare: 0.5, futureFactor: 0.25, bountyMultiple: 1 },
  mid: { bountyShare: 0.5, cashShare: 0.5, futureFactor: 0.5, bountyMultiple: 1.5 },
  high: { bountyShare: 0.5, cashShare: 0.5, futureFactor: 0.75, bountyMultiple: 3 },
};

export interface PkoSpot {
  /** total buy-in in $ (parsed from the tournament name), null if unknown */
  buyIn: number | null;
  /** starting stack in chips (needed for the early-stage $/chip conversion), null if unknown */
  startingStackChips: number | null;
  bigBlindChips: number;
  /** Hero's total chips at the start of the hand and each opponent's whose bounty Hero could win */
  heroChips: number;
  opponentChips: number[];
  /** stage signal: 'early' (far from the money), 'late' (near/in the money or final table), 'unknown' */
  stage: 'early' | 'late' | 'unknown';
}

export type PkoResult =
  | { status: 'unsupported'; reason: string; modelVersion: string }
  | {
      status: 'approximate';
      modelVersion: string;
      /** $ on the target's head under each scenario — FACE value, not decision value */
      faceValueUsd: Record<'low' | 'mid' | 'high', number>;
      /** decision value in BB of winning that bounty (cash part + discounted future part, converted to chips) */
      decisionValueBB: Record<'low' | 'mid' | 'high', number>;
      chipsPerDollar: number;
      covers: boolean;
      assumptions: string[];
      unknowns: string[];
    };

/** Bounty decision value of knocking out ONE opponent that Hero covers. */
export function bountyDecisionValue(spot: PkoSpot, opponentIndex = 0): PkoResult {
  const v = PKO_MODEL_VERSION;
  if (spot.buyIn == null || !(spot.buyIn > 0)) return { status: 'unsupported', reason: 'buy-in unknown: the bounty size cannot be estimated', modelVersion: v };
  if (spot.startingStackChips == null || !(spot.startingStackChips > 0)) return { status: 'unsupported', reason: 'starting stack unknown: cash cannot be converted to chips', modelVersion: v };
  if (spot.stage === 'late') return { status: 'unsupported', reason: 'near the money / final table: chips are not linear in $, ICM is required and not modelled', modelVersion: v };
  if (spot.opponentChips.length !== 1) return { status: 'unsupported', reason: 'multiway bounty spots (several opponents all-in) are not modelled in the prototype', modelVersion: v };
  const opp = spot.opponentChips[opponentIndex]!;
  const covers = spot.heroChips >= opp;
  // early stage: the non-bounty prize pool is (1 − bountyShare)·buyIn per player and every player started with
  // startingStackChips, so 1 $ of prize pool ≈ startingStack / ((1 − bountyShare)·buyIn) chips.
  const chipsPerDollar = (a: PkoAssumptions) => spot.startingStackChips! / ((1 - a.bountyShare) * spot.buyIn!);
  const face = (a: PkoAssumptions) => a.bountyShare * spot.buyIn! * a.bountyMultiple;
  const decision = (a: PkoAssumptions) => (covers ? (face(a) * (a.cashShare + (1 - a.cashShare) * a.futureFactor) * chipsPerDollar(a)) / spot.bigBlindChips : 0);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    status: 'approximate',
    modelVersion: v,
    faceValueUsd: { low: r2(face(PKO_SCENARIOS.low)), mid: r2(face(PKO_SCENARIOS.mid)), high: r2(face(PKO_SCENARIOS.high)) },
    decisionValueBB: { low: r2(decision(PKO_SCENARIOS.low)), mid: r2(decision(PKO_SCENARIOS.mid)), high: r2(decision(PKO_SCENARIOS.high)) },
    chipsPerDollar: r2(chipsPerDollar(PKO_SCENARIOS.mid)),
    covers,
    assumptions: [
      'Bounties fund 50 % of the buy-in; a collected bounty pays 50 % in cash now and adds 50 % to Hero’s own bounty.',
      'The part added to Hero’s bounty is worth 25 % / 50 % / 75 % of cash (low / mid / high).',
      'The target’s current bounty is 1× / 1.5× / 3× the starting bounty (low / mid / high).',
      'Early stage only: 1 $ of prize pool is worth starting-stack ÷ prize-pool-per-player chips (chip EV ≈ linear in $).',
      ...(covers ? [] : ['Hero does not cover this opponent: Hero cannot collect the bounty in this hand (value 0).']),
    ],
    unknowns: ['current bounty of each player', 'players remaining / field size', 'prize pool and payouts', 'distance to the money'],
  };
}

/**
 * Required equity for Hero to call an all-in from ONE covered opponent, chip EV vs with the bounty band.
 * `callBB` = chips Hero adds; `potBB` = everything Hero can win before the bounty (incl. Hero's call).
 */
export function pkoCallThreshold(spot: PkoSpot, callBB: number, potBB: number) {
  const chipEV = callBB / potBB;
  const b = bountyDecisionValue(spot);
  if (b.status === 'unsupported') return { chipEV, pko: null, reason: b.reason };
  const t = (x: number) => callBB / (potBB + x);
  return { chipEV, pko: { low: t(b.decisionValueBB.low), mid: t(b.decisionValueBB.mid), high: t(b.decisionValueBB.high) }, bounty: b };
}

/** Buy-in parsed from a tournament name such as "Speed Racer Bounty $5.40" (null if absent or ambiguous). */
export function buyInFromTournamentName(name: string): number | null {
  const m = [...name.matchAll(/\$\s?(\d+(?:[.,]\d{1,2})?)/g)];
  if (m.length !== 1) return null;
  const x = Number(m[0]![1]!.replace(',', '.'));
  return x > 0 ? x : null;
}
