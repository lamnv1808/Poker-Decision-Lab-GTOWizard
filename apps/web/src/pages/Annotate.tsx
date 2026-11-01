import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { PokerTable } from '../components/PokerTable';
import { Empty, ErrorNote, Panel, Spinner } from '../components/ui';
import { fmtNum } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';
import { type DecisionQuestion, DecisionHeader } from './Replay';

interface Row { id: string; externalId: string; street: string; stackDepthBB: number; potBB: number; toCallBB: number; investedBB: number; playersInPot: number; multiway: boolean; facingAllIn: boolean; format: string; topics: string[]; reviewTags: string[]; split: string; annotations: { id: string; status: string; version: number; source: string }[] }
interface Ann { id: string; version: number; status: string; source: string; authorKind: string; recommendation: string; explanationVi: string; explanationEn: string | null; confidence: string; scope: string; evaluated: { action: string; sizeToBB?: number | string | null; ev?: number | null; freq?: number | null }[]; assumedRanges: { player: string; range: string; justification: string }[]; economics: Record<string, unknown>; missingInfo: string[]; solverMeta: unknown; verifiedAt: string | null; createdAt: string }
interface Review { question: DecisionQuestion; observed: { type: string; amountBB: number; allIn: boolean }; reviewTags: string[]; topics: string[]; split: string; annotations: Ann[] }

const emptyForm = () => ({
  source: 'human' as 'human' | 'calculation' | 'solver',
  ranges: [{ player: 'Villain', range: '', justification: '' }],
  icm: 'not modelled',
  bounty: 'not modelled',
  missing: 'payout structure, bounty sizes',
  evaluated: [{ action: 'fold', size: '', ev: '' }, { action: 'call', size: '', ev: '' }],
  recommendation: '',
  explanationVi: '',
  explanationEn: '',
  confidence: 'medium' as 'low' | 'medium' | 'high',
  scope: '',
  tolerance: '0.05',
});

