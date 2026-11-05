import { expect, test } from '@playwright/test';
import { injectDecisionMaths } from './decision-maths';
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
      await expect(page.getByTestId('quick-feedback').first()).toBeVisible();
    }
    await expect(page.getByTestId('sim-net')).toBeVisible();
    await expect(page.getByTestId('sim-revealed')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  }
  await page.getByTestId('lang-vi').click();
  await expect(page.getByText('Lộ bài sau ván')).toBeVisible();
  await page.getByTestId('lang-en').click();
});

/** Plays the current hand to the end with check/call (fold when nothing else), never leaving early. */
async function playToEnd(page: import('@playwright/test').Page) {
  for (let k = 0; k < 25 && !(await page.getByTestId('sim-net').isVisible()); k++) {
    const bar = page.getByTestId('action-bar');
    if (!(await bar.isVisible())) {
      await page.waitForTimeout(200);
      continue;
    }
    // while the hand is running there is never a Next-hand button
    expect(await page.getByTestId('sim-next-sticky').count()).toBe(0);
    const cc = bar.locator('button:not([disabled])').filter({ hasText: /^(Check|Call)/ });
    const target = (await cc.count()) ? cc.first() : bar.locator('button:not([disabled])').filter({ hasText: /^Fold/ }).first();
    await Promise.all([page.waitForResponse((r) => r.url().includes('/act') && r.request().method() === 'POST'), target.click()]);
    await expect(page.getByTestId('quick-feedback').first()).toBeVisible();
  }
  await expect(page.getByTestId('sim-net')).toBeVisible();
}

test('mobile (iPhone portrait): Next hand is on screen without scrolling, safe, single and genuinely new', async ({ page }) => {
  await register(page, 'MobileNext');
  await waitForContent(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/play');
  await page.getByTestId('sim-deal').click();
  await expect(page.getByTestId('poker-table')).toBeVisible();
  const first = new URL(page.url()).pathname;
  await playToEnd(page);
  const sticky = page.getByTestId('sim-next-sticky');
  await expect(sticky).toBeInViewport();
  const box = (await sticky.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  // the inline copy is desktop-only, so the phone shows exactly one Next hand button
  await expect(page.getByTestId('sim-next')).toBeHidden();
  await page.waitForTimeout(1000); // let the smooth scroll to the summary settle
  await page.screenshot({ path: 'test-results/mobile-next-hand.png' });
  // opening and closing the detailed analysis neither advances nor resets the hand
  await page.getByTestId('qf-details-toggle').click();
  await expect(page.getByTestId('qf-details')).toBeVisible();
  await expect(sticky).toBeInViewport();
  await page.screenshot({ path: 'test-results/mobile-details-open.png' });
  await page.getByTestId('qf-details-toggle').click();
  expect(new URL(page.url()).pathname).toBe(first);
  await expect(page.getByTestId('sim-net')).toBeVisible();
  // a double tap deals exactly one new hand
  let deals = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/sim/hands') deals++;
  });
  await sticky.dblclick();
  await expect(page).not.toHaveURL(new RegExp(`${first}$`));
  await expect(page.getByTestId('action-bar')).toBeVisible();
  await page.waitForTimeout(500);
  expect(deals).toBe(1);
  // the previous hand is kept, complete, in history
  const old = await page.request.get(`/api/sim/hands/${first.split('/').pop()}`);
  expect(old.status()).toBe(200);
  expect((await old.json()).status).toBe('complete');
});

test('mobile: Decision Maths is behind the details toggle and never pushes Next hand off screen', async ({ page }) => {
  await register(page, 'DMMobile');
  await waitForContent(page);
  await injectDecisionMaths(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/play');
  await page.getByTestId('sim-deal').click();
  await expect(page.getByTestId('poker-table')).toBeVisible();
  await playToEnd(page);
  // the quick card shows no maths; Next hand is on screen
  await expect(page.getByTestId('decision-maths')).toHaveCount(0);
  const sticky = page.getByTestId('sim-next-sticky');
  await expect(sticky).toBeInViewport();
  await page.getByTestId('qf-details-toggle').click();
  const dm = page.getByTestId('qf-details').getByTestId('decision-maths');
  await expect(dm).toBeVisible();
  await dm.scrollIntoViewIfNeeded();
  await expect(dm.getByTestId('dm-verdict')).toContainText('not established');
  await expect(sticky).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/decision-maths-mobile.png' });
  await page.getByTestId('qf-details-toggle').click();
  await expect(sticky).toBeInViewport();
});
