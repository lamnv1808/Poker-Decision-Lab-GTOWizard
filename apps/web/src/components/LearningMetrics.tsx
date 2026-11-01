import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { Panel } from './ui';

interface Summary { attempts: number; graded: number; accuracyPct: number | null; avgEvLossBB: number | null; uniqueFamilies: number; medianResponseSec: number | null }
interface Metrics { tracks: Record<string, Summary>; calibration: { confidence: number; n: number; accuracyPct: number | null }[]; repeatedMistakes: { concept: string; errors: number }[]; byTopic: ({ key: string } & Summary)[]; byStreet: ({ key: string } & Summary)[]; byStandard: ({ standard: string } & Summary)[] }

/** Separate scores per track: Fundamentals, unreviewed Replay and Strategy are never merged. */
export function LearningMetrics() {
  const { t } = useT();
  const [m, setM] = useState<Metrics | null>(null);
  useEffect(() => {
    api.get<Metrics>('/real/metrics').then(setM).catch(() => setM(null));
  }, []);
  if (!m) return null;
  const tracks = ['fundamentals', 'replay', 'strategy'];
  const cell = (x: number | null, suf = '') => (x === null || x === undefined ? '—' : `${x}${suf}`);
  return (
    <Panel title={t('metrics.title')}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm tabular" data-testid="learning-metrics">
          <thead className="text-xs text-ink-400"><tr><th className="text-left"> </th><th className="text-right">{t('metrics.attempts')}</th><th className="text-right">{t('dash.accuracy')}</th><th className="text-right">{t('dash.evLoss')}</th><th className="text-right">{t('metrics.families')}</th><th className="text-right">{t('metrics.response')}</th></tr></thead>
          <tbody>
            {tracks.map((k) => {
              const s = m.tracks[k];
              return (
                <tr key={k} className="border-t border-ink-800">
                  <td className="py-1">{t(`metrics.track.${k}`)}</td>
                  <td className="text-right">{s?.attempts ?? 0}</td>
                  <td className="text-right">{k === 'replay' ? '—' : cell(s?.accuracyPct ?? null, '%')}</td>
                  <td className="text-right">{cell(s?.avgEvLossBB ?? null, ' BB')}</td>
                  <td className="text-right">{s?.uniqueFamilies ?? 0}</td>
                  <td className="text-right">{cell(s?.medianResponseSec ?? null, ' s')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 grid gap-4 md:grid-cols-3 text-xs">
        <div>
          <div className="mb-1 font-semibold uppercase text-ink-400">{t('metrics.calibration')}</div>
          {m.calibration.map((c) => <div key={c.confidence} className="flex justify-between tabular"><span>{t(`confidence.${c.confidence}`)}</span><span>{cell(c.accuracyPct, '%')} (n={c.n})</span></div>)}
        </div>
        <div>
          <div className="mb-1 font-semibold uppercase text-ink-400">{t('metrics.repeated')}</div>
          {m.repeatedMistakes.length ? m.repeatedMistakes.map((r) => <div key={r.concept} className="flex justify-between"><span>{t(`topic.${r.concept}`) !== `topic.${r.concept}` ? t(`topic.${r.concept}`) : r.concept}</span><span>{r.errors}×</span></div>) : <span className="text-ink-400">—</span>}
        </div>
        <div>
          <div className="mb-1 font-semibold uppercase text-ink-400">{t('metrics.standards')}</div>
          {m.byStandard.length ? m.byStandard.map((s) => <div key={s.standard} className="flex justify-between tabular" title={s.standard}><span className="truncate pr-2">{s.standard.split(':')[0]}</span><span>{cell(s.accuracyPct, '%')} (n={s.graded})</span></div>) : <span className="text-ink-400">—</span>}
        </div>
      </div>
      {m.byTopic.length > 0 && (
        <div className="mt-3 text-xs">
          <div className="mb-1 font-semibold uppercase text-ink-400">{t('replay.topics')}</div>
          <div className="flex flex-wrap gap-2">{m.byTopic.map((x) => <span key={x.key} className="rounded bg-ink-800 px-2 py-0.5">{t(`topic.${x.key}`) !== `topic.${x.key}` ? t(`topic.${x.key}`) : x.key}: {x.attempts}{x.accuracyPct !== null ? ` · ${x.accuracyPct}%` : ''}</span>)}</div>
        </div>
      )}
    </Panel>
  );
}
