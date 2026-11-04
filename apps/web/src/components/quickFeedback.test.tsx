import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../api';
import { type EngineFeedback, evidenceLevel, nextActionType, qualityLabel, toQuickFeedback } from '../feedbackPresentation';
import { useApp } from '../store';
import { NextBar, QuickFeedback, useSingleFlight } from './QuickFeedback';
import { ErrorNote, errorMessage } from './ui';

const L = (en: string) => ({ en, vi: `vi:${en}` });
const solver: EngineFeedback = {
  tier: 'solver',
  assessment: 'solverVerified',
  basis: 'solverEv',
  graded: true,
  grade: 'mistake',
  evLossBB: 1.2,
  note: L('Solver EVs for this spot.'),
  explain: { recommended: L('Fold'), why: L('Calling loses chips against this range.'), sizing: null },
};
const heuristic: EngineFeedback = {
  tier: 'limited',
  assessment: 'heuristicCoaching',
  basis: 'none',
  graded: false,
  note: L('No verified source.'),
  limitation: L('Multiway turn spot: not graded.'),
  coaching: L('Consider the board texture.'),
  explain: { recommended: L('Bet'), why: L('heuristic why'), sizing: null },
};

beforeEach(() => useApp.setState({ lang: 'en', me: null }));

describe('feedback presentation adapter', () => {
  it('maps engine grades to the five quality labels and never grades ungraded output', () => {
    expect(qualityLabel({ graded: true, grade: 'excellent' })).toBe('excellent');
    expect(qualityLabel({ graded: true, grade: 'acceptable' })).toBe('good');
    expect(qualityLabel({ graded: true, grade: 'marginal' })).toBe('inaccuracy');
    expect(qualityLabel({ graded: true, grade: 'major' })).toBe('blunder');
    expect(qualityLabel({ graded: false, grade: 'excellent' })).toBe('limited');
  });

  it('never labels heuristic or ungraded output as solver', () => {
    expect(evidenceLevel(solver)).toBe('solver');
    expect(evidenceLevel(heuristic)).toBe('heuristic');
    expect(evidenceLevel({ graded: false, tier: 'solver' })).toBe('insufficient');
    expect(evidenceLevel({ graded: false, assessment: 'solverVerified' })).toBe('insufficient');
    expect(evidenceLevel({ graded: true, tier: 'model', basis: 'modelEv', assessment: 'assumedRange' })).toBe('math');
    expect(evidenceLevel({ graded: true, assessment: 'reviewedStrategy' })).toBe('reference');
  });

  it('exposes a recommendation and EV only when evidence supports them, and never a score', () => {
    const q = toQuickFeedback(solver, { selectedAction: 'Call', lang: 'en', handComplete: false });
    expect(q).toMatchObject({ qualityLabel: 'mistake', recommendedAction: 'Fold', evLossBB: 1.2, evidenceLevel: 'solver', shortExplanation: 'Calling loses chips against this range.', nextActionType: 'nextDecision' });
    expect(q.score).toBeUndefined();
    const h = toQuickFeedback(heuristic, { selectedAction: 'Check', lang: 'en', handComplete: false });
    expect(h.qualityLabel).toBe('limited');
    expect(h.recommendedAction).toBeUndefined();
    expect(h.evLossBB).toBeUndefined();
    // limited decisions lead with the verified facts; the limitation stays as a separate note
    expect(h.shortExplanation).toBe('Consider the board texture.');
    expect(h.limitationNote).toBe('Multiway turn spot: not graded.');
    expect(h.score).toBeUndefined();
  });

  it('limited decision without facts still explains the limitation, and never invents a grade', () => {
    const bare: EngineFeedback = { ...heuristic, coaching: undefined };
    const q = toQuickFeedback(bare, { selectedAction: 'Check', lang: 'en', handComplete: false });
    expect(q.shortExplanation).toBe('Multiway turn spot: not graded.');
    expect(q.limitationNote).toBeUndefined();
    expect(q.qualityLabel).toBe('limited');
    expect(q.recommendedAction).toBeUndefined();
    expect(q.evLossBB).toBeUndefined();
    expect(q.grade).toBeUndefined();
  });

  it('graded decisions are unchanged: no limitation note', () => {
    const q = toQuickFeedback(solver, { selectedAction: 'Call', lang: 'en', handComplete: false });
    expect(q.limitationNote).toBeUndefined();
  });

  it('localises and lists only the analysis sections that have data', () => {
    const q = toQuickFeedback(solver, { selectedAction: 'Call', lang: 'vi', handComplete: true, facts: { potBB: 10, toCallBB: 4, requiredEquity: 0.28, spr: 3, street: 'river' } });
    expect(q.shortExplanation).toBe('vi:Calling loses chips against this range.');
    expect(q.availableAnalysis).toEqual(['why', 'context', 'odds', 'evidence', 'review']);
    expect(toQuickFeedback(solver, { selectedAction: 'Call', lang: 'en', handComplete: false }).availableAnalysis).not.toContain('review');
  });

  it('chooses the continuation from the real state: never Next Hand while the hand is running', () => {
    expect(nextActionType({ handComplete: false, inSession: false, sessionComplete: false, fullHand: true })).toBe('nextDecision');
    expect(nextActionType({ handComplete: false, inSession: true, sessionComplete: true, fullHand: true })).toBe('nextDecision');
    expect(nextActionType({ handComplete: true, inSession: false, sessionComplete: false, fullHand: true })).toBe('nextHand');
    expect(nextActionType({ handComplete: true, inSession: true, sessionComplete: false, fullHand: true })).toBe('nextScenario');
    expect(nextActionType({ handComplete: true, inSession: true, sessionComplete: true, fullHand: true })).toBe('finishSession');
  });
});

