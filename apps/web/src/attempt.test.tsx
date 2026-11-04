import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAttemptIds } from './attempt';

describe('useAttemptIds: one attempt id per logical decision', () => {
  it('every retry of the same decision reuses the id; the next decision gets a new one', () => {
    const { result, rerender } = renderHook(() => useAttemptIds());
    const spotA = { token: 'a' };
    const first = result.current(spotA);
    expect(result.current(spotA)).toBe(first); // retry after a timeout or a lost response
    rerender();
    expect(result.current(spotA)).toBe(first); // a re-render (e.g. the error note appearing) changes nothing
    const spotB = { token: 'b' };
    const second = result.current(spotB);
    expect(second).not.toBe(first);
    expect(result.current(spotB)).toBe(second);
  });

  it('string keys work for Full Hand decisions (hand id + decision index)', () => {
    const { result } = renderHook(() => useAttemptIds());
    const d0 = result.current('hand1:0');
    expect(result.current('hand1:0')).toBe(d0);
    expect(result.current('hand1:1')).not.toBe(d0);
  });

  it('a freshly mounted page (reload, back navigation) starts with a new id', () => {
    const a = renderHook(() => useAttemptIds()).result.current('hand1:0');
    const b = renderHook(() => useAttemptIds()).result.current('hand1:0');
    expect(a).not.toBe(b); // safe: the server refuses a stale decision index and dedupes token items itself
  });
});
