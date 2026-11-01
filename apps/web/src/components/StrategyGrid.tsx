import { GRID } from './RangeGrid';

/** Colours for postflop actions: passive → aggressive. */
export function actionColor(key: string): string {
  if (key === 'Fold') return '#3b82f6';
  if (key === 'Check') return '#64748b';
  if (key === 'Call') return '#22c55e';
  if (key.startsWith('Raise') || key.startsWith('AllIn')) return '#ef4444';
  if (key.startsWith('Bet')) {
    const n = Number(/\d+/.exec(key)?.[0] ?? 0);
    return n > 60 ? '#f59e0b' : '#eab308';
  }
  return '#94a3b8';
}

/** 13×13 grid; each cell is split horizontally by the class's average action frequencies. */
export function StrategyGrid({ byClass, actions, highlight }: { byClass: Record<string, number[]>; actions: string[]; highlight?: string }) {
  return (
    <div className="grid gap-[2px]" style={{ gridTemplateColumns: 'repeat(13, minmax(0, 1fr))' }} data-testid="strategy-grid">
      {GRID.flat().map((cls) => {
        const f = byClass[cls];
        return (
          <div key={cls} title={f ? `${cls}: ${actions.map((a, i) => `${a} ${Math.round(f[i]! * 100)}%`).join(', ')}` : `${cls}: not in range`} className={`relative flex aspect-square overflow-hidden rounded-[3px] ${cls === highlight ? 'ring-2 ring-white ring-offset-1 ring-offset-ink-900' : ''}`} style={{ background: '#111922' }}>
            {f && actions.map((a, i) => <div key={a} style={{ width: `${f[i]! * 100}%`, background: actionColor(a) }} />)}
            <span className={`absolute inset-0 flex items-center justify-center text-[8px] font-semibold leading-none sm:text-[10px] ${f ? 'text-ink-950' : 'text-ink-600'}`}>{cls}</span>
          </div>
        );
      })}
    </div>
  );
}
