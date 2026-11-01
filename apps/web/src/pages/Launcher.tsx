import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api';
import { ErrorNote, Panel, Toggle } from '../components/ui';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { RunView } from '../types';

export interface LauncherFilters {
  module: string;
  difficulty: number;
  ratedOnly: boolean;
  mode: 'practice' | 'rated';
  /** Which scenarios to draw from — New Only by default (never repeats while unseen ones exist). */
  pool?: Pool;
}
export type Pool = 'new' | 'newDue' | 'all' | 'played' | 'bookmarked' | 'weak';
const POOLS: Pool[] = ['new', 'newDue', 'all', 'played', 'bookmarked', 'weak'];

const KEY = (kind: string) => `pdl.launcher.${kind}`;

/** Last-used launcher filters are a per-device UI convenience (not training data). */
export function loadFilters(kind: 'hero' | 'villain', fallbackMode: 'practice' | 'rated'): LauncherFilters {
  try {
    const raw = localStorage.getItem(KEY(kind));
    if (raw) return { module: '', difficulty: 0, ratedOnly: false, mode: fallbackMode, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { module: '', difficulty: 0, ratedOnly: false, mode: fallbackMode };
}
function saveFilters(kind: string, f: LauncherFilters) {
  try {
    localStorage.setItem(KEY(kind), JSON.stringify(f));
  } catch {
    /* ignore */
  }
}

/** Start (or continue to) a randomly picked scenario: due reviews first, then new, then any. */
export function useNextTest() {
  const nav = useNavigate();
  return async (kind: 'hero' | 'villain', f: LauncherFilters, excludeScenarioId?: string) => {
    saveFilters(kind, f);
    const r = await api.post<RunView>('/runs/next', {
      kind,
      mode: f.mode,
      module: f.module || undefined,
      difficulty: f.difficulty || undefined,
      ratedOnly: f.ratedOnly,
      excludeScenarioId,
      pool: f.pool ?? 'new',
    });
    nav(`/run/${r.runId}`);
  };
}

const MODULES = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18'];

export function Launcher({ kind }: { kind: 'hero' | 'villain' }) {
  const { t } = useT();
  const defaultMode = useApp((s) => s.me?.preferences.defaultMode ?? 'practice');
  const [f, setF] = useState<LauncherFilters>(() => loadFilters(kind, defaultMode));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [exhausted, setExhausted] = useState<null | { counts: { available: number; completed: number; due: number } }>(() => (new URLSearchParams(window.location.search).get('exhausted') ? { counts: { available: 0, completed: 0, due: 0 } } : null));
  const [summary, setSummary] = useState<null | Record<'hero' | 'villain', { available: number; completed: number; mastered: number; due: number; new: number }>>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const nav = useNavigate();
  const next = useNextTest();
  const loadSummary = () => void api.get<typeof summary>('/history/summary').then(setSummary).catch(() => {});
  useEffect(loadSummary, []);
  const start = async (override?: Partial<LauncherFilters>) => {
    setBusy(true);
    setError(null);
    setExhausted(null);
    const ff = { ...f, ...override };
    setF(ff);
    try {
      await next(kind, ff);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'pool_exhausted') setExhausted({ counts: (e as ApiError & { body?: { counts: { available: number; completed: number; due: number } } }).body?.counts ?? { available: 0, completed: 0, due: 0 } });
      else setError(e);
      setBusy(false);
    }
  };
  const sum = summary?.[kind];
  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div>
        <h1 className="text-xl font-bold">{t(`nav.${kind}`)}</h1>
        <p className="text-sm text-ink-300">{t(`${kind}.intro`)}</p>
      </div>
      <Panel>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-ink-300">
              {t('filter.module')}
              <select value={f.module} onChange={(e) => setF({ ...f, module: e.target.value })} className="mt-1 w-full rounded-md border border-ink-600 bg-ink-850 px-2 py-2 text-sm" data-testid="launch-module">
                <option value="">{t('filter.allModules')}</option>
                {MODULES.map((m) => <option key={m} value={m}>{m} · {t(`moduleName.${m}`)}</option>)}
              </select>
            </label>
            <label className="text-xs text-ink-300">
              {t('filter.difficulty')}
              <select value={f.difficulty} onChange={(e) => setF({ ...f, difficulty: Number(e.target.value) })} className="mt-1 w-full rounded-md border border-ink-600 bg-ink-850 px-2 py-2 text-sm">
                <option value={0}>{t('filter.allDifficulty')}</option>
                {[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{t('filter.difficulty')} {d}</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-ink-300"><input type="checkbox" checked={f.ratedOnly} onChange={(e) => setF({ ...f, ratedOnly: e.target.checked })} /> {t('filter.ratedOnly')}</label>
            <Toggle label={t('mode.label')} value={f.mode} onChange={(mode) => setF({ ...f, mode })} options={[{ value: 'practice', label: t('mode.practice') }, { value: 'rated', label: t('mode.rated') }]} />
          </div>
          <label className="block text-xs text-ink-300">
            {t('pool.label')}
            <select value={f.pool ?? 'new'} onChange={(e) => setF({ ...f, pool: e.target.value as Pool })} className="mt-1 w-full rounded-md border border-ink-600 bg-ink-850 px-2 py-2 text-sm" data-testid="launch-pool">
              {POOLS.map((p) => <option key={p} value={p}>{t(`pool.${p}`)}</option>)}
            </select>
          </label>
          {sum && (
            <div className="rounded-lg bg-ink-850 px-3 py-2 text-xs text-ink-300" data-testid="launch-progress">
              <b className="text-ink-100">{t('progress.uniqueDone', { n: sum.completed, total: sum.available })}</b> · {t('status.mastered')} {sum.mastered} · {t('status.due')} {sum.due} · {t('status.new')} {sum.new}
            </div>
          )}
          <p className="text-xs text-ink-400">{t('launch.how')}</p>
          <ErrorNote error={error} />
          {exhausted && (
            <div className="space-y-2 rounded-lg border border-gold/40 bg-gold/5 p-3 text-sm" data-testid="pool-exhausted">
              <p>{t('pool.exhausted')}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void start({ pool: 'newDue' })} className="rounded-md border border-ink-600 px-3 py-1">{t('pool.newDue')}</button>
                <button type="button" onClick={() => void start({ pool: 'weak' })} className="rounded-md border border-ink-600 px-3 py-1">{t('pool.weak')}</button>
                <button type="button" onClick={() => void start({ pool: 'all' })} className="rounded-md border border-ink-600 px-3 py-1">{t('pool.all')}</button>
                <button type="button" onClick={() => nav('/play')} className="rounded-md bg-felt-500 px-3 py-1 font-semibold">{t('pool.tryFullHand')}</button>
              </div>
            </div>
          )}
          <button type="button" disabled={busy} onClick={() => void start()} className="w-full rounded-xl bg-felt-500 py-4 text-lg font-bold hover:bg-felt-600 disabled:opacity-50" data-testid="launch-start">
            {t('launch.start')}
          </button>
        </div>
      </Panel>
      <div className="text-center text-sm">
        <Link to={`/${kind}/browse`} className="text-ink-400 hover:text-accent" data-testid="launch-browse">{t('launch.browse')}</Link>
      </div>
      <div className="text-center text-xs text-ink-500">
        {!confirmReset ? (
          <button type="button" onClick={() => setConfirmReset(true)} className="hover:text-ink-300" data-testid="history-reset">{t('history.reset')}</button>
        ) : (
          <span className="space-x-2">
            <span className="text-ink-300">{t('history.resetConfirm')}</span>
            <button type="button" className="text-red-300" data-testid="history-reset-confirm" onClick={() => void api.post('/history/reset', { confirm: true }).then(() => { setConfirmReset(false); loadSummary(); })}>{t('history.resetYes')}</button>
            <button type="button" onClick={() => setConfirmReset(false)}>{t('history.resetNo')}</button>
          </span>
        )}
      </div>
    </div>
  );
}
