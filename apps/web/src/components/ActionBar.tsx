import { type HandState, type LegalActions, type PlayerAction, sizePresets } from '@pdl/core/engine';
import { useEffect, useMemo, useState } from 'react';
import { fmtAmount } from '../format';
import { useT } from '../i18n';

interface Props {
  state: HandState;
  legal: LegalActions;
  bigBlind: number;
  showBB: boolean;
  disabled?: boolean;
  onAct: (action: PlayerAction, confidence?: 1 | 2 | 3) => void;
  showConfidence?: boolean;
}

/**
 * Action bar: only legal actions are enabled. Bet/raise amounts are always RAISE-TO totals
 * (the engine's convention); the breakdown shows chips added from the stack and the pot fraction.
 */
export function ActionBar({ state, legal, bigBlind, showBB, disabled, onAct, showConfidence = true }: Props) {
  const { t } = useT();
  const me = state.players[state.toAct]!;
  const canSize = legal.canBet || legal.canRaise;
  const presets = useMemo(() => sizePresets(legal, state.street, state.currentBet, bigBlind), [legal, state.street, state.currentBet, bigBlind]);
  const [amount, setAmount] = useState<number>(legal.minRaiseTo);
  const [input, setInput] = useState('');
  const [confidence, setConfidence] = useState<1 | 2 | 3 | undefined>(undefined);
  useEffect(() => {
    setAmount(legal.minRaiseTo);
  }, [legal.minRaiseTo, legal.maxRaiseTo]);
  const unit = showBB ? bigBlind : 1;
  useEffect(() => {
    setInput(showBB ? String(Math.round((amount / bigBlind) * 100) / 100) : String(amount));
  }, [amount, showBB, bigBlind]);
  const fmt = (c: number) => fmtAmount(c, bigBlind, showBB);
  const sizeVerb = legal.canBet ? t('act.bet') : t('act.raiseTo');
  const isAllIn = amount >= legal.maxRaiseTo;
  const added = amount - me.streetCommitted;
  const potFrac = legal.pot + legal.toCall > 0 ? (amount - state.currentBet) / (legal.pot + legal.toCall) : 0;
  const valid = canSize && amount >= legal.minRaiseTo && amount <= legal.maxRaiseTo && Number.isInteger(amount);

  const commitInput = (v: string) => {
    setInput(v);
    const x = Number(v.replace(',', '.'));
    if (Number.isFinite(x) && x > 0) setAmount(Math.round(x * unit));
  };
  const act = (a: PlayerAction) => {
    if (!disabled) onAct(a, confidence);
  };
  const sizeAction = (to: number): PlayerAction => ({ type: legal.canBet ? 'bet' : 'raise', amount: to });

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900/95 p-3 shadow-2xl" data-testid="action-bar">
      {canSize && (
        <div className="mb-3 space-y-2">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('action.presets')}>
            {presets.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setAmount(p.raiseTo)}
                className={`rounded-md border px-2 py-1 text-xs font-medium tabular ${amount === p.raiseTo ? 'border-accent bg-accent/15 text-accent' : 'border-ink-600 text-ink-300 hover:border-ink-400'}`}
              >
                {p.kind === 'allin' ? t('action.allIn') : p.kind === 'bb' ? `${p.value}BB` : p.key}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              aria-label={t('action.slider')}
              type="range"
              min={legal.minRaiseTo}
              max={legal.maxRaiseTo}
              step={1}
              value={Math.min(Math.max(amount, legal.minRaiseTo), legal.maxRaiseTo)}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="h-2 flex-1 cursor-pointer accent-emerald-400"
            />
            <label className="flex items-center gap-1 text-xs text-ink-300">
              <span className="sr-only">{t('action.amount')}</span>
              <input
                data-testid="amount-input"
                inputMode="decimal"
                value={input}
                onChange={(e) => commitInput(e.target.value)}
                className={`w-20 rounded-md border bg-ink-850 px-2 py-1 text-right text-sm tabular text-ink-100 ${valid ? 'border-ink-600' : 'border-red-500'}`}
              />
              <span>{showBB ? 'BB' : ''}</span>
            </label>
          </div>
          <div className="text-[11px] leading-snug text-ink-400 tabular" data-testid="sizing-breakdown">
            {sizeVerb} <b className="text-ink-100">{fmt(amount)}</b> · {t('action.adds')} {fmt(added)} · {Math.round(potFrac * 100)}% {t('action.ofPot')}
            {legal.canRaise && <> · +{fmt(amount - state.currentBet)} {t('action.overBet')}</>}
            {!valid && (
              <span className="text-red-400">
                {' '}
                · {t('action.range')} {fmt(legal.minRaiseTo)}–{fmt(legal.maxRaiseTo)}
              </span>
            )}
          </div>
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          disabled={disabled || !legal.canFold}
          onClick={() => act({ type: 'fold' })}
          className="rounded-lg bg-red-900/70 py-3 text-sm font-bold text-red-100 hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-25"
        >
          {t('act.fold')}
        </button>
        {legal.canCheck ? (
          <button type="button" disabled={disabled} onClick={() => act({ type: 'check' })} className="rounded-lg bg-ink-700 py-3 text-sm font-bold hover:bg-ink-600 disabled:opacity-25">
            {t('act.check')}
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || legal.toCall === 0}
            onClick={() => act({ type: 'call' })}
            className="rounded-lg bg-sky-800 py-3 text-sm font-bold hover:bg-sky-700 disabled:opacity-25"
          >
            {legal.callIsAllIn ? `${t('act.call')} ${t('table.allIn')}` : `${t('act.call')} ${fmt(legal.callAmount)}`}
          </button>
        )}
        <button
          type="button"
          disabled={disabled || !canSize || !valid}
          onClick={() => act(sizeAction(amount))}
          className={`rounded-lg py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-25 ${isAllIn ? 'bg-gold text-ink-950 hover:brightness-110' : 'bg-felt-500 hover:bg-felt-600'}`}
        >
          {isAllIn ? `${t('action.allIn')} ${fmt(legal.maxRaiseTo)}` : `${sizeVerb} ${fmt(amount)}`}
        </button>
      </div>
      {showConfidence && (
        <div className="mt-2 flex items-center justify-end gap-1 text-[11px] text-ink-400">
          <span>{t('action.confidence')}:</span>
          {([3, 2, 1] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setConfidence(confidence === c ? undefined : c)}
              className={`rounded px-1.5 py-0.5 ${confidence === c ? 'bg-ink-600 text-ink-100' : 'hover:text-ink-100'}`}
            >
              {t(`confidence.${c}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
