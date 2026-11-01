import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Empty, ErrorNote, GradeBadge, Panel, Spinner, Stat, Toggle } from '../components/ui';
import { fmtNum, fmtPct, loc } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { Grade, Localized } from '../types';

type Focus = 'fullhand' | 'preflop' | 'postflop' | 'math' | 'villain' | 'replay';
const FOCUS: Focus[] = ['fullhand', 'preflop', 'postflop', 'math', 'villain', 'replay'];
type Mix = 'balanced' | 'heroFocus' | 'newOnly' | 'weak' | 'due';
const MIXES: Mix[] = ['balanced', 'heroFocus', 'newOnly', 'weak', 'due'];
interface SessionInfo { id: string; mode: string; durationMin: number; served: number; answered: number; remainingSec: number; ended: boolean }
interface Summary {
  id: string;
  mode: string;
  durationMin: number;
  served: number;
  attempts: number;
  graded: number;
  accuracyPct: number | null;
  minutes: number;
  byType: { type: string; attempts: number; graded: number; strategyRated: number; fundamentalsRated: number; ungraded: number; accuracyPct: number | null; avgEvLossBB: number | null }[];
  strategyRated: number;
  fundamentalsRated: number;
  ungraded: number;
  exhausted: string[];
  ratingDelta: { strategy: number | null; fundamentals: number | null };
  mistakes: { type: string | null; grade: Grade | null; evLossBB: number | null; at: string }[];
  recommendation: string | null;
  daily: { planned: number; done: number; leaks: { leakKey: string; label: Localized; evidence: string; served: number; total: number; correct: number }[] } | null;
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/** Ask the server for the next item and go there (or to the summary when time is up). */
export function useMixedNext() {
  const nav = useNavigate();
  return async (id: string) => {
    const r = await api.post<{ done: boolean; href?: string }>(`/mixed/sessions/${id}/next`);
    if (r.done) {
      await api.post(`/mixed/sessions/${id}/end`);
      nav(`/mixed/${id}/summary`);
    } else nav(r.href!);
  };
}

export function MixedSetup() {
  const { t } = useT();
  const defaultMode = useApp((s) => s.me?.preferences.defaultMode ?? 'practice');
  const [duration, setDuration] = useState<'5' | '10' | '20' | '30'>('10');
  const [difficulty, setDifficulty] = useState<'adaptive' | 'easy' | 'medium' | 'hard'>('adaptive');
  const [focus, setFocus] = useState<Focus[]>(FOCUS);
  const [mode, setMode] = useState<'practice' | 'rated'>(defaultMode);
  const [mix, setMix] = useState<Mix>('balanced');
  const [error, setError] = useState<unknown>(null);
  const next = useMixedNext();
  const start = async () => {
    try {
      const s = await api.post<{ id: string }>('/mixed/sessions', { durationMin: Number(duration), difficulty, focus, mode, mix });
      await next(s.id);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">{t('mixed.title')}</h1>
        <p className="text-sm text-ink-300">{t('mixed.intro')}</p>
      </div>
      <Panel title={t('mixed.setup')}>
        <div className="flex flex-wrap gap-3">
          <Toggle label={t('mixed.duration')} value={duration} onChange={setDuration} options={(['5', '10', '20', '30'] as const).map((d) => ({ value: d, label: `${d} min` }))} />
          <Toggle label={t('mixed.difficulty')} value={difficulty} onChange={setDifficulty} options={(['adaptive', 'easy', 'medium', 'hard'] as const).map((d) => ({ value: d, label: t(`mixed.diff.${d}`) }))} />
          <Toggle label={t('mode.label')} value={mode} onChange={setMode} options={[{ value: 'practice', label: t('mode.practice') }, { value: 'rated', label: t('mode.rated') }]} />
        </div>
        <label className="mt-3 block text-xs uppercase text-ink-400">
          {t('mixed.mix')}
          <select value={mix} onChange={(e) => setMix(e.target.value as Mix)} className="mt-1 block w-full rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm normal-case text-ink-100" data-testid="mixed-mix">
            {MIXES.map((m) => <option key={m} value={m}>{t(`mixed.mix.${m}`)}</option>)}
          </select>
        </label>
        <fieldset className="mt-3">
          <legend className="text-xs uppercase text-ink-400">{t('mixed.focus')}</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {FOCUS.map((f) => (
              <label key={f} className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${focus.includes(f) ? 'border-accent text-accent' : 'border-ink-600 text-ink-300'}`}>
                <input type="checkbox" className="sr-only" checked={focus.includes(f)} onChange={() => setFocus((x) => (x.includes(f) ? (x.length > 1 ? x.filter((y) => y !== f) : x) : [...x, f]))} data-testid={`mixed-focus-${f}`} />
                {t(`mixed.focus.${f}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-2 text-xs text-ink-400">{t('mixed.rules')}</p>
        <ErrorNote error={error} />
        <button type="button" onClick={() => void start()} className="mt-3 rounded-lg bg-felt-500 px-5 py-2 font-bold" data-testid="mixed-start">{t('mixed.start')}</button>
      </Panel>
    </div>
  );
}

/** Thin bar shown on any page opened from a Mixed session: time left, count, next. */
export function MixedBar() {
  const { t } = useT();
  const loc = useLocation();
  const id = new URLSearchParams(loc.search).get('mixed');
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [left, setLeft] = useState(0);
  const next = useMixedNext();
  useEffect(() => {
    if (!id) return;
    api.get<SessionInfo>(`/mixed/sessions/${id}`).then((s) => {
      setInfo(s);
      setLeft(s.remainingSec);
    }).catch(() => setInfo(null));
  }, [id, loc.pathname, loc.search]);
  useEffect(() => {
    if (!info) return;
    const h = setInterval(() => setLeft((x) => Math.max(0, x - 1)), 1000);
    return () => clearInterval(h);
  }, [info]);
  if (!id || !info) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2 text-sm" data-testid="mixed-bar">
      <b>{t('mixed.title')}</b>
      <span className="tabular text-ink-300">{left > 0 ? `${mmss(left)} ${t('mixed.left')}` : t('mixed.timeUp')}</span>
      <span className="text-ink-300">{t('mixed.answered', { n: info.answered })}</span>
      <span className="flex-1" />
      <button type="button" onClick={() => void next(id)} className="rounded-md bg-felt-500 px-3 py-1 font-semibold" data-testid="mixed-bar-next">{left > 0 ? t('mixed.next') : t('mixed.finish')}</button>
      <Link to={`/mixed/${id}/summary`} onClick={() => void api.post(`/mixed/sessions/${id}/end`)} className="text-xs text-ink-400">{t('mixed.end')}</Link>
    </div>
  );
}

/** /mixed/:id — jumps straight to the next item. */
export function MixedRunner() {
  const { id } = useParams();
  const next = useMixedNext();
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (id) void next(id).catch(setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return error ? <ErrorNote error={error} /> : <Spinner />;
}

export function MixedSummary() {
  const { id } = useParams();
  const { t, lang } = useT();
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<Summary>(`/mixed/sessions/${id}/summary`).then(setS).catch(setError);
  }, [id]);
  if (error) return <ErrorNote error={error} />;
  if (!s) return <Spinner />;
  const d = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : ''}${x}`);
  return (
    <div className="space-y-4" data-testid="mixed-summary">
      <h1 className="text-xl font-bold">{t('mixed.summary')}</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t('mixed.items')} value={s.attempts} sub={`${s.graded} ${t('dash.graded')} · ${s.minutes} min`} />
        <Stat label={t('dash.accuracy')} value={fmtPct(s.accuracyPct)} sub={`${s.strategyRated} ${t('mixed.strategyRated')} · ${s.fundamentalsRated} ${t('mixed.fundRated')} · ${s.ungraded} ${t('mixed.ungraded')}`} />
        <Stat label={t('dash.strategyRating')} value={d(s.ratingDelta.strategy)} sub={t('mixed.change')} />
        <Stat label={t('dash.fundamentalsRating')} value={d(s.ratingDelta.fundamentals)} sub={t('mixed.change')} />
      </div>
      {s.daily && (
        <Panel title={t('today.summary', { done: s.daily.done, n: s.daily.planned })}>
          <ul className="space-y-1 text-sm" data-testid="daily-summary">
            {s.daily.leaks.map((l) => (
              <li key={l.leakKey} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{loc(l.label, lang)}</span>
                <span className="tabular text-ink-300">{l.total ? t('today.drillResult', { c: l.correct, n: l.total }) : t('today.drillUngraded', { n: l.served })}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-ink-500">{t('today.summaryNote')}</p>
        </Panel>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title={t('mixed.byType')}>
          {s.byType.length === 0 ? <Empty>{t('mixed.nothing')}</Empty> : (
            <table className="w-full text-sm">
              <tbody>
                {s.byType.map((b) => (
                  <tr key={b.type} className="border-t border-ink-800">
                    <td className="py-1.5">{t(`mixed.type.${b.type}`)}</td>
                    <td className="tabular text-right">{b.attempts}</td>
                    <td className="tabular text-right text-[11px] text-ink-400">{b.strategyRated}/{b.fundamentalsRated}/{b.ungraded}</td>
                    <td className="tabular text-right">{fmtPct(b.accuracyPct)}</td>
                    <td className="tabular text-right text-ink-300">{b.avgEvLossBB === null ? '' : `${fmtNum(b.avgEvLossBB, 2)} BB`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-[11px] text-ink-500">{t('mixed.columns')}</p>
          {s.exhausted.length > 0 && <p className="mt-1 text-xs text-gold">{t('mixed.exhausted', { types: s.exhausted.map((x) => t(`mixed.type.${x}`)).join(', ') })}</p>}
          {s.recommendation && <p className="mt-3 text-sm">{t('mixed.recommend')}: <b>{t(`mixed.type.${s.recommendation}`)}</b></p>}
        </Panel>
        <Panel title={t('mixed.mistakes')}>
          {s.mistakes.length === 0 ? <Empty>{t('mixed.noMistakes')}</Empty> : (
            <ul className="space-y-1 text-sm">
              {s.mistakes.map((m, i) => (
                <li key={i} className="flex items-center gap-2"><GradeBadge grade={m.grade} /><span>{m.type ? t(`mixed.type.${m.type}`) : ''}</span>{m.evLossBB !== null && <span className="tabular text-ink-300">−{fmtNum(m.evLossBB, 2)} BB</span>}</li>
              ))}
            </ul>
          )}
          <Link to="/history?filter=incorrect" className="mt-2 inline-block text-xs text-accent">{t('mixed.reviewMistakes')}</Link>
        </Panel>
      </div>
      <div className="flex gap-2">
        <Link to="/mixed" className="rounded-lg bg-felt-500 px-4 py-2 font-bold">{t('mixed.again')}</Link>
        <Link to="/" className="rounded-lg border border-ink-600 px-4 py-2">{t('nav.dashboard')}</Link>
      </div>
    </div>
  );
}
