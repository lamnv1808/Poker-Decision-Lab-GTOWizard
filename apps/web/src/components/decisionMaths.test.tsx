import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useApp } from '../store';
import { DecisionMaths, type DecisionMathView } from './DecisionMaths';

beforeEach(() => useApp.setState({ lang: 'en', me: null }));

const f = (o: Partial<DecisionMathView['facts'][number]>): DecisionMathView['facts'][number] => ({ id: 'spr', formulaId: 'pdl.math.spr.v1', formula: '', inputs: [], value: 1, unit: 'ratio', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: [], caveats: [], ...o });
const base: DecisionMathView = {
  version: 'pdl-decision-math-v2', status: 'ok', unsupportedReason: null, gradeable: false,
  strategicVerdict: 'NOT_ESTABLISHED', strategicVerdictReason: 'Exact arithmetic only.',
  facts: [
    f({ id: 'requiredEquity', value: 0.3125, unit: 'fraction' }),
    f({ id: 'potOdds', value: 2.2, unit: 'ratio' }),
    f({ id: 'effectiveStack', value: 18.5, unit: 'BB' }),
    f({ id: 'spr', value: 2.4, unit: 'ratio' }),
    f({ id: 'minimumDefenceFrequency', value: 0.6667, unit: 'fraction', class: 'CONDITIONAL_MODEL_REFERENCE', assumptions: ['The bettor’s bluffs have zero equity when called.'] }),
  ],
  unsupported: [{ id: 'breakEvenFoldFrequency', reason: 'multiway pot' }],
};

describe('DecisionMaths', () => {
  it('separates exact arithmetic, assumption-dependent references, unavailable figures and the verdict', () => {
    render(<DecisionMaths m={base} />);
    expect(screen.getByTestId('dm-evidence')).toHaveTextContent('Exact arithmetic');
    expect(screen.getByTestId('dm-requiredEquity')).toHaveTextContent('Required equity: 31.3%');
    expect(screen.getByTestId('dm-potOdds')).toHaveTextContent('2.2 : 1');
    expect(screen.getByTestId('dm-effectiveStack')).toHaveTextContent('18.5 BB');
    expect(screen.getByTestId('dm-spr')).toHaveTextContent('2.4');
    // conditional references are not in the exact list and carry their assumptions
    expect(screen.getByTestId('dm-exact')).not.toHaveTextContent('Minimum defence');
    expect(screen.getByTestId('dm-conditional')).toHaveTextContent('Only if: The bettor’s bluffs have zero equity');
    expect(screen.getByTestId('dm-not-available')).toHaveTextContent('Break-even fold frequency: not available — multiway pot');
    expect(screen.getByTestId('dm-verdict')).toHaveTextContent('Verdict from these numbers alone: not established');
  });

  it('never renders a grade word', () => {
    const { container } = render(<DecisionMaths m={base} />);
    expect(container.textContent).not.toMatch(/mistake|blunder|excellent|EV loss/i);
  });

  it('an unsupported decision says so instead of inventing numbers', () => {
    render(<DecisionMaths m={{ ...base, status: 'unsupported', unsupportedReason: 'incomplete hand history', facts: [], unsupported: [] }} />);
    expect(screen.getByTestId('dm-unsupported')).toHaveTextContent('Not computed: incomplete hand history');
  });

  it('Vietnamese labels', () => {
    useApp.setState({ lang: 'vi' });
    render(<DecisionMaths m={base} />);
    expect(screen.getByTestId('dm-verdict')).toHaveTextContent('Kết luận chỉ từ các con số này: chưa xác lập');
  });
});
