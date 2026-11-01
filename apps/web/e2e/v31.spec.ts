import { expect, test } from '@playwright/test';
import { register, waitForContent } from './helpers';

/** V3.1: a scenario continues as a full hand; finished hands offer reveal + Villain reasoning + branch. */
test('scenario continues to a full hand; review reveals runout and explains Villain', async ({ page }) => {
  await register(page, 'V31');
  await waitForContent(page);
  await page.goto('/hero');
  await expect(page.getByTestId('launch-progress')).toContainText('0 unique scenarios completed');
  // play scenarios until one ends mid-hand and offers "Continue this hand"
  for (let i = 0; i < 8; i++) {
    await page.goto('/hero');
    await page.getByTestId('launch-start').click();
    await expect(page.getByTestId('poker-table')).toBeVisible();
    for (let k = 0; k < 6 && !(await page.getByTestId('run-complete').isVisible()); k++) {
      const bar = page.getByTestId('action-bar');
      if (await bar.isVisible()) await bar.locator('button:not([disabled])').filter({ hasText: /^(Check|Call)/ }).first().click();
      else await page.locator('[data-testid="question-submit"], button[type="submit"]').first().click().catch(() => {});
      await page.waitForTimeout(300);
    }
    if (await page.getByTestId('continue-hand').isVisible()) break;
  }
  await page.getByTestId('continue-hand').click();
  await expect(page.getByTestId('sim-progress')).toBeVisible();
  for (let k = 0; k < 20 && !(await page.getByTestId('sim-net').isVisible()); k++) {
    const bar = page.getByTestId('action-bar');
    if (await bar.isVisible()) await bar.locator('button:not([disabled])').filter({ hasText: /^(Check|Call)/ }).first().click();
    await page.waitForTimeout(200);
  }
  await expect(page.getByTestId('sim-winners')).toBeVisible();
  await page.getByTestId('reveal-cards').click();
  await expect(page.getByTestId('sim-hidden-panel')).toContainText('Simulator-only');
  const why = page.getByTestId('villain-why').first();
  if (await why.isVisible()) {
    await why.click();
    await expect(page.getByTestId('villain-branch').first()).toBeVisible();
  }
  await expect(page.getByTestId('sim-next')).toContainText('Next new hand');
});
