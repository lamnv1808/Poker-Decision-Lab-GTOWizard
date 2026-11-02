import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Empty, ErrorNote, Panel, Spinner, Toggle } from '../components/ui';
import { loc } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { Localized } from '../types';
import { useMixedNext } from './Mixed';

interface Priority { severity: number; evidence: number; confidence: number; recurrence: number; learning: number; score: number }
interface PlanItem { type: string; reason: 'leak' | 'review' | 'new'; leakKey?: string; params?: { decisionId?: string; role?: string; range?: string } }
interface Plan {
  minutes: 5 | 10 | 20;
  items: PlanItem[];
  estimatedSec: number;
  focus: { leakKey: string; label: Localized; evidence: 'solver' | 'pattern' | 'training'; priority: Priority; items: number; seconds: number }[];
  reviews: number;
  fresh: number;
  refreshedAt: string | null;
  pendingContext: number;
}

export const EVIDENCE_STYLE: Record<string, string> = {
  solver: 'border-emerald-500/50 text-emerald-300',
  pattern: 'border-amber-500/50 text-amber-300',
  training: 'border-sky-500/50 text-sky-300',
};

export function EvidenceBadge({ evidence }: { evidence: string }) {
  const { t } = useT();
  return <span className={`rounded border px-1.5 text-[10px] uppercase ${EVIDENCE_STYLE[evidence] ?? 'border-ink-500 text-ink-300'}`} title={t(`mem.evidence.${evidence}.help`)}>{t(`mem.evidence.${evidence}`)}</span>;
}

/** /today — the personal 5/10/20-minute plan, explained, then started as a Mixed session. */
export function TodayPage() {
  const { t, lang } = useT();
  const defaultMode = useApp((s) => s.me?.preferences.defaultMode ?? 'practice');
  const [minutes, setMinutes] = useState<'5' | '10' | '20'>('10');
  const [mode, setMode] = useState<'practice' | 'rated'>(defaultMode);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const next = useMixedNext();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setPlan(null);
    setError(null);
    api.get<Plan>(`/daily/plan?minutes=${minutes}`).then((p) => live && setPlan(p)).catch((e) => live && setError(e));
    return () => {
      live = false; // a slower earlier request must not overwrite the current duration's plan
    };
  }, [minutes, attempt]);
  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.post<{ id: string }>('/daily/start', { minutes: Number(minutes), mode });
      await next(s.id);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  const count = (r: PlanItem['reason']) => plan?.items.filter((i) => i.reason === r).length ?? 0;
  return (
    <div className="space-y-4" data-testid="today">
      <div>
        <h1 className="text-xl font-bold">{t('today.title')}</h1>
        <p className="text-sm text-ink-300">{t('today.intro')}</p>
      </div>
      <Panel>
        <div className="flex flex-wrap items-end gap-3">
          <Toggle label={t('mixed.duration')} value={minutes} onChange={setMinutes} options={(['5', '10', '20'] as const).map((m) => ({ value: m, label: `${m} min` }))} />
          <Toggle label={t('mode.label')} value={mode} onChange={setMode} options={[{ value: 'practice', label: t('mode.practice') }, { value: 'rated', label: t('mode.rated') }]} />
          <span className="flex-1" />
          <button type="button" disabled={!plan || busy || !plan.items.length} aria-busy={busy || undefined} onClick={() => void start()} className="min-h-11 rounded-lg bg-felt-500 px-5 py-2 font-bold disabled:opacity-50" data-testid="today-start">{busy ? t('common.loading') : t('today.start')}</button>
        </div>
        <ErrorNote error={error} onRetry={plan ? () => void start() : () => setAttempt((x) => x + 1)} />
      </Panel>
      {!plan && !error && <Spinner label={t('today.loadingPlan')} />}
      {plan && plan.items.length === 0 && <Empty>{t('today.empty')}</Empty>}
      {plan && plan.pendingContext > 0 && <p className="rounded-md border border-gold/40 bg-gold/5 px-3 py-2 text-sm text-gold" data-testid="analysis-pending">{t('mem.pending', { n: plan.pendingContext.toLocaleString() })}</p>}
      {plan && (
        <>
          <div className="grid grid-cols-3 gap-3 text-center text-sm">
            <div className="rounded-lg border border-ink-700 bg-ink-900 p-2"><div className="text-lg font-bold tabular">{count('leak')}</div><div className="text-xs text-ink-400">{t('today.leakItems')}</div></div>
            <div className="rounded-lg border border-ink-700 bg-ink-900 p-2"><div className="text-lg font-bold tabular">{plan.reviews}</div><div className="text-xs text-ink-400">{t('today.reviewItems')}</div></div>
            <div className="rounded-lg border border-ink-700 bg-ink-900 p-2"><div className="text-lg font-bold tabular">{plan.fresh}</div><div className="text-xs text-ink-400">{t('today.newItems')}</div></div>
          </div>
          <Panel title={t('today.focus')} actions={<Link to="/leaks" className="text-xs text-accent">{t('today.allLeaks')}</Link>}>
            {plan.focus.length === 0 ? (
              <Empty>{t('today.noLeaks')}</Empty>
            ) : (
              <ol className="space-y-2">
                {plan.focus.map((f, i) => (
                  <li key={f.leakKey} className="rounded-lg border border-ink-700 bg-ink-850 p-3" data-testid={`today-focus-${i}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-ink-400">{i + 1}.</span>
                      <span className="font-semibold">{loc(f.label, lang)}</span>
                      <EvidenceBadge evidence={f.evidence} />
                      <span className="text-xs text-ink-400">{t('today.itemsMin', { n: f.items, m: Math.max(1, Math.round(f.seconds / 60)) })}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] tabular text-ink-400" title={t('today.priorityHelp')}>
                      <span>{t('today.p.severity')} {f.priority.severity.toFixed(2)}</span>
                      <span>× {t('today.p.evidence')} {f.priority.evidence.toFixed(2)}</span>
                      <span>× {t('today.p.confidence')} {f.priority.confidence.toFixed(2)}</span>
                      <span>× {t('today.p.recurrence')} {f.priority.recurrence.toFixed(2)}</span>
                      <span>× {t('today.p.learning')} {f.priority.learning.toFixed(2)}</span>
                      <span className="text-ink-200">= {f.priority.score.toFixed(2)}</span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-2 text-[11px] text-ink-500">{t('today.priorityHelp')}</p>
          </Panel>
          <Panel title={t('today.sequence', { n: plan.items.length, m: Math.round(plan.estimatedSec / 60) })}>
            <ol className="flex flex-wrap gap-1.5 text-xs" data-testid="today-items">
              {plan.items.map((it, i) => (
                <li key={i} className={`rounded-full border px-2 py-0.5 ${it.reason === 'leak' ? 'border-accent/60 text-accent' : it.reason === 'review' ? 'border-gold/50 text-gold' : 'border-ink-600 text-ink-300'}`}>
                  {i + 1}. {it.params?.decisionId ? t('today.ownHand') : t(`mixed.type.${it.type}`)}
                </li>
              ))}
            </ol>
            <p className="mt-2 text-[11px] text-ink-500">{t('today.legend')}</p>
          </Panel>
        </>
      )}
    </div>
  );
}
