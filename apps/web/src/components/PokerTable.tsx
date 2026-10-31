import type { HandState } from '@pdl/core/engine';
import { fmtAmount, loc } from '../format';
import { useT } from '../i18n';
import type { Localized } from '../types';
import { PlayingCard } from './Cards';

export interface SeatMeta {
  pos: string;
  name?: string | null;
  bounty?: number | null;
  tendencies?: Localized | null;
}

interface Props {
  state: HandState;
  heroId: string;
  bigBlind: number;
  showBB: boolean;
  /** Labels per player id (positions); defaults to the id. */
  labels?: Record<string, string>;
  meta?: Record<string, SeatMeta>;
  heroCards?: string[];
}

/**
 * Original poker table component. Seats are laid out on an ellipse with Hero at the bottom;
 * the current actor pulses; committed bets sit in front of each seat; the dealer button marks BTN.
 */
export function PokerTable({ state, heroId, bigBlind, showBB, labels = {}, meta = {}, heroCards }: Props) {
  const { t, lang } = useT();
  const n = state.players.length;
  const heroIdx = Math.max(0, state.players.findIndex((p) => p.id === heroId));
  const pot = state.deadAntes + state.players.reduce((s, p) => s + p.totalCommitted, 0);
  const streetBets = state.players.reduce((s, p) => s + p.streetCommitted, 0);
  const acting = state.toAct >= 0 ? state.players[state.toAct]?.id : null;
  const btnIdx = n === 2 ? 0 : n - 1;
  const fmt = (c: number) => fmtAmount(c, bigBlind, showBB);

  return (
    <div className="relative mx-auto aspect-[1/1] w-full max-w-3xl select-none min-[480px]:aspect-[4/3] sm:aspect-[2/1]" data-testid="poker-table">
      <div className="felt absolute inset-[9%_5%_11%_5%] rounded-[50%]" />
      {/* centre: board + pot */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 sm:gap-2">
        <div className="rounded-full bg-black/35 px-3 py-0.5 text-xs text-ink-100 tabular sm:text-sm" data-testid="pot">
          {t('table.pot')}: <b>{fmt(pot)}</b>
          {streetBets > 0 && pot - streetBets > 0 && <span className="text-ink-300"> · {t('table.middle')} {fmt(pot - streetBets)}</span>}
        </div>
        <div className="flex gap-1 sm:gap-1.5" data-testid="board">
          {Array.from({ length: 5 }, (_, i) =>
            state.board[i] ? (
              <PlayingCard key={state.board[i]} card={state.board[i]} size="board" />
            ) : (
              <div key={i} className="h-11 w-8 rounded-md border border-white/10 bg-black/10 sm:h-14 sm:w-10" />
            ),
          )}
        </div>
        <div className="text-[10px] uppercase tracking-widest text-white/50">{t(`street.${state.street}`)}</div>
      </div>
      {state.players.map((p, i) => {
        const k = (i - heroIdx + n) % n;
        const angle = Math.PI / 2 + (k * 2 * Math.PI) / n;
        const x = 50 + 44 * Math.cos(angle);
        const y = 50 + 40 * Math.sin(angle);
        const bx = 50 + 27 * Math.cos(angle);
        const by = 50 + 24 * Math.sin(angle);
        const isHero = p.id === heroId;
        const m = meta[p.id];
        const cards = isHero ? (heroCards ?? p.cards) : p.cards;
        const label = labels[p.id] ?? p.id;
        return (
          <div key={p.id}>
            <div
              className="absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
              style={{ left: `${x}%`, top: `${y}%` }}
              data-testid={`seat-${label}`}
            >
              <div className={`mb-[-10px] flex gap-0.5 ${p.folded ? 'opacity-30' : ''}`}>
                {!p.folded || isHero ? (
                  cards && cards.length === 2 ? (
                    cards.map((c) => <PlayingCard key={c} card={c} size={isHero ? 'md' : 'sm'} dim={p.folded} />)
                  ) : (
                    <>
                      <PlayingCard hidden size="sm" />
                      <PlayingCard hidden size="sm" />
                    </>
                  )
                ) : null}
              </div>
              <div
                className={`relative min-w-[72px] rounded-lg border px-2 py-1 text-center text-[11px] leading-tight shadow-lg sm:min-w-[92px] sm:text-xs ${
                  isHero ? 'border-accent/70 bg-ink-800' : 'border-ink-600 bg-ink-850'
                } ${acting === p.id ? 'acting border-accent' : ''} ${p.folded ? 'opacity-50' : ''}`}
                title={m?.tendencies ? loc(m.tendencies, lang) : undefined}
              >
                <div className="flex items-center justify-center gap-1 font-semibold">
                  <span className={isHero ? 'text-accent' : 'text-ink-100'}>{label}</span>
                  {isHero && <span className="rounded bg-accent/20 px-1 text-[9px] text-accent">{t('table.hero')}</span>}
                  {m?.tendencies && <span aria-label={t('table.tendencies')} className="text-gold">●</span>}
                </div>
                <div className="tabular text-ink-300">{p.allIn ? <span className="font-bold text-gold">{t('table.allIn')}</span> : fmt(p.stack)}</div>
                {m?.bounty ? <div className="text-[10px] text-gold">🎯 ${m.bounty}</div> : null}
                {p.folded && <div className="text-[10px] uppercase text-ink-400">{t('table.folded')}</div>}
              </div>
              {i === btnIdx && (
                <div className="absolute -right-3 top-1/2 flex h-5 w-5 items-center justify-center rounded-full bg-white text-[10px] font-black text-ink-900 shadow" aria-label="dealer button">
                  D
                </div>
              )}
            </div>
            {p.streetCommitted > 0 && (
              <div
                className="absolute z-0 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-gold tabular sm:text-xs"
                style={{ left: `${bx}%`, top: `${by}%` }}
                data-testid={`bet-${label}`}
              >
                ● {fmt(p.streetCommitted)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Compact, readable action history grouped by street. */
export function ActionHistory({ state, bigBlind, showBB, labels = {} }: { state: HandState; bigBlind: number; showBB: boolean; labels?: Record<string, string> }) {
  const { t } = useT();
  const streets = ['preflop', 'flop', 'turn', 'river'] as const;
  const fmt = (c: number) => fmtAmount(c, bigBlind, showBB);
  return (
    <div className="space-y-1.5 text-xs" data-testid="action-history">
      {streets.map((st) => {
        const acts = state.history.filter((h) => h.street === st && h.type !== 'postAnte');
        if (!acts.length) return null;
        const boardIdx = st === 'flop' ? [0, 3] : st === 'turn' ? [3, 4] : st === 'river' ? [4, 5] : null;
        return (
          <div key={st}>
            <span className="mr-1 font-semibold uppercase text-ink-400">{t(`street.${st}`)}</span>
            {boardIdx && <span className="mr-1 font-mono text-ink-300">[{state.board.slice(boardIdx[0], boardIdx[1]).join(' ')}]</span>}
            {acts.map((a, i) => {
              const who = labels[a.playerId] ?? a.playerId;
              let txt = '';
              if (a.type === 'postSB' || a.type === 'postBB') txt = `${t(`act.${a.type}`)} ${fmt(a.amount)}`;
              else if (a.type === 'fold' || a.type === 'check') txt = t(`act.${a.type}`);
              else if (a.type === 'call') txt = `${t('act.call')} ${fmt(a.amount)}`;
              else if (a.type === 'bet') txt = `${t('act.bet')} ${fmt(a.amount)}`;
              else if (a.type === 'raise') txt = `${t('act.raiseTo')} ${fmt(a.amount)}`;
              else if (a.type === 'returnUncalled') txt = `${t('act.returned')} ${fmt(a.amount)}`;
              return (
                <span key={i} className={`mr-2 inline-block ${a.type === 'fold' ? 'text-ink-400' : 'text-ink-100'}`}>
                  <b>{who}</b> {txt}
                  {a.allIn && a.type !== 'returnUncalled' ? <span className="text-gold"> ({t('table.allIn')})</span> : null}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
