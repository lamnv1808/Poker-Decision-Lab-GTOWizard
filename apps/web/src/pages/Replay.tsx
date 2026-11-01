import type { HandState, LegalActions, PlayerAction } from '@pdl/core/engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, newAttemptId } from '../api';
import { ActionBar } from '../components/ActionBar';
import { CardText } from '../components/Cards';
import { ActionHistory, PokerTable } from '../components/PokerTable';
import { Empty, ErrorNote, GradeBadge, Panel, Spinner, Toggle } from '../components/ui';
import { fmtNum, fmtPct, loc } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { Grade, Localized } from '../types';

export interface DecisionQuestion {
  decisionId: string;
  street: string;
  format: string;
  tournament: string | null;
  level: string | null;
  blinds: { smallBlind: number; bigBlind: number; ante: number; anteMode: string };
  positions: Record<string, string>;
  heroId: string;
  heroCards: string[];
  state: HandState;
  legal: LegalActions | null;
  bigBlind: number;
  stackDepthBB: number;
  potBB: number;
  toCallBB: number;
  playersInPot: number;
  missingInfo: string[];
  pickReason?: string;
  reviewTopic?: { key: string; label: Localized } | null;
  poolSize?: number;
  potOddsPrompt?: { en: string; vi: string; terminal: boolean } | null;
}

interface Evaluated { action: string; sizeToBB?: number | string | null; ev?: number | null; freq?: number | null }
interface ReplayResult {
  yourAction: { action: string; toBB: number | null; addedBB: number; allIn: boolean };
  observed: { type: string; amountBB: number; allIn: boolean; note: Localized };
  sameAsObserved: boolean;
  facts: Record<string, number | null> | null;
  topics: { key: string; label: Localized }[];
  strategy: {
    status: 'unreviewed' | 'verified';
    evaluation?: 'ev' | 'qualitative' | 'not_evaluated';
    grade?: Grade;
    evLossBB?: number;
    toleranceBB?: number;
    source?: string;
    version?: number;
    recommendation?: string;
    explanationVi?: string;
    explanationEn?: string | null;
    confidence?: string;
    scope?: string;
    evaluated?: Evaluated[];
    missingInfo?: string[];
    economics?: Record<string, unknown>;
    assumedRanges?: { player: string; range: string; justification: string }[];
  };
  ratingChanges?: { skill: string; before: number; after: number }[];
}
interface Outcome { actions: { street: string; player: string; type: string; amountBB: number; allIn: boolean }[]; board: string[]; shown: { player: string; cards: string[] }[]; collected: { player: string; amountBB: number }[]; label: Localized; note: Localized }

export function DecisionHeader({ q }: { q: DecisionQuestion }) {
  const { t } = useT();
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="decision-header">
      <span className="rounded-md bg-ink-800 px-2 py-1 font-semibold">{t(`street.${q.street}`)}</span>
      <span className="rounded-md bg-ink-800 px-2 py-1">{q.format}</span>
      <span className="rounded-md bg-ink-800 px-2 py-1 tabular">{t('replay.stack')} {q.stackDepthBB} BB</span>
      <span className="rounded-md bg-ink-800 px-2 py-1 tabular">{t('table.pot')} {q.potBB} BB</span>
      {q.toCallBB > 0 && <span className="rounded-md bg-ink-800 px-2 py-1 tabular">{t('fact.toCall')} {q.toCallBB} BB</span>}
      <span className="rounded-md bg-ink-800 px-2 py-1">{q.playersInPot} {t('replay.players')}</span>
      <span className="text-ink-400">{q.level} · {q.blinds.smallBlind}/{q.blinds.bigBlind}{q.blinds.ante ? ` (${q.blinds.ante})` : ''}</span>
    </div>
  );
}

const describe = (a: { action: string; toBB: number | null; addedBB: number }, t: (k: string) => string) =>
  a.action === 'bet' || a.action === 'raise' ? `${t(a.action === 'bet' ? 'act.bet' : 'act.raiseTo')} ${a.toBB} BB (${t('replay.adds')} ${a.addedBB} BB)` : a.action === 'allin' ? `${t('table.allIn')} (${t('replay.adds')} ${a.addedBB} BB)` : a.action === 'call' ? `${t('act.call')} ${a.addedBB} BB` : t(`act.${a.action}`);

