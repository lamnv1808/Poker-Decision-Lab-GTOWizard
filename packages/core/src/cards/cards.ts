/**
 * Card primitives. A card is a 2-char string: rank + suit, e.g. "As", "Td", "2c".
 * Internally cards are also addressed as integers 0..51 = rankIndex * 4 + suitIndex.
 */
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export const SUITS = ['c', 'd', 'h', 's'] as const;
export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];
export type Card = `${Rank}${Suit}`;

export const SUIT_SYMBOL: Record<Suit, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };

const RANK_INDEX: Record<string, number> = Object.fromEntries(RANKS.map((r, i) => [r, i]));
const SUIT_INDEX: Record<string, number> = Object.fromEntries(SUITS.map((s, i) => [s, i]));

export function isCard(value: string): value is Card {
  return value.length === 2 && value[0]! in RANK_INDEX && value[1]! in SUIT_INDEX;
}

export function parseCard(value: string): Card {
  const v = value.trim();
  const normalized = (v[0]?.toUpperCase() ?? '') + (v[1]?.toLowerCase() ?? '');
  if (!isCard(normalized) || v.length !== 2) throw new Error(`Invalid card: "${value}"`);
  return normalized;
}

/** Parse "AsKd" / "As Kd" / "As,Kd" into cards. */
export function parseCards(value: string): Card[] {
  const compact = value.replace(/[\s,]/g, '');
  if (compact.length % 2 !== 0) throw new Error(`Invalid card list: "${value}"`);
  const out: Card[] = [];
  for (let i = 0; i < compact.length; i += 2) out.push(parseCard(compact.slice(i, i + 2)));
  return out;
}

export function cardToInt(card: Card): number {
  return RANK_INDEX[card[0]!]! * 4 + SUIT_INDEX[card[1]!]!;
}

export function intToCard(n: number): Card {
  return `${RANKS[n >> 2]!}${SUITS[n & 3]!}` as Card;
}

export function rankOf(card: Card): number {
  return RANK_INDEX[card[0]!]!;
}

export function suitOf(card: Card): number {
  return SUIT_INDEX[card[1]!]!;
}

export function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (let i = 0; i < 52; i++) deck.push(intToCard(i));
  return deck;
}

export function assertDistinct(cards: readonly Card[], context = 'cards'): void {
  const seen = new Set<string>();
  for (const c of cards) {
    if (seen.has(c)) throw new Error(`Duplicate card ${c} in ${context}`);
    seen.add(c);
  }
}

export function formatCard(card: Card): string {
  return `${card[0]}${SUIT_SYMBOL[card[1] as Suit]}`;
}
