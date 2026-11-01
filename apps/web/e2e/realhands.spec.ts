import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { register, waitForContent } from './helpers';

/** Real-hand workflow: import (server-side CLI) → replay without leakage → annotate → verify → graded strategy. */
test('real hand replay, fundamentals pot odds, annotation and reviewed strategy', async ({ page }) => {
  const email = await register(page, 'Annotator');
  await waitForContent(page);
  const env = { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgresql://pdl:pdl@localhost:5432/pdl_e2e_test' };
  const dir = execSync('npx tsx scripts/build-v2-fixture.ts', { cwd: '../server', env }).toString().trim();
  execSync(`npx tsx scripts/import-v2.ts ${email} ${dir}`, { cwd: '../server', env });

  // Replay: action -> reasoning + confidence -> reveal (historical, unreviewed)
  await page.goto('/replay');
  await expect(page.getByTestId('poker-table')).toBeVisible();
  const html = await page.content();
  expect(html).not.toMatch(/hero_all_in|actual_action/);
  await page.getByTestId('action-bar').getByRole('button').filter({ hasText: /^(Fold|Check)$/ }).first().click();
  await expect(page.getByTestId('replay-submit')).toBeDisabled();
  await page.getByTestId('reasoning').fill('Villain range is strong here');
  await page.getByTestId('confidence-2').click();
  await page.getByTestId('replay-submit').click();
  await expect(page.getByTestId('observed')).toContainText('historical');
  await expect(page.getByTestId('unreviewed')).toBeVisible();
  await page.getByTestId('show-outcome').click();
  await expect(page.getByTestId('outcome')).toBeVisible();

  // Fundamentals: pot odds from real hands
  await page.goto('/fundamentals');
  await page.getByTestId('potodds-input').fill('30');
  await page.getByTestId('potodds-submit').click();
  await expect(page.getByTestId('potodds-result')).toBeVisible();

  // Annotate a decision that faces a bet, verify it, then it is graded in Reviewed Strategy
  await page.goto('/annotate');
  await page.getByTestId('annot-filters').getByLabel('Min to call').fill('0.5');
  await page.getByTestId('annot-table').locator('tbody tr').first().click();
  await expect(page.getByTestId('annot-form')).toBeVisible();
  await page.getByTestId('annot-recommendation').fill('call');
  await page.getByTestId('annot-vi').fill('Theo vì giá tốt theo giả định range đã nêu.');
  await page.getByTestId('annot-scope').fill('E2E test annotation');
  const evInputs = page.getByTestId('annot-form').getByPlaceholder('EV BB (optional)');
  await evInputs.nth(0).fill('0');
  await evInputs.nth(1).fill('1.2');
  await page.getByTestId('annot-save').click();
  await expect(page.getByTestId('annot-history')).toContainText('draft');
  await page.getByTestId('verify').click();
  await page.getByTestId('verify-confirm').click();
  await expect(page.getByTestId('annot-history')).toContainText('verified');

  await page.goto('/strategy');
  await expect(page.getByTestId('poker-table')).toBeVisible();
  await page.getByTestId('action-bar').getByRole('button', { name: 'Fold' }).click();
  await page.getByTestId('reasoning').fill('Testing the verified grade');
  await page.getByTestId('confidence-3').click();
  await page.getByTestId('replay-submit').click();
  await expect(page.getByTestId('strategy-eval')).toBeVisible();
  await expect(page.getByTestId('grade')).toBeVisible();

  // Learning metrics keep tracks apart
  await page.goto('/progress');
  await expect(page.getByTestId('learning-metrics')).toContainText('Fundamentals');
});
