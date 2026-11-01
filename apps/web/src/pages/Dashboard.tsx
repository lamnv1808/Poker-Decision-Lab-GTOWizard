import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Empty, ErrorNote, Panel, Spinner, Stat } from '../components/ui';
import { fmtNum, fmtPct, loc } from '../format';
import { useT } from '../i18n';
import type { Localized } from '../types';

interface Dash {
  rating: { rating: number; rd: number; interval95: number; games: number } | null;
  ratingChange7d: number | null;
  sessions: number;
  decisions: number;
  graded: number;
  accuracyPct: number | null;
  avgEvLossBB: number | null;
  evSamples: number;
  strengths: { skill: string; rating: number; rd: number }[];
  weaknesses: { skill: string; rating: number; rd: number }[];
  provisionalSkills: string[];
  topLeaks: { leak: string; label: Localized; errorRate: number; opportunities: number; confidence: string }[];
  reviewDue: number;
  skillEvidence: 'ok' | 'insufficient';
  competency: {
    status: 'ok' | 'insufficient';
    rating: number | null;
    interval95: number | null;
    confidence: 'low' | 'medium' | 'high' | null;
    coveragePct: number;
    components: { strategy: number; fundamentals: number };
    strategy: { rating: number; interval95: number; games: number } | null;
    fundamentals: { rating: number; interval95: number; games: number } | null;
    exploratory: { attempts: number };
  };
}

