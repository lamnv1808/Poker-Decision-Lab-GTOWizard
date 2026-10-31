import type { HandState, LegalActions, PlayerAction } from '@pdl/core/engine';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, newAttemptId } from '../api';
import { ActionBar } from '../components/ActionBar';
import { CardText } from '../components/Cards';
import { ActionHistory, PokerTable } from '../components/PokerTable';
import { Empty, ErrorNote, Panel, Spinner } from '../components/ui';
import { fmtNum, fmtPct, loc } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { Localized } from '../types';

interface ImportResult { id: string; filename: string; status: string; handsParsed: number; handsDuplicate: number; handsFailed: number; createdAt: string; errors?: { externalHandId: string | null; message: string }[] }
interface HandRow { id: string; externalHandId: string; playedAt: string | null; heroPosition: string | null; tableSize: number; allIn: boolean; heroCards: string[] | null; level: string | null; heroDecisions: number; tournament: { name: string | null } | null }

export function HandsPage() {
  const { t, lang } = useT();
  const [hands, setHands] = useState<HandRow[] | null>(null);
  const [imports, setImports] = useState<ImportResult[]>([]);
  const [last, setLast] = useState<ImportResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const load = () => {
    api.get<HandRow[]>('/hands').then(setHands).catch(setError);
    api.get<ImportResult[]>('/imports').then(setImports).catch(() => undefined);
  };
  useEffect(load, []);
  const upload = async () => {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', f);
      setLast(await api.upload<ImportResult>('/imports', form));
      if (fileRef.current) fileRef.current.value = '';
      load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">{t('nav.hands')}</h1>
        <p className="text-sm text-ink-300">{t('hands.intro')}</p>
      </div>
      <Panel title={t('hands.import')}>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".txt,.zip,text/plain,application/zip" className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-ink-700 file:px-3 file:py-1.5 file:text-ink-100" data-testid="hh-file" />
          <button type="button" disabled={busy} onClick={upload} className="rounded-lg bg-felt-500 px-4 py-1.5 text-sm font-bold hover:bg-felt-600 disabled:opacity-50" data-testid="hh-upload">{t('hands.upload')}</button>
        </div>
        <p className="mt-2 text-xs text-ink-400">{t('hands.formats')}</p>
        <ErrorNote error={error} />
        {last && (
          <div className="mt-3 rounded-lg bg-ink-850 p-3 text-sm" data-testid="import-result">
            <div>{t('hands.parsed')}: <b>{last.handsParsed}</b> · {t('hands.duplicates')}: <b>{last.handsDuplicate}</b> · {t('hands.failed')}: <b className={last.handsFailed ? 'text-orange-300' : ''}>{last.handsFailed}</b></div>
            {last.errors && last.errors.length > 0 && (
              <ul className="mt-2 max-h-40 list-disc overflow-auto pl-5 text-xs text-orange-200">{last.errors.map((e, i) => <li key={i}>{e.externalHandId ? `#${e.externalHandId}: ` : ''}{e.message}</li>)}</ul>
            )}
          </div>
        )}
      </Panel>
      <Panel title={t('hands.list')}>
        {!hands ? <Spinner /> : hands.length === 0 ? <Empty>{t('hands.none')}</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm" data-testid="hands-table">
              <thead className="text-xs text-ink-400"><tr><th className="py-1.5">{t('hands.hand')}</th><th>{t('hands.cards')}</th><th>{t('hands.position')}</th><th>{t('hands.level')}</th><th>{t('hands.decisions')}</th><th /></tr></thead>
              <tbody>
                {hands.map((h) => (
                  <tr key={h.id} className="border-t border-ink-800">
                    <td className="py-2 font-mono text-xs">#{h.externalHandId}{h.allIn && <span className="ml-1 rounded bg-gold/20 px-1 text-[10px] text-gold">{t('table.allIn')}</span>}</td>
                    <td>{h.heroCards ? <CardText cards={h.heroCards.join('')} /> : '—'}</td>
                    <td>{h.heroPosition ?? '—'}</td>
                    <td className="text-xs text-ink-300">{h.level}</td>
                    <td className="tabular">{h.heroDecisions}</td>
                    <td className="text-right"><Link to={`/hands/${h.id}`} className="text-accent">{t('hands.review')}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {imports.length > 0 && (
        <Panel title={t('hands.history')}>
          <ul className="space-y-1 text-xs text-ink-300">{imports.map((i) => <li key={i.id}>{new Date(i.createdAt).toLocaleString(lang)} · {i.filename} · {i.status} · {i.handsParsed}/{i.handsDuplicate}/{i.handsFailed}</li>)}</ul>
        </Panel>
      )}
      <p className="text-xs text-ink-400">{loc({ en: 'Imported hands are private to your account.', vi: 'Ván bài đã nhập chỉ hiển thị với tài khoản của bạn.' }, lang)}</p>
    </div>
  );
}

interface HandDetail { id: string; externalHandId: string; tournament: string | null; level: string | null; heroName: string; heroPosition: string; heroCards: string[]; blinds: { smallBlind: number; bigBlind: number; ante: number }; spots: { index: number; street: string; answered: boolean; facingBet: boolean }[]; warnings: string[] }
interface SpotView { index: number; street: string; heroId: string; positions: Record<string, string>; bigBlind: number; state: HandState; legal: LegalActions; facts: Record<string, number | null> }
interface SpotResult { yourAction: PlayerAction; originalAction: { type: string; amount: number; allIn: boolean }; matchesOriginal: boolean; facts: Record<string, number | null>; note: Localized }

export function HandDetailPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { t, lang } = useT();
  const showBB = useApp((s) => s.me?.preferences.showBB ?? true);
  const [hand, setHand] = useState<HandDetail | null>(null);
  const [spot, setSpot] = useState<SpotView | null>(null);
  const [result, setResult] = useState<SpotResult | null>(null);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const spotIdx = Number(params.get('spot') ?? 0);
  useEffect(() => {
    api.get<HandDetail>(`/hands/${id}`).then(setHand).catch(setError);
  }, [id]);
  useEffect(() => {
    setResult(null);
    setQueued(false);
    api.get<SpotView>(`/hands/${id}/spots/${spotIdx}`).then(setSpot).catch(setError);
  }, [id, spotIdx]);
  const act = async (action: PlayerAction) => {
    try {
      setResult(await api.post<SpotResult>(`/hands/${id}/spots/${spotIdx}/answer`, { clientAttemptId: newAttemptId(), action }));
    } catch (e) {
      setError(e);
    }
  };
  if (error && !hand) return <ErrorNote error={error} />;
  if (!hand || !spot) return <Spinner />;
  const bb = spot.bigBlind;
  const f = (result?.facts ?? spot.facts) as Record<string, number | null>;
  const descr = (a: { type: string; amount?: number }) => (a.type === 'bet' || a.type === 'raise' ? `${t(a.type === 'bet' ? 'act.bet' : 'act.raiseTo')} ${fmtNum((a.amount ?? 0) / bb, 1)}BB` : a.type === 'call' && a.amount ? `${t('act.call')} ${fmtNum(a.amount / bb, 1)}BB` : t(`act.${a.type}`));
  return (
    <div className="space-y-4">
      <div>
        <Link to="/hands" className="text-xs text-accent">← {t('nav.hands')}</Link>
        <h1 className="text-xl font-bold">#{hand.externalHandId} · <CardText cards={hand.heroCards.join('')} /> · {hand.heroPosition}</h1>
        <p className="text-sm text-ink-300">{hand.tournament} · {hand.level} · {hand.blinds.smallBlind}/{hand.blinds.bigBlind}{hand.blinds.ante ? ` (${hand.blinds.ante})` : ''}</p>
      </div>
      <div className="flex flex-wrap gap-1.5" data-testid="spot-tabs">
        {hand.spots.map((s) => (
          <button key={s.index} type="button" onClick={() => setParams({ spot: String(s.index) })} className={`rounded-full border px-3 py-1 text-xs ${s.index === spotIdx ? 'border-accent text-accent' : 'border-ink-600 text-ink-300'}`}>
            {s.index + 1}. {t(`street.${s.street}`)}{s.answered ? ' ✓' : ''}
          </button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          <PokerTable state={spot.state} heroId={spot.heroId} bigBlind={bb} showBB={showBB} labels={spot.positions} heroCards={hand.heroCards} />
          {!result ? (
            <>
              <div className="text-sm font-medium">{t('hands.whatDo')}</div>
              <ActionBar state={spot.state} legal={spot.legal} bigBlind={bb} showBB={showBB} onAct={act} showConfidence={false} />
            </>
          ) : null}
          <Panel title={t('run.history')}><ActionHistory state={spot.state} bigBlind={bb} showBB={showBB} labels={spot.positions} /></Panel>
        </div>
        <Panel title={t('hands.analysis')}>
          <dl className="grid grid-cols-2 gap-y-1 text-sm tabular" data-testid="spot-facts">
            <dt className="text-ink-400">{t('fact.pot')}</dt><dd>{fmtNum(f.potBB, 1)} BB</dd>
            <dt className="text-ink-400">{t('fact.toCall')}</dt><dd>{fmtNum(f.toCallBB, 1)} BB</dd>
            {f.requiredEquityPct !== null && (<><dt className="text-ink-400">{t('fact.requiredEquity')}</dt><dd>{fmtPct(f.requiredEquityPct)}</dd></>)}
            {f.mdfPct !== null && (<><dt className="text-ink-400">{t('fact.mdf')}</dt><dd>{fmtPct(f.mdfPct)}</dd></>)}
            {f.sprAtStreet !== null && f.sprAtStreet !== undefined && (<><dt className="text-ink-400">SPR</dt><dd>{fmtNum(f.sprAtStreet)}</dd></>)}
            <dt className="text-ink-400">{t('fact.effStack')}</dt><dd>{fmtNum(f.effectiveStackBB, 1)} BB</dd>
          </dl>
          {result ? (
            <div className="mt-4 space-y-3 text-sm" data-testid="spot-result">
              <div>{t('fb.youChose')}: <b>{descr(result.yourAction)}</b></div>
              <div>{t('hands.original')}: <b>{descr(result.originalAction)}</b> {result.matchesOriginal ? <span className="text-emerald-400">({t('hands.same')})</span> : <span className="text-amber-300">({t('hands.different')})</span>}</div>
              <p className="rounded-md border border-ink-700 bg-ink-850 p-2.5 text-xs text-ink-300">{loc(result.note, lang)}</p>
              <button type="button" disabled={queued} onClick={async () => { await api.post(`/hands/${id}/spots/${spotIdx}/queue`); setQueued(true); }} className="rounded-lg border border-ink-600 px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50" data-testid="queue-spot">
                {queued ? t('hands.queued') : t('hands.saveQueue')}
              </button>
            </div>
          ) : (
            <p className="mt-4 text-xs text-ink-400">{t('hands.hidden')}</p>
          )}
          {hand.warnings.length > 0 && <ul className="mt-3 list-disc pl-5 text-xs text-amber-300">{hand.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        </Panel>
      </div>
    </div>
  );
}
