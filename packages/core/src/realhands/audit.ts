import { type Card, parseCards } from '../cards/cards';
import { type HandState, applyAction, computePots, legalActions, totalPot } from '../engine';
import { type ReconstructedHand, HandParseError, ggParser, reconstructHand } from '../hh/gg';

/**
 * Independent audit of Real Hand Source v2 records.
 * Every hand is rebuilt on this project's rules engine (which reconciles pots against the
 * history's own totals). Each supplied decision snapshot and pot-odds quiz is compared with the
 * engine's state immediately before the same Hero action. Disagreements quarantine the record with
 * explicit reasons — nothing is silently repaired or invented.
 */

export interface V2Player {
  id: string;
  initial_bb: number;
  remaining_bb: number;
  invested_street_bb: number;
  active: boolean;
}
export interface V2Question {
  hero_cards: string[];
  board: string[];
  button_seat: number;
  pot_at_decision_bb: number;
  call_bb: number;
  players: V2Player[];
  history: unknown[];
}
export interface V2Decision {
  id: string;
  family_id: string;
  street: 'preflop' | 'flop' | 'turn' | 'river';
  tags: string[];
  solver_verified: boolean;
  grading_status: string;
  question: V2Question;
  review_only: { actual_action: string; actual_increment_bb: number; is_all_in: boolean };
  answer: unknown;
}
export interface V2Quiz {
  id: string;
  family_id: string;
  question: V2Question;
  answer: { required_equity: number; formula: string; scope: string };
}
export interface V2HandRecord {
  hand_id: string;
  archive: string;
  member: string;
  raw: string;
}

export type HandIssue =
  | 'parse_failed'
  | 'unsupported_format'
  | 'duplicate_cards'
  | 'board_progression'
  | 'button_not_seated'
  | 'blind_positions'
  | 'raise_to_mismatch'
  | 'uncalled_return_mismatch'
  | 'pot_total_mismatch'
  | 'collected_mismatch'
  | 'chip_conservation'
  | 'hero_not_dealt';

export interface HandAudit {
  handId: string;
  ok: boolean;
  issues: { code: HandIssue; detail: string }[];
  /** Informational notes that do not invalidate the hand. */
  notes: string[];
  rec?: ReconstructedHand;
  tournamentId: string | null;
  tournamentName: string | null;
  format: TournamentFormat;
  playedAt: string | null;
}

export type TournamentFormat = 'PKO' | 'Hyper' | 'Turbo' | 'Deepstack' | 'Satellite' | 'Freeroll' | 'MTT';

export function tournamentFormat(name: string | null): TournamentFormat {
  const n = (name ?? '').toLowerCase();
  if (/bounty|pko|knockout/.test(n)) return 'PKO';
  if (/hyper/.test(n)) return 'Hyper';
  if (/satellite|step|qualifier/.test(n)) return 'Satellite';
  if (/freeroll/.test(n)) return 'Freeroll';
  if (/turbo|speed racer|super six/.test(n)) return 'Turbo';
  if (/deep/.test(n)) return 'Deepstack';
  return 'MTT';
}

const num = (s: string) => Number(s.replace(/,/g, ''));

