import { useRef } from 'react';

const R = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
export const GRID: string[][] = R.map((r1, i) => R.map((r2, j) => (i === j ? r1 + r2 : i < j ? `${r1}${r2}s` : `${r2}${r1}o`)));

/** 13×13 hand-class grid. Click or drag to toggle; `reference` overlays an answer after submission. */
export function RangeGrid({ selected, onChange, reference, readOnly = false }: { selected: Set<string>; onChange?: (s: Set<string>) => void; reference?: Set<string>; readOnly?: boolean }) {
  const dragMode = useRef<boolean | null>(null);
  const toggle = (cls: string, mode?: boolean) => {
    if (readOnly || !onChange) return;
    const next = new Set(selected);
    const on = mode ?? !next.has(cls);
    if (on) next.add(cls);
    else next.delete(cls);
    onChange(next);
  };
  return (
    <div className="grid touch-none select-none grid-cols-13 gap-[2px]" style={{ gridTemplateColumns: 'repeat(13, minmax(0, 1fr))' }} onPointerUp={() => (dragMode.current = null)} onPointerLeave={() => (dragMode.current = null)} data-testid="range-grid">
      {GRID.flat().map((cls) => {
        const sel = selected.has(cls);
        const ref = reference?.has(cls);
        let bg = sel ? 'bg-emerald-500 text-ink-950' : cls.length === 2 ? 'bg-ink-700' : cls.endsWith('s') ? 'bg-ink-800' : 'bg-ink-850';
        if (reference) bg = sel && ref ? 'bg-emerald-500 text-ink-950' : sel ? 'bg-red-500/80 text-white' : ref ? 'bg-sky-600/70 text-white' : 'bg-ink-850';
        return (
          <button
            key={cls}
            type="button"
            aria-pressed={sel}
            aria-label={cls}
            onPointerDown={(e) => {
              e.preventDefault();
              dragMode.current = !sel;
              toggle(cls, !sel);
            }}
            onPointerEnter={() => dragMode.current !== null && toggle(cls, dragMode.current)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(cls))}
            className={`aspect-square rounded-[3px] text-[8px] font-semibold leading-none sm:text-[10px] ${bg} ${readOnly ? 'cursor-default' : 'cursor-pointer hover:brightness-125'}`}
          >
            {cls}
          </button>
        );
      })}
    </div>
  );
}
