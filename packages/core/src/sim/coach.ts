import type { ActionOption, ModelEvaluation } from './evaluate';

/**
 * Coaching text and structured reasoning checks (Phase 1 overhaul, parts D and F).
 *
 * There is no language model here: free text is never "graded". Instead the player may tick the
 * reasons behind a decision, and each reason is checked against facts computed for that exact spot
 * (the model evaluation, pot odds, street). A reason is only called supported or contradicted when a
 * fact decides it; otherwise it is "not checked" and says why.
 */
type L = { en: string; vi: string };

export const REASON_KEYS = ['potOdds', 'value', 'bluff', 'bluffCatch', 'trap', 'showdownValue', 'protection', 'impliedOdds', 'foldEquity', 'position', 'blockers', 'villainTendency', 'stackDepth', 'tournament'] as const;
export type ReasonKey = (typeof REASON_KEYS)[number];

export const REASON_LABELS: Record<ReasonKey, L> = {
  potOdds: { en: 'The price is good enough to call', vi: 'Giá đủ tốt để theo' },
  value: { en: 'Worse hands will call (value)', vi: 'Bài yếu hơn sẽ theo (value)' },
  bluff: { en: 'Better hands will fold (bluff)', vi: 'Bài mạnh hơn sẽ bỏ (bluff)' },
  bluffCatch: { en: 'Villain bluffs enough here', vi: 'Đối thủ bluff đủ nhiều ở đây' },
  trap: { en: 'Check to let Villain bet (trap / induce)', vi: 'Check để đối thủ cược (bẫy / dụ)' },
  showdownValue: { en: 'Get to showdown cheaply', vi: 'Đến showdown với giá rẻ' },
  protection: { en: 'Protect my hand / deny equity', vi: 'Bảo vệ bài / tước equity' },
  impliedOdds: { en: 'Implied odds (win more later)', vi: 'Implied odds (thắng thêm về sau)' },
  foldEquity: { en: 'Fold equity', vi: 'Fold equity' },
  position: { en: 'Position', vi: 'Vị trí' },
  blockers: { en: 'Blockers', vi: 'Blocker' },
  villainTendency: { en: "Villain's tendencies", vi: 'Xu hướng của đối thủ' },
  stackDepth: { en: 'Stack depth / SPR', vi: 'Độ sâu stack / SPR' },
  tournament: { en: 'Tournament situation (ICM / bounty)', vi: 'Tình huống giải (ICM / bounty)' },
};

export type ReasonVerdict = 'supported' | 'contradicted' | 'notChecked';
export interface ReasonCheck { key: ReasonKey; verdict: ReasonVerdict; note: L }
export interface ReasoningAssessment {
  checks: ReasonCheck[];
  /** sound: every checkable reason holds; flawed: a key reason is contradicted; notAssessed: nothing checkable. */
  quality: 'sound' | 'mixed' | 'flawed' | 'notAssessed';
}

export interface SpotFacts {
  street: string;
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  toCallBB: number;
  requiredEquity: number | null;
  /** Hero's showdown equity vs the opponent range, when an opponent model exists. */
  equityVsRange?: number | null;
  model?: ModelEvaluation | null;
  /** True when the solver graded the decision (push/fold or solved flop). */
  solverGraded?: boolean;
  solverBest?: string | null;
  format?: string | null;
}

