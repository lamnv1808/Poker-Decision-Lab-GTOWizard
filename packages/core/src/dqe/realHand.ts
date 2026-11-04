import { auditPushFold } from '../gto/audit';
import type { ReconstructedHand } from '../hh/gg';
import { decisionContext } from '../realhands/context';
import type { EngineSnapshot } from '../realhands/audit';
import type { DqeDecision, PreflopNode, PriorAction } from './types';

/**
 * Build the DQE input for one historical decision from its reconstructed hand. Uses only what Hero could
 * see at that moment (state before the action, prior actions, Hero's cards). The observed action is the
 * one being evaluated; outcomes, later streets and villain cards are never read.
 *
 * A raise counts as a "shove" when it is all-in or covers the player who must answer it — the same rule
 * as the heads-up push/fold audit, so both see identical spots. For heads-up push/fold spots the
 * effective stack and dead money are taken from the audit itself (identical numbers by construction).
 */
export function dqeDecisionFromReal(rec: ReconstructedHand, snap: EngineSnapshot, format: string, scenarioId: string): DqeDecision {
  const ctx = decisionContext(rec, snap, format);
  const s = snap.state;
  const bb = rec.parsed.bigBlind;
  const heroId = snap.heroId;
  const hero = s.players.find((p) => p.id === heroId)!;
  const total = (id: string) => {
    const p = s.players.find((x) => x.id === id)!;
    return p.stack + p.streetCommitted;
  };
  const pos = (player: string) => rec.positions[player] ?? '?';
  const prior = rec.parsed.actions.slice(0, snap.actionIndex).filter((a) => a.street === s.street);
  const history: PriorAction[] = s.street === 'preflop'
    ? prior.map((a) => {
        const st = rec.statesBefore[rec.parsed.actions.indexOf(a)]!;
        const actor = st.players.find((p) => p.id === a.player)!;
        const others = st.players.filter((p) => p.id !== a.player && !p.folded);
        const covers = a.type === 'raise' && others.every((o) => a.amount >= o.stack + o.streetCommitted);
        const shove = (a.type === 'raise' || a.type === 'bet') && (a.allIn || covers || a.amount >= (actor.stack + actor.streetCommitted) * 0.9);
        return { pos: pos(a.player), action: a.type === 'fold' ? 'fold' : a.type === 'check' ? 'check' : a.type === 'call' ? 'call' : shove ? 'shove' : 'raise', toBB: a.type === 'raise' || a.type === 'bet' ? Math.round((a.amount / bb) * 100) / 100 : null };
      })
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
  // effective stack in the sense of each model
  const heroTotal = total(heroId);
  let eff = ctx.effStackBB;
  if (node === 'unopened') {
    const behind = s.players.filter((p) => p.id !== heroId && !p.folded).map((p) => p.stack + p.streetCommitted);
    eff = Math.round((Math.min(heroTotal, Math.max(0, ...behind)) / bb) * 100) / 100;
  } else if (node === 'facingShove') {
    const shover = prior.find((a) => a.type !== 'fold')!;
    eff = Math.round((Math.min(heroTotal, total(shover.player)) / bb) * 100) / 100;
  }
  let deadBB = Math.round((s.deadAntes / bb) * 100) / 100;
  const pf = s.street === 'preflop' ? auditPushFold(rec) : null;
  let pushFoldGrid: { stackBB: number; deadBB: number } | null = null;
  if (pf && pf.actionIndex === snap.actionIndex) {
    eff = pf.exactStackBB;
    deadBB = pf.exactDeadBB;
    pushFoldGrid = { stackBB: pf.stackBB, deadBB: pf.deadBB }; // chosen from the unrounded values
  }
  const a = rec.parsed.actions[snap.actionIndex]!;
  const heroShove = (a.type === 'raise' || a.type === 'bet') && (a.allIn || a.amount >= heroTotal * 0.9);
  const chosen = a.type === 'fold' ? 'fold' : a.type === 'check' ? 'check' : a.type === 'call' ? (node === 'unopened' ? 'limp' : 'call') : heroShove ? 'shove' : a.type;
  const legal = snap.legal;
  const legalActions = legal ? (['fold', legal.canCheck ? 'check' : 'call', legal.canRaise || legal.canBet ? 'raise' : null, 'shove'].filter(Boolean) as string[]) : [];
  return {
    scenarioId,
    format: /cash/i.test(format) ? 'cash' : 'MTT',
    economics: ctx.formatGroup === 'PKO' ? 'PKO' : 'chipEV',
    tableSize: rec.table.players.length,
    heroPos: ctx.position,
    villainPositions: s.players.filter((p) => p.id !== heroId && !p.folded).map((p) => pos(p.id)),
    effStackBB: eff,
    deadBB,
    street: s.street as DqeDecision['street'],
    board: s.board.length ? s.board.map(String) : null,
    node,
    history,
    legalActions,
    chosenAction: chosen === 'call' && node === 'unopened' ? 'limp' : chosen,
    heroClass: ctx.heroClass,
    potBB: Math.round(snap.potBB * 100) / 100,
    toCallBB: Math.round(snap.toCallBB * 100) / 100,
    requiredEquity: ctx.requiredEquity,
    heuristic: null,
    pushFoldGrid,
  };
  void hero;
}
