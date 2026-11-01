import { type Card, parseCards } from '../cards/cards';
import { type HandState, type PlayerAction, type TableConfig, applyAction, computePots, createHand, dealNextStreet, forfeitAllIn, legalActions, positionsFor, totalPot } from '../engine';

/**
 * GGPoker / Natural8-style tournament hand-history parser.
 * Architecture: detectFormat() picks a HandHistoryParser; parsers produce ParsedHand
 * (pure text extraction), then reconstructHand() replays it on the authoritative engine
 * to validate every action. Malformed hands are reported, never silently dropped.
 */

export type HHStreet = 'preflop' | 'flop' | 'turn' | 'river';

export interface ParsedAction {
  street: HHStreet;
  player: string;
  type: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  /** bet: amount; raise: raise-to total; call: amount added. */
  amount: number;
  allIn: boolean;
  line: number;
}

export interface ParsedHand {
  site: 'GGPoker';
  handId: string;
  tournamentId: string | null;
  tournamentName: string | null;
  playedAt: string | null;
  level: string | null;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  tableName: string | null;
  maxSeats: number | null;
  buttonSeat: number | null;
  seats: { seat: number; name: string; stack: number; bounty: number | null }[];
  heroName: string | null;
  heroCards: Card[] | null;
  posts: { player: string; kind: 'ante' | 'sb' | 'bb'; amount: number }[];
  actions: ParsedAction[];
  board: Card[];
  shown: { player: string; cards: Card[] }[];
  collected: { player: string; amount: number }[];
  uncalled: { player: string; amount: number }[];
  totalPot: number | null;
  /** Data the parser could not read; the hand is still kept with these notes. */
  warnings: string[];
  /** Fields that were inferred rather than read directly. */
  inferred: string[];
  raw: string;
}

export interface HandHistoryParser {
  format: string;
  detect(text: string): boolean;
  split(text: string): string[];
  parse(handText: string): ParsedHand;
}

const num = (s: string) => Number(s.replace(/[,$€£\s]/g, ''));
const AMOUNT = '([\\d,]+(?:\\.\\d+)?)';

export class HandParseError extends Error {
  constructor(
    message: string,
    public readonly handId: string | null,
    public readonly lineNo?: number,
  ) {
    super(message);
  }
}

