import type { HandState, LegalActions, PlayerAction } from '@pdl/core/engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, newAttemptId } from '../api';
import { ActionBar } from '../components/ActionBar';
import { PokerTable } from '../components/PokerTable';
import { ErrorNote, GradeBadge, Panel, Spinner, Toggle } from '../components/ui';
import { fmtNum, loc } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { Grade, Localized } from '../types';

interface Facts { potBB: number; toCallBB: number; requiredEquity: number | null; spr: number | null; street: string }
interface Feedback {
  graded: boolean;
  grade?: Grade;
  evLossBB?: number;
  basis: 'solverEv' | 'modelEv' | 'none';
  track: 'strategy' | 'fundamentals' | null;
  best?: string;
  evByAction?: Record<string, number>;
  note: Localized;
}
interface ModelEq { equity: number; stdErr: number; opponents: { id: string; archetype: string; rangePct: number }[] }
interface DecisionView { index: number; street: string; action: PlayerAction; confidence: number | null; reasoning: string | null; facts: Facts; feedback?: Feedback; modelEquity?: ModelEq }
interface TimelineEntry { street: string; playerId: string; type: string; toBB: number; addedBB: number; allIn: boolean; villain?: { archetype: string; source: 'solver' | 'heuristic' }; heroDecision?: number }
export interface SimView {
  id: string;
  status: 'active' | 'complete' | 'abandoned';
  mode: 'practice' | 'rated';
  feedback: 'guided' | 'exam';
  kind: 'play' | 'replay' | 'branch';
  parentId: string | null;
  branchAt: number | null;
  bigBlind: number;
  config: { tableSize: number; heroPos: string; stacksBB: Record<string, number>; anteMode: string; villains: Record<string, { archetype: string; label: Localized }> };
  state: HandState;
  heroCards: string[];
  legal: LegalActions | null;
  progress: { street: string; decisionNumber: number; complete: boolean };
  current: Facts | null;
  decisions: DecisionView[];
  review: null | { timeline: TimelineEntry[]; showdown: { id: string; cards: string[] }[]; netBB: Record<string, number>; heroNetBB: number; gradedCount: number; source: { villains: Localized } };
}
interface Setup { tableSize: number; stackBB: number; archetype: string; mode: 'practice' | 'rated'; feedback: 'guided' | 'exam' }

