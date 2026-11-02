import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api';
import { LearningMetrics } from '../components/LearningMetrics';
import { Empty, ErrorNote, Panel, Spinner } from '../components/ui';
import { useT } from '../i18n';

interface Row { key: string; decisions: number; graded: number; accuracyPct: number | null; avgEvLossBB: number | null; evSamples: number }
interface Prog {
  ratingHistory: { skill: string; rating: number; rd: number; at: string }[];
  ratings: { skill: string; rating: number; rd: number; interval95: number; games: number }[];
  byStreet: Row[];
  byPosition: Row[];
  byStackDepth: Row[];
  byDifficulty: Row[];
  byConcept: Row[];
  byTier?: Row[];
  byActionTier?: Row[];
  calibration?: { tier: string; confidence: number; n: number; accuracyPct: number | null }[];
}

const SERIES = ['#34d399', '#60a5fa', '#f59e0b', '#f472b6', '#a78bfa', '#22d3ee', '#fb7185', '#facc15', '#4ade80', '#c084fc', '#94a3b8'];
const tooltipStyle = { background: '#111922', border: '1px solid #31455a', borderRadius: 8, fontSize: 12 };

function AccuracyTable({ rows, label }: { rows: Row[]; label: string }) {
  const { t } = useT();
  if (!rows.length) return <Empty>{t('progress.noData')}</Empty>;
  return (
    <table className="w-full text-sm tabular">
      <thead className="text-xs text-ink-400"><tr><th className="py-1 text-left">{label}</th><th className="text-right">{t('progress.n')}</th><th className="text-right">{t('dash.accuracy')}</th><th className="text-right">{t('dash.evLoss')}</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-ink-800">
            <td className="py-1">{t(`street.${r.key}`) !== `street.${r.key}` ? t(`street.${r.key}`) : r.key}</td>
            <td className="text-right text-ink-300">{r.graded}</td>
            <td className="text-right">{r.accuracyPct === null ? '—' : `${r.accuracyPct}%`}</td>
            <td className="text-right text-ink-300">{r.avgEvLossBB === null ? '—' : `${r.avgEvLossBB.toFixed(2)} BB (n=${r.evSamples})`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProgressPage() {
  const { t } = useT();
  const [p, setP] = useState<Prog | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<Prog>('/progress').then(setP).catch(setError);
  }, []);
  const overall = useMemo(() => (p?.ratingHistory ?? []).filter((h) => h.skill === 'overall').map((h, i) => ({ i: i + 1, rating: h.rating, lo: h.rating - 2 * h.rd, hi: h.rating + 2 * h.rd })), [p]);
  if (error) return <ErrorNote error={error} />;
  if (!p) return <Spinner />;
  const skills = p.ratings.filter((r) => r.skill !== 'overall');
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('nav.progress')}</h1>
      <p className="text-xs text-ink-400">{t('progress.note')}</p>
      <LearningMetrics />
      <Panel title={t('progress.ratingOverTime')}>
        {overall.length < 2 ? <Empty>{t('progress.noData')}</Empty> : (
          <div className="h-64" data-testid="rating-chart">
            <ResponsiveContainer>
              <LineChart data={overall} margin={{ left: -10, right: 10 }}>
                <CartesianGrid stroke="#223040" strokeDasharray="3 3" />
                <XAxis dataKey="i" stroke="#7b8fa3" fontSize={11} label={{ value: t('progress.ratedDecision'), position: 'insideBottom', offset: -2, fill: '#7b8fa3', fontSize: 11 }} />
                <YAxis stroke="#7b8fa3" fontSize={11} domain={['auto', 'auto']} />
                <Tooltip contentStyle={tooltipStyle} />
                <Line type="monotone" dataKey="hi" stroke="#31455a" dot={false} strokeDasharray="4 4" name={t('progress.upper')} />
                <Line type="monotone" dataKey="rating" stroke="#34d399" strokeWidth={2} dot={false} name={t('dash.rating')} />
                <Line type="monotone" dataKey="lo" stroke="#31455a" dot={false} strokeDasharray="4 4" name={t('progress.lower')} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>
      <Panel title={t('progress.bySkill')}>
        {!skills.length ? <Empty>{t('progress.noData')}</Empty> : (
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={skills.map((s) => ({ ...s, name: t(`skill.${s.skill}`) }))} margin={{ left: -10 }}>
                <CartesianGrid stroke="#223040" strokeDasharray="3 3" />
                <XAxis dataKey="name" stroke="#7b8fa3" fontSize={10} interval={0} angle={-20} textAnchor="end" height={50} />
                <YAxis stroke="#7b8fa3" fontSize={11} domain={[600, 1500]} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v, _n, item) => [`${v} ±${(item.payload as { interval95: number }).interval95}`, t('dash.rating')]} />
                <Legend />
                <Bar dataKey="rating" name={t('dash.rating')} fill={SERIES[0]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title={t('progress.byStreet')}><AccuracyTable rows={p.byStreet} label={t('progress.street')} /></Panel>
        <Panel title={t('progress.byPosition')}><AccuracyTable rows={p.byPosition} label={t('progress.position')} /></Panel>
        <Panel title={t('progress.byStack')}><AccuracyTable rows={p.byStackDepth} label="BB" /></Panel>
        <Panel title={t('progress.byDifficulty')}><AccuracyTable rows={p.byDifficulty} label={t('filter.difficulty')} /></Panel>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title={t('progress.byTier')}>
          <AccuracyTable rows={(p.byTier ?? []).map((r) => ({ ...r, key: t(`tier.${r.key}`) }))} label={t('progress.tier')} />
          <p className="mt-2 text-[11px] text-ink-500">{t('progress.tierNote')}</p>
        </Panel>
        <Panel title={t('progress.byAction')}>
          <AccuracyTable rows={(p.byActionTier ?? []).map((r) => { const [tier, act] = r.key.split(':'); return { ...r, key: `${t(`tier.${tier}`)} · ${act === 'other' ? '—' : t(`act.${act}`)}` }; })} label={t('fb2.action')} />
        </Panel>
      </div>
      <Panel title={t('progress.calibration')}>
        <table className="w-full text-sm tabular" data-testid="calibration">
          <thead className="text-xs text-ink-400"><tr><th className="py-1 text-left">{t('progress.tier')}</th><th className="text-left">{t('action.confidence')}</th><th className="text-right">{t('progress.n')}</th><th className="text-right">{t('dash.accuracy')}</th></tr></thead>
          <tbody>
            {(p.calibration ?? []).filter((c) => c.n > 0).map((c) => (
              <tr key={`${c.tier}${c.confidence}`} className="border-t border-ink-800"><td className="py-1">{t(`tier.${c.tier}`)}</td><td>{t(`confidence.${c.confidence}`)}</td><td className="text-right text-ink-300">{c.n}</td><td className="text-right">{c.accuracyPct === null ? '—' : `${c.accuracyPct}%`}</td></tr>
            ))}
          </tbody>
        </table>
        {!(p.calibration ?? []).some((c) => c.n > 0) && <Empty>{t('progress.noData')}</Empty>}
        <p className="mt-2 text-[11px] text-ink-500">{t('progress.calibrationNote')}</p>
      </Panel>
      <Panel title={t('progress.byConcept')}><AccuracyTable rows={p.byConcept} label={t('progress.concept')} /></Panel>
    </div>
  );
}
