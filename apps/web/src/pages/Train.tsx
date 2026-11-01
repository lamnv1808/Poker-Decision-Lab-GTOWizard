import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Difficulty, Empty, ErrorNote, Panel, SourceBadge, Spinner, Toggle } from '../components/ui';
import { loc } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { Localized } from '../types';
import { useStartRun } from './ScenarioList';

type Filter = 'due' | 'weak' | 'bookmarked' | 'missed' | 'new' | 'mixed';
interface QueueItem {
  kind: 'scenario' | 'quiz' | 'imported';
  ref: string;
  reason: string;
  dueAt?: string | null;
  mastery?: number | null;
  lastGrade?: string | null;
  scenario?: { id: string; title: Localized; difficulty: number; classification: string; module: string } | null;
  hand?: { id: string; externalHandId: string; heroPosition: string | null } | null;
}

export function Train() {
  const { t, lang } = useT();
  const defaultMode = useApp((s) => s.me?.preferences.defaultMode ?? 'practice');
  const [filter, setFilter] = useState<Filter>('due');
  const [mode, setMode] = useState<'practice' | 'rated'>(defaultMode);
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const start = useStartRun();
  const nav = useNavigate();
  useEffect(() => {
    setItems(null);
    api.get<QueueItem[]>(`/review/queue?filter=${filter}`).then(setItems).catch(setError);
  }, [filter]);
  const open = (i: QueueItem) => {
    if (i.kind === 'scenario') void start(i.ref, mode).catch(setError);
    else if (i.kind === 'quiz') nav(i.ref === 'gto' ? '/gto' : `/math?kind=${i.ref}`);
    else nav(`/hands/${i.ref.split(':')[0]}?spot=${i.ref.split(':')[1]}`);
  };
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold">{t('nav.train')}</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {['gto', 'hero', 'villain', 'math', 'hands'].map((k) => (
          <Link key={k} to={`/${k}`} className="rounded-xl border border-ink-700 bg-ink-900 p-4 hover:border-ink-500">
            <div className="font-semibold">{t(`nav.${k}`)}</div>
            <div className="text-sm text-ink-300">{t(`${k}.intro`)}</div>
          </Link>
        ))}
      </div>
      <Panel
        title={t('train.queue')}
        actions={<Toggle label={t('mode.label')} value={mode} onChange={setMode} options={[{ value: 'practice', label: t('mode.practice') }, { value: 'rated', label: t('mode.rated') }]} />}
      >
        <div className="mb-3 flex flex-wrap gap-1.5">
          {(['due', 'missed', 'weak', 'bookmarked', 'new', 'mixed'] as Filter[]).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={`rounded-full border px-3 py-1 text-xs ${filter === f ? 'border-accent bg-accent/10 text-accent' : 'border-ink-600 text-ink-300'}`} data-testid={`queue-${f}`}>
              {t(`queue.${f}`)}
            </button>
          ))}
        </div>
        <ErrorNote error={error} />
        {!items ? <Spinner /> : items.length === 0 ? <Empty>{t('queue.empty')}</Empty> : (
          <ul className="divide-y divide-ink-800" data-testid="queue-list">
            {items.map((i) => (
              <li key={`${i.kind}:${i.ref}`} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className="w-20 text-[10px] uppercase text-ink-400">{t(`queue.reason.${i.reason}`)}</span>
                <div className="min-w-0 flex-1">
                  {i.kind === 'scenario' && i.scenario && (
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{loc(i.scenario.title, lang)}</span>
                      <Difficulty n={i.scenario.difficulty} />
                      <SourceBadge cls={i.scenario.classification} />
                    </div>
                  )}
                  {i.kind === 'quiz' && <span className="text-sm">{i.ref === 'gto' ? t('nav.gto') : `${t('nav.math')} · ${t(`quiz.${i.ref}`)}`}</span>}
                  {i.kind === 'imported' && <span className="text-sm">{t('nav.hands')} · #{i.hand?.externalHandId} · {t('hands.spot')} {Number(i.ref.split(':')[1]) + 1}</span>}
                  <div className="text-[11px] text-ink-400">
                    {i.mastery != null && <>{t('list.mastery')} {Math.round(i.mastery * 100)}% · </>}
                    {i.dueAt && <>{t('queue.due')} {new Date(i.dueAt).toLocaleDateString(lang)}</>}
                    {i.lastGrade && <> · {t(`grade.${i.lastGrade}`)}</>}
                  </div>
                </div>
                <button type="button" onClick={() => open(i)} className="rounded-lg border border-ink-600 px-3 py-1 text-sm hover:border-accent">{t('queue.practice')}</button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