export function AnnotatePage() {
  const { t } = useT();
  const showBB = useApp((s) => s.me?.preferences.showBB ?? true);
  const [f, setF] = useState({ street: '', minStack: '', maxStack: '', minPot: '', minFaced: '', multiway: '', format: '', annotation: 'any', status: 'accepted' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: Row[]; pageSize: number } | null>(null);
  const [sel, setSel] = useState<Review | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [error, setError] = useState<unknown>(null);
  const [confirmVerify, setConfirmVerify] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams(Object.entries({ ...f, page: String(page), pageSize: '20' }).filter(([, v]) => v !== ''));
    try {
      setData(await api.get(`/real/review?${qs}`));
    } catch (e) {
      setError(e);
    }
  }, [f, page]);
  useEffect(() => {
    void load();
  }, [load]);
  const open = async (id: string) => {
    setSelId(id);
    setForm(emptyForm());
    try {
      setSel(await api.get<Review>(`/real/decisions/${id}/review`));
    } catch (e) {
      setError(e);
    }
  };
  const save = async () => {
    if (!selId) return;
    setError(null);
    try {
      await api.post(`/real/decisions/${selId}/annotations`, {
        source: form.source,
        authorKind: 'human',
        infoAvailable: { street: sel?.question.street, stackDepthBB: sel?.question.stackDepthBB, potBB: sel?.question.potBB, toCallBB: sel?.question.toCallBB },
        assumedRanges: form.ranges.filter((r) => r.range.trim()),
        economics: { chipEV: true, icm: form.icm, bounty: form.bounty },
        missingInfo: form.missing.split(',').map((x) => x.trim()).filter(Boolean),
        evaluated: form.evaluated.filter((e) => e.action).map((e) => ({ action: e.action, sizeToBB: e.size === '' ? null : e.size === 'all-in' ? 'all-in' : Number(e.size), ev: e.ev === '' ? null : Number(e.ev) })),
        recommendation: form.recommendation,
        explanationVi: form.explanationVi,
        explanationEn: form.explanationEn || undefined,
        confidence: form.confidence,
        scope: form.scope,
        toleranceBB: Number(form.tolerance),
      });
      await open(selId);
      void load();
    } catch (e) {
      setError(e);
    }
  };
  const verify = async (id: string) => {
    try {
      await api.post(`/real/annotations/${id}/verify`, { confirm: true });
      setConfirmVerify(null);
      if (selId) await open(selId);
      void load();
    } catch (e) {
      setError(e);
    }
  };
  const input = 'rounded-md border border-ink-600 bg-ink-850 px-2 py-1 text-sm';
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">{t('nav.annotate')}</h1>
        <p className="text-sm text-ink-300">{t('annot.intro')}</p>
      </div>
      <div className="flex flex-wrap gap-2 text-sm" data-testid="annot-filters">
        <select aria-label={t('progress.street')} className={input} value={f.street} onChange={(e) => (setPage(1), setF({ ...f, street: e.target.value }))}><option value="">{t('replay.anyStreet')}</option>{['preflop', 'flop', 'turn', 'river'].map((x) => <option key={x} value={x}>{t(`street.${x}`)}</option>)}</select>
        <input aria-label={t('annot.minStack')} placeholder={t('annot.minStack')} className={`${input} w-24`} value={f.minStack} onChange={(e) => setF({ ...f, minStack: e.target.value })} />
        <input aria-label={t('annot.maxStack')} placeholder={t('annot.maxStack')} className={`${input} w-24`} value={f.maxStack} onChange={(e) => setF({ ...f, maxStack: e.target.value })} />
        <input aria-label={t('annot.minPot')} placeholder={t('annot.minPot')} className={`${input} w-24`} value={f.minPot} onChange={(e) => setF({ ...f, minPot: e.target.value })} />
        <input aria-label={t('annot.minFaced')} placeholder={t('annot.minFaced')} className={`${input} w-28`} value={f.minFaced} onChange={(e) => setF({ ...f, minFaced: e.target.value })} />
        <select aria-label={t('replay.multiway')} className={input} value={f.multiway} onChange={(e) => setF({ ...f, multiway: e.target.value })}><option value="">{t('replay.multiway')}: {t('gto.any')}</option><option value="false">{t('replay.headsUp')}</option><option value="true">{t('replay.multiwayShort')}</option></select>
        <select aria-label="format" className={input} value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}><option value="">Format: {t('gto.any')}</option>{['PKO', 'Hyper', 'Turbo', 'MTT', 'Freeroll'].map((x) => <option key={x}>{x}</option>)}</select>
        <select aria-label={t('annot.status')} className={input} value={f.annotation} onChange={(e) => setF({ ...f, annotation: e.target.value })} data-testid="annot-status-filter">{['any', 'none', 'draft', 'verified'].map((x) => <option key={x} value={x}>{t(`annot.filter.${x}`)}</option>)}</select>
        <select aria-label="record" className={input} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="accepted">{t('annot.accepted')}</option><option value="quarantined">{t('annot.quarantined')}</option></select>
      </div>
      <ErrorNote error={error} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Panel title={`${t('annot.queue')} (${data?.total ?? '…'})`}>
          {!data ? <Spinner /> : data.rows.length === 0 ? <Empty>{t('list.empty')}</Empty> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-xs tabular" data-testid="annot-table">
                <thead className="text-ink-400"><tr><th className="py-1">{t('progress.street')}</th><th>{t('replay.stack')}</th><th>{t('table.pot')}</th><th>{t('fact.toCall')}</th><th>{t('annot.invested')}</th><th>{t('replay.players')}</th><th>{t('annot.reviewTags')}</th><th>{t('annot.status')}</th></tr></thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} onClick={() => void open(r.id)} className={`cursor-pointer border-t border-ink-800 hover:bg-ink-850 ${selId === r.id ? 'bg-ink-800' : ''}`}>
                      <td className="py-1.5">{t(`street.${r.street}`)}</td>
                      <td>{fmtNum(r.stackDepthBB, 1)}</td>
                      <td>{fmtNum(r.potBB, 1)}</td>
                      <td>{fmtNum(r.toCallBB, 1)}</td>
                      <td>{fmtNum(r.investedBB, 1)}</td>
                      <td>{r.playersInPot}</td>
                      <td className="text-[10px] text-ink-400">{r.reviewTags.join(', ')}</td>
                      <td>{r.annotations[0] ? `${t(`annot.st.${r.annotations[0].status}`)} v${r.annotations[0].version}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 flex items-center gap-2 text-xs">
                <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-ink-600 px-2 py-0.5 disabled:opacity-30">←</button>
                <span>{page} / {Math.max(1, Math.ceil(data.total / data.pageSize))}</span>
                <button type="button" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)} className="rounded border border-ink-600 px-2 py-0.5 disabled:opacity-30">→</button>
                <span className="ml-2 text-ink-400">{t('annot.tagsNote')}</span>
              </div>
            </div>
          )}
        </Panel>
        {sel && (
          <div className="space-y-3">
            <Panel title={t('annot.decision')}>
              <DecisionHeader q={sel.question} />
              <div className="mt-2"><PokerTable state={sel.question.state} heroId={sel.question.heroId} bigBlind={sel.question.bigBlind} showBB={showBB} labels={sel.question.positions} heroCards={sel.question.heroCards} /></div>
              <div className="mt-8 text-xs text-ink-300">{t('replay.observed')}: <b>{t(`act.${sel.observed.type}`)} {sel.observed.amountBB ? `${fmtNum(sel.observed.amountBB, 2)} BB` : ''}</b> · {t('annot.split')}: {sel.split}</div>
            </Panel>
            <Panel title={t('annot.history')}>
              {sel.annotations.length === 0 ? <p className="text-sm text-ink-400">{t('annot.none')}</p> : (
                <ul className="space-y-2 text-sm" data-testid="annot-history">
                  {sel.annotations.map((a) => (
                    <li key={a.id} className="rounded-md border border-ink-700 p-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <b>v{a.version}</b>
                        <span className={`rounded px-1.5 ${a.status === 'verified' ? 'bg-emerald-500/20 text-emerald-300' : a.status === 'draft' ? 'bg-amber-500/20 text-amber-300' : 'bg-ink-700 text-ink-400'}`}>{t(`annot.st.${a.status}`)}</span>
                        <span>{t(`annot.source.${a.source}`)} · {a.authorKind}</span>
                        {a.status === 'draft' && (confirmVerify === a.id ? (
                          <span className="ml-auto flex items-center gap-2">{t('annot.confirmVerify')} <button type="button" className="rounded bg-emerald-600 px-2 py-0.5 text-white" onClick={() => void verify(a.id)} data-testid="verify-confirm">{t('annot.verify')}</button><button type="button" onClick={() => setConfirmVerify(null)}>✕</button></span>
                        ) : (
                          <button type="button" className="ml-auto rounded border border-emerald-600 px-2 py-0.5 text-emerald-300" onClick={() => setConfirmVerify(a.id)} data-testid="verify">{t('annot.verify')}</button>
                        ))}
                      </div>
                      <div className="mt-1">{t('fb.recommended')}: <b>{a.recommendation}</b></div>
                      <div className="text-xs text-ink-300">{a.explanationVi}</div>
                      <div className="text-[11px] text-ink-400">{a.evaluated.map((e) => `${e.action}${e.sizeToBB ? ` ${e.sizeToBB}` : ''}${typeof e.ev === 'number' ? ` EV ${e.ev}` : ''}${typeof e.freq === 'number' ? ` ${Math.round(e.freq * 100)}%` : ''}`).join(' · ')} · {a.scope}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title={t('annot.new')}>
              <div className="space-y-2 text-sm" data-testid="annot-form">
                <div className="flex flex-wrap gap-2">
                  <select aria-label={t('annot.sourceLabel')} className={input} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value as 'human' })}>{['human', 'calculation'].map((x) => <option key={x} value={x}>{t(`annot.source.${x}`)}</option>)}</select>
                  <select aria-label={t('annot.confidence')} className={input} value={form.confidence} onChange={(e) => setForm({ ...form, confidence: e.target.value as 'low' })}>{['low', 'medium', 'high'].map((x) => <option key={x} value={x}>{t('annot.confidence')}: {x}</option>)}</select>
                  <label className="flex items-center gap-1 text-xs">{t('annot.tolerance')} <input className={`${input} w-16`} value={form.tolerance} onChange={(e) => setForm({ ...form, tolerance: e.target.value })} /></label>
                </div>
                <div className="text-xs font-semibold uppercase text-ink-400">{t('annot.ranges')}</div>
                {form.ranges.map((r, i) => (
                  <div key={i} className="grid gap-1 sm:grid-cols-3">
                    <input aria-label="player" className={input} value={r.player} onChange={(e) => setForm({ ...form, ranges: form.ranges.map((x, j) => (j === i ? { ...x, player: e.target.value } : x)) })} />
                    <input aria-label="range" placeholder="22+, A2s+, …" className={input} value={r.range} onChange={(e) => setForm({ ...form, ranges: form.ranges.map((x, j) => (j === i ? { ...x, range: e.target.value } : x)) })} />
                    <input aria-label="justification" placeholder={t('annot.justification')} className={input} value={r.justification} onChange={(e) => setForm({ ...form, ranges: form.ranges.map((x, j) => (j === i ? { ...x, justification: e.target.value } : x)) })} />
                  </div>
                ))}
                <div className="grid gap-1 sm:grid-cols-3">
                  <label className="text-xs">ICM <input className={`${input} w-full`} value={form.icm} onChange={(e) => setForm({ ...form, icm: e.target.value })} /></label>
                  <label className="text-xs">Bounty <input className={`${input} w-full`} value={form.bounty} onChange={(e) => setForm({ ...form, bounty: e.target.value })} /></label>
                  <label className="text-xs">{t('replay.missing')} <input className={`${input} w-full`} value={form.missing} onChange={(e) => setForm({ ...form, missing: e.target.value })} /></label>
                </div>
                <div className="text-xs font-semibold uppercase text-ink-400">{t('annot.evaluated')}</div>
                {form.evaluated.map((e, i) => (
                  <div key={i} className="flex gap-1">
                    <select aria-label="action" className={input} value={e.action} onChange={(ev) => setForm({ ...form, evaluated: form.evaluated.map((x, j) => (j === i ? { ...x, action: ev.target.value } : x)) })}>{['', 'fold', 'check', 'call', 'bet', 'raise', 'allin'].map((x) => <option key={x} value={x}>{x || '—'}</option>)}</select>
                    <input aria-label={t('annot.size')} placeholder={t('annot.sizeHint')} className={`${input} w-28`} value={e.size} onChange={(ev) => setForm({ ...form, evaluated: form.evaluated.map((x, j) => (j === i ? { ...x, size: ev.target.value } : x)) })} />
                    <input aria-label="EV" placeholder={t('annot.evHint')} className={`${input} w-28`} value={e.ev} onChange={(ev) => setForm({ ...form, evaluated: form.evaluated.map((x, j) => (j === i ? { ...x, ev: ev.target.value } : x)) })} />
                  </div>
                ))}
                <button type="button" className="text-xs text-accent" onClick={() => setForm({ ...form, evaluated: [...form.evaluated, { action: '', size: '', ev: '' }] })}>+ {t('annot.addAction')}</button>
                <input aria-label={t('fb.recommended')} placeholder={t('fb.recommended')} className={`${input} w-full`} value={form.recommendation} onChange={(e) => setForm({ ...form, recommendation: e.target.value })} data-testid="annot-recommendation" />
                <textarea aria-label="vi" placeholder={t('annot.explVi')} rows={3} className={`${input} w-full`} value={form.explanationVi} onChange={(e) => setForm({ ...form, explanationVi: e.target.value })} data-testid="annot-vi" />
                <textarea aria-label="en" placeholder={t('annot.explEn')} rows={2} className={`${input} w-full`} value={form.explanationEn} onChange={(e) => setForm({ ...form, explanationEn: e.target.value })} />
                <input aria-label={t('annot.scope')} placeholder={t('annot.scope')} className={`${input} w-full`} value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} data-testid="annot-scope" />
                <p className="text-[11px] text-ink-400">{t('annot.formNote')}</p>
                <button type="button" onClick={() => void save()} className="rounded-lg bg-felt-500 px-4 py-2 text-sm font-bold hover:bg-felt-600" data-testid="annot-save">{t('annot.saveDraft')}</button>
              </div>
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
