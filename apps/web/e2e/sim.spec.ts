import { expect, test } from '@playwright/test';
import { register, waitForContent } from './helpers';

/** Full-hand Hero simulator: deal → play to the end without leakage → review → replay/compare. */
test('play a full hand as Hero, review it and replay the deal', async ({ page }) => {
  await register(page, 'SimPlayer');
  await waitForContent(page);
  await page.goto('/play');
  await page.getByTestId('sim-table').selectOption('6');
  await page.getByTestId('sim-deal').click();
  await expect(page.getByTestId('poker-table')).toBeVisible();
  await expect(page.getByTestId('sim-progress')).toBeVisible();
  for (let i = 0; i < 25; i++) {
    if (await page.getByTestId('sim-net').isVisible()) break;
    const bar = page.getByTestId('action-bar');
    if (!(await bar.isVisible())) {
      await page.waitForTimeout(200);
      continue;
    }
    // during play: only Hero's two cards and at most the dealt board are face up
    const faceUp = await page.getByTestId('poker-table').locator('[aria-label$="of spades"],[aria-label$="of hearts"],[aria-label$="of diamonds"],[aria-label$="of clubs"]').count();
    const board = await page.getByTestId('board').locator('[aria-label*=" of "]').count();
    expect(faceUp).toBe(2 + board);
    if (i === 0) {
      await page.getByTestId('sim-math-toggle').click();
      await expect(page.getByTestId('sim-math')).toBeVisible();
      await page.getByTestId('sim-reasoning').fill('Price is fine');
    }
    await bar.locator('button:not([disabled])').filter({ hasText: /^(Check|Call)/ }).first().click();
    await page.waitForTimeout(150);
  }
  await expect(page.getByTestId('sim-net')).toBeVisible();
  await expect(page.getByTestId('sim-timeline')).toBeVisible();
  await page.getByTestId('sim-replay').click();
  await expect(page.getByTestId('sim-progress')).toContainText('Replay');
});
