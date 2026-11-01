import { useState } from 'react';
import { fmtNum, fmtPct, loc } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { DecisionFeedback, Explanation, QuestionFeedback } from '../types';
import { CardText } from './Cards';
import { RangeGrid } from './RangeGrid';
import { AssessmentBadge } from '../pages/HeroSim';
import { GradeBadge, SourceBadge, Toggle } from './ui';

/** Map a content source + grading basis to the assessment label shown on every decision. */
export function assessmentOf(cls: string, basis: string): 'solverVerified' | 'mathVerified' | 'reviewedStrategy' | 'assumedRange' | 'heuristicCoaching' | 'notEvaluated' {
  if (cls === 'SOLVER_VERIFIED') return 'solverVerified';
  if (cls === 'COACH_REVIEWED') return 'reviewedStrategy';
  if (cls === 'MATH_VERIFIED') return basis === 'exact' ? 'mathVerified' : 'assumedRange';
  if (cls === 'HEURISTIC') return 'heuristicCoaching';
  return 'notEvaluated';
}

function describeAction(a: { type: string; amount?: number }, bb: number, t: (k: string) => string) {
  if (a.type === 'bet' || a.type === 'raise') return `${t(a.type === 'bet' ? 'act.bet' : 'act.raiseTo')} ${Math.round(((a.amount ?? 0) / bb) * 100) / 100}BB`;
  return t(`act.${a.type}`);
}