const p = (x: number) => `${Math.round(x * 100)}%`;
const bb = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)} BB`;

export function assessReasoning(reasons: readonly ReasonKey[], f: SpotFacts): ReasoningAssessment {
  const m = f.model ?? null;
  const mine = m ? m.options.find((o) => o.key === m.chosenKey) ?? null : null;
  const best = m ? m.options.find((o) => o.key === m.bestKey) ?? null : null;
  const tol = m?.toleranceBB ?? 0.05;
  const river = f.street === 'river';
  const bestBet = m ? m.options.filter((o) => o.kind === 'bet' || o.kind === 'raise' || o.kind === 'allin').sort((a, b) => b.evBB - a.evBB)[0] ?? null : null;
  const check = m ? m.options.find((o) => o.kind === 'check') ?? null : null;
  const out: ReasonCheck[] = [];
  const say = (key: ReasonKey, verdict: ReasonVerdict, en: string, vi: string) => out.push({ key, verdict, note: { en, vi } });
  const notChecked = (key: ReasonKey, en = 'Not something this evaluation can check for this spot.', vi = 'Đánh giá này không kiểm tra được điều này ở spot này.') => say(key, 'notChecked', en, vi);
  for (const key of reasons) {
    switch (key) {
      case 'potOdds':
      case 'bluffCatch': {
        if (f.requiredEquity === null || f.toCallBB <= 0) {
          say(key, 'contradicted', 'There was nothing to call, so pot odds do not apply.', 'Không có gì để theo, nên pot odds không áp dụng.');
          break;
        }
        const eq = f.equityVsRange ?? null;
        if (eq === null || !Number.isFinite(eq)) {
          notChecked(key, `You needed ${p(f.requiredEquity)} equity; without an opponent range the equity cannot be checked.`, `Bạn cần ${p(f.requiredEquity)} equity; không có range đối thủ nên không kiểm tra được equity.`);
          break;
        }
        const enough = eq >= f.requiredEquity;
        const terminal = !!m; // the model scope is terminal for a call
        const callOrFold = f.action === 'call' ? enough : !enough;
        if (!terminal) {
          say(key, 'notChecked', `Price check only: ${p(eq)} vs ${p(f.requiredEquity)} needed, but more betting can follow, so equity alone does not decide it.`, `Chỉ so giá: ${p(eq)} so với cần ${p(f.requiredEquity)}, nhưng còn có thể cược tiếp nên equity chưa đủ quyết định.`);
          break;
        }
        say(key, callOrFold ? 'supported' : 'contradicted', `Against the hands that bet here you win ${p(eq)}; calling needs ${p(f.requiredEquity)}.`, `Trước các tay cược ở đây bạn thắng ${p(eq)}; theo cần ${p(f.requiredEquity)}.`);
        break;
      }
      case 'value': {
        if (!(f.action === 'bet' || f.action === 'raise')) {
          say(key, 'contradicted', 'Value comes from betting or raising; you did not.', 'Value đến từ cược hoặc raise; bạn đã không làm vậy.');
          break;
        }
        if (!mine || mine.equityWhenCalled === undefined) {
          notChecked(key);
          break;
        }
        const ok = mine.equityWhenCalled >= 0.5;
        say(key, ok ? 'supported' : 'contradicted', `When called at this size you win ${p(mine.equityWhenCalled)} — ${ok ? 'more often than not, so it is a value bet' : 'the hands that call are mostly better, so it is not a value bet'}.`, `Khi bị theo ở size này bạn thắng ${p(mine.equityWhenCalled)} — ${ok ? 'nhiều hơn thua, nên đây là cược value' : 'các tay theo phần lớn mạnh hơn, nên không phải cược value'}.`);
        break;
      }
      case 'bluff':
      case 'foldEquity': {
        if (!(f.action === 'bet' || f.action === 'raise')) {
          say(key, 'contradicted', 'Fold equity needs a bet or raise.', 'Fold equity cần cược hoặc raise.');
          break;
        }
        if (!mine?.reaction || !m) {
          notChecked(key);
          break;
        }
        // a bluff targets BETTER hands folding: with the best of it when called, this is value, not a bluff
        if ((mine.equityWhenCalled ?? 0) >= 0.5) {
          say(key, 'contradicted', `When called you win ${p(mine.equityWhenCalled ?? 0)}: this is a value bet — worse hands calling is the point, not better hands folding.`, `Khi bị theo bạn thắng ${p(mine.equityWhenCalled ?? 0)}: đây là cược value — mục đích là bài yếu hơn theo, không phải bài mạnh hơn bỏ.`);
          break;
        }
        const risk = mine.addedBB ?? 0;
        const needed = risk > 0 ? risk / (m.facts.potBB + risk) : 1;
        const ok = mine.reaction.fold >= needed && mine.evBB >= (check?.evBB ?? 0) - tol;
        say(key, ok ? 'supported' : 'contradicted', `This size folds ${p(mine.reaction.fold)} of the opponent's range (break-even ≈ ${p(needed)}); EV ${bb(mine.evBB)}${check ? ` vs checking ${bb(check.evBB)}` : ''}.`, `Size này khiến ${p(mine.reaction.fold)} range đối thủ bỏ (hoà vốn ≈ ${p(needed)}); EV ${bb(mine.evBB)}${check ? ` so với check ${bb(check.evBB)}` : ''}.`);
        break;
      }
      case 'trap':
      case 'showdownValue': {
        if (f.action !== 'check' && f.action !== 'call') {
          say(key, 'contradicted', 'You did not check or call.', 'Bạn đã không check hay theo.');
          break;
        }
        if (!check || !m) {
          notChecked(key);
          break;
        }
        const gap = (bestBet?.evBB ?? -Infinity) - check.evBB;
        const ok = gap <= tol;
        const bets = check.villainBets;
        say(
          key,
          ok ? 'supported' : 'contradicted',
          `Checking: EV ${bb(check.evBB)}${bets !== undefined ? `, the opponent bets ${p(bets)} of its range after your check` : ''}; best bet ${bestBet ? bb(bestBet.evBB) : '—'}.`,
          `Check: EV ${bb(check.evBB)}${bets !== undefined ? `, đối thủ cược với ${p(bets)} range sau khi bạn check` : ''}; cược tốt nhất ${bestBet ? bb(bestBet.evBB) : '—'}.`,
        );
        break;
      }
      case 'protection':
      case 'impliedOdds':
        if (river) say(key, 'contradicted', 'On the river no cards are to come: there is nothing to protect and no later street to win more on.', 'Ở river không còn lá nào: không có gì để bảo vệ và không còn street sau để thắng thêm.');
        else notChecked(key, 'Depends on later streets, which this evaluation does not model.', 'Phụ thuộc các street sau, đánh giá này không mô hình hoá.');
        break;
      case 'villainTendency':
        if (m) say(key, 'supported', `The evaluation uses this opponent's model (${m.opponent.label.en}).`, `Đánh giá dùng mô hình của đối thủ này (${m.opponent.label.vi}).`);
        else notChecked(key);
        break;
      case 'tournament':
        notChecked(key, 'ICM and bounties are not modelled: the evaluation is chip EV.', 'Không mô hình hoá ICM và bounty: đánh giá theo chip EV.');
        break;
      default:
        notChecked(key);
    }
  }
  const sup = out.filter((x) => x.verdict === 'supported').length;
  const con = out.filter((x) => x.verdict === 'contradicted').length;
  const quality: ReasoningAssessment['quality'] = !sup && !con ? 'notAssessed' : con === 0 ? 'sound' : sup === 0 ? 'flawed' : 'mixed';
  void best;
  return { checks: out, quality };
}

