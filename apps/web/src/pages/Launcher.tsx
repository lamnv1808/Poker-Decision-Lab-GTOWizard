import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ErrorNote, Panel, Toggle } from '../components/ui';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { RunView } from '../types';

export interface LauncherFilters {
  module: string;
  difficulty: number;
  ratedOnly: boolean;
  mode: 'practice' | 'rated';
}

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
  const next = useNextTest();
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await next(kind, f);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
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
          <p className="text-xs text-ink-400">{t('launch.how')}</p>
          <ErrorNote error={error} />
          <button type="button" disabled={busy} onClick={() => void start()} className="w-full rounded-xl bg-felt-500 py-4 text-lg font-bold hover:bg-felt-600 disabled:opacity-50" data-testid="launch-start">
            {t('launch.start')}
          </button>
        </div>
      </Panel>
      <div className="text-center text-sm">
        <Link to={`/${kind}/browse`} className="text-ink-400 hover:text-accent" data-testid="launch-browse">{t('launch.browse')}</Link>
      </div>
    </div>
  );
}