function ExplanationBlock({ e, deep }: { e: Explanation; deep: boolean }) {
  const { t, lang } = useT();
  const strategyView = useApp((s) => s.me?.preferences.strategyView ?? 'gto');
  const [view, setView] = useState<'gto' | 'exploit'>(strategyView);
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      <div>
        <div className="text-xs font-semibold uppercase text-ink-400">{t('fb.keyReason')}</div>
        <p>{loc(e.keyReason, lang)}</p>
      </div>
      <div className="rounded-lg border border-accent/30 bg-accent/5 p-2.5">
        <div className="text-xs font-semibold uppercase text-accent">{t('fb.lesson')}</div>
        <p>{loc(e.lesson, lang)}</p>
      </div>
      {deep && (
        <>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase text-ink-400">{t('fb.strategy')}</span>
              <Toggle label={t('fb.strategy')} value={view} onChange={setView} options={[{ value: 'gto', label: t('fb.gto') }, { value: 'exploit', label: t('fb.exploit') }]} />
            </div>
            <p data-testid="strategy-text">{loc(view === 'gto' ? e.gto : e.exploit, lang)}</p>
          </div>
          {e.ranges && (
            <div>
              <div className="text-xs font-semibold uppercase text-ink-400">{t('fb.ranges')}</div>
              <p>{loc(e.ranges, lang)}</p>
            </div>
          )}
          {e.assumptions.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase text-ink-400">{t('fb.assumptions')}</div>
              <ul className="list-disc pl-5 text-ink-300">{e.assumptions.map((a, i) => <li key={i}>{loc(a, lang)}</li>)}</ul>
            </div>
          )}
          {e.commonMistakes.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase text-ink-400">{t('fb.mistakes')}</div>
              <ul className="list-disc pl-5 text-ink-300">{e.commonMistakes.map((a, i) => <li key={i}>{loc(a, lang)}</li>)}</ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RatingLine({ changes }: { changes?: { skill: string; before: number; after: number }[] }) {
  const { t } = useT();
  if (!changes || changes.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 text-xs" data-testid="rating-changes">
      {changes.map((c) => {
        const d = Math.round(c.after - c.before);
        return (
          <span key={c.skill} className="rounded bg-ink-800 px-2 py-0.5 tabular">
            {t(`skill.${c.skill}`)} {Math.round(c.after)} <span className={d >= 0 ? 'text-emerald-400' : 'text-red-400'}>({d >= 0 ? '+' : ''}{d})</span>
          </span>
        );
      })}
    </div>
  );
}

export function DecisionFeedbackView({ fb, bigBlind }: { fb: DecisionFeedback; bigBlind: number }) {
  const { t, lang } = useT();
  const pref = useApp((s) => s.me?.preferences.explanationView ?? 'quick');
  const [deep, setDeep] = useState(pref === 'deep');
  const best = fb.options.filter((o) => o.isBest);
  const unitLabel = fb.unit === 'icmPct' ? t('fb.icmUnit') : 'BB';
  const f = fb.facts;
  return (
    <div className="space-y-4" data-testid="feedback">
      <div className="flex flex-wrap items-center gap-2">
        <AssessmentBadge a={assessmentOf(fb.source.classification, fb.basis)} />
        {/* a rubric grade from heuristic content is coaching, not a verified strategic judgement */}
        {fb.basis === 'rubric' && <span className="text-[10px] uppercase text-amber-300">{t('fb.coachingGrade')}</span>}
        <GradeBadge grade={fb.grade} large />
        {fb.evLoss !== null && (
          <span className="text-sm tabular text-ink-300" data-testid="ev-loss">
            {t('fb.evLoss')}: <b className="text-ink-100">{fmtNum(fb.evLoss, fb.unit === 'icmPct' ? 3 : 2)} {unitLabel}</b>
          </span>
        )}
        <SourceBadge cls={fb.source.classification} />
        {fb.ratingEligible ? <span className="text-xs text-emerald-400">{t('fb.rated')}</span> : <span className="text-xs text-ink-400">{t('fb.notRated')}</span>}
        <div className="ml-auto">
          <Toggle label={t('fb.view')} value={deep ? 'deep' : 'quick'} onChange={(v) => setDeep(v === 'deep')} options={[{ value: 'quick', label: t('fb.quick') }, { value: 'deep', label: t('fb.deep') }]} />
        </div>
      </div>
      {fb.note === 'offTree' && <div className="rounded-md border border-amber-500/40 bg-amber-900/20 p-2.5 text-sm text-amber-200">{t('fb.offTree')}</div>}
      {fb.note === 'withinSamplingError' && <div className="text-xs text-sky-300">{t('fb.withinError')}</div>}
      {fb.basis === 'rubric' && <div className="text-xs text-ink-400">{t('fb.rubricNote')}</div>}
      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-lg bg-ink-850 p-2.5">
          <div className="text-xs uppercase text-ink-400">{t('fb.youChose')}</div>
          <div className="font-semibold">{describeAction(fb.chosen.action, bigBlind, t)}{fb.chosen.label && <span className="font-normal text-ink-400"> · {loc(fb.chosen.label, lang)}</span>}</div>
          {fb.chosen.feedback && <p className="mt-1 text-ink-300">{loc(fb.chosen.feedback, lang)}</p>}
        </div>
        <div className="rounded-lg bg-ink-850 p-2.5">
          <div className="text-xs uppercase text-ink-400">{t('fb.recommended')}</div>
          <div className="font-semibold text-emerald-300">{best.map((b) => loc(b.label, lang)).join(' / ') || '—'}</div>
          {best.length > 1 && <p className="mt-1 text-xs text-ink-400">{t('fb.mixed')}</p>}
        </div>
      </div>
      <ExplanationBlock e={fb.explanation} deep={deep} />
      {f && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-ink-400">{t('fb.math')}</div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs tabular" data-testid="math-facts">
            <dt className="text-ink-400">{t('fact.pot')}</dt><dd>{fmtNum(f.potBB, 1)} BB</dd>
            <dt className="text-ink-400">{t('fact.toCall')}</dt><dd>{fmtNum(f.toCallBB, 1)} BB</dd>
            {f.requiredEquityPct !== null && (<><dt className="text-ink-400">{t('fact.requiredEquity')}</dt><dd>{fmtPct(f.requiredEquityPct)}</dd></>)}
            {f.potOddsToOne !== null && (<><dt className="text-ink-400">{t('fact.potOdds')}</dt><dd>{fmtNum(f.potOddsToOne)} : 1</dd></>)}
            {f.mdfPct !== null && (<><dt className="text-ink-400">{t('fact.mdf')}</dt><dd>{fmtPct(f.mdfPct)}</dd></>)}
            {f.spr !== null && (<><dt className="text-ink-400">SPR</dt><dd>{fmtNum(f.spr)}</dd></>)}
            {f.betBreakEvenPct !== null && (<><dt className="text-ink-400">{t('fact.betBreakEven')}</dt><dd>{fmtPct(f.betBreakEvenPct)}</dd></>)}
            <dt className="text-ink-400">{t('fact.effStack')}</dt><dd>{fmtNum(f.effectiveStackBB, 1)} BB</dd>
          </dl>
        </div>
      )}
      {deep && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-ink-400">{t('fb.compare')}</div>
          <table className="w-full text-left text-xs" data-testid="option-table">
            <thead className="text-ink-400">
              <tr>
                <th className="py-1 font-medium">{t('fb.action')}</th>
                <th className="py-1 font-medium">{fb.basis === 'modelEv' || fb.basis === 'solverEv' ? `EV (${unitLabel})` : t('fb.rubric')}</th>
              </tr>
            </thead>
            <tbody>
              {fb.options.map((o) => (
                <tr key={o.id} className={`border-t border-ink-800 ${o.id === fb.chosen.optionId ? 'bg-ink-800/60' : ''}`}>
                  <td className="py-1.5 pr-2">{o.isBest && <span className="text-emerald-400">★ </span>}{loc(o.label, lang)}</td>
                  <td className="py-1.5 tabular">{o.ev !== null ? fmtNum(o.ev, fb.unit === 'icmPct' ? 3 : 2) : o.rubricGrade ? <GradeBadge grade={o.rubricGrade} /> : <span className="text-ink-400">{t('fb.notModeled')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {fb.model && (
            <div className="mt-2 space-y-1 text-xs text-ink-400">
              <div>{t('fb.modelNote')} {fb.model.evStdErr > 0 && <span className="tabular">(±{fmtNum(fb.model.evStdErr, 3)} {unitLabel} {t('fb.sampling')})</span>}</div>
              {fb.model.outcomes.map((o) => (
                <div key={o.key} className="tabular">
                  <b className="text-ink-300">{o.key}</b>:{' '}
                  {Object.entries(o.detail).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}
                </div>
              ))}
              <ul className="list-disc pl-5">{fb.model.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </div>
          )}
          <div className="mt-2 text-xs text-ink-400">{t('fb.method')}: {loc(fb.source.method, lang)}</div>
        </div>
      )}
      <RatingLine changes={fb.ratingChanges} />
      {fb.review && <div className="text-xs text-ink-400">{t('fb.reviewScheduled')} {new Date(fb.review.dueAt).toLocaleDateString(lang)}</div>}
    </div>
  );
}

export function QuestionFeedbackView({ fb }: { fb: QuestionFeedback }) {
  const { t, lang } = useT();
  const [deep, setDeep] = useState(false);
  const ans = fb.answer as { choiceId?: string; value?: number; classes?: string[] };
  return (
    <div className="space-y-3" data-testid="feedback">
      <div className="flex flex-wrap items-center gap-2">
        <AssessmentBadge a={assessmentOf(fb.source.classification, fb.basis)} />
        <GradeBadge grade={fb.grade} large />
        <span className="rounded border border-ink-600 px-1.5 py-0.5 text-[10px] uppercase text-ink-300">{t(`basis.${fb.basis}`)}</span>
        <SourceBadge cls={fb.source.classification} />
        {fb.ratingEligible ? <span className="text-xs text-emerald-400">{t('fb.rated')}</span> : <span className="text-xs text-ink-400">{t('fb.notRated')}</span>}
        <div className="ml-auto">
          <Toggle label={t('fb.view')} value={deep ? 'deep' : 'quick'} onChange={(v) => setDeep(v === 'deep')} options={[{ value: 'quick', label: t('fb.quick') }, { value: 'deep', label: t('fb.deep') }]} />
        </div>
      </div>
      {fb.choices && (
        <ul className="space-y-1 text-sm">
          {fb.choices.map((c) => (
            <li key={c.id} className={`rounded-md border px-2.5 py-1.5 ${c.correct ? 'border-emerald-500/50 bg-emerald-900/20' : c.id === ans.choiceId ? 'border-red-500/50 bg-red-900/20' : 'border-ink-700'}`}>
              {c.correct ? '✓ ' : c.id === ans.choiceId ? '✗ ' : ''}
              {loc(c.label, lang)}
              {c.feedback && (c.correct || c.id === ans.choiceId) && <div className="text-xs text-ink-300">{loc(c.feedback, lang)}</div>}
            </li>
          ))}
        </ul>
      )}
      {fb.truth.value !== undefined && (
        <div className="text-sm tabular">
          {t('q.yourAnswer')}: <b>{ans.value}</b> · {t('q.correctAnswer')}: <b className="text-emerald-300">{Math.round(fb.truth.value * 100) / 100}</b>
        </div>
      )}
      {fb.truth.classes && (
        <div className="space-y-1">
          <div className="text-xs text-ink-400">
            {t('q.overlap')}: {Math.round((fb.truth.overlap ?? 0) * 100)}% · <span className="text-emerald-400">■</span> {t('q.both')} <span className="text-red-400">■</span> {t('q.onlyYou')} <span className="text-sky-400">■</span> {t('q.onlyRef')}
          </div>
          <div className="max-w-sm"><RangeGrid selected={new Set(ans.classes ?? [])} reference={new Set(fb.truth.classes)} readOnly /></div>
          <div className="text-xs text-amber-300">{t('q.hypothesis')}</div>
        </div>
      )}
      <ExplanationBlock e={fb.explanation} deep={deep} />
      <RatingLine changes={fb.ratingChanges} />
      <div className="text-xs text-ink-400">{t('fb.method')}: {loc(fb.source.method, lang)}</div>
    </div>
  );
}

export { CardText };
