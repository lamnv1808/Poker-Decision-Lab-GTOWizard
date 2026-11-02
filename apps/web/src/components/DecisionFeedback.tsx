import { useState } from 'react';
import { fmtNum, loc } from '../format';
import { useT } from '../i18n';
import type { Grade, Localized } from '../types';
import { GradeBadge } from './ui';

/**
 * Post-decision feedback, most important first (Phase 1 overhaul F1):
 *   grade · recommended action · one-line why · sizing · EV difference (only when verified) · source.
 * Details (action comparison, assumptions, reasoning checks) are one tap away.
 */
export type Tier = 'solver' | 'model' | 'limited';
export interface OptionView {
  key: string;
  kind: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';
  toBB?: number;
  sizePctPot?: number;
  evBB: number;
  reaction?: { fold: number; call: number; raise: number };
  equityWhenCalled?: number;
  villainBets?: number;
  isChosen?: boolean;
}
export interface ModelView {
  scope: string;
  opponent: { label: Localized };
  options: OptionView[];
  bestKey: string;
  goodKeys: string[];
  confidence: 'high' | 'medium';
  toleranceBB: number;
  assumptions: Localized[];
  facts: { potBB: number; toCallBB: number; requiredEquity: number | null; equityVsRange: number };
}
export interface ReasonCheckView { key: string; verdict: 'supported' | 'contradicted' | 'notChecked'; note: Localized }
export interface FeedbackView {
  tier?: Tier;
  graded: boolean;
  grade?: Grade;
  evLossBB?: number;
  best?: string;
  evByAction?: Record<string, number>;
  note: Localized;
  coaching?: Localized;
  limitation?: Localized;
  explain?: { recommended: Localized; why: Localized; sizing: Localized | null };
  model?: ModelView;
  reasoning?: { quality: 'sound' | 'mixed' | 'flawed' | 'notAssessed'; checks: ReasonCheckView[] };
}

const TIER_CLS: Record<Tier, string> = {
  solver: 'border-emerald-400/60 text-emerald-300',
  model: 'border-sky-400/60 text-sky-300',
  limited: 'border-ink-500 text-ink-300',
};
const VERDICT_CLS = { supported: 'text-emerald-300', contradicted: 'text-red-300', notChecked: 'text-ink-400' };

