import { type Card, formatCard, fullDeck } from '../cards/cards';
import { classCombos, comboCount, parseRange, removeBlocked } from '../cards/range';
import { createRng, pick, randInt } from '../cards/rng';
import { bluffBreakEven, bountyChipValue, evBet, evCall, hitProbability, icmEquities, indifferentBluffShare, mdf, requiredEquity, spr } from '../math';
import type { Grade } from '../scenario/grading';
import type { Localized, SkillKey } from '../scenario/schema';

/**
 * Math Lab quiz generators. Every quiz is a pure function of (kind, seed, level):
 * the server regenerates it from the seed to grade, so answers are deterministic
 * and cannot be tampered with client-side.
 */
export const QUIZ_KINDS = ['potOdds', 'bluffBreakEven', 'mdf', 'bluffRatio', 'outs', 'combos', 'spr', 'callEv', 'shoveEv', 'icm', 'bounty'] as const;
export type QuizKind = (typeof QUIZ_KINDS)[number];

export interface Quiz {
  kind: QuizKind;
  seed: number;
  level: 1 | 2 | 3;
  skill: SkillKey;
  prompt: Localized;
  /** Correct answer in `unit`. */
  answer: number;
  unit: '%' | 'BB' | 'combos' | 'ratio';
  tolerance: number;
  steps: Localized[];
  formula: string;
}

const L = (en: string, vi: string): Localized => ({ en, vi });
const f1 = (x: number) => (Math.round(x * 10) / 10).toString();
const f2 = (x: number) => (Math.round(x * 100) / 100).toString();
const pct = (x: number) => Math.round(x * 1000) / 10;

const SIZES = [0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.25, 1.5, 2];

function potAndBet(rng: () => number, level: number) {
  const pot = level === 1 ? pick(rng, [4, 6, 8, 10, 12, 20]) : randInt(rng, 5, 60) + (level === 3 ? pick(rng, [0, 0.5]) : 0);
  const frac = level === 1 ? pick(rng, [0.5, 0.75, 1]) : pick(rng, SIZES);
  const bet = Math.round(pot * frac * 2) / 2;
  return { pot, bet: Math.max(0.5, bet) };
}

