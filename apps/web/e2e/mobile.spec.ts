import { expect, test } from '@playwright/test';
import { register, waitForContent } from './helpers';

test('mobile: navigation, table and action bar fit the screen', async ({ page }) => {
  await register(page, 'Mobile');
  await waitForContent(page);
  await page.getByTestId('menu-button').click();
  await page.getByRole('link', { name: 'Hero scenarios', exact: true }).click();
  await page.getByTestId('launch-browse').click();
  await page.getByTestId('start-sb-q9o-10bb-shove-vs-bb').click();
  await expect(page.getByTestId('poker-table')).toBeVisible();
  await expect(page.getByTestId('action-bar')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByTestId('action-bar').getByRole('button', { name: 'All-in', exact: true }).click();
  await page.getByTestId('action-bar').getByRole('button', { name: 'All-in 10 BB' }).click();
  await expect(page.getByTestId('feedback')).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-feedback.png', fullPage: true });
});

test('mobile: Today and My Leaks fit the screen', async ({ page }) => {
  await register(page, 'MobileToday');
  await waitForContent(page);
  for (const path of ['/today', '/leaks']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: 'test-results/mobile-leaks.png', fullPage: true });
});

test('mobile: a full simulated hand at 320 and 375 px — feedback first, no clipping, reveal, Vietnamese', async ({ page }) => {
  await register(page, 'MobilePlay');
  await waitForContent(page);
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/play');
    await page.getByTestId('sim-deal').click();
    await expect(page.getByTestId('poker-table')).toBeVisible();
    for (let k = 0; k < 15 && !(await page.getByTestId('sim-net').isVisible()); k++) {
      const bar = page.getByTestId('action-bar');
      if (!(await bar.isVisible())) {
        await page.waitForTimeout(200);
        continue;
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
      const cc = bar.locator('button:not([disabled])').filter({ hasText: /^(Check|Call)/ });
      const target = (await cc.count()) ? cc.first() : bar.locator('button:not([disabled])').filter({ hasText: /^Fold/ }).first();
      await Promise.all([page.waitForResponse((r) => r.url().includes('/act') && r.request().method() === 'POST'), target.click()]);
      await expect(page.getByTestId('decision-feedback').first()).toBeVisible();
    }
    await expect(page.getByTestId('sim-net')).toBeVisible();
    await expect(page.getByTestId('sim-revealed')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  }
  await page.getByTestId('lang-vi').click();
  await expect(page.getByText('Lộ bài sau ván')).toBeVisible();
  await page.getByTestId('lang-en').click();
});
