import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, newAttemptId, mixedSessionId, ApiError } from '../api';
import { PokerTable } from '../components/PokerTable';
import { Empty, ErrorNote, GradeBadge, Panel, Spinner } from '../components/ui';
import { fmtNum, loc } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { Grade, Localized } from '../types';
import { type DecisionQuestion, DecisionHeader } from './Replay';

interface PotOddsResult { answerPct: number; valuePct: number; tolerancePct: number; grade: Grade; callBB: number; winnablePotAfterCallBB: number; formula: string; scope: Localized; note: Localized }

/** Fundamentals: arithmetic exercises with mathematically supported answers. Scored separately; never Elo. */
export function FundamentalsPage() {
  const { t, lang } = useT();
  const showBB = useApp((s) => s.me?.preferences.showBB ?? true);
  const [q, setQ] = useState<DecisionQuestion | null>(null);
  const [value, setValue] = useState('');
  const [res, setRes] = useState<PotOddsResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [stats, setStats] = useState({ n: 0, ok: 0 });
  const shownAt = useRef(Date.now());
  const next = useCallback(async () => {
    setRes(null);
    setValue('');
    setError(null);
    try {
      setQ(await api.post<DecisionQuestion>('/real/next', { kind: 'potodds' }));
      shownAt.current = Date.now();
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void next();
  }, [next]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q || value === '') return;
    try {
      const r = await api.post<PotOddsResult>(`/real/potodds/${q.decisionId}/answer`, { clientAttemptId: newAttemptId(), valuePct: Number(value.replace(',', '.')), responseMs: Date.now() - shownAt.current, sessionId: mixedSessionId() });
      setRes(r);
      setStats((s) => ({ n: s.n + 1, ok: s.ok + (r.grade === 'excellent' ? 1 : 0) }));
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">{t('nav.fundamentals')}</h1>
        <p className="text-sm text-ink-300">{t('fund.intro')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Link to="/math" className="rounded-xl border border-ink-700 bg-ink-900 p-4 hover:border-ink-500"><div className="font-semibold">{t('nav.math')}</div><div className="text-sm text-ink-300">{t('math.intro')}</div></Link>
        <Link to="/hero/browse" className="rounded-xl border border-ink-700 bg-ink-900 p-4 hover:border-ink-500"><div className="font-semibold">{t('fund.models')}</div><div className="text-sm text-ink-300">{t('fund.modelsIntro')}</div></Link>
        <div className="rounded-xl border border-accent/40 bg-ink-900 p-4"><div className="font-semibold">{t('fund.potOdds')}</div><div className="text-sm text-ink-300">{t('fund.potOddsIntro')}</div></div>
      </div>
      <div className="text-xs text-ink-400 tabular">{t('gto.answered')}: {stats.n} · {t('gto.correct')}: {stats.n ? Math.round((100 * stats.ok) / stats.n) : 0}% · {t('fund.notSkill')}</div>
      {/* no imported hands yet is an empty state, not an error */}
      {!(error instanceof ApiError && error.status === 404) && <ErrorNote error={error} />}
      {!q && error instanceof ApiError && error.status === 404 ? (
        <Empty>
          {t('fund.noHands')} <Link to="/hands" className="text-accent">{t('fund.importLink')}</Link>
        </Empty>
      ) : !q ? <Spinner /> : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-3">
            <DecisionHeader q={q} />
            <PokerTable state={q.state} heroId={q.heroId} bigBlind={q.bigBlind} showBB={showBB} labels={q.positions} heroCards={q.heroCards} />
          </div>
          <Panel title={t('fund.potOdds')}>
            <form onSubmit={submit} className="space-y-3" data-testid="potodds-form">
              <p className="text-sm">{q.potOddsPrompt ? loc(q.potOddsPrompt, lang) : ''}</p>
              {q.potOddsPrompt && !q.potOddsPrompt.terminal && <p className="text-xs text-amber-300">{t('fund.nonTerminal')}</p>}
              <div className="flex items-center gap-2">
                <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} disabled={!!res} className="w-28 rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 tabular" aria-label="%" data-testid="potodds-input" />
                <span className="text-sm text-ink-400">%</span>
                {!res ? <button className="rounded-lg bg-felt-500 px-4 py-1.5 text-sm font-bold" data-testid="potodds-submit">{t('q.submit')}</button> : <button type="button" onClick={() => void next()} className="rounded-lg border border-ink-600 px-4 py-1.5 text-sm" data-testid="potodds-next">{t('math.next')}</button>}
              </div>
            </form>
            {res && (
              <div className="mt-3 space-y-2 border-t border-ink-800 pt-3 text-sm" data-testid="potodds-result">
                <div className="flex items-center gap-2"><GradeBadge grade={res.grade} /><span className="tabular">{t('q.correctAnswer')}: <b className="text-emerald-300">{res.answerPct}%</b> (±{res.tolerancePct})</span></div>
                <div className="text-xs tabular text-ink-300">{res.callBB} / {fmtNum(res.winnablePotAfterCallBB, 2)} BB · <code>{res.formula}</code></div>
                <p className="text-xs text-ink-300">{loc(res.scope, lang)}</p>
                <p className="text-xs text-amber-200">{loc(res.note, lang)}</p>
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