export function generateQuiz(kind: QuizKind, seed: number, level: 1 | 2 | 3 = 2): Quiz {
  const rng = createRng(seed ^ (level * 0x9e3779b1));
  const base = { kind, seed, level };
  switch (kind) {
    case 'potOdds': {
      const { pot, bet } = potAndBet(rng, level);
      const potBefore = pot + bet;
      const ans = pct(requiredEquity(bet, potBefore));
      return {
        ...base,
        skill: 'math',
        prompt: L(`The pot is ${f1(pot)}BB. Villain bets ${f1(bet)}BB. What equity do you need to call? (%)`, `Pot là ${f1(pot)}BB. Villain cược ${f1(bet)}BB. Bạn cần bao nhiêu equity để theo? (%)`),
        answer: ans,
        unit: '%',
        tolerance: 1,
        formula: 'call / (pot before call + call)',
        steps: [
          L(`Pot before your call includes the bet: ${f1(pot)} + ${f1(bet)} = ${f1(potBefore)}BB.`, `Pot trước khi theo gồm cả cược: ${f1(pot)} + ${f1(bet)} = ${f1(potBefore)}BB.`),
          L(`Required equity = ${f1(bet)} / (${f1(potBefore)} + ${f1(bet)}) = ${ans}%.`, `Equity cần = ${f1(bet)} / (${f1(potBefore)} + ${f1(bet)}) = ${ans}%.`),
        ],
      };
    }
    case 'bluffBreakEven': {
      const { pot, bet } = potAndBet(rng, level);
      const ans = pct(bluffBreakEven(bet, pot));
      return {
        ...base,
        skill: 'math',
        prompt: L(`You bluff ${f1(bet)}BB into ${f1(pot)}BB with no equity. How often must Villain fold to break even? (%)`, `Bạn bluff ${f1(bet)}BB vào pot ${f1(pot)}BB và không có equity. Villain phải bỏ bài bao nhiêu % để hòa vốn?`),
        answer: ans,
        unit: '%',
        tolerance: 1,
        formula: 'risk / (pot + risk)',
        steps: [L(`Break-even = ${f1(bet)} / (${f1(pot)} + ${f1(bet)}) = ${ans}%.`, `Điểm hòa vốn = ${f1(bet)} / (${f1(pot)} + ${f1(bet)}) = ${ans}%.`)],
      };
    }
    case 'mdf': {
      const { pot, bet } = potAndBet(rng, level);
      const ans = pct(mdf(pot, bet));
      return {
        ...base,
        skill: 'math',
        prompt: L(`Pot ${f1(pot)}BB, Villain bets ${f1(bet)}BB. What is your minimum defense frequency? (%)`, `Pot ${f1(pot)}BB, Villain cược ${f1(bet)}BB. Tần suất phòng thủ tối thiểu (MDF) là bao nhiêu? (%)`),
        answer: ans,
        unit: '%',
        tolerance: 1,
        formula: 'pot / (pot + bet)',
        steps: [
          L(`MDF = ${f1(pot)} / (${f1(pot)} + ${f1(bet)}) = ${ans}%.`, `MDF = ${f1(pot)} / (${f1(pot)} + ${f1(bet)}) = ${ans}%.`),
          L('MDF assumes Villain’s bluffs have zero equity and ignores ranges and future streets — it is a reference point, not a strategy.', 'MDF giả định bluff của Villain không có equity và bỏ qua range lẫn các vòng sau — chỉ là mốc tham chiếu, không phải chiến lược.'),
        ],
      };
    }
    case 'bluffRatio': {
      const { pot, bet } = potAndBet(rng, level);
      const ans = pct(indifferentBluffShare(pot, bet));
      return {
        ...base,
        skill: 'math',
        prompt: L(
          `River, polarized model (nuts or air). You bet ${f1(bet)}BB into ${f1(pot)}BB. What share of your betting range should be bluffs to make a bluff-catcher indifferent? (%)`,
          `River, mô hình phân cực (nuts hoặc bài rác). Bạn cược ${f1(bet)}BB vào pot ${f1(pot)}BB. Tỷ lệ bluff trong range cược là bao nhiêu để tay bắt bluff không phân biệt? (%)`,
        ),
        answer: ans,
        unit: '%',
        tolerance: 1,
        formula: 'bet / (pot + 2·bet)',
        steps: [
          L(`The caller risks ${f1(bet)} to win ${f1(pot + bet)}, so needs ${f1(bet)}/${f1(pot + 2 * bet)} equity.`, `Người theo bỏ ${f1(bet)} để thắng ${f1(pot + bet)}, nên cần ${f1(bet)}/${f1(pot + 2 * bet)} equity.`),
          L(`Bluff share = ${f1(bet)} / (${f1(pot)} + 2×${f1(bet)}) = ${ans}% (value : bluff = ${f2((pot + bet) / bet)} : 1).`, `Tỷ lệ bluff = ${f1(bet)} / (${f1(pot)} + 2×${f1(bet)}) = ${ans}% (value : bluff = ${f2((pot + bet) / bet)} : 1).`),
        ],
      };
    }
    case 'outs': {
      const outs = level === 1 ? pick(rng, [4, 8, 9]) : randInt(rng, 2, 15);
      const two = level === 1 ? false : rng() < 0.5;
      const unseen = two ? 47 : 46;
      const ans = pct(hitProbability(outs, unseen, two ? 2 : 1));
      return {
        ...base,
        skill: 'math',
        prompt: two
          ? L(`On the flop you have ${outs} clean outs. Exact chance to hit by the river (seeing both cards)? (%)`, `Trên flop bạn có ${outs} outs sạch. Xác suất chính xác trúng trước river (xem cả hai lá)? (%)`)
          : L(`On the turn you have ${outs} clean outs. Exact chance to hit on the river? (%)`, `Trên turn bạn có ${outs} outs sạch. Xác suất chính xác trúng ở river? (%)`),
        answer: ans,
        unit: '%',
        tolerance: 1,
        formula: two ? '1 − C(47−outs,2)/C(47,2)' : 'outs / 46',
        steps: two
          ? [
              L(`Miss both: (${47 - outs}/47)×(${46 - outs}/46). Hit = 1 − miss = ${ans}%.`, `Trượt cả hai: (${47 - outs}/47)×(${46 - outs}/46). Trúng = 1 − trượt = ${ans}%.`),
              L(`Rule of 4 estimate: ${outs * 4}% — less accurate with many outs.`, `Ước lượng quy tắc 4: ${outs * 4}% — kém chính xác khi nhiều outs.`),
            ]
          : [L(`${outs} / 46 = ${ans}% (rule of 2 estimate: ${outs * 2}%).`, `${outs} / 46 = ${ans}% (quy tắc 2 ước lượng: ${outs * 2}%).`)],
      };
    }
    case 'combos': {
      const deck = fullDeck();
      const classes = level === 1 ? ['AA', 'KK', 'AKs', 'AKo', 'AK', 'QQ'] : ['AA', 'KK', 'QQ', 'AK', 'AQ', 'KQ', 'AKo', 'AQs', 'JJ', 'KQs', 'AJ'];
      const cls = pick(rng, classes);
      const ranksInCls = [...new Set(cls.slice(0, 2).split(''))];
      // board: include 1-2 cards of the class ranks to create removal
      const board: Card[] = [];
      const used = new Set<string>();
      const nRemoval = level === 1 ? 1 : randInt(rng, 1, 2);
      for (let i = 0; i < nRemoval; i++) {
        const r = pick(rng, ranksInCls);
        const options = deck.filter((c) => c[0] === r && !used.has(c));
        const c = pick(rng, options);
        board.push(c);
        used.add(c);
      }
      while (board.length < 3) {
        const c = pick(rng, deck.filter((x) => !used.has(x) && !ranksInCls.includes(x[0]!)));
        board.push(c);
        used.add(c);
      }
      const total = classCombos(cls).length;
      const ans = comboCount(removeBlocked(parseRange(cls), board));
      return {
        ...base,
        skill: 'rangeReading',
        prompt: L(`Board ${board.map(formatCard).join(' ')}. How many combos of ${cls} are possible?`, `Board ${board.map(formatCard).join(' ')}. Có bao nhiêu combo ${cls} khả dĩ?`),
        answer: ans,
        unit: 'combos',
        tolerance: 0,
        formula: 'combos with no card on board',
        steps: [
          L(`${cls} has ${total} combos before card removal.`, `${cls} có ${total} combo khi chưa loại lá.`),
          L(`Remove every combo using a card already on the board: ${ans} remain.`, `Loại các combo dùng lá đã có trên board: còn ${ans}.`),
        ],
      };
    }
    case 'spr': {
      const pot = randInt(rng, 4, 30);
      const eff = randInt(rng, 10, 120);
      const ans = Math.round(spr(eff, pot) * 10) / 10;
      return {
        ...base,
        skill: 'math',
        prompt: L(`Flop pot ${pot}BB, effective stack ${eff}BB. What is the SPR?`, `Pot flop ${pot}BB, stack hiệu dụng ${eff}BB. SPR là bao nhiêu?`),
        answer: ans,
        unit: 'ratio',
        tolerance: 0.1,
        formula: 'effective stack / pot',
        steps: [L(`SPR = ${eff} / ${pot} = ${ans}. Low SPR (<3) makes top pair easier to stack off with.`, `SPR = ${eff} / ${pot} = ${ans}. SPR thấp (<3) giúp dễ all-in với đôi cao nhất hơn.`)],
      };
    }
    case 'callEv': {
      const { pot, bet } = potAndBet(rng, level);
      const eq = randInt(rng, 15, 60);
      const potBefore = pot + bet;
      const ans = Math.round(evCall(eq / 100, potBefore, bet) * 100) / 100;
      return {
        ...base,
        skill: 'math',
        prompt: L(`Pot ${f1(pot)}BB, Villain shoves ${f1(bet)}BB (you cover). Your equity is ${eq}%. EV of calling vs folding? (BB)`, `Pot ${f1(pot)}BB, Villain all-in ${f1(bet)}BB (bạn có nhiều chip hơn). Equity của bạn ${eq}%. EV của theo so với bỏ? (BB)`),
        answer: ans,
        unit: 'BB',
        tolerance: 0.1,
        formula: 'equity × (pot before call + call) − call',
        steps: [L(`EV = ${eq}% × (${f1(potBefore)} + ${f1(bet)}) − ${f1(bet)} = ${f2(ans)}BB.`, `EV = ${eq}% × (${f1(potBefore)} + ${f1(bet)}) − ${f1(bet)} = ${f2(ans)}BB.`)],
      };
    }
    case 'shoveEv': {
      const pot = pick(rng, [1.5, 2.5, 3, 4]);
      const risk = randInt(rng, 6, 20);
      const fold = randInt(rng, 30, 85);
      const eq = randInt(rng, 25, 50);
      const ans = Math.round(evBet(fold / 100, pot, risk, eq / 100) * 100) / 100;
      return {
        ...base,
        skill: 'shortStack',
        prompt: L(
          `Pot ${pot}BB before you act. You shove ${risk}BB. Villain folds ${fold}% and, when calling, you have ${eq}% equity. EV of shoving vs folding? (BB, Villain covers)`,
          `Pot ${pot}BB trước khi bạn hành động. Bạn all-in ${risk}BB. Villain bỏ ${fold}% và khi theo bạn có ${eq}% equity. EV của all-in so với bỏ? (BB, Villain nhiều chip hơn)`,
        ),
        answer: ans,
        unit: 'BB',
        tolerance: 0.15,
        formula: 'fold%·pot + call%·(eq·(pot + 2·risk) − risk)',
        steps: [
          L(`Fold part: ${fold}% × ${pot} = ${f2((fold / 100) * pot)}.`, `Phần bỏ bài: ${fold}% × ${pot} = ${f2((fold / 100) * pot)}.`),
          L(
            `Call part: ${100 - fold}% × (${eq}% × ${f1(pot + 2 * risk)} − ${risk}) = ${f2((1 - fold / 100) * ((eq / 100) * (pot + 2 * risk) - risk))}. Total ${f2(ans)}BB.`,
            `Phần bị theo: ${100 - fold}% × (${eq}% × ${f1(pot + 2 * risk)} − ${risk}) = ${f2((1 - fold / 100) * ((eq / 100) * (pot + 2 * risk) - risk))}. Tổng ${f2(ans)}BB.`,
          ),
        ],
      };
    }
    case 'icm': {
      const n = level === 3 ? 4 : 3;
      const stacks = Array.from({ length: n }, () => randInt(rng, 5, 60) * 1000);
      const payouts = n === 3 ? [50, 30, 20] : [40, 30, 20, 10];
      const eqs = icmEquities(stacks, payouts);
      const ans = Math.round(eqs[0]! * 10) / 10;
      return {
        ...base,
        skill: 'icm',
        prompt: L(
          `${n} players left. Stacks: Hero ${stacks.map((s) => s / 1000 + 'k').join(', ')} (Hero first). Payouts ${payouts.join('/')}% of the pool. Hero’s ICM equity? (% of pool)`,
          `Còn ${n} người. Stack: Hero ${stacks.map((s) => s / 1000 + 'k').join(', ')} (Hero đầu tiên). Giải thưởng ${payouts.join('/')}% tổng giải. Equity ICM của Hero? (% tổng giải)`,
        ),
        answer: ans,
        unit: '%',
        tolerance: 0.5,
        formula: 'Malmuth–Harville',
        steps: [
          L(`P(Hero 1st) = ${stacks[0]! / 1000}k / ${stacks.reduce((a, b) => a + b, 0) / 1000}k = ${pct(stacks[0]! / stacks.reduce((a, b) => a + b, 0))}%.`, `P(Hero nhất) = ${stacks[0]! / 1000}k / ${stacks.reduce((a, b) => a + b, 0) / 1000}k = ${pct(stacks[0]! / stacks.reduce((a, b) => a + b, 0))}%.`),
          L('Second place: for each other winner, Hero’s share of the remaining chips; continue for each paid place.', 'Hạng nhì: với mỗi người khác về nhất, tỷ lệ chip còn lại của Hero; tiếp tục cho mỗi hạng có thưởng.'),
          L(`Result: ${ans}% of the prize pool (chip share ${pct(stacks[0]! / stacks.reduce((a, b) => a + b, 0))}%).`, `Kết quả: ${ans}% tổng giải (tỷ lệ chip ${pct(stacks[0]! / stacks.reduce((a, b) => a + b, 0))}%).`),
        ],
      };
    }
    case 'bounty': {
      const bounty = pick(rng, [5, 10, 20, 25, 50]);
      const chips = pick(rng, [2_000_000, 5_000_000, 10_000_000]);
      const pool = pick(rng, [20_000, 50_000, 100_000]);
      const bb = pick(rng, [1000, 2000, 5000]);
      const ans = Math.round((bountyChipValue(bounty, chips, pool) / bb) * 10) / 10;
      return {
        ...base,
        skill: 'pko',
        prompt: L(
          `PKO: you win a $${bounty} cash bounty. ${chips.toLocaleString('en-US')} chips in play, $${pool.toLocaleString('en-US')} prize pool remaining, BB = ${bb}. Simplified model: bounty worth how many BB?`,
          `PKO: bạn nhận bounty $${bounty}. Có ${chips.toLocaleString('en-US')} chip trong giải, tổng giải còn $${pool.toLocaleString('en-US')}, BB = ${bb}. Mô hình đơn giản: bounty đáng bao nhiêu BB?`,
        ),
        answer: ans,
        unit: 'BB',
        tolerance: Math.max(0.1, ans * 0.02),
        formula: 'bounty × chips / prize pool / BB',
        steps: [
          L(`Chips per dollar = ${chips.toLocaleString('en-US')} / ${pool.toLocaleString('en-US')} = ${f2(chips / pool)}.`, `Chip mỗi đô = ${chips.toLocaleString('en-US')} / ${pool.toLocaleString('en-US')} = ${f2(chips / pool)}.`),
          L(`$${bounty} × ${f2(chips / pool)} = ${Math.round(bountyChipValue(bounty, chips, pool))} chips = ${ans}BB.`, `$${bounty} × ${f2(chips / pool)} = ${Math.round(bountyChipValue(bounty, chips, pool))} chip = ${ans}BB.`),
          L('This ignores bounty growth and ICM; it is a teaching approximation.', 'Mô hình bỏ qua tăng trưởng bounty và ICM; chỉ là xấp xỉ để học.'),
        ],
      };
    }
  }
}

export function gradeQuiz(quiz: Quiz, value: number): { grade: Grade; error: number } {
  if (!Number.isFinite(value)) return { grade: 'major', error: Infinity };
  const err = Math.abs(value - quiz.answer);
  const t = Math.max(quiz.tolerance, 1e-9);
  const grade: Grade = err <= t + 1e-9 ? 'excellent' : err <= 2 * t ? 'good' : err <= 3 * t ? 'acceptable' : err <= 5 * t ? 'marginal' : err <= 10 * t ? 'mistake' : 'major';
  return { grade, error: err };
}

/** Quiz difficulty on the 1–5 scenario scale (for ratings). */
export function quizDifficulty(quiz: Quiz): number {
  const hard: QuizKind[] = ['icm', 'shoveEv', 'bluffRatio'];
  return Math.min(5, quiz.level + (hard.includes(quiz.kind) ? 1 : 0));
}
