import { decisionMath, type DecisionMathResult, type HandState, type PlayerAction } from '@pdl/core';
import { env } from './env';

/**
 * Decision Maths in Full Hand feedback — behind DQE_DECISION_MATHS (default OFF).
 * Exact arithmetic about the decision (pot odds, required equity / all-in threshold, SPR, risk/reward, and
 * conditional references where they apply). Postflop decisions only (Phase 4B Gate 1 scope). Pure function of
 * the state before Hero acted: no database access, never stored, never graded or rated, never throws into the
 * response. Simulator hands are chip EV.
 */
export const decisionMathsEnabled = () => env.DQE_DECISION_MATHS === 'on';

export function decisionMathsForState(state: HandState, heroId: string, action: PlayerAction): DecisionMathResult | null {
  if (!decisionMathsEnabled() || state.street === 'preflop') return null;
  try {
    return decisionMath(state, heroId, action, { economics: 'chipEV' });
  } catch {
    return null;
  }
}