export function ReplayPage({ kind }: { kind: 'replay' | 'strategy' }) {
  const { t, lang } = useT();
  const showBB = useApp((s) => s.me?.preferences.showBB ?? true);
  const [params] = useSearchParams();
  const [street, setStreet] = useState<string>('');
  const [topic, setTopic] = useState<string>(params.get('topic') ?? '');
  const [multiway, setMultiway] = useState<'' | 'true' | 'false'>('');
  const [mode, setMode] = useState<'practice' | 'rated'>('practice');
  const [q, setQ] = useState<DecisionQuestion | null>(null);
  const [pending, setPending] = useState<PlayerAction | null>(null);
  const [reasoning, setReasoning] = useState('');
  const [confidence, setConfidence] = useState<1 | 2 | 3 | null>(null);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(Date.now());

  const next = useCallback(async () => {
    setError(null);
    setResult(null);
    setOutcome(null);
    setPending(null);
    setReasoning('');
    setConfidence(null);
    try {
      const filters = { street: street || undefined, topic: topic || undefined, multiway: multiway || undefined };
      const direct = params.get('decision');
      const r = direct && !q ? await api.get<DecisionQuestion>(`/real/decisions/${direct}/question`) : await api.post<DecisionQuestion>('/real/next', { kind, filters });
      setQ(r);
      shownAt.current = Date.now();
    } catch (e) {
      setQ(null);
      setError(e);
    }
  }, [kind, street, topic, multiway]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void next();
  }, [next]);

  const submit = async () => {
    if (!q || !pending || !confidence || reasoning.trim().length < 3) return;
    setBusy(true);
    try {
      const r = await api.post<ReplayResult>(`/real/decisions/${q.decisionId}/answer`, { clientAttemptId: newAttemptId(), action: pending, reasoning, confidence, responseMs: Date.now() - shownAt.current, mode });
      setResult(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const pendingLabel = pending && q ? (pending.type === 'bet' || pending.type === 'raise' ? `${t(pending.type === 'bet' ? 'act.bet' : 'act.raiseTo')} ${fmtNum((pending.amount ?? 0) / q.bigBlind, 2)} BB` : t(`act.${pending.type}`)) : '';
  const s = result?.strategy;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">{t(kind === 'replay' ? 'nav.replay' : 'nav.strategy')}</h1>
        <p className="text-sm text-ink-300">{t(kind === 'replay' ? 'replay.intro' : 'strategy.intro')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select aria-label={t('progress.street')} value={street} onChange={(e) => setStreet(e.target.value)} className="rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5">
          <option value="">{t('replay.anyStreet')}</option>
          {['preflop', 'flop', 'turn', 'river'].map((x) => <option key={x} value={x}>{t(`street.${x}`)}</option>)}
        </select>
        <select aria-label={t('replay.topic')} value={topic} onChange={(e) => setTopic(e.target.value)} className="max-w-[16rem] rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5" data-testid="replay-topic">
          <option value="">{t('replay.anyTopic')}</option>
          {['callingShove', 'initiatingShove', 'topPairVsAggression', 'turnChangesBoard', 'drawsAndOuts', 'valueBetting', 'bluffing', 'multiwayOrBounty', 'blockingAces'].map((x) => <option key={x} value={x}>{t(`topic.${x}`)}</option>)}
        </select>
        <Toggle label={t('replay.multiway')} value={multiway} onChange={setMultiway} options={[{ value: '', label: t('gto.any') }, { value: 'false', label: t('replay.headsUp') }, { value: 'true', label: t('replay.multiwayShort') }]} />
        {kind === 'strategy' && <div className="ml-auto"><Toggle label={t('mode.label')} value={mode} onChange={setMode} options={[{ value: 'practice', label: t('mode.practice') }, { value: 'rated', label: t('mode.rated') }]} /></div>}
      </div>
      {kind === 'replay' && <div className="rounded-md border border-amber-500/30 bg-amber-900/10 px-3 py-2 text-xs text-amber-200">{t('replay.unreviewedBanner')}</div>}
      <ErrorNote error={error} />
      {!q && !error ? <Spinner /> : !q ? (
        <Empty>{kind === 'strategy' ? <>{t('strategy.none')} <Link className="text-accent" to="/annotate">{t('nav.annotate')}</Link></> : t('list.empty')}</Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="space-y-3">
            <DecisionHeader q={q} />
            {q.reviewTopic && <div className="text-xs text-sky-300">{t('replay.conceptReview')}: {loc(q.reviewTopic.label, lang)}</div>}
            <PokerTable state={q.state} heroId={q.heroId} bigBlind={q.bigBlind} showBB={showBB} labels={q.positions} heroCards={q.heroCards} />
            {!result && q.legal && !pending && <ActionBar state={q.state} legal={q.legal} bigBlind={q.bigBlind} showBB={showBB} onAct={(a) => setPending(a)} showConfidence={false} />}
            {!result && pending && (
              <Panel>
                <div className="space-y-3" data-testid="reason-form">
                  <div className="flex items-center justify-between text-sm">
                    <span>{t('replay.yourChoice')}: <b>{pendingLabel}</b></span>
                    <button type="button" className="text-xs text-ink-400 hover:text-ink-100" onClick={() => setPending(null)}>{t('replay.change')}</button>
                  </div>
                  <label className="block text-xs text-ink-300">
                    {t('replay.reasoning')}
                    <textarea value={reasoning} onChange={(e) => setReasoning(e.target.value)} rows={3} maxLength={2000} placeholder={t('replay.reasoningHint')} className="mt-1 w-full rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm" data-testid="reasoning" />
                  </label>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-300">
                    {t('action.confidence')}:
                    {([3, 2, 1] as const).map((c) => (
                      <button key={c} type="button" onClick={() => setConfidence(c)} aria-pressed={confidence === c} className={`rounded-md border px-2.5 py-1 ${confidence === c ? 'border-accent bg-accent/10 text-accent' : 'border-ink-600'}`} data-testid={`confidence-${c}`}>{t(`confidence.${c}`)}</button>
                    ))}
                  </div>
                  <button type="button" disabled={busy || !confidence || reasoning.trim().length < 3} onClick={() => void submit()} className="w-full rounded-lg bg-felt-500 py-2.5 text-sm font-bold hover:bg-felt-600 disabled:opacity-40" data-testid="replay-submit">{t('replay.submit')}</button>
                  <p className="text-[11px] text-ink-400">{t('replay.submitNote')}</p>
                </div>
              </Panel>
            )}
            {result && (
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void next()} className="rounded-lg bg-felt-500 px-5 py-2 text-sm font-bold hover:bg-felt-600" data-testid="replay-next">{t('run.nextTest')} →</button>
                {!outcome && <button type="button" onClick={async () => setOutcome(await api.get<Outcome>(`/real/decisions/${q.decisionId}/outcome`))} className="rounded-lg border border-ink-600 px-3 py-2 text-sm" data-testid="show-outcome">{t('replay.whatHappened')}</button>}
              </div>
            )}
            {outcome && (
              <Panel title={loc(outcome.label, lang)}>
                <div className="space-y-1 text-xs" data-testid="outcome">
                  <div>{t('replay.board')}: <CardText cards={outcome.board.join('')} /></div>
                  <div className="text-ink-300">{outcome.actions.map((a, i) => <span key={i} className="mr-2 inline-block">{t(`street.${a.street}`)} <b>{a.player}</b> {t(`act.${a.type}`)}{a.amountBB ? ` ${a.amountBB}` : ''}{a.allIn ? ` (${t('table.allIn')})` : ''}</span>)}</div>
                  {outcome.shown.length > 0 && <div>{outcome.shown.map((x) => <span key={x.player} className="mr-3">{x.player}: <CardText cards={x.cards.join('')} /></span>)}</div>}
                  <div className="text-ink-400">{loc(outcome.note, lang)}</div>
                </div>
              </Panel>
            )}
            <Panel title={t('run.history')}><ActionHistory state={q.state} bigBlind={q.bigBlind} showBB={showBB} labels={q.positions} /></Panel>
          </div>
          <Panel title={t('run.feedback')}>
            {!result ? (
              <div className="space-y-2 text-sm text-ink-400">
                <p>{t('replay.hint')}</p>
                <p className="text-xs">{t('replay.missing')}: {q.missingInfo.map((m) => t(`missing.${m}`)).join(', ')}</p>
              </div>
            ) : (
              <div className="space-y-3 text-sm" data-testid="replay-result">
                <div className="rounded-lg bg-ink-850 p-2.5">
                  <div className="text-xs uppercase text-ink-400">{t('fb.youChose')}</div>
                  <div className="font-semibold">{describe(result.yourAction, t)}</div>
                </div>
                <div className="rounded-lg border border-ink-700 p-2.5" data-testid="observed">
                  <div className="text-xs uppercase text-ink-400">{t('replay.observed')}</div>
                  <div className="font-semibold">{t(`act.${result.observed.type}`)}{result.observed.amountBB ? ` ${fmtNum(result.observed.amountBB, 2)} BB` : ''}{result.observed.allIn ? ` (${t('table.allIn')})` : ''}</div>
                  <div className="text-xs text-ink-400">{loc(result.observed.note, lang)}</div>
                </div>
                {s?.status === 'unreviewed' ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-900/10 p-2.5 text-xs text-amber-200" data-testid="unreviewed">{t('replay.noJudgement')}</div>
                ) : s ? (
                  <div className="space-y-2" data-testid="strategy-eval">
                    <div className="flex flex-wrap items-center gap-2">
                      {s.evaluation === 'ev' && <GradeBadge grade={s.grade ?? null} large />}
                      {s.evaluation === 'ev' && <span className="tabular text-ink-300">{t('fb.evLoss')}: <b className="text-ink-100">{fmtNum(s.evLossBB, 2)} BB</b> (±{s.toleranceBB})</span>}
                      {s.evaluation === 'not_evaluated' && <span className="rounded border border-ink-500 px-2 py-0.5 text-xs" data-testid="not-evaluated">{t('replay.notEvaluated')}</span>}
                      {s.evaluation === 'qualitative' && <span className="rounded border border-sky-500/40 px-2 py-0.5 text-xs text-sky-300">{t('replay.qualitative')}</span>}
                      <span className="text-[10px] uppercase text-ink-400">{t(`annot.source.${s.source}`)} · v{s.version} · {t('annot.confidence')} {s.confidence}</span>
                    </div>
                    <div>{t('fb.recommended')}: <b className="text-emerald-300">{s.recommendation}</b></div>
                    <p>{lang === 'vi' ? s.explanationVi : (s.explanationEn ?? s.explanationVi)}</p>
                    {s.evaluated && (
                      <table className="w-full text-xs tabular">
                        <thead className="text-ink-400"><tr><th className="text-left">{t('fb.action')}</th><th className="text-right">{t('annot.size')}</th><th className="text-right">EV</th><th className="text-right">{t('pf.gtoFreq')}</th></tr></thead>
                        <tbody>{s.evaluated.map((e, i) => <tr key={i} className="border-t border-ink-800"><td>{e.action}</td><td className="text-right">{e.sizeToBB ?? '—'}</td><td className="text-right">{typeof e.ev === 'number' ? fmtNum(e.ev, 2) : '—'}</td><td className="text-right">{typeof e.freq === 'number' ? `${Math.round(e.freq * 100)}%` : '—'}</td></tr>)}</tbody>
                      </table>
                    )}
                    <p className="text-xs text-ink-400">{t('annot.scope')}: {s.scope}</p>
                  </div>
                ) : null}
                {result.facts && (
                  <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-xs tabular">
                    <dt className="text-ink-400">{t('fact.pot')}</dt><dd>{fmtNum(result.facts.potBB, 1)} BB</dd>
                    {result.facts.requiredEquityPct !== null && (<><dt className="text-ink-400">{t('fact.requiredEquity')}</dt><dd>{fmtPct(result.facts.requiredEquityPct)}</dd></>)}
                    {result.facts.spr !== null && (<><dt className="text-ink-400">SPR</dt><dd>{fmtNum(result.facts.spr)}</dd></>)}
                    <dt className="text-ink-400">{t('fact.effStack')}</dt><dd>{fmtNum(result.facts.effectiveStackBB, 1)} BB</dd>
                  </dl>
                )}
                {result.topics.length > 0 && <div className="text-xs text-ink-300">{t('replay.topics')}: {result.topics.map((x) => loc(x.label, lang)).join(' · ')}<div className="text-ink-400">{t('replay.topicsNote')}</div></div>}
                {result.ratingChanges && result.ratingChanges.length > 0 && <div className="text-xs text-ink-400">{result.ratingChanges.map((c) => `${t(`skill.${c.skill}`)} ${Math.round(c.after)} (${c.after >= c.before ? '+' : ''}${Math.round(c.after - c.before)})`).join(' · ')}</div>}
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