export function TierBadge({ tier }: { tier: Tier }) {
  const { t } = useT();
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${TIER_CLS[tier]}`} title={t(`tier.${tier}.help`)} data-testid={`tier-${tier}`}>{t(`tier.${tier}`)}</span>;
}

export function DecisionFeedback({ fb, extra }: { fb: FeedbackView; extra?: React.ReactNode }) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(false);
  const tier: Tier = fb.tier ?? (fb.graded ? 'solver' : 'limited');
  const optName = (o: OptionView) =>
    o.kind === 'fold' ? t('act.fold') : o.kind === 'check' ? t('act.check') : o.kind === 'call' ? t('act.call') : o.kind === 'allin' ? `${t('table.allIn')} ${fmtNum(o.toBB, 1)} BB` : `${t(o.kind === 'bet' ? 'act.bet' : 'act.raiseTo')} ${fmtNum(o.toBB, 1)} BB${o.sizePctPot !== undefined ? ` (${o.sizePctPot}%)` : ''}`;
  const ev = (x: number) => `${x >= 0 ? '+' : ''}${fmtNum(x, 2)} BB`;
  const pct = (x?: number) => (x === undefined ? '—' : `${Math.round(x * 100)}%`);
  return (
    <div className="space-y-2 text-sm" data-testid="decision-feedback">
      {/* headline */}
      <div className="flex flex-wrap items-center gap-2">
        {fb.graded ? <GradeBadge grade={fb.grade ?? null} large /> : <span className="rounded border border-ink-500 px-2 py-1 text-xs text-ink-200" data-testid="assessment-limited">{t('fb2.limited')}</span>}
        <TierBadge tier={tier} />
        {fb.graded && fb.evLossBB !== undefined && fb.evLossBB > 0 && <span className="text-xs tabular text-ink-300" data-testid="ev-diff">{t('fb2.evDiff')}: −{fmtNum(fb.evLossBB, 2)} BB</span>}
      </div>
      {fb.explain && (
        <div className="space-y-1" data-testid="fb-headline">
          <div>
            <span className="text-ink-400">{t('fb2.recommended')}: </span>
            <b className="text-emerald-300" data-testid="fb-recommended">{loc(fb.explain.recommended, lang)}</b>
          </div>
          <p className="text-ink-200" data-testid="fb-why">{loc(fb.explain.why, lang)}</p>
          {fb.explain.sizing && <p className="text-xs text-ink-300" data-testid="fb-sizing">{t('fb2.yourSizing')}: {loc(fb.explain.sizing, lang)}</p>}
        </div>
      )}
      {!fb.graded && (
        <div className="space-y-1">
          {fb.limitation && <p className="text-ink-200" data-testid="fb-limitation">{loc(fb.limitation, lang)}</p>}
          {fb.coaching && <p className="rounded border border-sky-500/30 bg-sky-500/5 px-2 py-1 text-xs text-sky-200" data-testid="sim-coaching">{loc(fb.coaching, lang)}</p>}
        </div>
      )}
      {fb.reasoning && fb.reasoning.quality !== 'notAssessed' && (
        <div className="rounded-md border border-ink-700 p-2 text-xs" data-testid="reasoning-assessment">
          <div className="mb-1 font-semibold">
            {t('fb2.reasoning')}: <span className={fb.reasoning.quality === 'sound' ? 'text-emerald-300' : fb.reasoning.quality === 'flawed' ? 'text-red-300' : 'text-amber-300'}>{t(`fb2.reasoning.${fb.reasoning.quality}`)}</span>
          </div>
          <ul className="space-y-0.5">
            {fb.reasoning.checks.map((c) => (
              <li key={c.key}>
                <span className={VERDICT_CLS[c.verdict]}>{c.verdict === 'supported' ? '✓' : c.verdict === 'contradicted' ? '✗' : '·'}</span> <b>{t(`reason.${c.key}`)}</b> — {loc(c.note, lang)}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] text-ink-500">{t('fb2.reasoningNote')}</p>
        </div>
      )}
      <button type="button" onClick={() => setOpen((x) => !x)} className="text-xs text-accent" data-testid="fb-details-toggle">
        {open ? '▾' : '▸'} {t('fb2.details')}
      </button>
      {open && (
        <div className="space-y-2 text-xs" data-testid="fb-details">
          {fb.model && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[320px] tabular" data-testid="action-comparison">
                <thead className="text-ink-400">
                  <tr>
                    <th className="text-left font-normal">{t('fb2.action')}</th>
                    <th className="text-right font-normal">EV</th>
                    <th className="text-right font-normal">{t('fb2.reaction')}</th>
                  </tr>
                </thead>
                <tbody>
                  {fb.model.options.map((o) => (
                    <tr key={o.key} className={`border-t border-ink-800 ${o.key === fb.model!.bestKey ? 'text-emerald-300' : ''}`}>
                      <td className="py-1">
                        {optName(o)}
                        {o.isChosen && <span className="ml-1 rounded bg-ink-700 px-1 text-[10px] text-ink-100">{t('fb2.you')}</span>}
                        {fb.model!.goodKeys.includes(o.key) && o.key !== fb.model!.bestKey && <span className="ml-1 text-[10px] text-emerald-400">≈</span>}
                      </td>
                      <td className="text-right">{ev(o.evBB)}</td>
                      <td className="text-right text-ink-400">
                        {o.reaction ? `${t('fb2.folds')} ${pct(o.reaction.fold)} · ${t('fb2.calls')} ${pct(o.reaction.call)} · ${t('fb2.raises')} ${pct(o.reaction.raise)}` : o.villainBets !== undefined ? `${t('fb2.betsAfterCheck')} ${pct(o.villainBets)}` : o.kind === 'call' ? `${t('fb2.youWin')} ${pct(o.equityWhenCalled)}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-ink-400">
                {t('fb2.modelFacts', { eq: pct(fb.model.facts.equityVsRange), req: fb.model.facts.requiredEquity === null ? '—' : pct(fb.model.facts.requiredEquity), tol: fmtNum(fb.model.toleranceBB, 2) })}
              </p>
            </div>
          )}
          {!fb.model && fb.evByAction && (
            <div className="flex flex-wrap gap-2 tabular">
              {Object.entries(fb.evByAction).map(([a, x]) => (
                <span key={a} className={`rounded border px-1.5 ${fb.best === a ? 'border-emerald-500 text-emerald-300' : 'border-ink-700 text-ink-300'}`}>{a}: {ev(x)}</span>
              ))}
            </div>
          )}
          <p className="text-ink-300">{loc(fb.note, lang)}</p>
          {fb.model && (
            <ul className="list-disc space-y-0.5 pl-4 text-ink-400" data-testid="fb-assumptions">
              {fb.model.assumptions.map((a, i) => <li key={i}>{loc(a, lang)}</li>)}
            </ul>
          )}
          {extra}
        </div>
      )}
    </div>
  );
}
