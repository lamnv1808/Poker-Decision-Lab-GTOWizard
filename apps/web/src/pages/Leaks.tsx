import { useEffect, useState } from 'react';
import { api } from '../api';
import { Empty, ErrorNote, Panel, Spinner } from '../components/ui';
import { loc } from '../format';
import { useT } from '../i18n';
import type { Localized } from '../types';
import { useStartRun } from './ScenarioList';
import { ImprovementPanel, LeakMemoryPanel } from './LeakMemory';

interface Leak {
  leak: string;
  label: Localized;
  opportunities: number;
  errors: number;
  errorRate: number;
  errorRateLower: number;
  avgEvLossBB: number | null;
  severity: 'low' | 'medium' | 'high';
  confidence: string;
  trend: number | null;
  lastPracticed: string | null;
  ranked: boolean;
  recommended: { id: string; title: Localized; mastery: number | null }[];
  nextReview: string | null;
}

const SEV = { high: 'text-red-300 border-red-500/40', medium: 'text-amber-300 border-amber-500/40', low: 'text-sky-300 border-sky-500/40' };

export function LeaksPage() {
  const { t, lang } = useT();
  const [leaks, setLeaks] = useState<Leak[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const start = useStartRun();
  useEffect(() => {
    api.get<Leak[]>('/leaks').then(setLeaks).catch(setError);
  }, []);
  if (error) return <ErrorNote error={error} />;
  if (!leaks) return <Spinner />;
  const ranked = leaks.filter((l) => l.ranked);
  const pending = leaks.filter((l) => !l.ranked);
  const row = (l: Leak) => (
    <li key={l.leak} className="rounded-lg border border-ink-700 bg-ink-850 p-3" data-testid={`leak-${l.leak}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{loc(l.label, lang)}</span>
        {l.ranked && <span className={`rounded border px-1.5 text-[10px] uppercase ${SEV[l.severity]}`}>{t(`leak.sev.${l.severity}`)}</span>}
        <span className="text-[10px] uppercase text-ink-400">{t('leak.confidence')}: {t(`leak.conf.${l.confidence}`)}</span>
        {l.trend !== null && <span className={`text-xs ${l.trend < 0 ? 'text-emerald-400' : l.trend > 0 ? 'text-red-400' : 'text-ink-400'}`}>{l.trend < 0 ? `↘ ${t('leak.improving')}` : l.trend > 0 ? `↗ ${t('leak.worsening')}` : '→'}</span>}
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-4 text-xs tabular text-ink-300 sm:grid-cols-4">
        <span>{t('leak.opps')}: {l.opportunities}</span>
        <span>{t('leak.errors')}: {l.errors} ({Math.round(l.errorRate * 100)}%)</span>
        <span>{t('leak.evLoss')}: {l.avgEvLossBB === null ? '—' : `${l.avgEvLossBB.toFixed(2)} BB`}</span>
        <span>{t('leak.last')}: {l.lastPracticed ? new Date(l.lastPracticed).toLocaleDateString(lang) : '—'}</span>
      </div>
      {l.recommended.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {l.recommended.map((r) => (
            <button key={r.id} type="button" onClick={() => void start(r.id, 'practice')} className="rounded-md border border-ink-600 px-2 py-1 text-xs hover:border-accent">
              ▶ {loc(r.title, lang)}
            </button>
          ))}
        </div>
      )}
    </li>
  );
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">{t('nav.leaks')}</h1>
        <p className="text-sm text-ink-300">{t('leak.pageIntro')}</p>
      </div>
      <LeakMemoryPanel />
      <ImprovementPanel />
      <h2 className="pt-2 text-lg font-semibold">{t('leak.trainingTitle')}</h2>
      <p className="text-sm text-ink-300">{t('leak.intro')}</p>
      <Panel title={t('leak.ranked')}>{ranked.length ? <ul className="space-y-2">{ranked.map(row)}</ul> : <Empty>{t('leak.noneRanked')}</Empty>}</Panel>
      {pending.length > 0 && <Panel title={t('leak.pending')}><ul className="space-y-2">{pending.map(row)}</ul></Panel>}
    </div>
  );
}
