import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Difficulty, Empty, ErrorNote, SourceBadge, Spinner, Toggle } from '../components/ui';
import { loc } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { RunView, ScenarioCard } from '../types';

export function useStartRun() {
  const nav = useNavigate();
  return async (scenarioId: string, mode: 'practice' | 'rated') => {
    const r = await api.post<RunView>('/runs', { scenarioId, mode });
    nav(`/run/${r.runId}`);
  };
}

export function ScenarioList({ mode }: { mode: 'hero' | 'villain' }) {
  const { t, lang } = useT();
  const defaultMode = useApp((s) => s.me?.preferences.defaultMode ?? 'practice');
  const [items, setItems] = useState<ScenarioCard[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [params] = useSearchParams();
  const [module, setModule] = useState(params.get('module') ?? '');
  const [diff, setDiff] = useState(0);
  const [ratedOnly, setRatedOnly] = useState(false);
  const [runMode, setRunMode] = useState<'practice' | 'rated'>(defaultMode);
  const start = useStartRun();
  const load = () => api.get<ScenarioCard[]>(`/scenarios?mode=${mode}`).then(setItems).catch(setError);
  useEffect(() => {
    void load();
  }, [mode]);
  const modules = useMemo(() => [...new Set(items?.map((i) => i.module) ?? [])].sort(), [items]);
  const shown = (items ?? []).filter((i) => (!module || i.module === module) && (!diff || i.difficulty === diff) && (!ratedOnly || i.rated));
  const toggleBookmark = async (s: ScenarioCard) => {
    if (s.bookmarked) await api.del(`/bookmarks/${s.id}`);
    else await api.put(`/bookmarks/${s.id}`);
    void load();
  };
  return (
    <div className="space-y-4">
      <div>
        <Link to={`/${mode}`} className="text-xs text-accent">← {t('launch.back')}</Link>
        <h1 className="text-xl font-bold">{t(`nav.${mode}`)} · {t('launch.allScenarios')}</h1>
        <p className="text-sm text-ink-300">{t(`${mode}.intro`)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <select aria-label={t('filter.module')} value={module} onChange={(e) => setModule(e.target.value)} className="rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5">
          <option value="">{t('filter.allModules')}</option>
          {modules.map((m) => <option key={m} value={m}>{t('module')} {m} · {t(`moduleName.${m}`)}</option>)}
        </select>
        <select aria-label={t('filter.difficulty')} value={diff} onChange={(e) => setDiff(Number(e.target.value))} className="rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5">
          <option value={0}>{t('filter.allDifficulty')}</option>
          {[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{t('filter.difficulty')} {d}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-ink-300"><input type="checkbox" checked={ratedOnly} onChange={(e) => setRatedOnly(e.target.checked)} /> {t('filter.ratedOnly')}</label>
        <div className="ml-auto"><Toggle label={t('mode.label')} value={runMode} onChange={setRunMode} options={[{ value: 'practice', label: t('mode.practice') }, { value: 'rated', label: t('mode.rated') }]} /></div>
      </div>
      <p className="text-xs text-ink-400">{t('mode.help')}</p>
      <ErrorNote error={error} />
      {!items ? <Spinner /> : shown.length === 0 ? <Empty>{t('list.empty')}</Empty> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="scenario-list">
          {shown.map((s) => (
            <article key={s.id} className="flex flex-col rounded-xl border border-ink-700 bg-ink-900 p-4" data-testid={`scenario-${s.id}`}>
              <div className="flex items-center gap-2 text-[11px] text-ink-400">
                <span>{t('module')} {s.module}</span>
                <Difficulty n={s.difficulty} />
                <span>{s.format.game} · {s.format.tableSize}-max</span>
                <button type="button" onClick={() => void toggleBookmark(s)} aria-label={t('list.bookmark')} aria-pressed={s.bookmarked} className={`ml-auto text-base ${s.bookmarked ? 'text-gold' : 'text-ink-600 hover:text-ink-300'}`}>★</button>
              </div>
              <h3 className="mt-1 font-semibold leading-snug">{loc(s.title, lang)}</h3>
              <p className="mt-1 flex-1 text-sm text-ink-300">{loc(s.summary, lang)}</p>
              <div className="mt-3 flex items-center gap-2">
                <SourceBadge cls={s.classification} />
                {!s.rated && <span className="text-[10px] text-ink-400">{t('list.practiceOnly')}</span>}
                {s.mastery !== null && <span className="text-[10px] text-ink-400">{t('list.mastery')} {Math.round(s.mastery * 100)}%</span>}
                {s.attempted && s.mastery === null && <span className="text-[10px] text-emerald-400">✓</span>}
                <button type="button" onClick={() => start(s.id, runMode).catch(setError)} className="ml-auto rounded-lg bg-felt-500 px-3 py-1.5 text-sm font-semibold hover:bg-felt-600" data-testid={`start-${s.id}`}>
                  {t('list.start')}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
