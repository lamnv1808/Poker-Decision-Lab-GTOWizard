import { applyAction, computePots, legalActions, totalPot, type HandState, type PlayerAction } from '../engine/engine';
import type { DqeDecision, Economics, PreflopNode, PriorAction } from './types';

/**
 * DQE input from a live engine state (simulator / training), immediately before Hero acts. Uses only the
 * visible state: prior actions this street, stacks, pot, Hero's hand class. Same node and "shove"
 * definitions as the real-hand adapter (a raise is a shove when all-in or when it covers every player
 * still able to answer it).
 */
export function dqeDecisionFromState(
  s: HandState,
  heroId: string,
  o: { positions: Record<string, string>; chosen: PlayerAction; heroClass: string | null; economics?: Economics; format?: DqeDecision['format']; scenarioId: string },
): DqeDecision {
  const bb = s.config.bigBlind;
  const total = (id: string) => {
    const p = s.players.find((x) => x.id === id)!;
    return p.stack + p.streetCommitted;
  };
  const pos = (id: string) => o.positions[id] ?? id;
  const acts = s.history.filter((h) => h.street === s.street && ['fold', 'check', 'call', 'bet', 'raise'].includes(h.type));
  const history: PriorAction[] = s.street === 'preflop'
    ? acts.map((h) => ({ pos: pos(h.playerId), action: h.type === 'fold' ? 'fold' : h.type === 'check' ? 'check' : h.type === 'call' ? 'call' : h.allIn ? 'shove' : 'raise', toBB: h.type === 'raise' || h.type === 'bet' ? Math.round((h.amount / bb) * 100) / 100 : null }))
    : [];
  let node: PreflopNode | 'postflop' = 'postflop';
  if (s.street === 'preflop') {
    const act = history.filter((h) => h.action !== 'fold');
    if (act.length === 0) node = 'unopened';
    else if (act.every((h) => h.action === 'call')) node = 'limped';
    else if (act.length === 1 && act[0]!.action === 'shove') node = 'facingShove';
    else if (act.some((h) => h.action === 'shove')) node = 'facingShoveMultiway';
    else {
      const raises = act.filter((h) => h.action === 'raise').length;
      node = raises === 1 ? 'facingOpen' : raises === 2 ? 'facing3bet' : 'facing4betPlus';
    }
  }
  const heroTotal = total(heroId);
  const opps = s.players.filter((p) => p.id !== heroId && !p.folded);
  let eff = Math.min(heroTotal, Math.max(0, ...opps.map((p) => p.stack + p.streetCommitted)));
  if (node === 'facingShove') eff = Math.min(heroTotal, total(acts.find((h) => h.type !== 'fold')!.playerId));
  const legal = legalActions(s);
  const pot = totalPot(s);
  let requiredEquity: number | null = null;
  if (legal && legal.toCall > 0 && node !== 'unopened' && node !== 'limped') {
    const after = applyAction(s, { type: 'call' });
    const winnable = computePots(after).filter((p) => p.eligible.includes(heroId)).reduce((a, p) => a + p.amount, 0);
    requiredEquity = Math.round((legal.callAmount / winnable) * 10000) / 10000;
  }
  const c = o.chosen;
  const shove = (c.type === 'raise' || c.type === 'bet') && (c.amount ?? 0) >= heroTotal * 0.9;
  const chosen = c.type === 'call' && node === 'unopened' ? 'limp' : shove ? 'shove' : c.type;
  return {
    scenarioId: o.scenarioId,
    format: o.format ?? 'MTT',
    economics: o.economics ?? 'chipEV',
    tableSize: s.players.length,
    heroPos: pos(heroId),
    villainPositions: opps.map((p) => pos(p.id)),
    effStackBB: Math.round((eff / bb) * 100) / 100,
    deadBB: Math.round((s.deadAntes / bb) * 100) / 100,
    street: s.street as DqeDecision['street'],
    board: s.board.length ? s.board.map(String) : null,
    node,
    history,
    legalActions: legal ? (['fold', legal.canCheck ? 'check' : 'call', legal.canRaise || legal.canBet ? 'raise' : null, 'shove'].filter(Boolean) as string[]) : [],
    chosenAction: chosen,
    heroClass: o.heroClass,
    potBB: Math.round((pot / bb) * 100) / 100,
    toCallBB: legal ? Math.round((legal.toCall / bb) * 100) / 100 : null,
    requiredEquity,
    heuristic: null,
  };
}