export function Dashboard() {
  const { t, lang } = useT();
  const [d, setD] = useState<Dash | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<Dash>('/dashboard').then(setD).catch(setError);
  }, []);
  if (error) return <ErrorNote error={error} />;
  if (!d) return <Spinner />;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-xl font-bold">{t('nav.dashboard')}</h1>
        <div className="flex gap-2">
          {d.reviewDue > 0 && <Link to="/train" className="rounded-lg border border-gold/50 px-3 py-1.5 text-sm text-gold">{t('dash.reviewDue', { n: d.reviewDue })}</Link>}
          <Link to="/today" className="rounded-lg bg-felt-500 px-3 py-1.5 text-sm font-semibold hover:bg-felt-600" data-testid="dash-today">{t('dash.today')}</Link>
          <Link to="/train" className="rounded-lg border border-ink-600 px-3 py-1.5 text-sm font-semibold hover:border-ink-400">{t('dash.startTraining')}</Link>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-[1.3fr_1fr_1fr]" data-testid="competency">
        <div className="rounded-xl border border-accent/40 bg-ink-900 p-4" data-testid="stat-proficiency">
          <div className="text-xs uppercase tracking-wide text-ink-400">{t('dash.proficiency')}</div>
          {d.competency.status === 'ok' ? (
            <>
              <div className="text-3xl font-bold tabular">{d.competency.rating} <span className="text-sm font-normal text-ink-300">±{d.competency.interval95}</span></div>
              <div className="text-xs text-ink-300">
                {t('dash.confidence')}: {t(`dash.conf.${d.competency.confidence}`)} · {t('dash.coverage')}: {d.competency.coveragePct}% · {t('dash.blend', { s: Math.round(d.competency.components.strategy * 100), f: Math.round(d.competency.components.fundamentals * 100) })}
              </div>
            </>
          ) : (
            <>
              <div className="text-xl font-semibold text-ink-200">{t('dash.notEnoughEvidence')}</div>
              <div className="text-xs text-ink-400">{t('dash.notEnoughHint')} · {t('dash.coverage')}: {d.competency.coveragePct}%</div>
            </>
          )}
        </div>
        <Stat
          testId="stat-rating"
          label={t('dash.strategyRating')}
          value={d.rating ? d.rating.rating : '—'}
          sub={d.rating ? `±${d.rating.interval95} (95%) · ${d.rating.games} ${t('dash.ratedDecisions')}` : t('dash.provisional')}
        />
        <Stat
          testId="stat-fundamentals"
          label={t('dash.fundamentalsRating')}
          value={d.competency.fundamentals ? d.competency.fundamentals.rating : '—'}
          sub={d.competency.fundamentals ? `±${d.competency.fundamentals.interval95} (95%) · ${d.competency.fundamentals.games} ${t('dash.ratedDecisions')}` : t('dash.provisional')}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t('dash.change7d')} value={d.ratingChange7d === null ? '—' : `${d.ratingChange7d >= 0 ? '+' : ''}${d.ratingChange7d}`} />
        <Stat testId="stat-accuracy" label={t('dash.accuracy')} value={fmtPct(d.accuracyPct)} sub={`${d.graded} ${t('dash.graded')} / ${d.decisions} ${t('dash.decisions')}`} />
        <Stat label={t('dash.evLoss')} value={d.avgEvLossBB === null ? '—' : `${fmtNum(d.avgEvLossBB, 2)} BB`} sub={`${d.evSamples} ${t('dash.evSamples')}`} />
        <Stat label={t('dash.exploratory')} value={d.competency.exploratory.attempts} sub={t('dash.exploratoryNote')} />
      </div>
      <p className="text-xs text-ink-400">{t('dash.metricsNote')}</p>
      <TrainingActivity />
      <div className="grid gap-4 md:grid-cols-3">
        <Panel title={t('dash.strengths')}>
          {d.strengths.length ? <ul className="space-y-1 text-sm">{d.strengths.map((s) => <li key={s.skill} className="flex justify-between"><span>{t(`skill.${s.skill}`)}</span><b className="tabular">{s.rating}</b></li>)}</ul> : <Empty>{t('dash.notEnoughEvidence')}</Empty>}
        </Panel>
        <Panel title={t('dash.weaknesses')}>
          {d.weaknesses.length ? <ul className="space-y-1 text-sm">{d.weaknesses.map((s) => <li key={s.skill} className="flex justify-between"><span>{t(`skill.${s.skill}`)}</span><b className="tabular">{s.rating}</b></li>)}</ul> : <Empty>{t('dash.notEnoughEvidence')}</Empty>}
          {d.provisionalSkills.length > 0 && <p className="mt-2 text-xs text-ink-400">{t('dash.provisionalSkills')}: {d.provisionalSkills.map((s) => t(`skill.${s}`)).join(', ')}</p>}
        </Panel>
        <Panel title={t('dash.topLeaks')} actions={<Link to="/leaks" className="text-xs text-accent">{t('dash.all')}</Link>}>
          {d.topLeaks.length ? (
            <ul className="space-y-1 text-sm">{d.topLeaks.map((l) => <li key={l.leak} className="flex justify-between gap-2"><span>{loc(l.label, lang)}</span><span className="tabular text-ink-300">{Math.round(l.errorRate * 100)}% · n={l.opportunities}</span></li>)}</ul>
          ) : (
            <Empty>{t('dash.noLeaks')}</Empty>
          )}
        </Panel>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { to: '/play', k: 'play' },
          { to: '/villain', k: 'villain' },
          { to: '/math', k: 'math' },
        ].map((c) => (
          <Link key={c.to} to={c.to} className="rounded-xl border border-ink-700 bg-ink-900 p-4 hover:border-ink-500">
            <div className="font-semibold">{t(`nav.${c.k}`)}</div>
            <div className="text-sm text-ink-300">{t(`${c.k}.intro`)}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

interface Progress {
  note: { en: string; vi: string };
  fullHands: { completed: number; uniqueSituations: number; inProgress: number };
  totals: { decisions: number; graded: number; ungraded: number };
  modules: { module: string; decisions: number; graded: number; ungraded: number; correct: number; ratedDecisions: number; strategyDelta: number; fundamentalsDelta: number }[];
  streetCoverage: Record<string, number>;
  calibration: { confidence: number; n: number; accuracyPct: number | null }[];
  reviewQueue: number;
  streakDays: number;
}

/** Practice progress for every module — explicitly not a rating — plus each module's rating contribution. */
function TrainingActivity() {
  const { t, lang } = useT();
  const [p, setP] = useState<Progress | null>(null);
  useEffect(() => {
    api.get<Progress>('/training-progress').then(setP).catch(() => setP(null));
  }, []);
  if (!p) return null;
  const maxStreet = Math.max(1, ...Object.values(p.streetCoverage));
  const delta = (x: number) => (x === 0 ? '—' : `${x > 0 ? '+' : ''}${x}`);
  return (
    <Panel title={t('prog.title')}>
      <p className="mb-3 text-xs text-ink-400">{loc(p.note, lang)}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="training-activity">
        <Stat label={t('prog.decisions')} value={p.totals.decisions} sub={`${p.totals.graded} ${t('prog.graded')} · ${p.totals.ungraded} ${t('prog.ungraded')}`} />
        <Stat label={t('prog.hands')} value={p.fullHands.completed} sub={t('prog.unique', { n: p.fullHands.uniqueSituations })} />
        <Stat label={t('prog.streak')} value={p.streakDays} sub={t('prog.days')} />
        <Stat label={t('prog.reviewQueue')} value={p.reviewQueue} />
        <div>
          <div className="mb-1 text-[11px] uppercase text-ink-400">{t('prog.streets')}</div>
          {(['preflop', 'flop', 'turn', 'river'] as const).map((s) => (
            <div key={s} className="flex items-center gap-2 text-[11px]">
              <span className="w-12 text-ink-300">{t(`street.${s}`)}</span>
              <div className="h-1.5 flex-1 rounded bg-ink-800"><div className="h-1.5 rounded bg-accent/70" style={{ width: `${(100 * (p.streetCoverage[s] ?? 0)) / maxStreet}%` }} /></div>
              <span className="w-8 text-right tabular text-ink-400">{p.streetCoverage[s] ?? 0}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-xs tabular" data-testid="module-contribution">
          <thead className="text-ink-400">
            <tr><th className="py-1 text-left font-normal">{t('prog.module')}</th><th className="text-right font-normal">{t('prog.decisions')}</th><th className="text-right font-normal">{t('prog.graded')}</th><th className="text-right font-normal">{t('prog.rated')}</th><th className="text-right font-normal">{t('dash.strategyRating')}</th><th className="text-right font-normal">{t('dash.fundamentalsRating')}</th></tr>
          </thead>
          <tbody>
            {p.modules.filter((m) => m.decisions > 0).map((m) => (
              <tr key={m.module} className="border-t border-ink-800">
                <td className="py-1">{t(`prog.mod.${m.module}`)}</td>
                <td className="text-right">{m.decisions}</td>
                <td className="text-right">{m.graded}</td>
                <td className="text-right">{m.ratedDecisions}</td>
                <td className="text-right">{delta(m.strategyDelta)}</td>
                <td className="text-right">{delta(m.fundamentalsDelta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-ink-500">{t('prog.whyNotRated')}</p>
      </div>
      {p.calibration.some((c) => c.n > 0) && (
        <div className="mt-3 text-xs text-ink-300">
          {t('prog.calibration')}: {p.calibration.filter((c) => c.n > 0).map((c) => `${t(`confidence.${c.confidence}`)} ${c.accuracyPct}% (n=${c.n})`).join(' · ')}
        </div>
      )}
    </Panel>
  );
}
