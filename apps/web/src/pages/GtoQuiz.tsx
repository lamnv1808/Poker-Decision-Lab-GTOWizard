import type { HandState } from '@pdl/core/engine';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, newAttemptId } from '../api';
import { GtoGrid } from '../components/GtoGrid';
import { PokerTable } from '../components/PokerTable';
import { GtoPostflop } from './GtoPostflop';
import { ErrorNote, GradeBadge, Panel, SourceBadge, Spinner, Toggle } from '../components/ui';
import { fmtNum, loc } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { Grade, Localized } from '../types';

type Role = 'sbShove' | 'bbCall';
interface Spot { token: string; role: Role; stackBB: number; deadBB: number; anteLabel: Localized; heroId: string; heroCards: string[]; bigBlind: number; state: HandState }
interface Result {
  heroClass: string;
  action: string;
  grade: Grade;
  evLossBB: number;
  frequency: number;
  evAggressive: number;
  bestAction: string;
  ranges: { push: Record<string, number>; call: Record<string, number> };
  pushPct: number;
  callPct: number;
  exploitabilityBB: number;
  assumptions: { en: string[]; vi: string[] };
  source: { classification: string; method: Localized };
  ratingChanges?: { skill: string; before: number; after: number }[];
}

export function GtoQuiz() {
  const { t, lang } = useT();
  const showBB = useApp((s) => s.me?.preferences.showBB ?? true);
  const [role, setRole] = useState<'any' | Role>('any');
  const [range, setRange] = useState<'2-15' | '2-7' | '7-11' | '11-15'>('2-15');
  const [mode, setMode] = useState<'rated' | 'practice'>('rated');
  const [spot, setSpot] = useState<Spot | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'push' | 'call'>('push');
  const [stats, setStats] = useState({ n: 0, ok: 0, ev: 0, streak: 0 });
  const [street, setStreet] = useState<'preflop' | 'postflop'>(() => (new URLSearchParams(window.location.search).get('street') === 'postflop' ? 'postflop' : 'preflop'));

  const next = useCallback(async () => {
    setResult(null);
    setError(null);
    const [lo, hi] = range.split('-');
    try {
      setSpot(await api.get<Spot>(`/gto/spot?minStack=${lo}&maxStack=${hi}&role=${role}`));
    } catch (e) {
      setError(e);
    }
  }, [range, role]);
  useEffect(() => {
    if (street === 'preflop') void next();
  }, [next, street]);

  const answer = useCallback(
    async (action: 'shove' | 'call' | 'fold') => {
      if (!spot || result || busy) return;
      setBusy(true);
      try {
        const r = await api.post<Result>('/gto/answer', { token: spot.token, action, clientAttemptId: newAttemptId(), mode });
        setResult(r);
        setView(spot.role === 'sbShove' ? 'push' : 'call');
        const ok = r.evLossBB < 0.05;
        setStats((s) => ({ n: s.n + 1, ok: s.ok + (ok ? 1 : 0), ev: s.ev + r.evLossBB, streak: ok ? s.streak + 1 : 0 }));
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
      if (street !== 'preflop') return;
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (!spot) return;
      const k = e.key.toLowerCase();
      if (!result && k === 'f') void answer('fold');
      if (!result && (k === 's' || k === 'c')) void answer(spot.role === 'sbShove' ? 'shove' : 'call');
      if (result && (k === 'enter' || k === 'n' || k === ' ')) {
        e.preventDefault();
        void next();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [spot, result, answer, next, street]);

  const aggressive = spot?.role === 'sbShove' ? 'shove' : 'call';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">{t('nav.gto')}</h1>
          <p className="text-sm text-ink-300">{t('gto.intro')}</p>
        </div>
        <Link to="/gto/audit" className="rounded-lg border border-ink-600 px-3 py-1.5 text-sm hover:border-accent" data-testid="audit-link">{t('nav.audit')} →</Link>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Toggle label={t('pf.street')} value={street} onChange={setStreet} options={[{ value: 'preflop', label: t('pf.tabPreflop') }, { value: 'postflop', label: t('pf.tabPostflop') }]} />
      </div>
      {street === 'postflop' ? <GtoPostflop mode={mode} /> : (<>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Toggle label={t('gto.role')} value={role} onChange={setRole} options={[{ value: 'any', label: t('gto.any') }, { value: 'sbShove', label: t('gto.sbShove') }, { value: 'bbCall', label: t('gto.bbCall') }]} />
        <Toggle label={t('gto.stacks')} value={range} onChange={setRange} options={[{ value: '2-15', label: '2–15BB' }, { value: '2-7', label: '2–7' }, { value: '7-11', label: '7–11' }, { value: '11-15', label: '11–15' }]} />
        <div className="ml-auto"><Toggle label={t('mode.label')} value={mode} onChange={setMode} options={[{ value: 'practice', label: t('mode.practice') }, { value: 'rated', label: t('mode.rated') }]} /></div>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-ink-300 tabular" data-testid="gto-stats">
        <span>{t('gto.answered')}: <b className="text-ink-100">{stats.n}</b></span>
        <span>{t('gto.correct')}: <b className="text-ink-100">{stats.n ? Math.round((100 * stats.ok) / stats.n) : 0}%</b></span>
        <span>{t('gto.evLost')}: <b className="text-ink-100">{fmtNum(stats.ev, 2)} BB</b></span>
        <span>{t('gto.streak')}: <b className="text-gold">{stats.streak}</b></span>
      </div>
      <ErrorNote error={error} />
      {!spot ? <Spinner /> : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="gto-spot">
              <span className="rounded-md bg-ink-800 px-2 py-1 font-semibold">{spot.role === 'sbShove' ? t('gto.foldedToSb') : t('gto.sbShoves')}</span>
              <span className="rounded-md bg-ink-800 px-2 py-1 tabular">{t('gto.effective')}: <b>{spot.stackBB} BB</b></span>
              <span className="rounded-md bg-ink-800 px-2 py-1">{loc(spot.anteLabel, lang)}</span>
            </div>
            <PokerTable state={spot.state} heroId={spot.heroId} bigBlind={spot.bigBlind} showBB={showBB} heroCards={spot.heroCards} />
            {!result ? (
              <div className="grid grid-cols-2 gap-3" data-testid="gto-actions">
                <button type="button" disabled={busy} onClick={() => void answer('fold')} className="rounded-xl bg-red-900/70 py-4 text-base font-bold text-red-100 hover:bg-red-800">{t('act.fold')} <span className="text-xs opacity-60">(F)</span></button>
                <button type="button" disabled={busy} onClick={() => void answer(aggressive)} className="rounded-xl bg-gold py-4 text-base font-bold text-ink-950 hover:brightness-110">
                  {spot.role === 'sbShove' ? t('gto.shove') : t('act.call')} <span className="text-xs opacity-60">({spot.role === 'sbShove' ? 'S' : 'C'})</span>
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => void next()} className="w-full rounded-xl bg-felt-500 py-4 text-base font-bold hover:bg-felt-600" data-testid="gto-next">{t('gto.next')} <span className="text-xs opacity-60">(Enter)</span></button>
            )}
          </div>
          <Panel title={t('run.feedback')}>
            {!result ? (
              <p className="text-sm text-ink-400">{t('gto.hint')}</p>
            ) : (
              <div className="space-y-3" data-testid="gto-result">
                <div className="flex flex-wrap items-center gap-2">
                  <GradeBadge grade={result.grade} large />
                  <span className="text-sm tabular text-ink-300">{t('fb.evLoss')}: <b className="text-ink-100">{fmtNum(result.evLossBB, 2)} BB</b></span>
                  <SourceBadge cls={result.source.classification} />
                </div>
                <div className="rounded-lg bg-ink-850 p-3 text-sm">
                  <div>
                    <b className="font-mono">{result.heroClass}</b>: {t('gto.equilibrium')}{' '}
                    <b className="text-emerald-300">{result.bestAction === 'mixed' ? `${t('gto.mixed')} (${Math.round(result.frequency * 100)}% ${spot.role === 'sbShove' ? t('gto.shove') : t('act.call')})` : result.bestAction === 'fold' ? t('act.fold') : spot.role === 'sbShove' ? t('gto.shove') : t('act.call')}</b>
                  </div>
                  <div className="mt-1 text-xs tabular text-ink-300">
                    EV({spot.role === 'sbShove' ? t('gto.shove') : t('act.call')}) = {fmtNum(result.evAggressive, 2)} BB · EV({t('act.fold')}) = 0
                  </div>
                </div>
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase text-ink-400">{view === 'push' ? `${t('gto.sbRange')} ${result.pushPct}%` : `${t('gto.bbRange')} ${result.callPct}%`}</span>
                    <Toggle label={t('gto.range')} value={view} onChange={setView} options={[{ value: 'push', label: t('gto.sbShort') }, { value: 'call', label: t('gto.bbShort') }]} />
                  </div>
                  <GtoGrid freq={view === 'push' ? result.ranges.push : result.ranges.call} highlight={result.heroClass} testId="gto-grid" />
                </div>
                {result.ratingChanges && result.ratingChanges.length > 0 && (
                  <div className="text-xs text-ink-400">{result.ratingChanges.map((c) => `${t(`skill.${c.skill}`)} ${Math.round(c.after)} (${c.after >= c.before ? '+' : ''}${Math.round(c.after - c.before)})`).join(' · ')}</div>
                )}
                <details className="text-xs text-ink-400">
                  <summary className="cursor-pointer">{t('fb.assumptions')}</summary>
                  <ul className="mt-1 list-disc pl-5">{result.assumptions[lang].map((a, i) => <li key={i}>{a}</li>)}</ul>
                  <p className="mt-1">{loc(result.source.method, lang)}</p>
                </details>
              </div>
            )}
          </Panel>
        </div>
      )}
      </>)}
    </div>
  );
}
