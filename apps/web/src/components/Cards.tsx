const SUIT: Record<string, { sym: string; cls: string; name: string }> = {
  s: { sym: '♠', cls: 'text-slate-900', name: 'spades' },
  h: { sym: '♥', cls: 'text-red-600', name: 'hearts' },
  d: { sym: '♦', cls: 'text-blue-600', name: 'diamonds' },
  c: { sym: '♣', cls: 'text-emerald-700', name: 'clubs' },
};
const RANK_NAME: Record<string, string> = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };

/** Four-colour deck for readability at small sizes. */
export function PlayingCard({ card, size = 'md', hidden = false, dim = false }: { card?: string; size?: 'sm' | 'md' | 'lg' | 'board'; hidden?: boolean; dim?: boolean }) {
  const dims = size === 'sm' ? 'w-7 h-10 text-sm' : size === 'lg' ? 'w-14 h-20 text-2xl' : size === 'board' ? 'w-8 h-11 text-base sm:w-10 sm:h-14 sm:text-lg' : 'w-10 h-14 text-lg';
  if (hidden || !card)
    return (
      <div
        aria-label="hidden card"
        className={`${dims} card-face rounded-md border border-sky-200/30 bg-[repeating-linear-gradient(45deg,#1e3a5f_0_4px,#24476f_4px_8px)] ${dim ? 'opacity-40' : ''}`}
      />
    );
  const r = card[0]!;
  const s = SUIT[card[1]!]!;
  return (
    <div
      aria-label={`${RANK_NAME[r] ?? r} of ${s.name}`}
      className={`${dims} card-face deal-in flex flex-col items-center justify-center rounded-md bg-white font-bold leading-none ${s.cls} ${dim ? 'opacity-40' : ''}`}
    >
      <span>{RANK_NAME[r] ?? r}</span>
      <span className="text-[0.8em]">{s.sym}</span>
    </div>
  );
}

export function CardText({ cards }: { cards: string }) {
  const list = cards.match(/.{2}/g) ?? [];
  return (
    <span className="font-mono">
      {list.map((c, i) => (
        <span key={i} className={c[1] === 'h' ? 'text-red-400' : c[1] === 'd' ? 'text-sky-400' : c[1] === 'c' ? 'text-emerald-400' : 'text-ink-100'}>
          {c[0] === 'T' ? '10' : c[0]}
          {SUIT[c[1]!]!.sym}
        </span>
      ))}
    </span>
  );
}
