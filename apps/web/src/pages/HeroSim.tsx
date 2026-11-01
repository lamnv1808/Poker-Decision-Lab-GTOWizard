import type { HandState, LegalActions, PlayerAction } from '@pdl/core/engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, newAttemptId } from '../api';
import { ActionBar } from '../components/ActionBar';
import { PokerTable } from '../components/PokerTable';
import { CardText } from '../components/Cards';
import { ErrorNote, GradeBadge, Panel, Spinner, Toggle } from '../components/ui';
import { fmtNum, loc } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { Grade, Localized } from '../types';

interface Facts { potBB: number; toCallBB: number; requiredEquity: number | null; spr: number | null; street: string }
type Assessment = 'solverVerified' | 'mathVerified' | 'reviewedStrategy' | 'assumedRange' | 'heuristicCoaching' | 'notEvaluated';
interface Feedback {
  assessment?: Assessment;
  coaching?: Localized;
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
interface DecisionView { topics?: string[]; legal?: LegalActions; index: number; street: string; action: PlayerAction; confidence: number | null; reasoning: string | null; facts: Facts; feedback?: Feedback; modelEquity?: ModelEq }
interface VillainWhy { archetype: string; source: 'solver' | 'heuristic' | 'scripted'; chosen: 'fold' | 'passive' | 'aggressive'; forced?: boolean; probs?: { fold: number; passive: number; aggressive: number }; strength?: { kind: 'preflopTop' | 'postflop'; value: number } }
interface TimelineEntry { street: string; playerId: string; type: string; toBB: number; addedBB: number; allIn: boolean; villain?: VillainWhy; heroDecision?: number }
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
  origin?: { kind: 'random' | 'scenario' | 'solverFlop'; scenarioId: string | null; flop: string | null };
  bookmarked?: boolean;
  review: null | { timeline: TimelineEntry[]; showdown: { id: string; cards: string[]; category: string | null }[]; netBB: Record<string, number>; heroNetBB: number; gradedCount: number; winners: { id: string; amountBB: number; category: string | null }[]; endedBy: 'fold' | 'showdown'; terminalStreet: string; source: { villains: Localized } };
}
interface Setup { table?: 'random' | 'solverFlop'; tableSize: number; stackBB: number; archetype: string; mode: 'practice' | 'rated'; feedback: 'guided' | 'exam' }

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
    const v = await api.post<SimView>('/sim/hands', { table: s.table ?? 'random', tableSize: s.tableSize || undefined, stackBB: s.stackBB || undefined, archetype: s.archetype, mode: s.mode, feedback: s.feedback, sessionId });
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
  const [gen, setGen] = useState<{ handsCompleted: number; uniqueSituations: number } | null>(null);
  useEffect(() => {
    api.get<typeof active>('/sim/hands/active').then(setActive).catch(setError);
    api.get<{ generated: { handsCompleted: number; uniqueSituations: number } }>('/history/summary').then((x) => setGen(x.generated)).catch(() => {});
  }, []);
  const sel = 'rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm';
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">{t('sim.title')}</h1>
        <p className="text-sm text-ink-300">{t('sim.intro')}</p>
        {gen && <p className="mt-1 text-xs text-ink-400" data-testid="sim-generated-count">{t('sim.generatedCount', { n: gen.handsCompleted, u: gen.uniqueSituations })}</p>}
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
        <div className="mb-3">
          <Toggle label={t('sim.tableType')} value={s.table ?? 'random'} onChange={(table) => setS({ ...s, table })} options={[{ value: 'random', label: t('sim.table.random') }, { value: 'solverFlop', label: t('sim.table.solverFlop') }]} />
          <p className="mt-1 text-xs text-ink-400">{t(s.table === 'solverFlop' ? 'sim.table.solverFlopNote' : 'sim.table.randomNote')}</p>
        </div>
        <div className={`grid gap-3 sm:grid-cols-3 ${s.table === 'solverFlop' ? 'pointer-events-none opacity-40' : ''}`}>
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
  // after the hand, streets that were never reached are shown as skipped, not completed
  const reached = v.review ? STREETS.indexOf(v.review.terminalStreet) : 3;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="sim-progress">
      <ol className="flex items-center gap-1 text-[11px]">
        {[...STREETS, 'showdown'].map((s, i) => (
          <li key={s} className={`rounded-full px-2 py-0.5 ${i === cur ? 'bg-accent/20 text-accent' : i < cur && (i === 4 || i <= reached) ? 'text-ink-300' : 'text-ink-600 line-through'}`}>
            {i < cur && (i === 4 || i <= reached) ? '✓ ' : ''}{s === 'showdown' ? t('sim.handEnd') : t(`street.${s}`)}
          </li>
        ))}
      </ol>
      <span className="text-xs text-ink-300 tabular" data-testid="sim-decision-counter">{t('sim.decisionN', { n: v.progress.decisionNumber })}</span>
      <span className="rounded bg-ink-800 px-1.5 text-[10px] uppercase text-ink-300">{t(`mode.${v.mode}`)} · {t(`sim.${v.feedback}`)}{v.kind !== 'play' ? ` · ${t(`sim.kind.${v.kind}`)}` : ''}</span>
    </div>
  );
}