/** Text-level checks the parser does not enforce, plus engine reconstruction and reconciliation. */
export function auditHand(raw: string): HandAudit {
  const issues: HandAudit['issues'] = [];
  const notes: string[] = [];
  const handId = /Poker Hand #([A-Z]*\d+)/.exec(raw)?.[1] ?? 'unknown';
  const base = { handId, tournamentId: /Tournament #(\d+)/.exec(raw)?.[1] ?? null, tournamentName: null as string | null, format: 'MTT' as TournamentFormat, playedAt: null as string | null };
  let parsed;
  try {
    parsed = ggParser.parse(raw.trim());
  } catch (e) {
    const msg = (e as Error).message;
    return { ...base, ok: false, issues: [{ code: /not supported|Unrecognized/.test(msg) ? 'unsupported_format' : 'parse_failed', detail: msg }], notes };
  }
  base.tournamentName = parsed.tournamentName;
  base.format = tournamentFormat(parsed.tournamentName);
  base.playedAt = parsed.playedAt;
  if (!parsed.heroName || !parsed.heroCards) issues.push({ code: 'hero_not_dealt', detail: 'No "Dealt to Hero" line' });

  // Board progression: each street line must repeat the previous board exactly, then add 3/1/1 cards.
  const lines = raw.split(/\r?\n/);
  let board: string[] = [];
  for (const l of lines) {
    const m = /^\*\*\* (FLOP|TURN|RIVER) \*\*\*(.*)$/.exec(l.trim());
    if (!m) continue;
    const groups = [...m[2]!.matchAll(/\[([^\]]+)\]/g)].map((g) => g[1]!.trim().split(/\s+/));
    const expectedPrev = m[1] === 'FLOP' ? 0 : m[1] === 'TURN' ? 3 : 4;
    const adds = m[1] === 'FLOP' ? 3 : 1;
    const prev = groups.length > 1 ? groups[0]! : [];
    const added = groups[groups.length - 1] ?? [];
    if (board.length !== expectedPrev || prev.join(' ') !== board.join(' ') || added.length !== adds)
      issues.push({ code: 'board_progression', detail: `${m[1]} line ${l.trim()} does not extend board [${board.join(' ')}]` });
    board = [...board, ...added];
  }
  // Card uniqueness across Hero's cards, the board and every other player's shown cards
  const known = [...(parsed.heroCards ?? []), ...parsed.board, ...parsed.shown.filter((x) => x.player !== parsed.heroName).flatMap((x) => x.cards)];
  if (new Set(known).size !== known.length) issues.push({ code: 'duplicate_cards', detail: `a card appears twice among ${known.join(' ')}` });
  const heroShow = parsed.shown.find((x) => x.player === parsed.heroName);
  // Hero may voluntarily show one card; it must be one of the dealt cards.
  if (heroShow && heroShow.cards.some((c) => !(parsed.heroCards ?? []).includes(c))) issues.push({ code: 'duplicate_cards', detail: 'Hero shows a card that was not dealt to Hero' });

  // Button
  if (parsed.buttonSeat !== null && !parsed.seats.some((s) => s.seat === parsed.buttonSeat)) notes.push('button seat is empty (dead button)');

  // Raise-to vs increment: "raises X to Y" ⇒ Y − X must equal the bet faced before the raise
  for (const l of lines) {
    const m = /^(.+?): raises ([\d,]+) to ([\d,]+)/.exec(l.trim());
    if (m && num(m[3]!) - num(m[2]!) < 0) issues.push({ code: 'raise_to_mismatch', detail: l.trim() });
  }

  let rec: ReconstructedHand;
  try {
    rec = reconstructHand(parsed);
  } catch (e) {
    const err = e as HandParseError;
    const code: HandIssue = /pot/.test(err.message) ? 'pot_total_mismatch' : /blind/i.test(err.message) ? 'blind_positions' : 'parse_failed';
    return { ...base, ok: false, issues: [...issues, { code, detail: err.message }], notes };
  }
  // raise increments versus engine's bet before each raise
  rec.parsed.actions.forEach((a, i) => {
    if (a.type !== 'raise') return;
    const line = lines.find((l) => l.trim().startsWith(`${a.player}: raises`) && num(/to ([\d,]+)/.exec(l)?.[1] ?? '0') === a.amount);
    const inc = line ? num(/raises ([\d,]+) to/.exec(line)![1]!) : null;
    const before = rec.statesBefore[i]!;
    if (inc !== null && a.amount - inc !== before.currentBet) issues.push({ code: 'raise_to_mismatch', detail: `${line?.trim()} but bet faced was ${before.currentBet}` });
  });
  // Uncalled bet returns: history vs engine
  const histReturns = rec.parsed.uncalled.map((u) => `${u.player}:${u.amount}`).sort();
  const engReturns = rec.final.history.filter((h) => h.type === 'returnUncalled').map((h) => `${h.playerId}:${h.amount}`).sort();
  if (histReturns.join() !== engReturns.join()) issues.push({ code: 'uncalled_return_mismatch', detail: `history [${histReturns.join(', ')}] vs engine [${engReturns.join(', ')}]` });
  // Chip conservation
  const start = rec.table.players.reduce((s, p) => s + p.stack, 0);
  const st = rec.final;
  const onTable = st.players.reduce((s, p) => s + p.stack, 0) + (st.complete ? 0 : totalPot(st));
  if (st.complete && st.result && Object.keys(st.result.awards).length > 0 && onTable !== start) issues.push({ code: 'chip_conservation', detail: `${onTable} ≠ ${start}` });
  // Collected amounts vs engine awards (only when the engine could resolve every pot)
  if (st.complete && st.result && Object.keys(st.result.awards).length > 0) {
    const coll: Record<string, number> = {};
    for (const c of rec.parsed.collected) coll[c.player] = (coll[c.player] ?? 0) + c.amount;
    const eng = st.result.awards;
    const keys = [...new Set([...Object.keys(coll), ...Object.keys(eng)])];
    const diffs = keys.map((k) => (coll[k] ?? 0) - (eng[k] ?? 0)).filter((d) => d !== 0);
    const sumEq = Object.values(coll).reduce((a, b) => a + b, 0) === Object.values(eng).reduce((a, b) => a + b, 0);
    // A split pot's odd chip may be given to a different winner (site tie-break rule): note, not error.
    if (diffs.length && sumEq && diffs.every((d) => Math.abs(d) <= st.result!.pots.length)) notes.push('odd-chip allocation in a split pot differs from the engine');
    else for (const k of keys) if ((coll[k] ?? 0) !== (eng[k] ?? 0)) issues.push({ code: 'collected_mismatch', detail: `${k}: history ${coll[k] ?? 0} vs engine ${eng[k] ?? 0}` });
  } else if (st.result && !Object.keys(st.result.awards).length) notes.push('showdown cards incomplete: per-player awards not reconciled (pot total was)');
  if (rec.final.history.some((h) => h.type === 'fold' && h.allIn)) notes.push('history records a fold by an all-in player (treated as a forfeit)');
  return { ...base, ok: issues.length === 0, issues, notes, rec };
}

