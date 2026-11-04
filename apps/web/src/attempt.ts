import { useCallback, useRef } from 'react';
import { newAttemptId } from './api';

/**
 * One attempt id per logical decision, not per request. `attemptFor(decision)` returns the same id
 * for every call with the same decision (the spot/question object, or a "hand:decisionIndex" key),
 * so a retry after a timeout or a lost response is recognised by the server as the same answer and
 * never recorded or rated twice. Showing a new decision gives a new id.
 */
export function useAttemptIds() {
  const ref = useRef<{ key: unknown; id: string } | null>(null);
  return useCallback((decision: unknown) => {
    if (!ref.current || ref.current.key !== decision) ref.current = { key: decision, id: newAttemptId() };
    return ref.current.id;
  }, []);
}
