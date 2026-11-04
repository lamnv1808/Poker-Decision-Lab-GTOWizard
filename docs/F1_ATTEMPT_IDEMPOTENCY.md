# F1 — one logical decision = one attempt (2026-11-04)

## Root cause
Server idempotency was keyed only on `clientAttemptId`, and every page generated a new id per request
(`newAttemptId()` inside the submit handler). When the server committed an answer but the response was
lost (network drop, app switch, the 60 s client timeout from P0), the user's retry carried a new id:
- token items (GTO push/fold, postflop library, math quiz) were recorded and **rated again** — tokens are
  stateless and reusable;
- a Full Hand / scenario-run action carried no decision identity, so a retry was applied to the **next**
  decision when the same action was legal there.

## Fix (no schema, grading, poker-rule or rating-formula change)
| Layer | Change |
|---|---|
| Token items (`gto.ts`, `postflop.ts`, `mathlab.ts`) | each issued token carries a random server-issued decision id `n` inside the signed payload; the attempt is recorded under `tok:<scope>:<n>` (`attemptKey.ts`), so every answer to one token — any client id, sequential or concurrent — resolves to one attempt via the existing unique `(userId, clientAttemptId)`. Retries return the stored result. Tokens issued before deploy (no `n`) keep the client id. |
| Full Hand (`sim.ts`) | `act` requires `decisionIndex` (exposed as `view.decisionIndex`). A repeated `clientAttemptId` returns the stored step's feedback (`duplicate: true`) and must match its index (`409 attempt_mismatch`); a new id for a decision that is no longer open gets `409 stale_decision`; a concurrent same-id loser answers like a retry. Nothing is written on any of these paths. |
| Scenario runs (`runs.ts`) | `act`/`answer` require `nodeKey` (the node shown); a stale one gets `409 stale_decision` without changes. |
| Web (`attempt.ts` + 8 pages) | `useAttemptIds()` keeps one id per decision on screen (spot/question object, `hand:decisionIndex`, `run:answers:node`) and reuses it for every retry. |

API compatibility: `decisionIndex` (sim) and `nodeKey` (runs) are now required; a page loaded before the
deploy gets a 400 on its next action and recovers on reload. All other request shapes are unchanged.

## Evidence
- `apps/server/test/lost-response.test.ts` (13 tests, DB rows): lost response + new-id retry, different
  action, 6 concurrent new-id retries, legacy token, math, postflop, decision index, same-id retry,
  delayed stale retry after the next decision began, id/decision mismatch, future index, missing index,
  concurrent same-id and different-action races. On the pre-fix code 10 of 13 fail (e.g. 6 attempts
  instead of 1; a stale retry answered 200 and acted on the next decision).
- `apps/server/test/api.test.ts`: stale scenario-run action → 409, steps unchanged.
- `apps/web/e2e/lost-response.spec.ts` (real browser, real server): response dropped after the server
  committed → tap again → result shown, same id resent, one attempt; reload → resumes at the next decision.
- `apps/web/src/attempt.test.tsx`: id stable per decision, new per decision.