export const ggParser: HandHistoryParser = {
  format: 'GGPoker',
  detect(text) {
    return /^\s*Poker Hand #[A-Z]*\d+: Tournament #/m.test(text);
  },
  split(text) {
    const normalized = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    const parts = normalized.split(/\n(?=Poker Hand #)/);
    return parts.map((p) => p.trim()).filter((p) => p.startsWith('Poker Hand #'));
  },
  parse(raw) {
    const lines = raw.split('\n');
    const header = lines[0] ?? '';
    if (/Flipout/i.test(header)) throw new HandParseError('Flipout hands (automatic all-in format) are not supported', /#([A-Z]*\d+)/.exec(header)?.[1] ?? null, 1);
    const hm = /^Poker Hand #([A-Z]*\d+): Tournament #(\d+),\s*(.*?)\s+Hold'em No Limit - (Level\s*\d+)\(([\d,]+)\/([\d,]+)(?:\(([\d,]+)\))?\) - (\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/.exec(header);
    if (!hm) throw new HandParseError('Unrecognized header (only GGPoker No-Limit Hold’em tournament hands are supported)', /#([A-Z]*\d+)/.exec(header)?.[1] ?? null, 1);
    const hand: ParsedHand = {
      site: 'GGPoker',
      handId: hm[1]!,
      tournamentId: hm[2]!,
      tournamentName: hm[3]!.replace(/,\s*$/, '') || null,
      level: hm[4]!.replace(/\s/g, ''),
      smallBlind: num(hm[5]!),
      bigBlind: num(hm[6]!),
      ante: hm[7] ? num(hm[7]) : 0,
      playedAt: hm[8]!.replace(/\//g, '-').replace(' ', 'T'),
      tableName: null,
      maxSeats: null,
      buttonSeat: null,
      seats: [],
      heroName: null,
      heroCards: null,
      posts: [],
      actions: [],
      board: [],
      shown: [],
      collected: [],
      uncalled: [],
      totalPot: null,
      warnings: [],
      inferred: [],
      raw,
    };
    let street: HHStreet | 'showdown' | 'summary' = 'preflop';
    let section: 'setup' | 'play' | 'showdown' | 'summary' = 'setup';
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!.trim();
      const ln = i + 1;
      if (!line) continue;
      let m: RegExpExecArray | null;
      if ((m = /^Table '([^']*)' (\d+)-max Seat #(\d+) is the button/.exec(line))) {
        hand.tableName = m[1]!;
        hand.maxSeats = Number(m[2]);
        hand.buttonSeat = Number(m[3]);
        continue;
      }
      if (section === 'setup' && (m = new RegExp(`^Seat (\\d+): (.+?) \\(${AMOUNT} in chips(?:, \\$?${AMOUNT} bounty)?\\)`).exec(line))) {
        hand.seats.push({ seat: Number(m[1]), name: m[2]!, stack: num(m[3]!), bounty: m[4] ? num(m[4]) : null });
        continue;
      }
      if ((m = /^\*\*\* (HOLE CARDS|FLOP|TURN|RIVER|SHOWDOWN|SUMMARY|FIRST FLOP|SECOND FLOP|FIRST TURN|SECOND TURN|FIRST RIVER|SECOND RIVER) \*\*\*(.*)$/.exec(line))) {
        const tag = m[1]!;
        if (tag.startsWith('FIRST') || tag.startsWith('SECOND')) throw new HandParseError('Run-it-twice hands are not supported yet', hand.handId, ln);
        if (tag === 'HOLE CARDS') {
          section = 'play';
          street = 'preflop';
        } else if (tag === 'SHOWDOWN') {
          section = 'showdown';
          street = 'showdown';
        } else if (tag === 'SUMMARY') {
          section = 'summary';
          street = 'summary';
        } else {
          street = tag.toLowerCase() as HHStreet;
          const cards = [...m[2]!.matchAll(/\[([^\]]+)\]/g)].map((x) => x[1]!);
          const last = cards[cards.length - 1];
          if (!last) throw new HandParseError(`Missing ${tag} cards`, hand.handId, ln);
          const newCards = parseCards(last.replace(/\s+/g, ''));
          hand.board.push(...newCards);
        }
        continue;
      }
      if ((m = new RegExp(`^(.+?): posts the ante ${AMOUNT}`).exec(line))) {
        hand.posts.push({ player: m[1]!, kind: 'ante', amount: num(m[2]!) });
        continue;
      }
      if ((m = new RegExp(`^(.+?): posts small blind ${AMOUNT}`).exec(line))) {
        hand.posts.push({ player: m[1]!, kind: 'sb', amount: num(m[2]!) });
        continue;
      }
      if ((m = new RegExp(`^(.+?): posts big blind ${AMOUNT}`).exec(line))) {
        hand.posts.push({ player: m[1]!, kind: 'bb', amount: num(m[2]!) });
        continue;
      }
      if ((m = /^Dealt to (.+?)\s*\[([^\]]+)\]/.exec(line))) {
        hand.heroName = m[1]!;
        hand.heroCards = parseCards(m[2]!.replace(/\s+/g, ''));
        continue;
      }
      if (/^Dealt to /.test(line)) continue;
      if (section === 'play') {
        const allIn = /and is all-in\s*$/.test(line);
        const body = line.replace(/\s+and is all-in\s*$/, '');
        const st = street as HHStreet;
        if ((m = /^(.+?): folds/.exec(body))) hand.actions.push({ street: st, player: m[1]!, type: 'fold', amount: 0, allIn, line: ln });
        else if ((m = /^(.+?): checks/.exec(body))) hand.actions.push({ street: st, player: m[1]!, type: 'check', amount: 0, allIn, line: ln });
        else if ((m = new RegExp(`^(.+?): calls ${AMOUNT}`).exec(body))) hand.actions.push({ street: st, player: m[1]!, type: 'call', amount: num(m[2]!), allIn, line: ln });
        else if ((m = new RegExp(`^(.+?): bets ${AMOUNT}`).exec(body))) hand.actions.push({ street: st, player: m[1]!, type: 'bet', amount: num(m[2]!), allIn, line: ln });
        else if ((m = new RegExp(`^(.+?): raises ${AMOUNT} to ${AMOUNT}`).exec(body))) hand.actions.push({ street: st, player: m[1]!, type: 'raise', amount: num(m[3]!), allIn, line: ln });
        else if ((m = new RegExp(`^Uncalled bet \\(${AMOUNT}\\) returned to (.+)$`).exec(body))) hand.uncalled.push({ player: m[2]!, amount: num(m[1]!) });
        else if ((m = /^(.+?): shows \[([^\]]+)\]/.exec(body))) hand.shown.push({ player: m[1]!, cards: parseCards(m[2]!.replace(/\s+/g, '')) });
        else if ((m = new RegExp(`^(.+?) collected ${AMOUNT} from`).exec(body))) hand.collected.push({ player: m[1]!, amount: num(m[2]!) });
        else if (/^(.+?): (doesn't show|mucks|sits out|is sitting out|has timed out|is disconnected|is connected|said)/.test(body)) continue;
        else hand.warnings.push(`Line ${ln} not understood: "${line}"`);
        continue;
      }
      if (section === 'showdown') {
        if ((m = /^(.+?): shows \[([^\]]+)\]/.exec(line))) hand.shown.push({ player: m[1]!, cards: parseCards(m[2]!.replace(/\s+/g, '')) });
        else if ((m = new RegExp(`^(.+?) collected ${AMOUNT} from`).exec(line))) hand.collected.push({ player: m[1]!, amount: num(m[2]!) });
        continue;
      }
      if (section === 'summary') {
        if ((m = new RegExp(`^Total pot ${AMOUNT}`).exec(line))) hand.totalPot = num(m[1]!);
        continue;
      }
    }
    if (!hand.heroName) hand.warnings.push('Hero hole cards not found');
    if (hand.buttonSeat === null) hand.warnings.push('Button seat not found');
    if (hand.seats.length < 2) throw new HandParseError('Fewer than two seats found', hand.handId);
    return hand;
  },
};

export const PARSERS: HandHistoryParser[] = [ggParser];

export function detectFormat(text: string): HandHistoryParser | null {
  return PARSERS.find((p) => p.detect(text)) ?? null;
}

export interface ReconstructedHand {
  parsed: ParsedHand;
  table: TableConfig;
  /** Player name → position label. */
  positions: Record<string, string>;
  heroPosition: string | null;
  /** Engine state before each recorded action (index aligned with parsed.actions). */
  statesBefore: HandState[];
  final: HandState;
  allInSeen: boolean;
  /** Final pot (incl. antes) computed by the engine. */
  potComputed: number;
}

/**
 * Replay a parsed hand on the engine. Throws HandParseError if any action is illegal
 * or the reconstructed pot disagrees with the history's own total.
 */
export function reconstructHand(parsed: ParsedHand): ReconstructedHand {
  const sbPost = parsed.posts.find((p) => p.kind === 'sb');
  const bbPost = parsed.posts.find((p) => p.kind === 'bb');
  if (!bbPost) throw new HandParseError('No big blind posted', parsed.handId);
  const seatsSorted = [...parsed.seats].sort((a, b) => a.seat - b.seat);
  const dealtIn = seatsSorted.filter((s) => s.stack > 0);
  const bbIdx = dealtIn.findIndex((s) => s.name === bbPost.player);
  if (bbIdx < 0) throw new HandParseError('Big blind player not seated', parsed.handId);
  const n = dealtIn.length;
  // Engine order starts at SB; with no SB posted (dead small blind) we cannot reconstruct faithfully.
  if (!sbPost) throw new HandParseError('Hands without a posted small blind are not supported yet', parsed.handId);
  const sbIdx = dealtIn.findIndex((s) => s.name === sbPost.player);
  if (sbIdx < 0 || (n > 2 && (sbIdx + 1) % n !== bbIdx) || (n === 2 && sbIdx === bbIdx)) throw new HandParseError('Blind positions are inconsistent', parsed.handId);
  const ordered = Array.from({ length: n }, (_, k) => dealtIn[(sbIdx + k) % n]!);
  const labels = positionsFor(n);
  const positions: Record<string, string> = {};
  ordered.forEach((s, k) => (positions[s.name] = labels[k]!));
  const shownBy = new Map(parsed.shown.map((s) => [s.player, s.cards]));
  if (parsed.heroName && parsed.heroCards) shownBy.set(parsed.heroName, parsed.heroCards);
  const antePosts = parsed.posts.filter((p) => p.kind === 'ante');
  const anteMode = antePosts.length === 0 ? 'none' : antePosts.length === 1 && antePosts[0]!.player === bbPost.player && n > 2 ? 'bigBlind' : 'each';
  const ante = antePosts.length ? Math.max(...antePosts.map((a) => a.amount)) : 0;
  const table: TableConfig = {
    smallBlind: parsed.smallBlind,
    bigBlind: parsed.bigBlind,
    ante,
    anteMode,
    players: ordered.map((s) => ({ id: s.name, stack: s.stack, cards: shownBy.get(s.name) })),
  };
  let state: HandState;
  try {
    state = createHand(table);
  } catch (e) {
    throw new HandParseError(`Invalid table: ${(e as Error).message}`, parsed.handId);
  }
  const statesBefore: HandState[] = [];
  const boardBy: Record<Exclude<HHStreet, 'preflop'>, Card[]> = { flop: parsed.board.slice(0, 3), turn: parsed.board.slice(3, 4), river: parsed.board.slice(4, 5) };
  const dealTo = (target: HHStreet) => {
    const order: HHStreet[] = ['preflop', 'flop', 'turn', 'river'];
    while (order.indexOf(state.street) < order.indexOf(target)) {
      if (!state.awaitingBoard) throw new HandParseError(`Betting on ${state.street} did not close before ${target}`, parsed.handId);
      const next = order[order.indexOf(state.street) + 1] as Exclude<HHStreet, 'preflop'>;
      if (boardBy[next].length === 0) throw new HandParseError(`Missing ${next} cards`, parsed.handId);
      state = dealNextStreet(state, boardBy[next]);
    }
  };
  let allInSeen = false;
  for (const a of parsed.actions) {
    dealTo(a.street);
    // GG records a "fold" for players already all-in (e.g. all-in from posting a blind): a forfeit.
    const self = state.players.find((p) => p.id === a.player);
    if (a.type === 'fold' && self?.allIn && !self.folded) {
      statesBefore.push(state);
      state = forfeitAllIn(state, a.player);
      continue;
    }
    const actor = state.players[state.toAct];
    if (!actor || actor.id !== a.player) throw new HandParseError(`Line ${a.line}: expected ${actor?.id ?? 'no one'} to act, history says ${a.player}`, parsed.handId, a.line);
    statesBefore.push(state);
    const legal = legalActions(state)!;
    let action: PlayerAction;
    if (a.type === 'call') {
      if (Math.abs(legal.callAmount - a.amount) > 0) throw new HandParseError(`Line ${a.line}: call amount ${a.amount} ≠ engine ${legal.callAmount}`, parsed.handId, a.line);
      action = { type: 'call' };
    } else if (a.type === 'bet') action = { type: 'bet', amount: a.amount };
    else if (a.type === 'raise') action = { type: 'raise', amount: a.amount };
    else action = { type: a.type };
    try {
      state = applyAction(state, action);
    } catch (e) {
      throw new HandParseError(`Line ${a.line}: ${(e as Error).message}`, parsed.handId, a.line);
    }
    if (a.allIn) allInSeen = true;
  }
  // deal remaining board for all-in runouts
  while (state.awaitingBoard && !state.complete) {
    const order: HHStreet[] = ['preflop', 'flop', 'turn', 'river'];
    const next = order[order.indexOf(state.street) + 1] as Exclude<HHStreet, 'preflop'> | undefined;
    if (!next || boardBy[next].length === 0) break;
    state = dealNextStreet(state, boardBy[next]);
  }
  const potComputed = state.complete && state.result ? state.result.pots.reduce((s, p) => s + p.amount, 0) : totalPot(state);
  if (parsed.totalPot !== null && parsed.totalPot !== potComputed) {
    throw new HandParseError(`Reconstructed pot ${potComputed} ≠ history total ${parsed.totalPot}`, parsed.handId);
  }
  void computePots;
  return {
    parsed,
    table,
    positions,
    heroPosition: parsed.heroName ? (positions[parsed.heroName] ?? null) : null,
    statesBefore,
    final: state,
    allInSeen,
    potComputed,
  };
}

export interface ParseFileResult {
  format: string | null;
  hands: ReconstructedHand[];
  errors: { handId: string | null; message: string; line?: number; raw: string }[];
}

/** Parse every hand in a text file. Each failure is captured with its raw text. */
export function parseHandHistoryText(text: string): ParseFileResult {
  const parser = detectFormat(text);
  if (!parser) return { format: null, hands: [], errors: [{ handId: null, message: 'Unsupported or unrecognized hand-history format', raw: text.slice(0, 500) }] };
  const hands: ReconstructedHand[] = [];
  const errors: ParseFileResult['errors'] = [];
  for (const chunk of parser.split(text)) {
    try {
      hands.push(reconstructHand(parser.parse(chunk)));
    } catch (e) {
      const err = e as HandParseError;
      errors.push({ handId: err.handId ?? /#([A-Z]*\d+)/.exec(chunk)?.[1] ?? null, message: err.message, line: err.lineNo, raw: chunk });
    }
  }
  return { format: parser.format, hands, errors };
}

export interface ReviewSpot {
  actionIndex: number;
  street: HHStreet;
  heroAction: ParsedAction;
  /** Facts derivable exactly from the hand state at the decision. */
  facts: { potBB: number; toCallBB: number; requiredEquityPct: number | null; sprAtStreet: number | null; effectiveStackBB: number; mdfPct: number | null };
}

/** Hero decision points worth reviewing (voluntary actions; facing-bet spots and all-ins first). */
export function reviewSpots(h: ReconstructedHand): ReviewSpot[] {
  const hero = h.parsed.heroName;
  if (!hero) return [];
  const bb = h.parsed.bigBlind;
  const spots: ReviewSpot[] = [];
  h.parsed.actions.forEach((a, i) => {
    if (a.player !== hero) return;
    const s = h.statesBefore[i]!;
    const l = legalActions(s)!;
    const me = s.players.find((p) => p.id === hero)!;
    const others = s.players.filter((p) => p.id !== hero && !p.folded);
    const eff = Math.min(me.stack, Math.max(0, ...others.map((p) => p.stack + p.streetCommitted - me.streetCommitted)));
    const potBefore = l.pot;
    spots.push({
      actionIndex: i,
      street: a.street,
      heroAction: a,
      facts: {
        potBB: potBefore / bb,
        toCallBB: l.toCall / bb,
        requiredEquityPct: l.toCall > 0 ? Math.round((l.callAmount / (potBefore + l.callAmount)) * 1000) / 10 : null,
        sprAtStreet: potBefore > 0 && a.street !== 'preflop' ? Math.round((eff / potBefore) * 100) / 100 : null,
        effectiveStackBB: Math.round((eff / bb) * 100) / 100,
        mdfPct: l.toCall > 0 ? Math.round(((potBefore - l.toCall) / potBefore) * 1000) / 10 : null,
      },
    });
  });
  // a pure preflop fold with nothing invested is a low-value review spot; keep it but sort later
  return spots;
}
