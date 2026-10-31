import type { Lang, Localized } from './types';

export const loc = (l: Localized | null | undefined, lang: Lang) => (l ? l[lang] || l.en : '');

export function fmtAmount(chips: number, bigBlind: number, showBB: boolean): string {
  if (showBB) {
    const bb = chips / bigBlind;
    return `${Number.isInteger(bb) ? bb : bb.toFixed(1)} BB`;
  }
  return chips.toLocaleString('en-US');
}

export const fmtPct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? '—' : `${x.toFixed(d)}%`);
export const fmtNum = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? '—' : x.toFixed(d));
