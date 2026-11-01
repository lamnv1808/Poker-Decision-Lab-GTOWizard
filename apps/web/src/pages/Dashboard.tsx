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
          <Link to="/train" className="rounded-lg bg-felt-500 px-3 py-1.5 text-sm font-semibold hover:bg-felt-600">{t('dash.startTraining')}</Link>
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
