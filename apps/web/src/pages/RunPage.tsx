import type { PlayerAction } from '@pdl/core/engine';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, newAttemptId, ApiError, mixedSessionId } from '../api';
import { ActionBar } from '../components/ActionBar';
import { DecisionFeedbackView, QuestionFeedbackView } from '../components/Feedback';
import { ActionHistory, PokerTable } from '../components/PokerTable';
import { NotesPanel } from '../components/Notes';
import { RangeGrid } from '../components/RangeGrid';
import { loadFilters, useNextTest } from './Launcher';
import { Difficulty, ErrorNote, Panel, SourceBadge, Spinner } from '../components/ui';
import { loc } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { DecisionFeedback, QuestionFeedback, RunView } from '../types';

function QuestionForm({ view, onAnswer, busy }: { view: RunView; onAnswer: (a: unknown, c?: 1 | 2 | 3) => void; busy: boolean }) {
  const { t, lang } = useT();
  const q = view.question!;
  const [choice, setChoice] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [classes, setClasses] = useState<Set<string>>(new Set());
  useEffect(() => {
    setChoice(null);
    setValue('');
    setClasses(new Set());
  }, [view.nodeKey]);
  const submit = () => {
    if (q.choices) choice && onAnswer({ choiceId: choice });
    else if (q.type === 'rangeGrid') onAnswer({ classes: [...classes] });
    else if (value !== '') onAnswer({ value: Number(value.replace(',', '.')) });
  };
  return (
    <div className="space-y-3" data-testid="question">
      <div className="flex items-center gap-2">
        <span className="rounded border border-ink-600 px-1.5 py-0.5 text-[10px] uppercase text-ink-300">{t(`qtype.${q.type}`)}</span>
        <span className="text-[10px] uppercase text-ink-400">{t(`basis.${q.basis}`)}</span>
      </div>
      <p className="text-base font-medium">{loc(q.prompt, lang)}</p>
      {q.choices && (
        <div className="grid gap-2">
          {q.choices.map((c) => (
            <button key={c.id} type="button" onClick={() => setChoice(c.id)} className={`rounded-lg border px-3 py-2 text-left text-sm ${choice === c.id ? 'border-accent bg-accent/10' : 'border-ink-700 hover:border-ink-500'}`}>
              {loc(c.label, lang)}
            </button>
          ))}
        </div>
      )}
      {q.type === 'rangeGrid' && (
        <div className="max-w-md">
          <RangeGrid selected={classes} onChange={setClasses} />
          <div className="mt-1 text-xs text-ink-400">{classes.size} {t('q.classesSelected')}</div>
        </div>
      )}
      {!q.choices && q.type !== 'rangeGrid' && (
        <label className="flex items-center gap-2 text-sm">
          <input data-testid="number-answer" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className="w-32 rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 tabular" />
          <span className="text-ink-400">{q.type === 'percentEstimate' ? '%' : t('q.combos')}</span>
        </label>
      )}
      <button type="button" disabled={busy} onClick={submit} className="rounded-lg bg-felt-500 px-4 py-2 text-sm font-bold hover:bg-felt-600 disabled:opacity-40" data-testid="submit-answer">
        {t('q.submit')}
      </button>
    </div>
  );
}

