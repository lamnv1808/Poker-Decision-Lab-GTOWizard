/**
 * Villain response engine — HEURISTIC opponent models (not GTO).
 *
 * Each archetype is a small set of parameters that turns hand strength and the price of a call
 * into probabilities for fold / passive (check-call) / aggressive (bet-raise). Because the policy is
 * a probability for every combo, the range a Villain "represents" after its actions is the exact
 * Bayesian range under this model; Hero feedback uses that range and says so.
 */
export const ARCHETYPES = ['nit', 'tag', 'lag', 'station', 'maniac'] as const;
export type Archetype = (typeof ARCHETYPES)[number];

export interface ArchetypeParams {
  /** Preflop: share of hands played unopened, and raised unopened. */
  vpip: number;
  pfr: number;
  /** Postflop: probability of betting a strong hand, and of bluffing a weak one. */
  aggression: number;
  bluff: number;
  /** Extra strength required to continue vs a bet (negative = calls too wide). */
  callMargin: number;
  /** Postflop bet size as a fraction of the pot. */
  betFrac: number;
  /**
   * sim-v1.1: extra strength demanded when facing a bet, because a bettor's range is stronger than
   * a random hand (the strength measure ranks against random hands). 0 = ignores the bet.
   */
  betRespect: number;
}

export const ARCHETYPE_PARAMS: Record<Archetype, ArchetypeParams> = {
  nit: { vpip: 0.12, pfr: 0.1, aggression: 0.35, bluff: 0.03, callMargin: 0.15, betFrac: 0.5, betRespect: 0.3 },
  tag: { vpip: 0.22, pfr: 0.18, aggression: 0.6, bluff: 0.1, callMargin: 0.07, betFrac: 0.66, betRespect: 0.25 },
  lag: { vpip: 0.33, pfr: 0.27, aggression: 0.7, bluff: 0.2, callMargin: 0.03, betFrac: 0.75, betRespect: 0.18 },
  station: { vpip: 0.5, pfr: 0.08, aggression: 0.25, bluff: 0.03, callMargin: -0.12, betFrac: 0.4, betRespect: 0.05 },
  maniac: { vpip: 0.6, pfr: 0.5, aggression: 0.85, bluff: 0.35, callMargin: 0, betFrac: 1, betRespect: 0.1 },
};

export const ARCHETYPE_LABELS: Record<Archetype, { en: string; vi: string }> = {
  nit: { en: 'Nit (very tight, passive)', vi: 'Nit (rất chặt, thụ động)' },
  tag: { en: 'TAG regular (tight-aggressive)', vi: 'TAG (chặt - hung hăng)' },
  lag: { en: 'LAG (loose-aggressive)', vi: 'LAG (rộng - hung hăng)' },
  station: { en: 'Calling station', vi: 'Calling station (hay theo)' },
  maniac: { en: 'Maniac (hyper-aggressive)', vi: 'Maniac (cực kỳ hung hăng)' },
};

export interface PolicyCtx {
  street: 'preflop' | 'flop' | 'turn' | 'river';
  /** Amount to call (0 = no bet faced). */
  toCall: number;
  /** Voluntary raises so far on this street (preflop: opens count as raises). */
  raises: number;
  /** Required equity to call, from the winnable pot (0 when nothing to call). */
  requiredEq: number;
  /** Opponents still in the hand. */
  nOpp: number;
  canCheck: boolean;
  canRaise: boolean;
}

export interface ActionProbs {
  fold: number;
  passive: number;
  aggressive: number;
}

const below = (edge: number, x: number, w = 0.02) => 1 / (1 + Math.exp((x - edge) / w));
const above = (edge: number, x: number, w = 0.04) => 1 / (1 + Math.exp((edge - x) / w));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * @param x preflop: top-share of the combo (0 = best); postflop: strength in [0,1] (1 = best).
 */
export function policy(arch: Archetype, ctx: PolicyCtx, x: number, modelVersion = 'sim-v1.1'): ActionProbs {
  const p = ARCHETYPE_PARAMS[arch];
  let fold: number;
  let passive: number;
  let aggressive: number;
  if (ctx.street === 'preflop') {
    if (ctx.raises === 0) {
      const play = below(p.vpip, x);
      aggressive = below(p.pfr, x);
      passive = Math.max(0, play - aggressive);
      fold = 1 - play;
    } else {
      // a cheap price widens the continuing range
      const price = clamp(0.3 / Math.max(0.08, ctx.requiredEq), 0.6, 2.5);
      const cont = clamp(p.vpip * (ctx.raises === 1 ? 0.55 : ctx.raises === 2 ? 0.3 : 0.2) * price * (1 - p.callMargin), 0.01, 0.9);
      const reraise = p.pfr * (ctx.raises === 1 ? 0.3 : ctx.raises === 2 ? 0.12 : 0.06);
      aggressive = below(reraise, x, 0.01);
      passive = Math.max(0, below(cont, x) - aggressive);
      fold = Math.max(0, 1 - aggressive - passive);
    }
  } else {
    const s = Math.pow(x, Math.max(1, ctx.nOpp));
    if (ctx.toCall === 0) {
      aggressive = clamp(p.aggression * above(0.7, s) + p.bluff * below(0.3, s, 0.04), 0, 1);
      passive = 1 - aggressive;
      fold = 0;
    } else {
      const respect = modelVersion === 'sim-v1' ? 0 : p.betRespect;
      const cont = above(ctx.requiredEq + p.callMargin + respect, s);
      const raise = clamp(p.aggression * 0.5 * above(0.9, s, 0.02) + p.bluff * 0.25 * below(0.15, s, 0.03), 0, 1);
      aggressive = raise;
      passive = (1 - raise) * cont;
      fold = (1 - raise) * (1 - cont);
    }
  }
  if (!ctx.canRaise) {
    passive += aggressive;
    aggressive = 0;
  }
  if (ctx.canCheck) {
    passive += fold;
    fold = 0;
  }
  const t = fold + passive + aggressive;
  return { fold: fold / t, passive: passive / t, aggressive: aggressive / t };
}