export interface EngineSnapshot {
  state: HandState;
  heroId: string;
  actionIndex: number;
  potBB: number;
  toCallBB: number;
  callAmountBB: number;
  /** All Hero-eligible pots right now (main/side), in BB. */
  heroEligiblePotBB: number;
  activePlayers: number;
  othersAllIn: number;
  canRaise: boolean;
  legal: ReturnType<typeof legalActions>;
}

/** Engine state immediately before Hero's n-th voluntary action (1-based, V2 numbering). */
export function snapshotForHeroAction(rec: ReconstructedHand, n: number): EngineSnapshot | null {
  const hero = rec.parsed.heroName;
  if (!hero) return null;
  let count = 0;
  for (let i = 0; i < rec.parsed.actions.length; i++) {
    if (rec.parsed.actions[i]!.player !== hero) continue;
    count++;
    if (count !== n) continue;
    const state = rec.statesBefore[i]!;
    const bb = rec.parsed.bigBlind;
    const legal = legalActions(state);
    const pots = computePots(state);
    const live = state.players.filter((p) => !p.folded);
    return {
      state,
      heroId: hero,
      actionIndex: i,
      potBB: totalPot(state) / bb,
      toCallBB: (legal?.toCall ?? 0) / bb,
      callAmountBB: (legal?.callAmount ?? 0) / bb,
      heroEligiblePotBB: pots.filter((p) => p.eligible.includes(hero)).reduce((s, p) => s + p.amount, 0) / bb,
      activePlayers: live.length,
      othersAllIn: live.filter((p) => p.id !== hero && p.allIn).length,
      canRaise: !!(legal && (legal.canRaise || legal.canBet)),
      legal,
    };
  }
  return null;
}

export type DecisionIssue =
  | 'hand_invalid'
  | 'decision_not_found'
  | 'hero_cards_mismatch'
  | 'board_mismatch'
  | 'pot_mismatch'
  | 'call_mismatch'
  | 'stack_mismatch'
  | 'street_mismatch'
  | 'observed_action_mismatch';

const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

