import { randomUUID } from 'node:crypto';

/**
 * One logical decision = one attempt, whatever the network does.
 *
 * Items served as signed tokens (GTO push/fold, postflop library quiz, math quiz) carry a random
 * server-issued decision id (`n`) inside the signed payload. Every answer to that token is recorded
 * under the same attempt key, so a retry after a lost response — even one sent with a different
 * clientAttemptId by an older page — returns the stored result instead of recording (and rating) the
 * same decision twice. The unique (userId, clientAttemptId) constraint makes this hold under
 * concurrency too. Tokens issued before this change have no `n` and keep the client's id.
 */
export const newDecisionNonce = () => randomUUID();

const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function tokenAttemptKey(scope: 'gto' | 'gtopf' | 'math', nonce: unknown, clientAttemptId: string): string {
  return typeof nonce === 'string' && NONCE.test(nonce) ? `tok:${scope}:${nonce}` : clientAttemptId;
}
