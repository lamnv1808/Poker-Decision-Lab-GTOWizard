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
