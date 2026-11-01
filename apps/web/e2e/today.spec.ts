import { expect, test } from '@playwright/test';
import { register, waitForContent } from './helpers';

/** Phase 1: Today plan → a daily Mixed session; My Leaks shows memory + improvement, EN/VI. */
test('today plan starts a daily session; My Leaks shows memory and improvement', async ({ page }) => {
  await register(page, 'Today');
  await waitForContent(page);
  await page.getByTestId('dash-today').click();
  await expect(page.getByTestId('today')).toBeVisible();
  // a new user has no leaks: honest empty state, still a plan of reviews/new material
  await expect(page.getByText('No leak with enough evidence yet', { exact: false })).toBeVisible();
  await page.getByRole('radio', { name: '5 min' }).click();
  await expect(page.getByTestId('today-items').locator('li').first()).toBeVisible();
  await page.getByTestId('today-start').click();
  await expect(page.getByTestId('mixed-bar')).toBeVisible();
  await page.goto('/leaks');
  await expect(page.getByText('My leaks (memory)')).toBeVisible();
  await expect(page.getByTestId('improvement')).toBeVisible();
  await page.getByTestId('lang-vi').click();
  await expect(page.getByText('Lỗi của tôi (bộ nhớ)')).toBeVisible();
  await expect(page.getByText('Luyện tập (trong ứng dụng)')).toBeVisible();
  await page.getByTestId('lang-en').click();
});
