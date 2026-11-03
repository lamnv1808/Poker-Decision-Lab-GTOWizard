import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
// Ported from the Codex P0 patch.
import { api } from '../api';
import { useApp } from '../store';
import { TodayPage } from './Today';
vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
beforeEach(() => { vi.mocked(api.get).mockReset(); useApp.setState({ lang: 'en', me: null }); });
const plan = (n: number) => ({ items: [], focus: [], reviews: n, fresh: 0, estimatedSec: 0, pendingContext: 0 });
it('replaces failed loading with a working retry', async () => {
  vi.mocked(api.get).mockRejectedValueOnce(new Error('Timed out')).mockResolvedValue(plan(0));
  render(<MemoryRouter><TodayPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByText('Timed out')).toBeNull());
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(screen.getByTestId('today-start')).toBeDisabled();
});
it('ignores an older plan response after changing duration', async () => {
  let old!: (p: unknown) => void;
  vi.mocked(api.get).mockImplementationOnce(() => new Promise((resolve) => { old = resolve; })).mockResolvedValue(plan(2));
  render(<MemoryRouter><TodayPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole('radio', { name: '5 min' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/daily/plan?minutes=5'));
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  await act(async () => { old(plan(99)); });
  await waitFor(() => expect(screen.queryByText('99')).toBeNull());
});
