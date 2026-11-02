import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Fresh } from './Fresh';

/** Stands in for a training page that loads a new item on mount (GtoQuiz, MathLab, Replay, ...). */
function Exercise({ onMount }: { onMount: () => void }) {
  const nav = useNavigate();
  useEffect(onMount, [onMount]);
  return <button type="button" onClick={() => nav('/gto?mixed=s1')}>next in session</button>;
}

const setup = (wrap: boolean) => {
  const onMount = vi.fn();
  const el = <Exercise onMount={onMount} />;
  render(
    <MemoryRouter initialEntries={['/gto?mixed=s1']}>
      <Routes>
        <Route path="/gto" element={wrap ? <Fresh>{el}</Fresh> : el} />
      </Routes>
    </MemoryRouter>,
  );
  return onMount;
};

describe('Fresh: a navigation to the same URL is a new exercise', () => {
  it('without it the page is reused and the old spot stays on screen (the repeated-hand bug)', () => {
    const onMount = setup(false);
    act(() => screen.getByRole('button').click());
    expect(onMount).toHaveBeenCalledTimes(1);
  });
  it('with it every navigation remounts the page, so a new item is loaded', () => {
    const onMount = setup(true);
    act(() => screen.getByRole('button').click());
    act(() => screen.getByRole('button').click());
    expect(onMount).toHaveBeenCalledTimes(3);
  });
});