const SETUP_KEY = 'pdl.sim.setup';
const MATH_KEY = 'pdl.sim.math';
function loadSetup(mode: 'practice' | 'rated'): Setup {
  try {
    const raw = localStorage.getItem(SETUP_KEY);
    if (raw) return { tableSize: 0, stackBB: 0, archetype: 'mixed', mode, feedback: 'guided', ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { tableSize: 0, stackBB: 0, archetype: 'mixed', mode, feedback: 'guided' };
}
function saveSetup(s: Setup) {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function useStartSim() {
  const nav = useNavigate();
  return async (s: Setup, sessionId?: string) => {
    saveSetup(s);
    const v = await api.post<SimView>('/sim/hands', { tableSize: s.tableSize || undefined, stackBB: s.stackBB || undefined, archetype: s.archetype, mode: s.mode, feedback: s.feedback, sessionId });
    nav(`/play/${v.id}${sessionId ? `?mixed=${sessionId}` : ''}`);
  };
}

const pct = (x: number | null | undefined) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${(100 * x).toFixed(1)}%`);
const STREETS = ['preflop', 'flop', 'turn', 'river'];

export function HeroSimSetup() {
  const { t, lang } = useT();
  const defaultMode = useApp((s) => s.me?.preferences.defaultMode ?? 'practice');
  const [s, setS] = useState<Setup>(() => loadSetup(defaultMode));
  const [active, setActive] = useState<{ id: string; decisions: number; tableSize: number; updatedAt: string; kind: string }[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const start = useStartSim();
  useEffect(() => {
    api.get<typeof active>('/sim/hands/active').then(setActive).catch(setError);
  }, []);
  const sel = 'rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm';
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">{t('sim.title')}</h1>
        <p className="text-sm text-ink-300">{t('sim.intro')}</p>
      </div>
      {active && active.length > 0 && (
        <Panel title={t('sim.resume')}>
          <ul className="divide-y divide-ink-800" data-testid="sim-active">
            {active.map((h) => (
              <li key={h.id} className="flex items-center justify-between py-2 text-sm">
                <span>{t('sim.tableOf', { n: h.tableSize })} · {t('sim.decisionsMade', { n: h.decisions })} · <span className="text-ink-400">{new Date(h.updatedAt).toLocaleString(lang)}</span></span>
                <Link to={`/play/${h.id}`} className="rounded-md border border-ink-600 px-3 py-1">{t('sim.continue')}</Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <Panel title={t('sim.newHand')}>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">{t('sim.tableSize')}
            <select className={`${sel} mt-1 block w-full`} value={s.tableSize} onChange={(e) => setS({ ...s, tableSize: Number(e.target.value) })} data-testid="sim-table">
              <option value={0}>{t('sim.random')}</option>
              {[2, 3, 6, 9].map((n) => <option key={n} value={n}>{t('sim.tableOf', { n })}</option>)}
            </select>
          </label>
          <label className="text-sm">{t('sim.stack')}
            <select className={`${sel} mt-1 block w-full`} value={s.stackBB} onChange={(e) => setS({ ...s, stackBB: Number(e.target.value) })}>
              <option value={0}>{t('sim.random')}</option>
              {[10, 15, 20, 40, 60, 100].map((n) => <option key={n} value={n}>{n} BB</option>)}
            </select>
          </label>
          <label className="text-sm">{t('sim.opponents')}
            <select className={`${sel} mt-1 block w-full`} value={s.archetype} onChange={(e) => setS({ ...s, archetype: e.target.value })}>
              <option value="mixed">{t('sim.mixed')}</option>
              {['nit', 'tag', 'lag', 'station', 'maniac'].map((a) => <option key={a} value={a}>{t(`arch.${a}`)}</option>)}
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Toggle label={t('mode.label')} value={s.mode} onChange={(mode) => setS({ ...s, mode })} options={[{ value: 'practice', label: t('mode.practice') }, { value: 'rated', label: t('mode.rated') }]} />
          <Toggle label={t('sim.feedback')} value={s.feedback} onChange={(feedback) => setS({ ...s, feedback })} options={[{ value: 'guided', label: t('sim.guided') }, { value: 'exam', label: t('sim.exam') }]} />
        </div>
        <p className="mt-2 text-xs text-ink-400">{t('sim.modelNote')}</p>
        <ErrorNote error={error} />
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void start(s).catch(setError).finally(() => setBusy(false));
          }}
          className="mt-3 rounded-lg bg-felt-500 px-5 py-2 font-bold"
          data-testid="sim-deal"
        >
          {t('sim.deal')}
        </button>
      </Panel>
    </div>
  );
}

function Progress({ v }: { v: SimView }) {
  const { t } = useT();
  const cur = v.progress.complete ? 4 : STREETS.indexOf(v.state.street);
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="sim-progress">
      <ol className="flex items-center gap-1 text-[11px]">
        {[...STREETS, 'showdown'].map((s, i) => (
          <li key={s} className={`rounded-full px-2 py-0.5 ${i === cur ? 'bg-accent/20 text-accent' : i < cur ? 'text-ink-300' : 'text-ink-500'}`}>
            {i < cur ? '✓ ' : ''}{s === 'showdown' ? t('sim.handEnd') : t(`street.${s}`)}
          </li>
        ))}
      </ol>
      <span className="text-xs text-ink-300 tabular" data-testid="sim-decision-counter">{t('sim.decisionN', { n: v.progress.decisionNumber })}</span>
      <span className="rounded bg-ink-800 px-1.5 text-[10px] uppercase text-ink-300">{t(`mode.${v.mode}`)} · {t(`sim.${v.feedback}`)}{v.kind !== 'play' ? ` · ${t(`sim.kind.${v.kind}`)}` : ''}</span>
    </div>
  );
}

function FeedbackCard({ fb, eq }: { fb: Feedback; eq?: ModelEq }) {
  const { t, lang } = useT();
  return (
    <div className="space-y-1.5 text-sm" data-testid="sim-feedback">
      <div className="flex flex-wrap items-center gap-2">
        {fb.graded ? <GradeBadge grade={fb.grade ?? null} /> : <span className="rounded bg-ink-800 px-2 py-0.5 text-xs text-ink-300">{t('sim.notGraded')}</span>}
        {fb.basis !== 'none' && <span className="text-[10px] uppercase text-ink-400">{fb.basis === 'solverEv' ? t('sim.basis.solver') : t('sim.basis.model')}</span>}
        {fb.evLossBB !== undefined && fb.graded && <span className="text-xs tabular text-ink-300">{t('sim.evLoss')}: {fmtNum(fb.evLossBB, 2)} BB</span>}
      </div>
      {fb.evByAction && (
        <div className="flex flex-wrap gap-2 text-xs tabular">
          {Object.entries(fb.evByAction).map(([a, ev]) => (
            <span key={a} className={`rounded border px-1.5 ${fb.best === a ? 'border-emerald-500 text-emerald-300' : 'border-ink-700 text-ink-300'}`}>{a}: {ev >= 0 ? '+' : ''}{fmtNum(ev, 2)} BB</span>
          ))}
        </div>
      )}
      <p className="text-xs text-ink-200">{loc(fb.note, lang)}</p>
      {eq && Number.isFinite(eq.equity) && (
        <p className="text-[11px] text-ink-400">
          {t('sim.modelEquity')}: {pct(eq.equity)} ({eq.opponents.map((o) => `${o.id} ${t(`arch.${o.archetype}`)} ~${o.rangePct}%`).join(', ')})
        </p>
      )}
    </div>
  );
}

export function HeroSimPage() {
  const { id } = useParams();
  const { t, lang } = useT();
  const nav = useNavigate();
  const showBB = useApp((s) => s.me?.preferences.showBB ?? true);
  const mixed = new URLSearchParams(window.location.search).get('mixed');
  const [v, setV] = useState<SimView | null>(null);
  const [last, setLast] = useState<{ fb: Feedback; eq?: ModelEq } | null>(null);
  const [reasoning, setReasoning] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [math, setMath] = useState(() => {
    try {
      return localStorage.getItem(MATH_KEY) === '1';
    } catch {
      return false;
    }
  });
  const shownAt = useRef(Date.now());
  const start = useStartSim();
  const load = useCallback(async () => {
    setError(null);
    try {
      setV(await api.get<SimView>(`/sim/hands/${id}`));
      shownAt.current = Date.now();
    } catch (e) {
      setError(e);
    }
  }, [id]);
  useEffect(() => {
    setV(null);
    setLast(null);
    void load();
  }, [load]);
  const toggleMath = () => {
    setMath((m) => {
      try {
        localStorage.setItem(MATH_KEY, m ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !m;
    });
  };
  const act = async (action: PlayerAction, confidence?: 1 | 2 | 3) => {
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ view: SimView; feedback: (Feedback & { modelEquity?: ModelEq }) | null }>(`/sim/hands/${v.id}/act`, {
        clientAttemptId: newAttemptId(),
        action,
        confidence,
        reasoning: reasoning.trim() || undefined,
        responseMs: Date.now() - shownAt.current,
      });
      setV(r.view);
      setLast(r.feedback ? { fb: r.feedback, eq: r.feedback.modelEquity } : null);
      setReasoning('');
      shownAt.current = Date.now();
    } catch (e) {
      setError(e);
      if ((e as { status?: number }).status === 409) void load();
    } finally {
      setBusy(false);
    }
  };
  if (!v) return error ? <ErrorNote error={error} /> : <Spinner />;
  const bb = v.bigBlind;
  const labels = Object.fromEntries(v.state.players.map((p) => [p.id, p.id]));
  const meta = Object.fromEntries(Object.entries(v.config.villains).map(([k, x]) => [k, { pos: k, tendencies: x.label }]));
  // At the end, reveal only the hands that reached showdown.
  const shown = v.review ? new Map(v.review.showdown.map((s) => [s.id, s.cards])) : null;
  const tableState: HandState = shown ? { ...v.state, players: v.state.players.map((p) => (shown.has(p.id) ? { ...p, cards: shown.get(p.id) as HandState['players'][number]['cards'] } : p)) } : v.state;
  const hero = v.state.players.find((p) => p.id === v.config.heroPos)!;
  const nextSetup: Setup = { ...loadSetup(v.mode), mode: v.mode, feedback: v.feedback };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold">{t('sim.title')}</h1>
        <Progress v={v} />
      </div>
      <ErrorNote error={error} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          <PokerTable state={tableState} heroId={v.config.heroPos} bigBlind={bb} showBB={showBB} labels={labels} meta={meta} heroCards={v.heroCards} />
          <div className="grid grid-cols-2 gap-2 text-xs tabular sm:grid-cols-4" data-testid="sim-tracker">
            <div className="rounded-lg bg-ink-900 px-3 py-2"><div className="text-ink-400">{t('sim.heroStack')}</div><b>{fmtNum(hero.stack / bb, 1)} BB</b></div>
            <div className="rounded-lg bg-ink-900 px-3 py-2"><div className="text-ink-400">{t('table.pot')}</div><b>{fmtNum((v.current?.potBB ?? (v.state.deadAntes + v.state.players.reduce((s, p) => s + p.totalCommitted, 0)) / bb), 1)} BB</b></div>
            <div className="rounded-lg bg-ink-900 px-3 py-2"><div className="text-ink-400">{t('sim.toCall')}</div><b>{v.current ? `${fmtNum(v.current.toCallBB, 1)} BB` : '—'}</b></div>
            <div className="rounded-lg bg-ink-900 px-3 py-2"><div className="text-ink-400">{t('sim.startStack')}</div><b>{v.config.stacksBB[v.config.heroPos]} BB</b></div>
          </div>
        </div>
        <div className="space-y-3">
          {v.current && v.legal && (
            <Panel title={t('sim.yourMove')} actions={<button type="button" onClick={toggleMath} className="text-xs text-accent" data-testid="sim-math-toggle">{math ? t('sim.hideMath') : t('sim.showMath')}</button>}>
              {math && (
                <div className="mb-3 space-y-1 rounded-lg bg-ink-850 p-2 text-xs tabular" data-testid="sim-math">
                  <div>{t('sim.requiredEq')}: <b>{pct(v.current.requiredEquity)}</b> <span className="text-ink-400">= {t('sim.call')} / {t('sim.winnablePot')}</span></div>
                  {v.current.spr !== null && <div>SPR: <b>{fmtNum(v.current.spr, 2)}</b></div>}
                  <div className="text-ink-400">{t('sim.mathNote')}</div>
                </div>
              )}
              <textarea value={reasoning} onChange={(e) => setReasoning(e.target.value)} maxLength={1000} rows={2} placeholder={t('sim.reasoning')} className="mb-2 w-full rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm" data-testid="sim-reasoning" />
              <ActionBar state={v.state} legal={v.legal} bigBlind={bb} showBB={showBB} disabled={busy} onAct={(a, c) => void act(a, c)} />
            </Panel>
          )}
          {last && (
            <Panel title={t('sim.lastDecision')}>
              <FeedbackCard fb={last.fb} eq={last.eq} />
            </Panel>
          )}
          {!v.review && v.feedback === 'exam' && v.decisions.length > 0 && <p className="text-xs text-ink-400">{t('sim.examHidden')}</p>}
          {v.review && (
            <Panel title={t('sim.result')}>
              <div className={`text-2xl font-bold tabular ${v.review.heroNetBB >= 0 ? 'text-emerald-300' : 'text-red-300'}`} data-testid="sim-net">
                {v.review.heroNetBB >= 0 ? '+' : ''}{fmtNum(v.review.heroNetBB, 1)} BB
              </div>
              <p className="mt-1 text-[11px] text-ink-400">{loc(v.review.source.villains, lang)}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {mixed ? (
                  <button type="button" onClick={() => nav(`/mixed/${mixed}`)} className="rounded-lg bg-felt-500 px-4 py-1.5 text-sm font-bold" data-testid="mixed-next">{t('mixed.next')}</button>
                ) : (
                  <button type="button" onClick={() => void start(nextSetup).catch(setError)} className="rounded-lg bg-felt-500 px-4 py-1.5 text-sm font-bold" data-testid="sim-next">{t('sim.nextHand')}</button>
                )}
                <button type="button" onClick={() => void api.post<SimView>(`/sim/hands/${v.id}/replay`).then((r) => nav(`/play/${r.id}`)).catch(setError)} className="rounded-lg border border-ink-600 px-3 py-1.5 text-sm" data-testid="sim-replay">{t('sim.replay')}</button>
              </div>
            </Panel>
          )}
        </div>
      </div>
      {v.review && <Review v={v} onError={setError} />}
    </div>
  );
}

function Review({ v, onError }: { v: SimView; onError: (e: unknown) => void }) {
  const { t } = useT();
  const nav = useNavigate();
  const [family, setFamily] = useState<{ id: string; kind: string; branchAt: number | null; complete: boolean; heroNetBB: number | null; actions: PlayerAction[] }[] | null>(null);
  const [branchAt, setBranchAt] = useState<number | null>(null);
  useEffect(() => {
    api.get<typeof family>(`/sim/hands/${v.id}/family`).then(setFamily).catch(onError);
  }, [v.id, onError]);
  const branch = async (decisionIndex: number, action: PlayerAction) => {
    try {
      const r = await api.post<SimView>(`/sim/hands/${v.id}/branch`, { decisionIndex, action });
      nav(`/play/${r.id}`);
    } catch (e) {
      onError(e);
    }
  };
  const fmtAct = (a: PlayerAction) => `${a.type}${a.amount ? ` ${fmtNum(a.amount / v.bigBlind, 1)}` : ''}`;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title={t('sim.timeline')}>
        <ol className="space-y-3 text-sm" data-testid="sim-timeline">
          {STREETS.filter((s) => v.review!.timeline.some((e) => e.street === s)).map((s) => (
            <li key={s}>
              <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">{t(`street.${s}`)}</div>
              <ul className="space-y-1">
                {v.review!.timeline.filter((e) => e.street === s && !['postSB', 'postBB', 'postAnte'].includes(e.type)).map((e, i) => {
                  const d = e.heroDecision !== undefined ? v.decisions[e.heroDecision] : undefined;
                  return (
                    <li key={i} className={`rounded-md px-2 py-1 ${d ? 'bg-accent/10' : ''}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <b className={e.playerId === v.config.heroPos ? 'text-accent' : ''}>{e.playerId}</b>
                        <span className="tabular">{e.type}{e.type === 'bet' || e.type === 'raise' || e.type === 'call' ? ` ${fmtNum(e.type === 'call' ? e.addedBB : e.toBB, 1)} BB` : ''}{e.allIn ? ' (all-in)' : ''}</span>
                        {e.villain && <span className="rounded bg-ink-800 px-1 text-[10px] text-ink-300">{t(`arch.${e.villain.archetype}`)} · {e.villain.source === 'solver' ? t('sim.src.solver') : t('sim.src.heuristic')}</span>}
                        {d?.feedback?.graded && <GradeBadge grade={d.feedback.grade ?? null} />}
                      </div>
                      {d && (
                        <div className="mt-1 space-y-1 text-xs">
                          {d.reasoning && <p className="italic text-ink-300">“{d.reasoning}”</p>}
                          {d.feedback && <FeedbackCard fb={d.feedback} eq={d.modelEquity} />}
                          {v.kind === 'play' && (
                            branchAt === d.index ? (
                              <div className="flex flex-wrap gap-1" data-testid="sim-branch-options">
                                {(['fold', 'check', 'call'] as const).filter((x) => x !== d.action.type).map((x) => (
                                  <button key={x} type="button" onClick={() => void branch(d.index, { type: x })} className="rounded border border-ink-600 px-2 py-0.5">{x}</button>
                                ))}
                                <button type="button" onClick={() => setBranchAt(null)} className="px-2 text-ink-400">×</button>
                              </div>
                            ) : (
                              <button type="button" onClick={() => setBranchAt(d.index)} className="text-accent" data-testid={`sim-branch-${d.index}`}>{t('sim.branch')}</button>
                            )
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
        {v.review!.showdown.length > 0 && (
          <div className="mt-3 text-xs text-ink-300">{t('sim.showdown')}: {v.review!.showdown.map((s) => `${s.id} ${s.cards.join('')}`).join(' · ')}</div>
        )}
      </Panel>
      <Panel title={t('sim.compare')}>
        <p className="mb-2 text-xs text-ink-400">{t('sim.compareNote')}</p>
        {!family ? <Spinner /> : (
          <table className="w-full text-sm" data-testid="sim-family">
            <tbody>
              {family.map((f) => (
                <tr key={f.id} className={`border-t border-ink-800 ${f.id === v.id ? 'text-accent' : ''}`}>
                  <td className="py-1.5">{t(`sim.kind.${f.kind}`)}{f.branchAt !== null ? ` @${f.branchAt + 1}` : ''}</td>
                  <td className="text-xs text-ink-300">{f.actions.map(fmtAct).join(' → ')}</td>
                  <td className="text-right tabular">{f.heroNetBB === null ? '…' : `${f.heroNetBB >= 0 ? '+' : ''}${fmtNum(f.heroNetBB, 1)}`}</td>
                  <td className="text-right">{f.id !== v.id && <Link to={`/play/${f.id}`} className="text-xs text-accent">{t('sim.open')}</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
