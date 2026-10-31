/**
 * Independent Chip Model (Malmuth–Harville). Given stacks and payouts, returns each
 * player's expected prize. This is an exact computation of a *model*: ICM ignores
 * skill, position and future blinds. It is only meaningful when real payout data is known.
 */
export function icmEquities(stacks: readonly number[], payouts: readonly number[]): number[] {
  const n = stacks.length;
  if (n === 0) return [];
  if (n > 12) throw new Error('ICM supports up to 12 players');
  if (stacks.some((s) => !(s >= 0))) throw new Error('Invalid stacks');
  const places = Math.min(payouts.length, n);
  const eq = new Array<number>(n).fill(0);
  const total = stacks.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error('Total chips must be positive');
  const memo = new Map<string, number>();
  // probability that the players in `order` finish in places 1..k in that order
  const recurse = (usedMask: number, remaining: number, prob: number, place: number) => {
    if (place >= places || prob === 0) return;
    for (let i = 0; i < n; i++) {
      if (usedMask & (1 << i)) continue;
      const s = stacks[i]!;
      if (s === 0) continue;
      const p = prob * (s / remaining);
      eq[i]! += p * payouts[place]!;
      recurse(usedMask | (1 << i), remaining - s, p, place + 1);
    }
  };
  void memo;
  recurse(0, total, 1, 0);
  // busted players (stack 0) receive the lowest remaining paid places in a fixed order
  return eq;
}

/**
 * Bubble factor for Hero vs one opponent in an all-in confrontation:
 * (equity lost when losing) / (equity gained when winning). >1 means calls need more equity.
 */
export function bubbleFactor(stacks: readonly number[], payouts: readonly number[], hero: number, villain: number): number {
  const base = icmEquities(stacks, payouts)[hero]!;
  const risk = Math.min(stacks[hero]!, stacks[villain]!);
  const win = [...stacks];
  win[hero]! += risk;
  win[villain]! -= risk;
  const lose = [...stacks];
  lose[hero]! -= risk;
  lose[villain]! += risk;
  const gain = icmEquities(win, payouts)[hero]! - base;
  const loss = base - icmEquities(lose, payouts)[hero]!;
  if (gain <= 0) return Infinity;
  return loss / gain;
}

/**
 * Simplified PKO bounty model. Assumption (always shown to the user): the cash portion
 * of a won bounty is converted into chips at the tournament's average $/chip,
 * i.e. chips = bountyCash × (totalChips / remainingPrizePool).
 * Real bounty value also depends on future bounty growth and ICM; this is a teaching model.
 */
export function bountyChipValue(bountyCash: number, totalChipsInPlay: number, remainingPrizePool: number): number {
  if (!(bountyCash >= 0 && totalChipsInPlay > 0 && remainingPrizePool > 0)) throw new Error('Invalid bounty inputs');
  return bountyCash * (totalChipsInPlay / remainingPrizePool);
}

/**
 * ICM equities when some players may have busted (stack 0) in the hand being evaluated.
 * Busted players take the lowest remaining places (ties share those prizes equally);
 * survivors split the top places by Malmuth–Harville.
 */
export function icmWithBusts(stacks: readonly number[], payouts: readonly number[]): number[] {
  const survivors = stacks.map((s, i) => ({ s, i })).filter((x) => x.s > 0);
  const busted = stacks.map((s, i) => ({ s, i })).filter((x) => x.s <= 0);
  const out = new Array<number>(stacks.length).fill(0);
  const k = survivors.length;
  const top = icmEquities(
    survivors.map((x) => x.s),
    payouts.slice(0, k),
  );
  survivors.forEach((x, j) => (out[x.i] = top[j]!));
  if (busted.length > 0) {
    const places = payouts.slice(k, k + busted.length);
    const share = places.reduce((a, b) => a + b, 0) / busted.length;
    for (const b of busted) out[b.i] = share;
  }
  return out;
}
