import type { HandState } from '@pdl/core/engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, mixedSessionId } from '../api';
import { useAttemptIds } from '../attempt';
import { CardText } from '../components/Cards';
import { PokerTable } from '../components/PokerTable';
import { StrategyGrid, actionColor } from '../components/StrategyGrid';
import { ErrorNote, GradeBadge, Panel, SourceBadge, Spinner, Toggle } from '../components/ui';
import { fmtNum, loc } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { Grade, Localized } from '../types';

type Node = 'any' | 'ip_vs_check' | 'oop_vs_bet39' | 'oop_vs_bet89';
interface Spot { token: string; flop: string; node: Exclude<Node, 'any'>; hero: string; heroCards: string[]; bigBlind: number; state: HandState; actions: { index: number; key: string; label: Localized }[]; stackBB: number }
interface Result {
  heroClass: string;
  heroCombo: string;
  grade: Grade;
  evLossBB: number;
  equityPct: number;
  options: { key: string; label: Localized; freq: number; ev: number; best: boolean }[];
  overall: number[];
  rangeByClass: Record<string, number[]>;
  exploitabilityPctPot: number;
  source: { classification: string; method: Localized };
  ratingChanges?: { skill: string; before: number; after: number }[];
}

export function GtoPostflop({ mode }: { mode: 'rated' | 'practice' }) {
  const nav = useNavigate();
  const { t, lang } = useT();
  const showBB = useApp((s) => s.me?.preferences.showBB ?? true);
  const [node, setNode] = useState<Node>('any');
  const [spot, setSpot] = useState<Spot | null>(null);
  const attemptFor = useAttemptIds();
  const [result, setResult] = useState<Result | null>(null);
  // On a phone the verdict + Next replace the (shorter) answer buttons; bring Next fully on screen so the
  // player never has to scroll to continue. 'nearest' does nothing when it is already visible.
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (result) nextRef.current?.scrollIntoView({ block: 'nearest' });
  }, [result]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({ n: 0, ok: 0, ev: 0 });

  const next = useCallback(async () => {
    setSpot(null);
    setResult(null);
    setError(null);
    try {
      setSpot(await api.get<Spot>(`/gto/postflop/spot?node=${node}`));
    } catch (e) {
      setError(e);
    }
  }, [node]);
  const advance = useCallback(async () => {
    const session = mixedSessionId();
    if (session) nav(`/mixed/${session}`);
    else await next();
  }, [nav, next]);
  useEffect(() => {
    void next();
  }, [next]);

  const answer = useCallback(
    async (actionIndex: number) => {
      if (!spot || result || busy) return;
      setBusy(true);
      try {
        const r = await api.post<Result>('/gto/postflop/answer', { token: spot.token, actionIndex, clientAttemptId: attemptFor(spot), mode, sessionId: mixedSessionId() });
        setResult(r);
        setStats((s) => ({ n: s.n + 1, ok: s.ok + (r.grade === 'excellent' ? 1 : 0), ev: s.ev + r.evLossBB }));
      } catch (e) {
        setError(e);
      } finally {
        setBusy(false);
      }
    },
    [spot, result, busy, mode],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!spot) return;
      if (!result && /^[1-9]$/.test(e.key) && Number(e.key) <= spot.actions.length) void answer(Number(e.key) - 1);
      if (result && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        void advance();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [spot, result, answer, advance]);

  const situation = spot ? (spot.node === 'ip_vs_check' ? t('pf.ipVsCheck') : t('pf.oopVsBet')) : '';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Toggle label={t('gto.role')} value={node} onChange={setNode} options={[{ value: 'any', label: t('gto.any') }, { value: 'ip_vs_check', label: t('pf.cbet') }, { value: 'oop_vs_bet39', label: t('pf.vs33') }, { value: 'oop_vs_bet89', label: t('pf.vs75') }]} />
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-ink-300 tabular" data-testid="pf-stats">
        <span>{t('gto.answered')}: <b className="text-ink-100">{stats.n}</b></span>
        <span>{t('gto.correct')}: <b className="text-ink-100">{stats.n ? Math.round((100 * stats.ok) / stats.n) : 0}%</b></span>
        <span>{t('gto.evLost')}: <b className="text-ink-100">{fmtNum(stats.ev, 2)} BB</b></span>
      </div>
      <ErrorNote error={error} onRetry={!spot ? () => void next() : undefined} />
      {!spot ? (error ? null : <Spinner />) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="pf-spot">
              <span className="rounded-md bg-ink-800 px-2 py-1 font-semibold">{situation}</span>
              <span className="rounded-md bg-ink-800 px-2 py-1">{t('pf.srp', { stack: spot.stackBB })}</span>
            </div>
            <PokerTable state={spot.state} heroId={spot.hero} bigBlind={spot.bigBlind} showBB={showBB} heroCards={spot.heroCards} />
            {!result ? (
              <div className={`grid gap-2 ${spot.actions.length > 3 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}`} data-testid="pf-actions">
                {spot.actions.map((a) => (
                  <button key={a.key} type="button" disabled={busy} onClick={() => void answer(a.index)} className="rounded-xl py-4 text-sm font-bold text-ink-950 hover:brightness-110 disabled:opacity-50" style={{ background: actionColor(a.key) }}>
                    {loc(a.label, lang)} <span className="text-[10px] opacity-60">({a.index + 1})</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-2" data-testid="pf-quick-feedback" aria-live="polite">
                <div className="flex items-center gap-2"><GradeBadge grade={result.grade} /><span>{t('fb.evLoss')}: {fmtNum(result.evLossBB, 2)} BB</span></div>
                <button type="button" onClick={() => void advance()} className="w-full rounded-xl bg-felt-500 py-4 text-base font-bold hover:bg-felt-600" ref={nextRef} data-testid="pf-next">{t(mixedSessionId() ? 'mixed.next' : 'gto.next')} <span className="text-xs opacity-60">(Enter)</span></button>
              </div>
            )}
          </div>
          <Panel title={t('run.feedback')}>
            {!result ? <p className="text-sm text-ink-400">{t('pf.hint')}</p> : (
              <div className="space-y-3" data-testid="pf-result">
                <div className="flex flex-wrap items-center gap-2">
                  <GradeBadge grade={result.grade} large />
                  <span className="text-sm tabular text-ink-300">{t('fb.evLoss')}: <b className="text-ink-100">{fmtNum(result.evLossBB, 2)} BB</b></span>
                  <SourceBadge cls={result.source.classification} />
                </div>
                <div className="text-sm"><CardText cards={result.heroCombo} /> · {t('pf.equity')} {result.equityPct}%</div>
                <table className="w-full text-sm tabular" data-testid="pf-options">
                  <thead className="text-xs text-ink-400"><tr><th className="text-left">{t('fb.action')}</th><th className="text-right">{t('pf.gtoFreq')}</th><th className="text-right">EV (BB)</th></tr></thead>
                  <tbody>
                    {result.options.map((o, i) => (
                      <tr key={o.key} className="border-t border-ink-800">
                        <td className="py-1"><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm" style={{ background: actionColor(o.key) }} />{o.best && <span className="text-emerald-400">★ </span>}{loc(o.label, lang)}</td>
                        <td className="text-right">{Math.round(o.freq * 100)}%</td>
                        <td className="text-right">{fmtNum(o.ev, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase text-ink-400">{t('pf.rangeStrategy')}</div>
                  <StrategyGrid byClass={result.rangeByClass} actions={result.options.map((o) => o.key)} highlight={result.heroClass} />
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-300">
                    {result.options.map((o, i) => <span key={o.key}><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: actionColor(o.key) }} />{loc(o.label, lang)} {result.overall[i]}%</span>)}
                  </div>
                </div>
                {result.ratingChanges && result.ratingChanges.length > 0 && <div className="text-xs text-ink-400">{result.ratingChanges.map((c) => `${t(`skill.${c.skill}`)} ${Math.round(c.after)} (${c.after >= c.before ? '+' : ''}${Math.round(c.after - c.before)})`).join(' · ')}</div>}
                <details className="text-xs text-ink-400"><summary className="cursor-pointer">{t('fb.method')}</summary><p className="mt-1">{loc(result.source.method, lang)}</p><p className="mt-1">{t('pf.mixNote')}</p></details>
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
