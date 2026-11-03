import { expect, test, type Page } from '@playwright/test';
import { register, waitForContent } from './helpers';

/**
 * P0 reproduction suite, branch-agnostic (runs unchanged on main, the Codex patch and ux/quick-feedback).
 * Each test is a user-visible acceptance criterion; on main several are expected to fail (= reproduced).
 */
const errorBox = (page: Page) => page.locator('div.bg-red-900\\/20');
const spinner = (page: Page) => page.locator('.animate-spin');
const retry = (page: Page) => page.getByRole('button', { name: /^(retry|try again)$/i });

test('R1 Today: a plan request that never answers ends in a visible, retryable error (no endless spinner)', async ({ page }) => {
  await register(page, 'R1');
  await waitForContent(page);
  await page.clock.install();
  await page.route('**/api/daily/plan**', () => { /* never answers */ });
  await page.goto('/today');
  await expect(spinner(page)).toBeVisible();
  await page.clock.runFor(65_000); // past any client timeout up to 60 s
  await expect(spinner(page)).toHaveCount(0, { timeout: 5_000 });
  await expect(errorBox(page)).toBeVisible();
  await expect(retry(page)).toBeVisible();
  await page.unroute('**/api/daily/plan**');
  await retry(page).click();
  await expect(page.getByTestId('today-items')).toBeVisible();
});

test('R2 Today: success, then an empty-body 503 shows a readable message', async ({ page }) => {
  await register(page, 'R2');
  await waitForContent(page);
  await page.goto('/today');
  await expect(page.getByTestId('today-items')).toBeVisible();
  await page.route('**/api/daily/plan**', (r) => r.fulfill({ status: 503, body: '' }));
  await page.getByRole('radio', { name: '20 min' }).click();
  await expect(errorBox(page)).toBeVisible();
  expect(((await errorBox(page).innerText()).replace(/retry|try again/gi, '')).trim().length).toBeGreaterThan(3);
});

test('R3 Mixed start: an empty-body 502 never shows an empty red box', async ({ page }) => {
  await register(page, 'R3');
  await waitForContent(page);
  await page.route('**/api/mixed/sessions', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 502, body: '' }) : r.continue()));
  await page.goto('/mixed');
  await page.getByTestId('mixed-start').click();
  await expect(errorBox(page)).toBeVisible();
  expect(((await errorBox(page).innerText()).replace(/retry|try again/gi, '')).trim().length).toBeGreaterThan(3);
});

test('R4 Mixed: replay-only focus without imported hands gives a clear outcome, not a dead session', async ({ page }) => {
  await register(page, 'R4');
  await waitForContent(page);
  await page.goto('/mixed');
  for (const f of ['fullhand', 'preflop', 'postflop', 'math', 'villain']) await page.getByTestId(`mixed-focus-${f}`).uncheck({ force: true });
  await page.getByTestId('mixed-start').click();
  // acceptable: a readable refusal on the setup page, or the session summary; not a spinner or a bare error
  await expect(errorBox(page).or(page.getByTestId('mixed-summary'))).toBeVisible();
  if (await errorBox(page).isVisible()) expect((await errorBox(page).innerText()).trim().length).toBeGreaterThan(3);
});

test('R5 Mixed: a second push/fold item in a row is a new spot (repeated-AKo mechanism)', async ({ page }) => {
  await register(page, 'R5');
  await waitForContent(page);
  await page.goto('/mixed');
  for (const f of ['fullhand', 'postflop', 'math', 'villain', 'replay']) await page.getByTestId(`mixed-focus-${f}`).uncheck({ force: true });
  await page.getByTestId('mixed-start').click();
  await expect(page).toHaveURL(/\/gto\?.*mixed=/);
  const sid = new URL(page.url()).searchParams.get('mixed')!;
  const tokens: string[] = [];
  page.on('response', async (r) => { if (r.url().includes('/api/gto/spot')) tokens.push((await r.json()).token); });
  await page.getByTestId('gto-actions').getByRole('button').first().click();
  await expect(page.getByTestId('gto-result')).toBeVisible();
  let n = 1;
  await page.route(`**/api/mixed/sessions/${sid}/next`, (r) => r.fulfill({ json: { done: false, type: 'gto', href: `/gto?mixed=${sid}`, remainingSec: 300, served: ++n } }));
  const before = tokens.length;
  await page.getByTestId('mixed-bar-next').click();
  await expect(page.getByTestId('gto-result')).toHaveCount(0);
  await expect(page.getByTestId('gto-actions')).toBeVisible();
  await expect.poll(() => tokens.length).toBeGreaterThan(before);
});

test('R6 Mixed: a double click on Start creates exactly one session', async ({ page }) => {
  await register(page, 'R6');
  await waitForContent(page);
  let creates = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/mixed/sessions') creates++; });
  await page.goto('/mixed');
  await page.route('**/api/mixed/sessions', async (r) => { await new Promise((x) => setTimeout(x, 400)); await r.continue(); });
  await page.getByTestId('mixed-start').dblclick();
  await expect(page.getByTestId('mixed-bar')).toBeVisible();
  await page.waitForTimeout(800);
  expect(creates).toBe(1);
});

test('R7 Mixed: an active hand is resumed, with no lost or duplicate decision', async ({ page }) => {
  await register(page, 'R7');
  await waitForContent(page);
  await page.goto('/mixed');
  for (const f of ['preflop', 'postflop', 'math', 'villain', 'replay']) await page.getByTestId(`mixed-focus-${f}`).uncheck({ force: true });
  await page.getByTestId('mixed-start').click();
  for (let i = 0; i < 6 && !/\/play\//.test(page.url()); i++) { await page.getByTestId('mixed-bar-next').click(); await page.waitForTimeout(400); }
  test.skip(!/\/play\//.test(page.url()), 'no full hand served in six items');
  const hand = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByTestId('action-bar')).toBeVisible();
  const bar = page.getByTestId('action-bar');
  const cc = bar.locator('button:not([disabled])').filter({ hasText: /^(Check|Call)/ });
  await Promise.all([page.waitForResponse((r) => r.url().includes('/act')), (await cc.count() ? cc.first() : bar.locator('button:not([disabled])').first()).click()]);
  const after1 = (await (await page.request.get(`/api/sim/hands/${hand}`)).json()).decisions.length;
  // leave mid-hand through the session bar: the same hand must come back with its decisions
  await page.getByTestId('mixed-bar-next').click();
  await page.waitForTimeout(800);
  const v = await (await page.request.get(`/api/sim/hands/${hand}`)).json();
  expect(v.decisions.length).toBe(after1);
  if (v.status === 'active') expect(new URL(page.url()).pathname).toBe(`/play/${hand}`);
});

test('R8 Mobile GTO: after answering, feedback and Next are on screen without scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, 'R8');
  await waitForContent(page);
  await page.goto('/gto');
  await page.getByTestId('gto-actions').getByRole('button').first().click();
  await expect(page.getByTestId('gto-next')).toBeInViewport();
  // keyboard: Enter advances to a new unanswered spot
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('gto-actions')).toBeVisible();
});
