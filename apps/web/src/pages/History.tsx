import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Empty, ErrorNote, GradeBadge, Panel, Spinner, Toggle } from '../components/ui';
import { fmtNum, loc } from '../format';
import { useT } from '../i18n';
import type { Grade, Localized } from '../types';
import { useStartRun } from './ScenarioList';

interface Attempt {
  id: string;
  attemptType: string;
  itemRef: string;
  grade: Grade | null;
  graded: boolean;
  isError: boolean;
  evLoss: number | null;
  evUnit: string | null;
  mode: string;
  ratingApplied: boolean;
  createdAt: string;
  street: string | null;
  heroPosition: string | null;
  prompt: Localized | null;
  chosen: { label: Localized | null; action: { type: string } } | null;
}
interface HistoryData { sessions: { id: string; kind: string; mode: string; startedAt: string; attempts: number }[]; attempts: Attempt[] }
interface Note { id: string; targetType: string; targetRef: string; body: string; updatedAt: string }
interface Bookmark { scenarioId: string; createdAt: string }

/** Review history: sessions, attempts (all / incorrect / reattempted), bookmarks and notes. */
export function HistoryPage() {
  const { t, lang } = useT();
  const [filter, setFilter] = useState<'all' | 'incorrect' | 'reattempts'>('all');
  const [data, setData] = useState<HistoryData | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [error, setError] = useState<unknown>(null);
  const start = useStartRun();
  useEffect(() => {
    setData(null);
    api.get<HistoryData>(`/history?filter=${filter}&limit=100`).then(setData).catch(setError);
  }, [filter]);
  useEffect(() => {
    api.get<Note[]>('/notes').then(setNotes).catch(() => undefined);
    api.get<Bookmark[]>('/bookmarks').then(setBookmarks).catch(() => undefined);
  }, []);
  const itemLink = (a: Attempt) => {
    if (a.attemptType === 'quiz' && a.itemRef.startsWith('gto:')) return <Link className="text-accent" to="/gto">{t('nav.gto')} · {a.itemRef.split(':')[4]} @ {a.itemRef.split(':')[2]}BB</Link>;
    if (a.attemptType === 'quiz') return <Link className="text-accent" to={`/math?kind=${a.itemRef.split(':')[1]}`}>{t(`quiz.${a.itemRef.split(':')[1]}`)}</Link>;
    if (a.attemptType === 'imported') return <Link className="text-accent" to={`/hands/${a.itemRef.split(':')[0]}?spot=${a.itemRef.split(':')[1]}`}>{t('nav.hands')}</Link>;
    const id = a.itemRef.split(':')[0]!;
    return <button type="button" className="text-left text-accent" onClick={() => void start(id, 'practice').catch(setError)}>{id}</button>;
  };
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('nav.history')}</h1>
      <ErrorNote error={error} />
      <Panel
        title={t('history.decisions')}
        actions={<Toggle label={t('history.filter')} value={filter} onChange={setFilter} options={[{ value: 'all', label: t('history.all') }, { value: 'incorrect', label: t('history.incorrect') }, { value: 'reattempts', label: t('history.reattempts') }]} />}
      >
        {!data ? <Spinner /> : data.attempts.length === 0 ? <Empty>{t('progress.noData')}</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm" data-testid="history-table">
              <thead className="text-xs text-ink-400">
                <tr><th className="py-1.5">{t('history.when')}</th><th>{t('history.item')}</th><th>{t('fb.youChose')}</th><th>{t('history.grade')}</th><th>{t('fb.evLoss')}</th><th>{t('mode.label')}</th></tr>
              </thead>
              <tbody>
                {data.attempts.map((a) => (
                  <tr key={a.id} className="border-t border-ink-800 align-top">
                    <td className="py-1.5 pr-2 text-xs text-ink-400 tabular">{new Date(a.createdAt).toLocaleString(lang)}</td>
                    <td className="pr-2">{itemLink(a)}{a.street && <div className="text-[11px] text-ink-400">{t(`street.${a.street}`)}{a.heroPosition ? ` · ${a.heroPosition}` : ''}</div>}</td>
                    <td className="pr-2 text-xs">{a.chosen ? (a.chosen.label ? loc(a.chosen.label, lang) : t(`act.${a.chosen.action.type}`)) : '—'}</td>
                    <td className="pr-2"><GradeBadge grade={a.grade} /></td>
                    <td className="pr-2 text-xs tabular">{a.evLoss === null ? '—' : `${fmtNum(a.evLoss, a.evUnit === 'icmPct' ? 3 : 2)} ${a.evUnit === 'icmPct' ? '%' : 'BB'}`}</td>
                    <td className="text-xs text-ink-400">{t(`mode.${a.mode}`)}{a.ratingApplied ? ' ★' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title={t('history.sessions')}>
          {!data || data.sessions.length === 0 ? <Empty>{t('progress.noData')}</Empty> : (
            <ul className="space-y-1 text-sm">{data.sessions.map((s) => <li key={s.id} className="flex justify-between gap-2"><span>{new Date(s.startedAt).toLocaleString(lang)} · {t(`history.kind.${s.kind}`)}</span><span className="text-ink-400">{t(`mode.${s.mode}`)} · {s.attempts}</span></li>)}</ul>
          )}
        </Panel>
        <Panel title={t('history.bookmarks')}>
          {bookmarks.length === 0 ? <Empty>{t('queue.empty')}</Empty> : (
            <ul className="space-y-1 text-sm">{bookmarks.map((b) => <li key={b.scenarioId}><button type="button" className="text-accent" onClick={() => void start(b.scenarioId, 'practice').catch(setError)}>★ {b.scenarioId}</button></li>)}</ul>
          )}
        </Panel>
      </div>
      <Panel title={t('history.notes')}>
        {notes.length === 0 ? <Empty>{t('history.noNotes')}</Empty> : (
          <ul className="space-y-2 text-sm" data-testid="all-notes">
            {notes.map((n) => (
              <li key={n.id} className="rounded-md bg-ink-850 px-3 py-2">
                <div className="text-[11px] text-ink-400">{t(`history.target.${n.targetType}`)} · {n.targetType === 'hand' ? <Link className="text-accent" to={`/hands/${n.targetRef}`}>{n.targetRef.slice(0, 8)}</Link> : n.targetRef} · {new Date(n.updatedAt).toLocaleDateString(lang)}</div>
                <p className="whitespace-pre-wrap">{n.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
