import { expect, test } from '@playwright/test';
import { register, waitForContent } from './helpers';

/** Desktop: compact feedback after each decision, CTA next to the feedback, replay keeps the original. */
test('desktop: quick feedback, detailed analysis on demand, Next hand beside the result', async ({ page }) => {
  await register(page, 'QuickFb');
  await waitForContent(page);
  await page.goto('/play');
  await page.getByTestId('sim-deal').click();
  await expect(page.getByTestId('poker-table')).toBeVisible();
  const first = new URL(page.url()).pathname;
  let checkedDetail = false;
  for (let k = 0; k < 25 && !(await page.getByTestId('sim-net').isVisible()); k++) {
    const bar = page.getByTestId('action-bar');
    if (!(await bar.isVisible())) {
      await page.waitForTimeout(200);
      continue;
    }
    await expect(page.getByTestId('sim-next')).toHaveCount(0);
    const cc = bar.locator('button:not([disabled])').filter({ hasText: /^(Check|Call)/ });
    const target = (await cc.count()) ? cc.first() : bar.locator('button:not([disabled])').filter({ hasText: /^Fold/ }).first();
    await Promise.all([page.waitForResponse((r) => r.url().includes('/act') && r.request().method() === 'POST'), target.click()]);
    const qf = page.getByTestId('quick-feedback').first();
    await expect(qf).toBeVisible();
    // quality label is one of the five, or Assessment limited; collapsed by default (Quick style)
    await expect(page.getByTestId('qf-quality')).toHaveAttribute('data-quality', /^(excellent|good|inaccuracy|mistake|blunder|limited)$/);
    await expect(page.getByTestId('qf-details')).toHaveCount(0);
    if ((await page.getByTestId('qf-quality').getAttribute('data-quality')) === 'limited') await expect(page.getByTestId('qf-recommended')).toHaveCount(0);
    if (!checkedDetail && (await page.getByTestId('action-bar').isVisible())) {
      // expanding mid-hand keeps the hand where it is
      await page.getByTestId('qf-details-toggle').click();
      await expect(page.getByTestId('qf-sec-evidence')).toBeVisible();
      await expect(page.getByTestId('action-bar')).toBeVisible();
      await page.getByTestId('qf-details-toggle').click();
      checkedDetail = true;
    }
  }
  await expect(page.getByTestId('sim-summary')).toBeVisible();
  await expect(page.getByTestId('sim-next')).toBeVisible();
  await expect(page.getByTestId('sim-next')).toBeInViewport();
  await expect(page.getByTestId('next-bar')).toBeHidden();
  await page.screenshot({ path: 'test-results/desktop-hand-summary.png' });
  // Replay: a new hand id with the same deal; the original stays complete
  await page.getByTestId('sim-replay').click();
  await expect(page.getByTestId('sim-progress')).toContainText('Replay');
  expect(new URL(page.url()).pathname).not.toBe(first);
  expect((await (await page.request.get(`/api/sim/hands/${first.split('/').pop()}`)).json()).status).toBe('complete');
});

test('desktop: Detailed feedback style opens the analysis automatically and persists', async ({ page }) => {
  await register(page, 'DeepFb');
  await waitForContent(page);
  await page.goto('/play');
  await page.getByTestId('sim-deal').click();
  await expect(page.getByTestId('action-bar')).toBeVisible();
  await page.getByTestId('qf-style').selectOption('deep');
  const bar = page.getByTestId('action-bar');
  const cc = bar.locator('button:not([disabled])').filter({ hasText: /^(Check|Call)/ });
  const target = (await cc.count()) ? cc.first() : bar.locator('button:not([disabled])').filter({ hasText: /^Fold/ }).first();
  await Promise.all([page.waitForResponse((r) => r.url().includes('/act') && r.request().method() === 'POST'), target.click()]);
  await expect(page.getByTestId('qf-details')).toBeVisible();
  const me = await (await page.request.get('/api/auth/me')).json();
  expect(me.preferences.explanationView).toBe('deep');
});

test('a failed Mixed session start shows a readable error with retry, never an empty red box', async ({ page }) => {
  await register(page, 'MixedFail');
  await waitForContent(page);
  await page.route('**/api/mixed/sessions', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 502, body: '' }) : r.continue()));
  await page.goto('/mixed');
  await page.getByTestId('mixed-start').click();
  const note = page.getByTestId('error-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText(/\S{4,}/);
  await expect(page.getByTestId('error-retry')).toBeVisible();
  await page.unroute('**/api/mixed/sessions');
  await page.getByTestId('error-retry').click();
  await expect(page).not.toHaveURL(/\/mixed$/);
});

test('Today: a plan request that fails shows a retry instead of an endless spinner', async ({ page }) => {
  await register(page, 'TodayFail');
  await waitForContent(page);
  let fail = true;
  await page.route('**/api/daily/plan**', (r) => (fail ? r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable', message: '' }) }) : r.continue()));
  await page.goto('/today');
  // empty server message → falls back to the HTTP status text, never an empty box
  await expect(page.getByTestId('error-note')).toContainText(/\S{4,}/);
  fail = false;
  await page.getByTestId('error-retry').click();
  await expect(page.getByTestId('today-items')).toBeVisible();
});

test('in a Mixed session whose time is up, the end-of-hand button says Finish session and opens the summary', async ({ page }) => {
  await register(page, 'FinishSess');
  await waitForContent(page);
  await page.goto('/mixed');
  for (const f of ['preflop', 'postflop', 'math', 'villain', 'replay']) await page.getByTestId(`mixed-focus-${f}`).uncheck({ force: true });
  await page.getByTestId('mixed-start').click();
  // full-hand focus can also serve a curated scenario; only a /play/ item is used here
  for (let i = 0; i < 5 && !/\/play\//.test(page.url()); i++) {
    await page.getByTestId('mixed-bar-next').click();
    await page.waitForTimeout(300);
  }
  test.skip(!/\/play\//.test(page.url()), 'session served no full hand in five items');
  const sid = new URL(page.url()).searchParams.get('mixed')!;
  for (let k = 0; k < 25 && !(await page.getByTestId('sim-net').isVisible()); k++) {
    const bar = page.getByTestId('action-bar');
    if (!(await bar.isVisible())) {
      await page.waitForTimeout(200);
      continue;
    }
    const cc = bar.locator('button:not([disabled])').filter({ hasText: /^(Check|Call)/ });
    const target = (await cc.count()) ? cc.first() : bar.locator('button:not([disabled])').filter({ hasText: /^Fold/ }).first();
    // the session clock runs out while the last hand is being played
    if (k === 0) await page.route(`**/api/mixed/sessions/${sid}`, async (r) => r.fulfill({ json: { ...(await (await r.fetch()).json()), remainingSec: 0, ended: true } }));
    await Promise.all([page.waitForResponse((r) => r.url().includes('/act') && r.request().method() === 'POST'), target.click()]);
  }
  await expect(page.getByTestId('mixed-next')).toHaveText('Finish session');
  await page.unroute(`**/api/mixed/sessions/${sid}`);
  await page.route(`**/api/mixed/sessions/${sid}/next`, (r) => r.fulfill({ json: { done: true, remainingSec: 0 } }));
  await page.getByTestId('mixed-next').click();
  await expect(page.getByTestId('mixed-summary')).toBeVisible();
});
