import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
// Ported from the Codex P0 patch. The reconciled branch remounts every training page on each
// navigation (components/Fresh.tsx), so the item=<n> URL parameter test is not ported.
import { api } from '../api';
import { useApp } from '../store';
import { MixedRunner } from './Mixed';

vi.mock('../api', () => ({ api: { post: vi.fn() } }));
beforeEach(() => { vi.mocked(api.post).mockReset(); useApp.setState({ lang: 'en', me: null }); });
function Destination() { return <div data-testid="destination">{useLocation().search}</div>; }
it('requests only one item when StrictMode repeats effects', async () => {
  vi.mocked(api.post).mockResolvedValue({ done: false, href: '/gto?mixed=s', served: 1 });
  render(<StrictMode><MemoryRouter initialEntries={['/mixed/s']}><Routes>
    <Route path="/mixed/:id" element={<MixedRunner />} /><Route path="/gto" element={<Destination />} />
  </Routes></MemoryRouter></StrictMode>);
  expect(await screen.findByTestId('destination')).toHaveTextContent('mixed=s');
  expect(api.post).toHaveBeenCalledTimes(1);
});
it('shows a retry after a failed next request and recovers', async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue({ done: false, href: '/gto?mixed=s', served: 2 });
  render(<MemoryRouter initialEntries={['/mixed/s']}><Routes>
    <Route path="/mixed/:id" element={<MixedRunner />} /><Route path="/gto" element={<Destination />} />
  </Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  expect(await screen.findByTestId('destination')).toHaveTextContent('mixed=s');
});
