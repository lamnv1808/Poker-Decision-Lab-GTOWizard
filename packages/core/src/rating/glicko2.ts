/**
 * Glicko-2 (Glickman 2012), single-game rating periods, centred on 1000.
 * This rates DECISION-MAKING PROFICIENCY on validated training content —
 * it is not a poker player ranking and never uses money results.
 */
export const RATING_METHOD_VERSION = 'glicko2-v1';
const SCALE = 173.7178;
export const BASE_RATING = 1000;
export const INITIAL_RD = 350;
export const INITIAL_VOL = 0.06;
const TAU = 0.5;
const MIN_RD = 45;
const MAX_RD = 350;

export interface Glicko {
  rating: number;
  rd: number;
  vol: number;
}

export const initialGlicko = (): Glicko => ({ rating: BASE_RATING, rd: INITIAL_RD, vol: INITIAL_VOL });

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const E = (mu: number, muj: number, phij: number) => 1 / (1 + Math.exp(-g(phij) * (mu - muj)));

/** Inflate RD for inactivity: `periods` elapsed rating periods (we use days). */
export function inflateRd(p: Glicko, periods: number): Glicko {
  if (periods <= 0) return p;
  const phi = p.rd / SCALE;
  const phiStar = Math.sqrt(phi * phi + p.vol * p.vol * Math.min(periods, 365));
  return { ...p, rd: Math.min(MAX_RD, phiStar * SCALE) };
}

/** One-game Glicko-2 update. `score` in [0,1]. */
export function glickoUpdate(p: Glicko, opponent: { rating: number; rd: number }, score: number): Glicko {
  return glickoPeriod(p, [{ ...opponent, score }]);
}

/** Full Glicko-2 rating-period update over several games (Glickman 2012, steps 2–8). */
export function glickoPeriod(p: Glicko, games: { rating: number; rd: number; score: number }[]): Glicko {
  for (const gm of games) if (!(gm.score >= 0 && gm.score <= 1)) throw new Error('score must be in [0,1]');
  const mu = (p.rating - BASE_RATING) / SCALE;
  const phi = p.rd / SCALE;
  if (games.length === 0) return inflateRd(p, 1);
  let vInv = 0;
  let sum = 0;
  for (const gm of games) {
    const muj = (gm.rating - BASE_RATING) / SCALE;
    const gj = g(gm.rd / SCALE);
    const e = E(mu, muj, gm.rd / SCALE);
    vInv += gj * gj * e * (1 - e);
    sum += gj * (gm.score - e);
  }
  const v = 1 / vInv;
  const delta = v * sum;
  const a = Math.log(p.vol * p.vol);
  const f = (x: number) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (TAU * TAU);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else fA /= 2;
    B = C;
    fB = fC;
  }
  const vol = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * sum;
  return { rating: muNew * SCALE + BASE_RATING, rd: Math.max(MIN_RD, phiNew * SCALE), vol };
}

/** Partial update: interpolate between the prior and full update by weight w ∈ [0,1]. */
export function weightedUpdate(p: Glicko, opponent: { rating: number; rd: number }, score: number, w: number): Glicko {
  if (w <= 0) return p;
  const full = glickoUpdate(p, opponent, score);
  const k = Math.min(1, w);
  return { rating: p.rating + k * (full.rating - p.rating), rd: p.rd + k * (full.rd - p.rd), vol: p.vol + k * (full.vol - p.vol) };
}

/** Scenario difficulty (1–5) as an opponent rating. Calibrated so difficulty 3 ≈ 1100. */
export function difficultyRating(difficulty: number): { rating: number; rd: number } {
  return { rating: 800 + (difficulty - 1) * 150, rd: 80 };
}

/** 95% interval half-width shown to users. */
export const confidenceHalfWidth = (rd: number) => 1.96 * rd;