describe('QuickFeedback', () => {
  function Harness({ fb, onNext }: { fb: EngineFeedback; onNext?: () => void }) {
    const [open, setOpen] = useState(false);
    const m = toQuickFeedback(fb, { selectedAction: 'Call 4 BB', lang: 'en', handComplete: true });
    return <QuickFeedback m={m} open={open} onToggle={() => setOpen((x) => !x)} primary={onNext ? { label: 'Next hand', onClick: onNext, testId: 'sim-next' } : undefined} details={<p>DETAIL</p>} />;
  }

  it('a limited decision shows the verified facts first, then the limitation; no grade or recommendation', () => {
    render(<Harness fb={heuristic} />);
    expect(screen.getByTestId('qf-quality')).toHaveTextContent('Assessment limited');
    expect(screen.getByTestId('qf-why')).toHaveTextContent('Consider the board texture.');
    expect(screen.getByTestId('qf-limitation')).toHaveTextContent('Multiway turn spot: not graded.');
    expect(screen.queryByTestId('qf-recommended')).toBeNull();
    expect(screen.queryByTestId('qf-score')).toBeNull();
  });

  it('shows the compact verdict first and keeps detailed analysis collapsed until asked', async () => {
    render(<Harness fb={solver} />);
    expect(screen.getByTestId('qf-quality')).toHaveTextContent('Mistake');
    expect(screen.getByTestId('qf-selected')).toHaveTextContent('Call 4 BB');
    expect(screen.getByTestId('qf-recommended')).toHaveTextContent('Fold');
    expect(screen.getByTestId('qf-evidence-solver')).toBeInTheDocument();
    expect(screen.queryByTestId('qf-score')).toBeNull();
    expect(screen.queryByTestId('qf-details')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'View detailed analysis' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(screen.getByTestId('qf-details')).toHaveTextContent('DETAIL');
    expect(screen.getByRole('button', { name: 'Hide detailed analysis' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows Assessment Limited without a recommendation for heuristic output', () => {
    render(<Harness fb={heuristic} />);
    expect(screen.getByTestId('qf-quality')).toHaveTextContent('Assessment limited');
    expect(screen.queryByTestId('qf-recommended')).toBeNull();
    expect(screen.queryByTestId('qf-evloss')).toBeNull();
    expect(screen.getByTestId('qf-evidence-heuristic')).toBeInTheDocument();
  });

  it('toggling the analysis does not trigger the continuation', async () => {
    const onNext = vi.fn();
    render(<Harness fb={solver} onNext={onNext} />);
    await userEvent.click(screen.getByTestId('qf-details-toggle'));
    await userEvent.click(screen.getByTestId('qf-details-toggle'));
    expect(onNext).not.toHaveBeenCalled();
  });
});

describe('Next hand: one shared, double-tap-safe handler', () => {
  function Page({ advance }: { advance: () => Promise<void> }) {
    const next = useSingleFlight(advance);
    const cta = { label: 'Next hand', onClick: () => void next.run(), busy: next.busy, testId: 'sim-next' };
    return (
      <>
        <button type="button" onClick={cta.onClick} disabled={cta.busy} data-testid="sim-next">{cta.label}</button>
        <NextBar cta={cta} />
      </>
    );
  }

  it('runs once for a double tap and for inline + sticky taps together', async () => {
    let resolve!: () => void;
    const advance = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<Page advance={advance} />);
    const sticky = screen.getByTestId('sim-next-sticky');
    act(() => {
      sticky.click();
      sticky.click();
      screen.getByTestId('sim-next').click();
    });
    expect(advance).toHaveBeenCalledTimes(1);
    expect(sticky).toBeDisabled();
    await act(async () => resolve());
    expect(sticky).toBeEnabled();
    await userEvent.click(sticky);
    expect(advance).toHaveBeenCalledTimes(2);
  });

  it('the sticky bar respects the safe-area inset and reserves space for the content above it', () => {
    render(<Page advance={async () => {}} />);
    expect(screen.getByTestId('next-bar').getAttribute('style')).toContain('env(safe-area-inset-bottom)');
    expect(screen.getByTestId('next-bar-spacer')).toBeInTheDocument();
  });
});

describe('errors are never an empty red box', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to a message when the server gives none, and offers retry', async () => {
    const onRetry = vi.fn();
    render(<ErrorNote error={new ApiError(500, 'error', '')} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    await userEvent.click(screen.getByTestId('error-retry'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('localises timeouts and network failures', () => {
    const t = (k: string) => k;
    expect(errorMessage(new ApiError(0, 'timeout', 'x'), t)).toBe('common.err.timeout');
    expect(errorMessage(new ApiError(0, 'network', 'x'), t)).toBe('common.err.network');
    expect(errorMessage(new Error('   '), t)).toBe('common.err.generic');
  });

  it('a failed response without a JSON message still produces a non-empty ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502, statusText: '' })));
    await expect(api.get('/x')).rejects.toMatchObject({ status: 502, message: 'Request failed (HTTP 502).' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })));
    await expect(api.get('/x')).rejects.toMatchObject({ status: 502 });
  });

  it('a request that never answers is aborted with a timeout error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))));
    const p = api.get('/slow');
    const assertion = expect(p).rejects.toMatchObject({ code: 'timeout', status: 0 });
    await vi.advanceTimersByTimeAsync(60_001);
    await assertion;
    vi.useRealTimers();
  });
});