/** Compare a supplied V2 decision snapshot with the engine. */
export function auditDecision(d: V2Decision, rec: ReconstructedHand): { ok: boolean; issues: { code: DecisionIssue; detail: string }[]; snap: EngineSnapshot | null } {
  const issues: { code: DecisionIssue; detail: string }[] = [];
  const n = Number(d.id.split('-').pop());
  const snap = snapshotForHeroAction(rec, n);
  if (!snap) return { ok: false, issues: [{ code: 'decision_not_found', detail: `Hero action #${n} not found` }], snap };
  const q = d.question;
  const bb = rec.parsed.bigBlind;
  if (q.hero_cards.join() !== (rec.parsed.heroCards ?? []).join()) issues.push({ code: 'hero_cards_mismatch', detail: `${q.hero_cards.join(' ')} vs ${(rec.parsed.heroCards ?? []).join(' ')}` });
  if (q.board.join(' ') !== snap.state.board.join(' ')) issues.push({ code: 'board_mismatch', detail: `[${q.board.join(' ')}] vs engine [${snap.state.board.join(' ')}]` });
  if (d.street !== snap.state.street) issues.push({ code: 'street_mismatch', detail: `${d.street} vs ${snap.state.street}` });
  if (!close(q.pot_at_decision_bb, snap.potBB)) issues.push({ code: 'pot_mismatch', detail: `${q.pot_at_decision_bb.toFixed(4)} vs engine ${snap.potBB.toFixed(4)} BB` });
  if (!close(q.call_bb, snap.callAmountBB)) issues.push({ code: 'call_mismatch', detail: `${q.call_bb.toFixed(4)} vs engine ${snap.callAmountBB.toFixed(4)} BB` });
  const heroQ = q.players.find((p) => p.id === 'Hero');
  const heroE = snap.state.players.find((p) => p.id === snap.heroId)!;
  if (heroQ && !close(heroQ.remaining_bb, heroE.stack / bb)) issues.push({ code: 'stack_mismatch', detail: `Hero remaining ${heroQ.remaining_bb.toFixed(4)} vs engine ${(heroE.stack / bb).toFixed(4)} BB` });
  const a = rec.parsed.actions[snap.actionIndex]!;
  const map: Record<string, string> = { calls: 'call', bets: 'bet', raises: 'raise', checks: 'check', folds: 'fold' };
  if (map[d.review_only.actual_action] !== a.type) issues.push({ code: 'observed_action_mismatch', detail: `${d.review_only.actual_action} vs ${a.type}` });
  return { ok: issues.length === 0, issues, snap };
}

export type QuizIssue = 'not_heads_up' | 'third_player_all_in' | 'no_call' | 'winnable_pot_differs' | 'answer_mismatch' | 'decision_invalid';

/**
 * Pot-odds benchmark: required equity = call / (winnable pot after calling).
 * When Hero's call is all-in for less, chips Hero cannot win are excluded (the supplied
 * formula uses the whole pot, which overstates the price in those spots).
 */
export function auditQuiz(q: V2Quiz, snap: EngineSnapshot): { ok: boolean; issues: { code: QuizIssue; detail: string }[]; requiredEquity: number | null; terminal: boolean } {
  const issues: { code: QuizIssue; detail: string }[] = [];
  if (snap.activePlayers !== 2) issues.push({ code: 'not_heads_up', detail: `${snap.activePlayers} players in the pot` });
  const thirdAllIn = snap.state.players.some((p) => p.id !== snap.heroId && p.allIn && p.folded);
  if (thirdAllIn) issues.push({ code: 'third_player_all_in', detail: 'a third player is all-in' });
  if (!(snap.callAmountBB > 0)) issues.push({ code: 'no_call', detail: 'nothing to call' });
  const legal = snap.legal!;
  let required: number | null = null;
  let terminal = snap.state.street === 'river';
  if (legal && legal.toCall > 0) {
    // Let the engine apply the call, then sum only the pots Hero is eligible to win.
    const after = applyAction(snap.state, { type: 'call' });
    const winnable = computePots(after)
      .filter((p) => p.eligible.includes(snap.heroId))
      .reduce((s, p) => s + p.amount, 0);
    required = legal.callAmount / winnable;
    const live = after.players.filter((p) => !p.folded);
    if (live.filter((p) => !p.allIn).length <= 1) terminal = true;
    const naive = q.answer.required_equity;
    if (Math.abs(required - naive) > 0.0005) issues.push({ code: 'winnable_pot_differs', detail: `supplied ${(100 * naive).toFixed(2)}% vs engine ${(100 * required).toFixed(2)}%` });
  }
  return { ok: issues.length === 0, issues, requiredEquity: required, terminal };
}

export function parseHeroCards(cards: string[]): Card[] {
  return parseCards(cards.join(''));
}