const ASSESS_CLS: Record<Assessment, string> = {
  solverVerified: 'border-emerald-400/60 text-emerald-300',
  mathVerified: 'border-emerald-400/60 text-emerald-300',
  reviewedStrategy: 'border-emerald-400/60 text-emerald-300',
  assumedRange: 'border-sky-400/60 text-sky-300',
  heuristicCoaching: 'border-amber-400/60 text-amber-300',
  notEvaluated: 'border-ink-500 text-ink-400',
};
/** Solver Verified / Math Verified / Reviewed Strategy / Assumed-Range Model / Heuristic Coaching / Not Evaluated */
export function AssessmentBadge({ a }: { a: Assessment }) {
  const { t } = useT();
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${ASSESS_CLS[a]}`} title={t(`assess.${a}.help`)} data-testid={`assess-${a}`}>{t(`assess.${a}`)}</span>;
}

function FeedbackCard({ fb, eq }: { fb: Feedback; eq?: ModelEq }) {
  const { t, lang } = useT();
  return (
    <div className="space-y-1.5 text-sm" data-testid="sim-feedback">
      <div className="flex flex-wrap items-center gap-2">
        {fb.assessment && <AssessmentBadge a={fb.assessment} />}
        {fb.graded ? <GradeBadge grade={fb.grade ?? null} /> : <span className="rounded bg-ink-800 px-2 py-0.5 text-xs text-ink-300">{t('sim.notGraded')}</span>}
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
      {fb.coaching && <p className="rounded border border-sky-500/30 bg-sky-500/5 px-2 py-1 text-xs text-sky-200" data-testid="sim-coaching">{loc(fb.coaching, lang)}</p>}
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
              <div className="mt-2 space-y-0.5 text-sm" data-testid="sim-winners">
                <div className="text-xs text-ink-400">{v.review.endedBy === 'showdown' ? t('sim.endedShowdown', { street: t(`street.${v.review.terminalStreet}`) }) : t('sim.endedFold', { street: t(`street.${v.review.terminalStreet}`) })}</div>
                {v.review.winners.map((w) => (
                  <div key={w.id}>
                    <b className={w.id === v.config.heroPos ? 'text-accent' : ''}>{w.id}</b> {t('sim.wins', { n: fmtNum(w.amountBB, 1) })}
                    {w.category && <span className="text-ink-300"> · {t(`hand.${w.category}`)}</span>}
                  </div>
                ))}
              </div>
              <HiddenInfo id={v.id} />
              <p className="mt-2 text-[11px] text-ink-400">{loc(v.review.source.villains, lang)}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {mixed ? (
                  <button type="button" onClick={() => nav(`/mixed/${mixed}`)} className="rounded-lg bg-felt-500 px-4 py-1.5 text-sm font-bold" data-testid="mixed-next">{t('mixed.next')}</button>
                ) : (
                  <button type="button" onClick={() => void start(nextSetup).catch(setError)} className="rounded-lg bg-felt-500 px-4 py-1.5 text-sm font-bold" data-testid="sim-next">{t('sim.nextNewHand')}</button>
                )}
                <button type="button" onClick={() => void api.post<SimView>(`/sim/hands/${v.id}/replay`).then((r) => nav(`/play/${r.id}`)).catch(setError)} className="rounded-lg border border-ink-600 px-3 py-1.5 text-sm" data-testid="sim-replay">{t('sim.replay')}</button>
                <button type="button" onClick={() => void api.post(`/sim/hands/${v.id}/bookmark`, { on: !v.bookmarked }).then(() => setV({ ...v, bookmarked: !v.bookmarked })).catch(setError)} className={`rounded-lg border px-3 py-1.5 text-sm ${v.bookmarked ? 'border-gold text-gold' : 'border-ink-600'}`} data-testid="sim-bookmark">★ {t(v.bookmarked ? 'sim.bookmarked' : 'sim.bookmark')}</button>
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
  const branchVillain = async (historyIndex: number, choice: 'fold' | 'passive' | 'aggressive') => {
    try {
      const r = await api.post<SimView>(`/sim/hands/${v.id}/branch-villain`, { historyIndex, choice });
      nav(`/play/${r.id}`);
    } catch (e) {
      onError(e);
    }
  };
  const fmtAct = (a: PlayerAction) => `${a.type}${a.amount ? ` ${fmtNum(a.amount / v.bigBlind, 1)}` : ''}`;
  /** Legal alternatives to what Hero did: fold / check / call, a min-raise and all-in. */
  const alternatives = (d: DecisionView): PlayerAction[] => {
    const l = d.legal;
    if (!l) return [];
    const out: PlayerAction[] = [];
    if (l.canFold) out.push({ type: 'fold' });
    out.push(l.canCheck ? { type: 'check' } : { type: 'call' });
    if (l.canBet || l.canRaise) {
      const type = l.canBet ? 'bet' : 'raise';
      for (const amt of [l.minRaiseTo, l.maxRaiseTo]) if (!out.some((o) => o.amount === amt)) out.push({ type, amount: amt });
    }
    return out.filter((a) => !(a.type === d.action.type && (a.amount ?? 0) === (d.action.amount ?? 0)));
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title={t('sim.timeline')}>
        <ol className="space-y-3 text-sm" data-testid="sim-timeline">
          {STREETS.filter((s) => v.review!.timeline.some((e) => e.street === s)).map((s) => (
            <li key={s}>
              <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">{t(`street.${s}`)}</div>
              <ul className="space-y-1">
                {v.review!.timeline.map((e, hi) => ({ e, hi })).filter(({ e }) => e.street === s && !['postSB', 'postBB', 'postAnte'].includes(e.type)).map(({ e, hi }, i) => {
                  const d = e.heroDecision !== undefined ? v.decisions[e.heroDecision] : undefined;
                  return (
                    <li key={i} className={`rounded-md px-2 py-1 ${d ? 'bg-accent/10' : ''}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <b className={e.playerId === v.config.heroPos ? 'text-accent' : ''}>{e.playerId}</b>
                        <span className="tabular">{t(`act.log.${e.type}`)}{e.type === 'bet' || e.type === 'raise' || e.type === 'call' || e.type === 'returnUncalled' ? ` ${fmtNum(e.type === 'call' || e.type === 'returnUncalled' ? e.addedBB : e.toBB, 1)} BB` : ''}{e.allIn ? ' (all-in)' : ''}</span>
                        {e.villain && <span className="rounded bg-ink-800 px-1 text-[10px] text-ink-300">{t(`arch.${e.villain.archetype}`)} · {t(`sim.src.${e.villain.source}`)}{e.villain.forced ? ` · ${t('sim.forced')}` : ''}</span>}
                        {d?.feedback?.graded && <GradeBadge grade={d.feedback.grade ?? null} />}
                      </div>
                      {e.villain && e.villain.source !== 'scripted' && <VillainWhyRow w={e.villain} onBranch={(choice) => void branchVillain(hi, choice)} />}
                      {d && (
                        <div className="mt-1 space-y-1 text-xs">
                          {d.topics && d.topics.length > 0 && <div className="flex flex-wrap gap-1">{d.topics.map((x) => <span key={x} className="rounded bg-ink-800 px-1.5 text-[10px] text-ink-300">{t(`topic.${x}`)}</span>)}</div>}
                          {d.legal && <div className="text-[11px] text-ink-400">{t('sim.alternatives')}: {alternatives(d).map(fmtAct).join(' · ') || '—'}</div>}
                          {d.confidence && <div className="text-[11px] text-ink-400">{t('sim.yourConfidence')}: {t(`confidence.${d.confidence}`)}</div>}
                          {d.reasoning && <p className="italic text-ink-300">“{d.reasoning}”</p>}
                          {d.feedback && <FeedbackCard fb={d.feedback} eq={d.modelEquity} />}
                          {v.kind === 'play' && (
                            branchAt === d.index ? (
                              <div className="flex flex-wrap gap-1" data-testid="sim-branch-options">
                                {alternatives(d).map((a) => (
                                  <button key={fmtAct(a)} type="button" onClick={() => void branch(d.index, a)} className="rounded border border-ink-600 px-2 py-0.5">{fmtAct(a)}</button>
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

/** After the hand: why the modelled Villain acted (labelled heuristic or solver) + Branch Challenge. */
function VillainWhyRow({ w, onBranch }: { w: VillainWhy; onBranch: (c: 'fold' | 'passive' | 'aggressive') => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const p = (x?: number) => (x === undefined ? '—' : `${Math.round(x * 100)}%`);
  const strength = w.strength ? (w.strength.kind === 'preflopTop' ? t('sim.why.top', { n: Math.max(1, Math.round(w.strength.value * 100)) }) : t('sim.why.post', { n: Math.round(w.strength.value * 100) })) : '';
  return (
    <div className="mt-1 text-[11px]">
      <button type="button" className="text-ink-400 hover:text-ink-200" onClick={() => setOpen(!open)} data-testid="villain-why">{open ? '▾' : '▸'} {t('sim.why.title')}</button>
      {open && (
        <div className="mt-1 space-y-1 rounded border border-ink-700 bg-ink-850 p-2 text-ink-300">
          <p>{t(w.source === 'solver' ? 'sim.why.solver' : 'sim.why.heuristic', { arch: t(`arch.${w.archetype}`), strength, fold: p(w.probs?.fold), passive: p(w.probs?.passive), aggressive: p(w.probs?.aggressive) })}</p>
          <div className="flex flex-wrap gap-1" data-testid="villain-branch">
            <span className="text-ink-400">{t('sim.whatIf')}</span>
            {(['fold', 'passive', 'aggressive'] as const).filter((c) => c !== w.chosen).map((c) => (
              <button key={c} type="button" onClick={() => onBranch(c)} className="rounded border border-ink-600 px-1.5">{t(`sim.choice.${c}`)}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Optional, after the hand: simulator-only hidden cards and the hypothetical runout (labelled). */
function HiddenInfo({ id }: { id: string }) {
  const { t, lang } = useT();
  const [h, setH] = useState<null | { runout: string[]; opponents: { id: string; cards: string[]; folded: boolean }[]; label: Localized }>(null);
  const [show, setShow] = useState<{ runout: boolean; cards: boolean }>({ runout: false, cards: false });
  const get = async (k: 'runout' | 'cards') => {
    if (!h) setH(await api.get(`/sim/hands/${id}/hidden`));
    setShow((x) => ({ ...x, [k]: true }));
  };
  return (
    <div className="mt-3 space-y-2 text-xs" data-testid="sim-hidden">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void get('runout')} className="rounded border border-ink-600 px-2 py-1" data-testid="reveal-runout">{t('sim.revealRunout')}</button>
        <button type="button" onClick={() => void get('cards')} className="rounded border border-ink-600 px-2 py-1" data-testid="reveal-cards">{t('sim.revealCards')}</button>
      </div>
      {h && (show.runout || show.cards) && (
        <div className="rounded border border-dashed border-amber-400/50 bg-amber-500/5 p-2" data-testid="sim-hidden-panel">
          <p className="mb-1 text-[11px] text-amber-200">{loc(h.label, lang)}</p>
          {show.runout && <div>{t('sim.hypotheticalRunout')}: {h.runout.length ? <CardText cards={h.runout.join('')} /> : '—'}</div>}
          {show.cards && <div className="space-y-0.5">{h.opponents.map((o) => <div key={o.id}>{o.id}: <CardText cards={o.cards.join('')} />{o.folded ? ` (${t('table.folded')})` : ''}</div>)}</div>}
        </div>
      )}
    </div>
  );
}
