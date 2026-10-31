import { bluffBreakEven, indifferentBluffShare, mdf, requiredEquity, spr, valuePerBluff, icmEquities } from '@pdl/core/math';
import { Fragment, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, newAttemptId } from '../api';
import { ErrorNote, GradeBadge, Panel, Spinner, Toggle } from '../components/ui';
import { fmtNum, loc } from '../format';
import { useT } from '../i18n';
import type { Grade, Localized } from '../types';

const KINDS = ['potOdds', 'bluffBreakEven', 'mdf', 'bluffRatio', 'outs', 'combos', 'spr', 'callEv', 'shoveEv', 'icm', 'bounty'] as const;
interface Quiz { token: string; kind: string; level: number; prompt: Localized; unit: string; tolerance: number; formula: string }
interface Result { answer: number; value: number; unit: string; grade: Grade; error: number; steps: Localized[]; formula: string; ratingChanges?: { skill: string; before: number; after: number }[] }

function Calculator() {
  const { t } = useT();
  const [pot, setPot] = useState('10');
  const [bet, setBet] = useState('7.5');
  const [stack, setStack] = useState('40');
  const P = Number(pot);
  const B = Number(bet);
  const S = Number(stack);
  const ok = P > 0 && B > 0;
  const rows: [string, string][] = ok
    ? [
        [t('calc.required'), `${fmtNum(requiredEquity(B, P + B) * 100, 1)}%`],
        [t('calc.mdf'), `${fmtNum(mdf(P, B) * 100, 1)}%`],
        [t('calc.bluffBE'), `${fmtNum(bluffBreakEven(B, P) * 100, 1)}%`],
        [t('calc.bluffShare'), `${fmtNum(indifferentBluffShare(P, B) * 100, 1)}%`],
        [t('calc.valuePerBluff'), `${fmtNum(valuePerBluff(P, B), 2)} : 1`],
        ...(S > 0 ? ([[t('calc.spr'), fmtNum(spr(S, P), 2)]] as [string, string][]) : []),
      ]
    : [];
  return (
    <Panel title={t('calc.title')}>
      <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
        {[
          [t('calc.pot'), pot, setPot],
          [t('calc.bet'), bet, setBet],
          [t('calc.stack'), stack, setStack],
        ].map(([l, v, set]) => (
          <label key={l as string} className="text-ink-300">
            {l as string}
            <input inputMode="decimal" value={v as string} onChange={(e) => (set as (s: string) => void)(e.target.value)} className="mt-0.5 w-full rounded-md border border-ink-600 bg-ink-850 px-2 py-1 tabular" />
          </label>
        ))}
      </div>
      <dl className="grid grid-cols-2 gap-y-1 text-sm tabular" data-testid="calculator">
        {rows.map(([k, v]) => (<Fragment key={k}><dt className="text-ink-400">{k}</dt><dd className="text-right font-semibold">{v}</dd></Fragment>))}
      </dl>
      <p className="mt-3 text-xs text-ink-400">{t('calc.note')}</p>
    </Panel>
  );
}