/** Short, hand-specific coaching for a Tier 2 evaluation: what was best and why, in one or two sentences. */
export function explainModel(m: ModelEvaluation): { recommended: L; why: L; sizing: L | null } {
  const best = m.options.find((o) => o.key === m.bestKey)!;
  const mine = m.options.find((o) => o.key === m.chosenKey)!;
  const name = (o: ActionOption): L =>
    o.kind === 'fold' ? { en: 'Fold', vi: 'Bỏ bài' } : o.kind === 'check' ? { en: 'Check', vi: 'Check' } : o.kind === 'call' ? { en: 'Call', vi: 'Theo' } : o.kind === 'allin' ? { en: `All-in (${o.toBB} BB)`, vi: `All-in (${o.toBB} BB)` } : { en: `${o.kind === 'bet' ? 'Bet' : 'Raise to'} ${o.toBB} BB (${o.sizePctPot}% pot)`, vi: `${o.kind === 'bet' ? 'Cược' : 'Raise lên'} ${o.toBB} BB (${o.sizePctPot}% pot)` };
  const others = m.goodKeys.filter((k) => k !== best.key).map((k) => m.options.find((o) => o.key === k)!);
  const rec = name(best);
  const recommended: L = others.length ? { en: `${rec.en} (also fine: ${others.map((o) => name(o).en).join(', ')})`, vi: `${rec.vi} (cũng ổn: ${others.map((o) => name(o).vi).join(', ')})` } : rec;
  const why = (o: ActionOption): L => {
    if (o.kind === 'fold') return { en: `Against the hands that bet, you win only ${p(m.facts.equityVsRange)}; calling needs ${p(m.facts.requiredEquity ?? 0)}.`, vi: `Trước các tay cược, bạn chỉ thắng ${p(m.facts.equityVsRange)}; theo cần ${p(m.facts.requiredEquity ?? 0)}.` };
    if (o.kind === 'call') return { en: `You win ${p(m.facts.equityVsRange)} against the hands that bet, more than the ${p(m.facts.requiredEquity ?? 0)} the price requires.`, vi: `Bạn thắng ${p(m.facts.equityVsRange)} trước các tay cược, nhiều hơn mức ${p(m.facts.requiredEquity ?? 0)} mà giá yêu cầu.` };
    if (o.kind === 'check') {
      const b = o.villainBets;
      return { en: `Betting gets called mostly by better hands or folds out worse ones${b !== undefined ? `; after a check the opponent bets ${p(b)} of the time` : ''}.`, vi: `Cược chủ yếu bị bài mạnh hơn theo hoặc khiến bài yếu hơn bỏ${b !== undefined ? `; sau khi check đối thủ cược ${p(b)} số lần` : ''}.` };
    }
    const r = o.reaction;
    if (!r) return { en: '', vi: '' };
    const valueBet = (o.equityWhenCalled ?? 0) >= 0.5;
    return valueBet
      ? { en: `Value: the opponent calls ${p(r.call)} and you win ${p(o.equityWhenCalled ?? 0)} of those calls (folds ${p(r.fold)}, raises ${p(r.raise)}).`, vi: `Value: đối thủ theo ${p(r.call)} và bạn thắng ${p(o.equityWhenCalled ?? 0)} các lần theo đó (bỏ ${p(r.fold)}, raise ${p(r.raise)}).` }
      : { en: `Bluff: the opponent folds ${p(r.fold)} — enough to profit even though calls (${p(r.call)}) beat you.`, vi: `Bluff: đối thủ bỏ ${p(r.fold)} — đủ để có lãi dù các lần theo (${p(r.call)}) thắng bạn.` };
  };
  let sizing: L | null = null;
  if ((mine.kind === 'bet' || mine.kind === 'raise' || mine.kind === 'allin') && (best.kind === 'bet' || best.kind === 'raise' || best.kind === 'allin') && mine.key !== best.key) {
    sizing = m.goodKeys.includes(mine.key)
      ? { en: `Your size (${mine.toBB} BB) is about as good as the best (${best.toBB} BB).`, vi: `Size của bạn (${mine.toBB} BB) tốt gần bằng size tốt nhất (${best.toBB} BB).` }
      : { en: `Your size ${mine.toBB} BB: EV ${bb(mine.evBB)}; ${best.toBB} BB: EV ${bb(best.evBB)}. ${(best.reaction?.call ?? 0) > (mine.reaction?.call ?? 0) ? 'The better size gets called by more of the hands you beat.' : 'The better size folds out more of the hands that beat you or pays more when called.'}`, vi: `Size của bạn ${mine.toBB} BB: EV ${bb(mine.evBB)}; ${best.toBB} BB: EV ${bb(best.evBB)}. ${(best.reaction?.call ?? 0) > (mine.reaction?.call ?? 0) ? 'Size tốt hơn được nhiều tay bạn thắng theo hơn.' : 'Size tốt hơn khiến nhiều tay thắng bạn bỏ hơn hoặc được trả nhiều hơn khi bị theo.'}` };
  }
  return { recommended, why: why(best), sizing };
}
