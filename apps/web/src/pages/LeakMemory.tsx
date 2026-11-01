import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Empty, ErrorNote, Panel, Spinner, Toggle } from '../components/ui';
import { loc } from '../format';
import { useT } from '../i18n';
import type { Localized } from '../types';
import { EvidenceBadge } from './Today';

interface Memory {
  leakKey: string;
  label: Localized;
  evidence: 'solver' | 'pattern' | 'training';
  status: 'active' | 'improving' | 'resolved';
  severity: number;
  confidence: string;
  n: number;
  rate: number | null;
  ciLo: number | null;
  ciHi: number | null;
  bandLo: number | null;
  bandHi: number | null;
  evLossBB: number | null;
  recentN: number;
  recentRate: number | null;
  examples: string[];
  firstDetectedAt: string;
  timesDetected: number;
  drillCount: number;
  lastDrillAccuracy: number | null;
  reviewDueAt: string | null;
  snapshots: { at: string; rate: number | null; drillAccuracy: number | null }[];
}

const STATUS = { active: 'border-red-500/50 text-red-300', improving: 'border-emerald-500/50 text-emerald-300', resolved: 'border-ink-500 text-ink-400' };
const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

/** Persistent mistake memory from real hands and training (My Leaks). */
export function LeakMemoryPanel() {
  const { t, lang } = useT();
  const [data, setData] = useState<{ refreshedAt: string | null; leaks: Memory[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  useEffect(() => {
    api.get<{ refreshedAt: string | null; leaks: Memory[] }>('/memory').then(setData).catch(setError);
  }, []);
  const refresh = async () => {
    setBusy(true);
    try {
      setData(await api.post('/memory/refresh'));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const shown = data?.leaks.filter((l) => showResolved || l.status !== 'resolved') ?? [];
  const resolved = data?.leaks.filter((l) => l.status === 'resolved').length ?? 0;
  return (
    <Panel
      title={t('mem.title')}
      actions={<button type="button" disabled={busy} onClick={() => void refresh()} className="text-xs text-accent disabled:opacity-50" data-testid="mem-refresh">{busy ? '…' : t('mem.refresh')}</button>}
    >
      <p className="mb-2 text-xs text-ink-400">{t('mem.intro')}</p>
      <ErrorNote error={error} />
      {!data && !error && <Spinner />}
      {data && (shown.length === 0 ? <Empty>{t('mem.none')}</Empty> : (
        <ul className="space-y-2" data-testid="mem-list">
          {shown.map((l) => (
            <li key={l.leakKey} className="rounded-lg border border-ink-700 bg-ink-850 p-3" data-testid={`mem-${l.leakKey}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{loc(l.label, lang)}</span>
                <EvidenceBadge evidence={l.evidence} />
                <span className={`rounded border px-1.5 text-[10px] uppercase ${STATUS[l.status]}`}>{t(`mem.status.${l.status}`)}</span>
                <span className="text-[10px] uppercase text-ink-400">{t('leak.confidence')}: {t(`leak.conf.${l.confidence}`)}</span>
              </div>
              <div className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs tabular text-ink-300 sm:grid-cols-2">
                {l.evidence === 'pattern' && (
                  <>
                    <span>{t('mem.rate')}: <b className="text-ink-100">{pct(l.rate)}</b> ({t('mem.ci90')} {pct(l.ciLo)}–{pct(l.ciHi)}) · n {l.n}</span>
                    <span>{t('mem.band')}: {pct(l.bandLo)}–{pct(l.bandHi)} <span className="text-ink-500">({t('mem.heuristic')})</span></span>
                  </>
                )}
                {l.evidence === 'solver' && (
                  <>
                    <span>{t('mem.verifiedMistakes', { k: Math.round((l.rate ?? 0) * l.n), n: l.n })}</span>
                    <span>{t('mem.chipEv')}: <b className="text-ink-100">−{(l.evLossBB ?? 0).toFixed(2)} BB</b></span>
                  </>
                )}
                {l.evidence === 'training' && <span>{t('mem.trainingErrors', { rate: pct(l.rate), n: l.n })}</span>}
                {l.evidence !== 'training' && <span>{t('mem.recent', { rate: pct(l.recentRate), n: l.recentN })}</span>}
                <span>{t('mem.since', { d: new Date(l.firstDetectedAt).toLocaleDateString(lang), n: l.timesDetected })}</span>
                <span>
                  {t('mem.drills', { n: l.drillCount })}
                  {l.lastDrillAccuracy !== null && ` · ${t('mem.lastDrill')} ${pct(l.lastDrillAccuracy)}`}
                  {l.reviewDueAt && ` · ${t('mem.nextReview')} ${new Date(l.reviewDueAt).toLocaleDateString(lang)}`}
                </span>
              </div>
              {l.examples.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {l.examples.slice(0, 3).map((id, i) => (
                    <Link key={id} to={`/replay?decision=${id}`} className="rounded-md border border-ink-600 px-2 py-0.5 text-xs hover:border-accent">⟳ {t('mem.ownHand', { n: i + 1 })}</Link>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      ))}
      {resolved > 0 && <button type="button" onClick={() => setShowResolved((x) => !x)} className="mt-2 text-xs text-ink-400 underline">{showResolved ? t('mem.hideResolved') : t('mem.showResolved', { n: resolved })}</button>}
      {data?.refreshedAt && <p className="mt-2 text-[11px] text-ink-500">{t('mem.refreshedAt', { d: new Date(data.refreshedAt).toLocaleString(lang) })}</p>}
    </Panel>
  );
}

interface Change { current: { k: number; n: number; rate: number | null }; previous: { k: number; n: number; rate: number | null }; verdict: 'better' | 'worse' | 'noClearChange' | 'insufficient'; p: number | null }
interface Improvement {
  realPlay: { anchor: string | null; periods: { days: number; decisions: { current: number; previous: number }; solver: Change & { evLossBB: { current: number; previous: number } }; patterns: (Change & { leakKey: string; label: Localized })[] }[] };
  training: { periods: { days: number; attempts: { current: number; previous: number }; errors: Change; avgEvLossBB: { current: number | null; previous: number | null }; ratingDelta: { strategy: number | null; fundamentals: number | null }; dailySessions: number; drills: { leakKey: string; label: Localized; sessions: number; first: number; last: number }[] }[] };
}

const VERDICT = { better: 'text-emerald-300', worse: 'text-red-300', noClearChange: 'text-ink-300', insufficient: 'text-ink-500' };

function Verdict({ c }: { c: Change }) {
  const { t } = useT();
  return <span className={`text-xs ${VERDICT[c.verdict]}`} title={c.p !== null ? `p = ${c.p}` : undefined}>{t(`imp.${c.verdict}`)}</span>;
}

const side = (c: Change['current']) => (c.n ? `${(c.rate! * 100).toFixed(1)}% (${c.k}/${c.n})` : '—');

/** 7/30/60-day improvement: real play and training, never mixed. */
export function ImprovementPanel() {
  const { t, lang } = useT();
  const [days, setDays] = useState<'7' | '30' | '60'>('30');
  const [r, setR] = useState<Improvement | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<Improvement>('/improvement').then(setR).catch(setError);
  }, []);
  const rp = r?.realPlay.periods.find((p) => p.days === Number(days));
  const tr = r?.training.periods.find((p) => p.days === Number(days));
  const signed = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : ''}${x}`);
  return (
    <Panel title={t('imp.title')} actions={<Toggle label={t('imp.title')} value={days} onChange={setDays} options={(['7', '30', '60'] as const).map((d) => ({ value: d, label: t('imp.days', { n: d }) }))} />}>
      <ErrorNote error={error} />
      {!r && !error && <Spinner />}
      {r && (
        <div className="grid gap-4 md:grid-cols-2" data-testid="improvement">
          <div>
            <h3 className="mb-1 text-sm font-semibold">{t('imp.realPlay')}</h3>
            {!rp ? <Empty>{t('imp.noHands')}</Empty> : (
              <>
                <p className="mb-2 text-[11px] text-ink-500">{t('imp.realAnchor', { d: new Date(r.realPlay.anchor!).toLocaleDateString(lang), n: rp.decisions.current, p: rp.decisions.previous })}</p>
                <table className="w-full text-xs tabular">
                  <thead className="text-ink-400"><tr><th className="text-left" /><th className="text-right">{t('imp.current')}</th><th className="text-right">{t('imp.previous')}</th><th className="text-right" /></tr></thead>
                  <tbody>
                    <tr className="border-t border-ink-800"><td className="py-1">{t('imp.solverMistakes')}</td><td className="text-right">{side(rp.solver.current)}</td><td className="text-right">{side(rp.solver.previous)}</td><td className="text-right"><Verdict c={rp.solver} /></td></tr>
                    {rp.patterns.map((p) => (
                      <tr key={p.leakKey} className="border-t border-ink-800"><td className="py-1">{loc(p.label, lang)}</td><td className="text-right">{side(p.current)}</td><td className="text-right">{side(p.previous)}</td><td className="text-right"><Verdict c={p} /></td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold">{t('imp.training')}</h3>
            {tr && (
              <table className="w-full text-xs tabular">
                <tbody>
                  <tr className="border-t border-ink-800"><td className="py-1">{t('imp.attempts')}</td><td className="text-right">{tr.attempts.current}</td><td className="text-right text-ink-400">{tr.attempts.previous}</td><td /></tr>
                  <tr className="border-t border-ink-800"><td className="py-1">{t('imp.errorRate')}</td><td className="text-right">{side(tr.errors.current)}</td><td className="text-right text-ink-400">{side(tr.errors.previous)}</td><td className="text-right"><Verdict c={tr.errors} /></td></tr>
                  <tr className="border-t border-ink-800"><td className="py-1">{t('fb.evLoss')}</td><td className="text-right">{tr.avgEvLossBB.current === null ? '—' : `${tr.avgEvLossBB.current.toFixed(2)} BB`}</td><td className="text-right text-ink-400">{tr.avgEvLossBB.previous === null ? '—' : `${tr.avgEvLossBB.previous.toFixed(2)} BB`}</td><td /></tr>
                  <tr className="border-t border-ink-800"><td className="py-1">{t('dash.strategyRating')}</td><td className="text-right">{signed(tr.ratingDelta.strategy)}</td><td /><td /></tr>
                  <tr className="border-t border-ink-800"><td className="py-1">{t('dash.fundamentalsRating')}</td><td className="text-right">{signed(tr.ratingDelta.fundamentals)}</td><td /><td /></tr>
                  <tr className="border-t border-ink-800"><td className="py-1">{t('imp.dailySessions')}</td><td className="text-right">{tr.dailySessions}</td><td /><td /></tr>
                </tbody>
              </table>
            )}
            {tr && tr.drills.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs">
                {tr.drills.map((d) => <li key={d.leakKey}>{loc(d.label, lang)}: {t('imp.drillAcc', { n: d.sessions, a: Math.round(d.first * 100), b: Math.round(d.last * 100) })}</li>)}
              </ul>
            )}
          </div>
          <p className="text-[11px] text-ink-500 md:col-span-2">{t('imp.method')}</p>
        </div>
      )}
    </Panel>
  );
}
