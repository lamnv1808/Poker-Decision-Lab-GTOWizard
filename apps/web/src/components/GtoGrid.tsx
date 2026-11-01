import { GRID } from './RangeGrid';

/** 13×13 equilibrium frequency heat-map. `highlight` outlines the hero's hand class. */
export function GtoGrid({ freq, highlight, testId }: { freq: Record<string, number>; highlight?: string; testId?: string }) {
  return (
    <div className="grid gap-[2px]" style={{ gridTemplateColumns: 'repeat(13, minmax(0, 1fr))' }} data-testid={testId}>
      {GRID.flat().map((cls) => {
        const f = freq[cls] ?? 0;
        const hl = cls === highlight;
        return (
          <div
            key={cls}
            title={`${cls}: ${Math.round(f * 100)}%`}
            className={`relative flex aspect-square items-center justify-center overflow-hidden rounded-[3px] text-[8px] font-semibold leading-none sm:text-[10px] ${hl ? 'ring-2 ring-gold ring-offset-1 ring-offset-ink-900' : ''}`}
            style={{ background: '#17212b' }}
          >
            <div className="absolute inset-x-0 bottom-0 bg-emerald-500" style={{ height: `${f * 100}%` }} />
            <span className={`relative ${f > 0.5 ? 'text-ink-950' : 'text-ink-300'}`}>{cls}</span>
          </div>
        );
      })}
    </div>
  );
}
