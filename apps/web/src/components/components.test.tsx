import { applyAction, createHand, dealNextStreet, legalActions } from '@pdl/core/engine';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../store';
import { ActionBar } from './ActionBar';
import { PokerTable } from './PokerTable';
import { RangeGrid } from './RangeGrid';

const table = (stacks: number[]) => ({ smallBlind: 500, bigBlind: 1000, ante: 1000, anteMode: 'bigBlind' as const, players: stacks.map((s, i) => ({ id: ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'][i]!, stack: s })) });

beforeEach(() => useApp.setState({ lang: 'en', me: null }));

describe('ActionBar', () => {
  it('shows only legal actions preflop and submits raise-to amounts', async () => {
    let s = createHand(table([30000, 30000, 30000, 30000, 30000, 35000]));
    for (let i = 0; i < 3; i++) s = applyAction(s, { type: 'fold' });
    const onAct = vi.fn();
    render(<ActionBar state={s} legal={legalActions(s)!} bigBlind={1000} showBB onAct={onAct} showConfidence={false} />);
    expect(screen.getByRole('button', { name: 'Fold' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Check' })).toBeNull();
    expect(screen.getByRole('button', { name: /Call 1 BB/ })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: '2.5BB' }));
    expect(screen.getByTestId('sizing-breakdown')).toHaveTextContent('Raise to 2.5 BB · adds 2.5 BB');
    await userEvent.click(screen.getByRole('button', { name: 'Raise to 2.5 BB' }));
    expect(onAct).toHaveBeenCalledWith({ type: 'raise', amount: 2500 }, undefined);
  });
  it('disables fold when checking is free and rejects sub-minimum amounts', async () => {
    let s = createHand(table([30000, 30000]).players.length ? { ...table([30000, 30000]), anteMode: 'none', ante: 0 } : table([]));
    s = applyAction(s, { type: 'call' });
    s = applyAction(s, { type: 'check' });
    s = dealNextStreet(s, ['Kd', '7c', '2h']);
    const onAct = vi.fn();
    render(<ActionBar state={s} legal={legalActions(s)!} bigBlind={1000} showBB onAct={onAct} showConfidence={false} />);
    expect(screen.getByRole('button', { name: 'Fold' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check' })).toBeEnabled();
    const input = screen.getByTestId('amount-input');
    fireEvent.change(input, { target: { value: '0.5' } });
    expect(screen.getByRole('button', { name: /Bet 0.5 BB/ })).toBeDisabled();
    fireEvent.change(input, { target: { value: '1.5' } });
    expect(screen.getByRole('button', { name: /Bet 1.5 BB/ })).toBeEnabled();
  });
  it('labels an all-in call clearly', () => {
    let s = createHand({ smallBlind: 500, bigBlind: 1000, ante: 0, anteMode: 'none', players: [{ id: 'SB', stack: 5000 }, { id: 'BB', stack: 20000 }] });
    s = applyAction(s, { type: 'raise', amount: 5000 });
    // BB faces an all-in: raising is not possible (opponent all-in)
    render(<ActionBar state={s} legal={legalActions(s)!} bigBlind={1000} showBB onAct={() => {}} showConfidence={false} />);
    expect(screen.getByRole('button', { name: /Call 4 BB/ })).toBeEnabled();
    expect(screen.queryByTestId('amount-input')).toBeNull();
  });
});

describe('PokerTable', () => {
  it('renders seats, pot, hero cards and hides villain cards', () => {
    const cfg = table([30000, 30000, 30000, 30000, 30000, 35000]);
    cfg.players[5] = { ...cfg.players[5]!, cards: ['As', 'Js'] } as never;
    const s = createHand(cfg);
    render(<PokerTable state={s} heroId="BTN" bigBlind={1000} showBB />);
    expect(screen.getByTestId('pot')).toHaveTextContent('Pot: 2.5 BB');
    expect(screen.getByLabelText('A of spades')).toBeInTheDocument();
    expect(screen.getAllByLabelText('hidden card').length).toBe(10);
    expect(screen.getByTestId('seat-BB')).toHaveTextContent('28 BB');
  });
  it('switches to Vietnamese labels', () => {
    useApp.setState({ lang: 'vi' });
    const s = createHand(table([30000, 30000, 30000, 30000, 30000, 35000]));
    render(<PokerTable state={s} heroId="BTN" bigBlind={1000} showBB={false} />);
    expect(screen.getByText('Preflop')).toBeInTheDocument();
    expect(screen.getByTestId('pot')).toHaveTextContent('Pot: 2,500');
  });
});

describe('RangeGrid', () => {
  it('toggles hand classes', () => {
    const onChange = vi.fn();
    render(<RangeGrid selected={new Set(['AA'])} onChange={onChange} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'AKs' }));
    expect([...onChange.mock.calls[0]![0]].sort()).toEqual(['AA', 'AKs']);
    expect(screen.getAllByRole('button')).toHaveLength(169);
  });
});
