/** Position labels, ordered clockwise from the small blind (engine seat order). */
export const POSITION_LAYOUTS: Record<number, string[]> = {
  2: ['SB', 'BB'],
  3: ['SB', 'BB', 'BTN'],
  4: ['SB', 'BB', 'CO', 'BTN'],
  5: ['SB', 'BB', 'HJ', 'CO', 'BTN'],
  6: ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'],
  7: ['SB', 'BB', 'UTG', 'LJ', 'HJ', 'CO', 'BTN'],
  8: ['SB', 'BB', 'UTG', 'UTG1', 'LJ', 'HJ', 'CO', 'BTN'],
  9: ['SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN'],
  10: ['SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'MP', 'LJ', 'HJ', 'CO', 'BTN'],
};

export function positionsFor(tableSize: number): string[] {
  const layout = POSITION_LAYOUTS[tableSize];
  if (!layout) throw new Error(`Unsupported table size ${tableSize}`);
  return layout;
}

/** Heads-up the button posts the small blind. */
export function displayPosition(tableSize: number, pos: string): string {
  return tableSize === 2 && pos === 'SB' ? 'BTN/SB' : pos;
}