function IcmCalc() {
  const { t } = useT();
  const [stacks, setStacks] = useState('50, 30, 20');
  const [payouts, setPayouts] = useState('50, 30, 20');
  let out: number[] | null = null;
  try {
    const s = stacks.split(',').map((x) => Number(x.trim())).filter((x) => x > 0);
    const p = payouts.split(',').map((x) => Number(x.trim())).filter((x) => x > 0);
    if (s.length >= 2 && p.length >= 1 && s.length <= 9) out = icmEquities(s, p);
  } catch {
    out = null;
  }
  return (
    <Panel title={t('calc.icm')}>
      <label className="block text-xs text-ink-300">{t('calc.stacks')}<input value={stacks} onChange={(e) => setStacks(e.target.value)} className="mt-0.5 w-full rounded-md border border-ink-600 bg-ink-850 px-2 py-1 tabular" /></label>
      <label className="mt-2 block text-xs text-ink-300">{t('calc.payouts')}<input value={payouts} onChange={(e) => setPayouts(e.target.value)} className="mt-0.5 w-full rounded-md border border-ink-600 bg-ink-850 px-2 py-1 tabular" /></label>
      {out && <ol className="mt-2 space-y-0.5 text-sm tabular">{out.map((e, i) => <li key={i} className="flex justify-between"><span className="text-ink-400">#{i + 1}</span><span>{fmtNum(e, 2)}</span></li>)}</ol>}
      <p className="mt-2 text-xs text-ink-400">{t('calc.icmNote')}</p>
    </Panel>
  );
}

export function MathLab() {
  const { t, lang } = useT();
  const [params] = useSearchParams();
  const [kind, setKind] = useState<string>(params.get('kind') ?? 'potOdds');
  const [level, setLevel] = useState<'1' | '2' | '3'>('2');
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [value, setValue] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setResult(null);
    setValue('');
    setError(null);
    try {
      setQuiz(await api.get<Quiz>(`/math/quiz?kind=${kind}&level=${level}`));
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    void load();
  }, [kind, level]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quiz || value === '') return;
    setBusy(true);
    try {
      setResult(await api.post<Result>('/math/quiz/answer', { token: quiz.token, value: Number(value.replace(',', '.')), clientAttemptId: newAttemptId(), mode: 'rated' }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">{t('nav.math')}</h1>
        <p className="text-sm text-ink-300">{t('math.intro')}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Panel>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <select aria-label={t('math.topic')} value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm" data-testid="quiz-kind">
              {KINDS.map((k) => <option key={k} value={k}>{t(`quiz.${k}`)}</option>)}
            </select>
            <Toggle label={t('math.level')} value={level} onChange={setLevel} options={[{ value: '1', label: t('math.l1') }, { value: '2', label: t('math.l2') }, { value: '3', label: t('math.l3') }]} />
          </div>
          <ErrorNote error={error} />
          {!quiz ? <Spinner /> : (
            <form onSubmit={submit} className="space-y-3">
              <p className="text-base font-medium" data-testid="quiz-prompt">{loc(quiz.prompt, lang)}</p>
              <div className="flex items-center gap-2">
                <input data-testid="quiz-answer" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} disabled={!!result} className="w-32 rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 tabular" aria-label={t('math.answer')} />
                <span className="text-sm text-ink-400">{quiz.unit === 'ratio' ? '' : quiz.unit}</span>
                {!result ? (
                  <button disabled={busy} className="rounded-lg bg-felt-500 px-4 py-1.5 text-sm font-bold hover:bg-felt-600" data-testid="quiz-submit">{t('q.submit')}</button>
                ) : (
                  <button type="button" onClick={() => void load()} className="rounded-lg border border-ink-600 px-4 py-1.5 text-sm" data-testid="quiz-next">{t('math.next')}</button>
                )}
              </div>
              <div className="text-xs text-ink-400">{t('math.tolerance')}: ±{quiz.tolerance} {quiz.unit === 'ratio' ? '' : quiz.unit}</div>
            </form>
          )}
          {result && (
            <div className="mt-4 space-y-2 border-t border-ink-800 pt-4" data-testid="quiz-result">
              <div className="flex items-center gap-2"><GradeBadge grade={result.grade} large /><span className="text-sm tabular">{t('q.correctAnswer')}: <b className="text-emerald-300">{result.answer}</b> {result.unit === 'ratio' ? '' : result.unit}</span></div>
              <div className="text-xs text-ink-400">{t('math.formula')}: <code>{result.formula}</code></div>
              <ol className="list-decimal space-y-1 pl-5 text-sm">{result.steps.map((s, i) => <li key={i}>{loc(s, lang)}</li>)}</ol>
              {result.ratingChanges && result.ratingChanges.length > 0 && <div className="text-xs text-ink-400">{result.ratingChanges.map((c) => `${t(`skill.${c.skill}`)} ${Math.round(c.after)} (${c.after >= c.before ? '+' : ''}${Math.round(c.after - c.before)})`).join(' · ')}</div>}
            </div>
          )}
        </Panel>
        <div className="space-y-4">
          <Calculator />
          <IcmCalc />
        </div>
      </div>
    </div>
  );
}
