import { type ReactNode, useCallback, useId, useRef, useState } from 'react';
import type { EvidenceLevel, QualityLabel, QuickFeedbackModel } from '../feedbackPresentation';
import { fmtNum } from '../format';
import { useT } from '../i18n';
import { useApp } from '../store';

const QUALITY_CLS: Record<QualityLabel, string> = {
  excellent: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/60',
  good: 'bg-emerald-500/10 text-emerald-200 border-emerald-500/40',
  inaccuracy: 'bg-amber-500/10 text-amber-200 border-amber-400/50',
  mistake: 'bg-orange-500/15 text-orange-200 border-orange-400/50',
  blunder: 'bg-red-500/15 text-red-200 border-red-400/60',
  limited: 'bg-ink-800 text-ink-200 border-ink-500',
};
const EVIDENCE_CLS: Record<EvidenceLevel, string> = {
  solver: 'border-emerald-400/60 text-emerald-300',
  reference: 'border-emerald-400/50 text-emerald-300',
  math: 'border-sky-400/60 text-sky-300',
  heuristic: 'border-amber-400/60 text-amber-300',
  insufficient: 'border-ink-500 text-ink-400',
};

export function EvidenceChip({ level }: { level: EvidenceLevel }) {
  const { t } = useT();
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${EVIDENCE_CLS[level]}`} title={t(`qf.evidence.${level}.help`)} data-testid={`qf-evidence-${level}`}>{t(`qf.evidence.${level}`)}</span>;
}

/**
 * One handler for every "continue" button on the page (inline and sticky): a second tap while the
 * first is still running is ignored, so a hand can never be dealt or advanced twice.
 */
export function useSingleFlight(fn: () => Promise<unknown>) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [fn]);
  return { run, busy };
}

export interface Cta { label: string; onClick: () => void; busy?: boolean; testId: string }

/** Detail view open state: starts from the Feedback Style preference; toggling never touches the hand. */
export function useDetailOpen() {
  const pref = useApp((s) => s.me?.preferences.explanationView ?? 'quick');
  return useState(pref === 'deep');
}

/**
 * Compact post-decision feedback: quality, your action, the recommendation (only with evidence),
 * one sentence, the next step and a collapsed detailed analysis.
 */
export function QuickFeedback({ m, primary, secondary, details, open, onToggle, primaryOnMobile = true }: {
  m: QuickFeedbackModel;
  primary?: Cta;
  secondary?: ReactNode;
  details?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** false when the sticky bar carries the primary CTA on small screens */
  primaryOnMobile?: boolean;
}) {
  const { t } = useT();
  const detailId = useId();
  return (
    <section className="space-y-2 text-sm" data-testid="quick-feedback" aria-live="polite" aria-label={t('qf.aria')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-md border px-2.5 py-1 text-base font-bold ${QUALITY_CLS[m.qualityLabel]}`} data-testid="qf-quality" data-quality={m.qualityLabel}>{t(`qf.quality.${m.qualityLabel}`)}</span>
        <EvidenceChip level={m.evidenceLevel} />
        {m.score !== undefined && <span className="text-xs tabular text-ink-300" data-testid="qf-score">{t('qf.score')}: <b>{Math.round(m.score)}</b>/100</span>}
        {m.evLossBB !== undefined && <span className="text-xs tabular text-ink-300" data-testid="qf-evloss">{t('fb2.evDiff')}: −{fmtNum(m.evLossBB, 2)} BB</span>}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
        {m.selectedAction && (
          <>
            <dt className="text-ink-400">{t('qf.you')}</dt>
            <dd className="font-semibold" data-testid="qf-selected">{m.selectedAction}</dd>
          </>
        )}
        {m.recommendedAction && (
          <>
            <dt className="text-ink-400">{t('fb2.recommended')}</dt>
            <dd className="font-semibold text-emerald-300" data-testid="qf-recommended">{m.recommendedAction}</dd>
          </>
        )}
      </dl>
      {m.shortExplanation && <p className="text-ink-200" data-testid="qf-why">{m.shortExplanation}</p>}
      {m.limitationNote && <p className="text-xs text-ink-400" data-testid="qf-limitation">{m.limitationNote}</p>}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {primary && (
          <button
            type="button"
            onClick={primary.onClick}
            disabled={primary.busy}
            aria-busy={primary.busy || undefined}
            className={`min-h-11 rounded-lg bg-felt-500 px-5 py-2 font-bold hover:bg-felt-600 disabled:opacity-60 ${primaryOnMobile ? '' : 'hidden lg:inline-block'}`}
            data-testid={primary.testId}
          >
            {primary.label}
          </button>
        )}
        {details && (
          <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={detailId} className="min-h-11 rounded-lg border border-ink-600 px-3 py-2 text-sm text-ink-100 hover:border-accent" data-testid="qf-details-toggle">
            {open ? t('qf.hideDetails') : t('qf.viewDetails')}
          </button>
        )}
        {secondary}
      </div>
      {details && open && (
        <div id={detailId} className="space-y-3 border-t border-ink-800 pt-3 text-xs" data-testid="qf-details">
          {details}
        </div>
      )}
    </section>
  );
}

/** One titled block of the detailed analysis. Renders nothing without content, so no empty sections. */
export function DetailSection({ n, title, children, testId }: { n: number; title: string; children: ReactNode; testId: string }) {
  if (children === null || children === undefined || children === false || (Array.isArray(children) && children.every((c) => c === null || c === undefined || c === false))) return null;
  return (
    <div data-testid={testId}>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{n}. {title}</h3>
      <div className="space-y-1 text-ink-200">{children}</div>
    </div>
  );
}

/**
 * Fixed bottom bar for small screens (hidden from lg up, where the CTA sits next to the feedback).
 * Respects the iOS home-indicator inset; the spacer keeps page content from hiding behind it.
 */
export function NextBar({ cta, extra }: { cta: Cta; extra?: ReactNode }) {
  return (
    <>
      <div aria-hidden className="h-24 lg:hidden" data-testid="next-bar-spacer" />
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-700 bg-ink-950/95 px-4 pt-2 backdrop-blur lg:hidden" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }} data-testid="next-bar">
        <div className="mx-auto flex max-w-6xl items-center gap-2">
          {extra}
          <button type="button" onClick={cta.onClick} disabled={cta.busy} aria-busy={cta.busy || undefined} className="min-h-12 flex-1 rounded-xl bg-felt-500 px-4 text-base font-bold hover:bg-felt-600 disabled:opacity-60" data-testid={`${cta.testId}-sticky`}>
            {cta.label}
          </button>
        </div>
      </div>
    </>
  );
}
