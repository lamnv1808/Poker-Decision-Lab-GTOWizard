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

/** Today's plan runs item by item and ends in a summary with the daily section — no spinner left hanging. */
test("today's plan progresses through its items to the summary", async ({ page }) => {
  await register(page, 'TodayRun');
  await waitForContent(page);
  await page.goto('/today');
  // the page clears the 10-min plan and loads the 5-min one: wait for that response, not for the old list
  await Promise.all([page.waitForResponse((r) => r.url().includes('/api/daily/plan?minutes=5') && r.ok()), page.getByRole('radio', { name: '5 min' }).click()]);
  await expect(page.getByTestId('today-items').locator('li').first()).toBeVisible();
  const planned = await page.getByTestId('today-items').locator('li').count();
  expect(planned).toBeGreaterThan(0);
  await page.getByTestId('today-start').click();
  const seen: string[] = [];
  for (let i = 0; i < Math.min(planned, 6); i++) {
    await expect(page.getByTestId('mixed-bar')).toBeVisible({ timeout: 15_000 });
    // every served item renders real content: no spinner and no error left on screen
    await expect(page.getByRole('status')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('error-note')).toHaveCount(0);
    seen.push(new URL(page.url()).pathname);
    if (new URL(page.url()).pathname.startsWith('/play/')) {
      // an unfinished hand is resumed by design, so a full-hand item is played to the end first
      for (let k = 0; k < 25 && !(await page.getByTestId('sim-net').isVisible()); k++) {
        const bar = page.getByTestId('action-bar');
        if (!(await bar.isVisible())) {
          await page.waitForTimeout(200);
          continue;
        }
        const cc = bar.locator('button:not([disabled])').filter({ hasText: /^(Check|Call)/ });
        const target = (await cc.count()) ? cc.first() : bar.locator('button:not([disabled])').filter({ hasText: /^Fold/ }).first();
        await Promise.all([page.waitForResponse((r) => r.url().includes('/act') && r.request().method() === 'POST'), target.click()]);
      }
      await expect(page.getByTestId('mixed-next')).toHaveText('Next exercise');
      await page.getByTestId('mixed-next').click();
    } else await page.getByTestId('mixed-bar-next').click();
    await page.waitForURL((u) => u.pathname !== '/mixed' || u.search !== '');
  }
  expect(seen.length).toBeGreaterThan(0);
  await page.getByTestId('mixed-bar').getByRole('link').click();
  await expect(page.getByTestId('mixed-summary')).toBeVisible();
  await expect(page.getByTestId('daily-summary')).toBeAttached();
  await expect(page.getByTestId('mixed-summary')).toContainText(/Today's plan: [1-9]\d*\/\d+ items/);
});
