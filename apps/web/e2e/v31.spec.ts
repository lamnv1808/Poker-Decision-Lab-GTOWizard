import { expect, test } from '@playwright/test';
import { register, waitForContent } from './helpers';

/** V3.1: a scenario continues as a full hand; finished hands reveal automatically + Villain reasoning + branch. */
test('scenario continues to a full hand; review reveals runout and explains Villain', async ({ page }) => {
  await register(page, 'V31');
  await waitForContent(page);
  await page.goto('/hero');
  await expect(page.getByTestId('launch-progress')).toContainText('0 unique scenarios completed');
  // a scenario that is known to end mid-hand (deterministic: no random scenario picking)
  await page.goto('/hero/browse');
  await page.getByTestId('start-btn-ajs-35bb-open-flop-cbet').click();
  await expect(page.getByTestId('poker-table')).toBeVisible();
  for (let k = 0; k < 6 && !(await page.getByTestId('run-complete').isVisible()); k++) {
    await page.getByTestId('action-bar').locator('button:not([disabled])').filter({ hasText: /^(Check|Call)/ }).first().click();
    await page.waitForTimeout(300);
  }
  await page.getByTestId('continue-hand').click();
  await expect(page.getByTestId('sim-progress')).toBeVisible();
  for (let k = 0; k < 20 && !(await page.getByTestId('sim-net').isVisible()); k++) {
    const bar = page.getByTestId('action-bar');
    if (await bar.isVisible()) await bar.locator('button:not([disabled])').filter({ hasText: /^(Check|Call)/ }).first().click();
    await page.waitForTimeout(200);
  }
  await expect(page.getByTestId('sim-winners')).toBeVisible();
  await expect(page.getByTestId('sim-revealed')).toContainText('Revealed after the hand');
  const why = page.getByTestId('villain-why').first();
  if (await why.isVisible()) {
    await why.click();
    await expect(page.getByTestId('villain-branch').first()).toBeVisible();
  }
  await expect(page.getByTestId('sim-next')).toContainText('Next hand');
});