export function RunPage() {
  const { id } = useParams();
  const { t, lang } = useT();
  const showBB = useApp((s) => s.me?.preferences.showBB ?? true);
  const nav = useNavigate();
  const [view, setView] = useState<RunView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [latest, setLatest] = useState<DecisionFeedback | QuestionFeedback | null>(null);
  const [bookmarked, setBookmarked] = useState<boolean | null>(null);
  useEffect(() => {
    if (!view) return;
    api.get<{ scenarioId: string }[]>('/bookmarks').then((b) => setBookmarked(b.some((x) => x.scenarioId === view.scenario.id))).catch(() => undefined);
  }, [view?.scenario.id]);
  const toggleBookmark = async () => {
    if (!view) return;
    if (bookmarked) await api.del(`/bookmarks/${view.scenario.id}`);
    else await api.put(`/bookmarks/${view.scenario.id}`);
    setBookmarked(!bookmarked);
  };

  useEffect(() => {
    api.get<RunView>(`/runs/${id}`).then(setView).catch(setError);
  }, [id]);

  const act = async (action: PlayerAction, confidence?: 1 | 2 | 3) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ feedback: DecisionFeedback; view: RunView }>(`/runs/${id}/act`, { clientAttemptId: newAttemptId(), action, confidence });
      setLatest(r.feedback);
      setView(r.view);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const answer = async (a: unknown, confidence?: 1 | 2 | 3) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ feedback: QuestionFeedback; view: RunView }>(`/runs/${id}/answer`, { clientAttemptId: newAttemptId(), answer: a, confidence });
      setLatest(r.feedback);
      setView(r.view);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const nextTest = useNextTest();
  const goNext = async () => {
    if (!view) return;
    const mixed = mixedSessionId();
    if (mixed) return nav(`/mixed/${mixed}`); // inside a Mixed session the session decides what comes next
    setBusy(true);
    setLatest(null);
    try {
      // the launcher's saved filters decide the next pick (a practice replay does not force practice next)
      const f = loadFilters(view.scenario.mode, view.mode);
      await nextTest(view.scenario.mode, f, view.scenario.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'pool_exhausted') nav(`/${view.scenario.mode}?exhausted=1`);
      else setError(e);
    } finally {
      setBusy(false);
    }
  };
  const again = async () => {
    if (!view) return;
    const r = await api.post<RunView>('/runs', { scenarioId: view.scenario.id, mode: view.mode });
    setLatest(null);
    nav(`/run/${r.runId}`);
  };

  if (error && !view) return <ErrorNote error={error} />;
  if (!view) return <Spinner />;
  const s = view.scenario;
  const bb = s.blinds.bigBlind;
  const meta = Object.fromEntries(s.players.map((p) => [p.pos, p]));
  const heroCards = view.heroCards.match(/.{2}/g)!;
  const isFb = (f: DecisionFeedback | QuestionFeedback): f is DecisionFeedback => 'chosen' in f;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
            <span>{t('module')} {s.module}</span>
            <span>·</span>
            <span>{s.format.game} · {s.format.tableSize}-max · {t(`stage.${s.format.stage}`)}</span>
            <Difficulty n={s.difficulty} />
            <SourceBadge cls={s.source.classification} />
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${view.mode === 'rated' ? 'bg-gold/20 text-gold' : 'bg-ink-700 text-ink-300'}`}>{t(`mode.${view.mode}`)}</span>
          </div>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-bold">
            {loc(s.title, lang)}
            <button type="button" onClick={() => void toggleBookmark()} aria-pressed={!!bookmarked} aria-label={t('list.bookmark')} title={t('list.bookmark')} className={`text-lg ${bookmarked ? 'text-gold' : 'text-ink-600 hover:text-ink-300'}`} data-testid="bookmark">★</button>
          </h1>
          <p className="text-sm text-ink-300">{loc(s.summary, lang)}</p>
        </div>
        <div className="text-right text-xs text-ink-400 tabular">
          {t('table.blinds')} {s.blinds.smallBlind.toLocaleString()}/{bb.toLocaleString()}
          {s.blinds.ante > 0 && ` · ${t('table.ante')} ${s.blinds.ante.toLocaleString()}${s.blinds.anteMode === 'bigBlind' ? ' (BB)' : ''}`}
          {s.tournament?.payouts && <div>{t('table.payouts')}: {s.tournament.payouts.join(' / ')}</div>}
          {s.tournament?.note && <div className="max-w-xs">{loc(s.tournament.note, lang)}</div>}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-3">
          <PokerTable state={view.state} heroId={s.heroPos} bigBlind={bb} showBB={showBB} meta={meta} heroCards={heroCards} />
          {s.players.some((p) => p.tendencies) && (
            <div className="flex flex-wrap gap-2 text-xs">
              {s.players.filter((p) => p.tendencies).map((p) => (
                <span key={p.pos} className="rounded-md border border-gold/30 bg-gold/5 px-2 py-1 text-ink-300"><b className="text-gold">{p.pos}</b>: {loc(p.tendencies, lang)}</span>
              ))}
            </div>
          )}
          {view.status === 'decision' && view.legal && (
            <div className="space-y-2">
              {view.prompt && <div className="text-sm font-medium" data-testid="prompt">{loc(view.prompt, lang)}</div>}
              <ActionBar state={view.state} legal={view.legal} bigBlind={bb} showBB={showBB} disabled={busy} onAct={act} />
            </div>
          )}
          {view.status === 'question' && view.question && (
            <Panel><QuestionForm view={view} onAnswer={answer} busy={busy} /></Panel>
          )}
          {view.status === 'complete' && (
            <Panel>
              <div className="flex flex-wrap items-center gap-3" data-testid="run-complete">
                <span className="font-semibold">{view.terminated === 'offTree' ? t('run.offTree') : t('run.complete')}</span>
                {s.mode === 'hero' && !view.state.complete && (
                  // the scenario's lesson is over but the poker hand is not: play it to the end
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void api.post<{ id: string }>(`/sim/from-run/${view.runId}`).then((h) => nav(`/play/${h.id}${mixedSessionId() ? `?mixed=${mixedSessionId()}` : ''}`)).catch(setError)}
                    className="rounded-lg bg-felt-500 px-5 py-2 text-sm font-bold hover:bg-felt-600 disabled:opacity-50"
                    data-testid="continue-hand"
                  >
                    {t('run.continueHand')}
                  </button>
                )}
                <button type="button" disabled={busy} onClick={() => void goNext()} className={`rounded-lg px-5 py-2 text-sm font-bold disabled:opacity-50 ${s.mode === 'hero' && !view.state.complete ? 'border border-ink-600' : 'bg-felt-500 hover:bg-felt-600'}`} data-testid="next-test">{t('run.nextTest')} →</button>
                <button type="button" onClick={again} className="rounded-lg border border-ink-600 px-3 py-1.5 text-sm hover:border-ink-400">{t('run.again')}</button>
                <Link to={s.mode === 'hero' ? '/hero/browse' : '/villain/browse'} className="text-sm text-ink-400 hover:text-accent">{t('launch.browse')}</Link>
              </div>
              {s.mode === 'hero' && !view.state.complete && <p className="mt-2 text-xs text-ink-400">{t('run.continueNote')}</p>}
            </Panel>
          )}
          <ErrorNote error={error} />
          <Panel title={t('run.history')}><ActionHistory state={view.state} bigBlind={bb} showBB={showBB} /></Panel>
        </div>
        <div className="space-y-3">
          {latest ? (
            <Panel title={t('run.feedback')}>{isFb(latest) ? <DecisionFeedbackView fb={latest} bigBlind={bb} /> : <QuestionFeedbackView fb={latest} />}</Panel>
          ) : (
            <Panel title={t('run.feedback')}><p className="text-sm text-ink-400">{t('run.feedbackHint')}</p></Panel>
          )}
          {view.status === 'complete' && <Panel title={t('history.notes')}><NotesPanel targetType="scenario" targetRef={s.id} /></Panel>}
          {view.feedback.length > 1 && (
            <Panel title={t('run.sequence')}>
              <ol className="space-y-1 text-sm" data-testid="decision-sequence">
                {view.feedback.map((f, i) => (
                  <li key={i} className="flex items-center justify-between gap-2">
                    <span className="text-ink-300">{i + 1}. {t(`street.${f.street}`)} — {isFb(f) ? (f.chosen.label ? loc(f.chosen.label, lang) : f.chosen.action.type) : t(`qtype.${(f as QuestionFeedback).questionType}`)}</span>
                    <span className="text-xs">{f.grade ? t(`grade.${f.grade}`) : '—'}</span>
                  </li>
                ))}
              </ol>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
