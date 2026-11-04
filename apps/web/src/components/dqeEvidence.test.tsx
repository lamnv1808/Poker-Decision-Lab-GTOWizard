import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useApp } from '../store';
import { DqeEvidence, type DqeVerdictView } from './DqeEvidence';

const base: DqeVerdictView = { category: 'INSUFFICIENT_EVIDENCE', label: 'unrated', grade: null, evLossBB: null, modelEvLossBB: null, bestAction: null, frequencies: null, source: null, matchStatus: null, approximation: null, facts: {}, missing: null, engineVersion: 'dqe-1.0.0' };

beforeEach(() => useApp.setState({ lang: 'en', me: null }));

describe('DqeEvidence', () => {
  it('verified solver EV shows the EV loss and the source', () => {
    render(<DqeEvidence v={{ ...base, category: 'VERIFIED_SOLVER_EV', label: 'mistake', grade: 'mistake', evLossBB: 1.4, source: { id: 'pdl-pushfold-hu', version: 'v1', referenceKey: 'k' }, frequencies: { shove: 1, fold: 0 } }} />);
    expect(screen.getByTestId('dqe-category')).toHaveTextContent('Verified solver EV');
    expect(screen.getByText(/EV loss vs the verified solution: 1.4 BB/)).toBeInTheDocument();
    expect(screen.getByText(/pdl-pushfold-hu/)).toBeInTheDocument();
  });

  it('a model estimate is labelled as such and never shown as an EV loss', () => {
    render(<DqeEvidence v={{ ...base, category: 'MODEL_ESTIMATE', label: 'modelEstimate', modelEvLossBB: 0.8, approximation: 'Restricted game: no overcalls' }} />);
    expect(screen.getByTestId('dqe-category')).toHaveTextContent('Model estimate (approximate)');
    expect(screen.getByTestId('dqe-model-diff')).toHaveTextContent('not a grade');
    expect(screen.queryByText(/EV loss vs the verified/)).toBeNull();
    expect(screen.getByText(/no overcalls/)).toBeInTheDocument();
  });

  it('Unrated names exactly what is missing and shows no EV', () => {
    render(<DqeEvidence v={{ ...base, missing: { reason: 'no_reference_for_node', detail: 'no validated reference for MTT · chipEV · 9-max · UTG · facingOpen · 40 BB' } }} />);
    expect(screen.getByTestId('dqe-category')).toHaveTextContent('Unrated: insufficient evidence');
    expect(screen.getByTestId('dqe-missing')).toHaveTextContent('9-max · UTG · facingOpen · 40 BB');
    expect(screen.queryByText(/EV loss/)).toBeNull();
  });
});
