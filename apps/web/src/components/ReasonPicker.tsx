import { useState } from 'react';
import { useT } from '../i18n';

/** Structured, optional reasons (checked against the spot's facts after you act). Free text is a private note. */
export const REASONS = ['potOdds', 'value', 'bluff', 'bluffCatch', 'trap', 'showdownValue', 'protection', 'impliedOdds', 'foldEquity', 'position', 'blockers', 'villainTendency', 'stackDepth', 'tournament'] as const;
export type Reason = (typeof REASONS)[number];
const FIRST: Reason[] = ['value', 'bluff', 'potOdds', 'bluffCatch', 'trap', 'protection'];

export function ReasonPicker({ value, onChange, note, onNote }: { value: Reason[]; onChange: (r: Reason[]) => void; note?: string; onNote?: (s: string) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [showNote, setShowNote] = useState(false);
  const list = more ? REASONS : FIRST;
  const toggle = (r: Reason) => onChange(value.includes(r) ? value.filter((x) => x !== r) : value.length < 6 ? [...value, r] : value);
  // collapsed by default: the action buttons come first, reasons are optional
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-2 text-xs text-accent" data-testid="reason-open">
        + {t('reason.add')}{value.length ? ` (${value.length})` : ''}
      </button>
    );
  return (
    <div className="mt-2 text-xs" data-testid="reason-picker">
      <div className="mb-1 text-ink-400">{t('reason.prompt')}</div>
      <div className="flex flex-wrap gap-1.5">
        {list.map((r) => (
          <button key={r} type="button" onClick={() => toggle(r)} aria-pressed={value.includes(r)} className={`rounded-full border px-2.5 py-1 ${value.includes(r) ? 'border-accent bg-accent/10 text-accent' : 'border-ink-600 text-ink-300'}`} data-testid={`reason-${r}`}>
            {t(`reason.${r}`)}
          </button>
        ))}
        <button type="button" onClick={() => setMore((x) => !x)} className="px-1 text-ink-400 underline" data-testid="reason-more">{more ? t('reason.less') : t('reason.more')}</button>
        {onNote && (
          <button type="button" onClick={() => setShowNote((x) => !x)} className="px-1 text-ink-400 underline" data-testid="reason-note-toggle">{t('reason.note')}</button>
        )}
      </div>
      {onNote && showNote && (
        <textarea value={note ?? ''} onChange={(e) => onNote(e.target.value)} maxLength={1000} rows={2} placeholder={t('reason.notePlaceholder')} className="mt-1.5 w-full rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm" data-testid="reason-note" />
      )}
    </div>
  );
}
