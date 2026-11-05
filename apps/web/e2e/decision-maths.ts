import type { Page } from '@playwright/test';

/**
 * Decision Maths is behind a server flag that is OFF in CI. These E2E tests inject a realistic payload into the
 * real act response (everything else comes from the real server) to check rendering and that the mobile quick
 * feedback / Next hand flow is not obstructed. Payload = output of decisionMath() for a heads-up half-pot bet:
 * 5 BB into 10 BB, 95 BB behind.
 */
export const DM_PAYLOAD = {
  version: 'pdl-decision-math-v2', status: 'ok', unsupportedReason: null, gradeable: false,
  strategicVerdict: 'NOT_ESTABLISHED',
  strategicVerdictReason: 'Arithmetic alone does not show whether this action is correct: that needs an estimate of Hero’s equity against the opponent’s range or of the opponent’s fold probability, which these numbers do not include. Any rating shown elsewhere comes from the existing grader, not from this section.',
  facts: [
    { id: 'effectiveStack', formulaId: 'pdl.math.effectiveStack.v1', formula: 'min(Hero behind, largest opponent behind)', inputs: [], value: 90, unit: 'BB', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: [], caveats: [] },
    { id: 'spr', formulaId: 'pdl.math.spr.v1', formula: 'effective stack ÷ pot', inputs: [], value: 6, unit: 'ratio', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: [], caveats: ['Describes the situation at this decision; it does not say whether to check, bet, call or raise.'] },
    { id: 'callAmount', formulaId: 'pdl.math.callAmount.v1', formula: 'C', inputs: [], value: 5, unit: 'BB', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: [], caveats: [] },
    { id: 'potOdds', formulaId: 'pdl.math.potOdds.v1', formula: 'P : C', inputs: [], value: 3, unit: 'ratio', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: [], caveats: [] },
    { id: 'requiredEquity', formulaId: 'pdl.math.requiredEquity.v1', formula: 'C / (P + C)', inputs: [{ name: 'P', value: 15, unit: 'BB' }, { name: 'C', value: 5, unit: 'BB' }], value: 0.25, unit: 'fraction', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: [], caveats: ['Break-even equity for this call only: later betting (implied / reverse implied odds) is not included.'] },
    { id: 'minimumDefenceFrequency', formulaId: 'pdl.math.minimumDefenceFrequency.v1', formula: 'P0 / (P0 + B)', inputs: [], value: 0.666667, unit: 'fraction', class: 'CONDITIONAL_MODEL_REFERENCE', assumptions: ['The bettor’s bluffs have zero equity when called.', 'One street; no raises, no later betting, no card removal.'], applicability: ['heads-up'], caveats: ['A theoretical reference for a whole range, not an instruction to defend any particular hand.'] },
  ],
  unsupported: [],
};

export async function injectDecisionMaths(page: Page) {
  await page.route('**/api/sim/hands/*/act', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (body.feedback) body.feedback.decisionMaths = DM_PAYLOAD;
    await route.fulfill({ response: res, json: body });
  });
}
