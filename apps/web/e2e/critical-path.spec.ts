import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { login, register, waitForContent } from './helpers';

const fixture = readFileSync(new URL('../../../packages/core/test/fixtures/gg-sample.txt', import.meta.url));

test('MVP critical path: train, review, import, persist across devices', async ({ page, browser }) => {
  const email = await register(page, 'Hero');
  await waitForContent(page);

  // Language switch (persists to the account)
  await page.getByTestId('lang-vi').click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
  await page.getByTestId('lang-en').click();
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await page.getByTestId('lang-vi').click();

  // Rated, math-verified hero decision
  await page.goto('/hero');
  await page.getByRole('radio', { name: 'Xếp hạng' }).click();
  await page.getByTestId('start-bb-k9o-call-sb-shove-12bb').click();
  await expect(page.getByTestId('action-bar')).toBeVisible();
  await expect(page.getByTestId('seat-BB')).toBeVisible();
  await page.getByTestId('action-bar').getByRole('button', { name: /^Theo/ }).click();
  await expect(page.getByTestId('feedback')).toBeVisible();
  await expect(page.getByTestId('ev-loss')).toBeVisible();
  await expect(page.getByTestId('rating-changes')).toBeVisible();
  await expect(page.getByTestId('math-facts')).toContainText('44.0%');
  await expect(page.getByTestId('run-complete')).toBeVisible();
  // Deep analysis with GTO / exploit toggle
  await page.getByRole('radio', { name: 'Chi tiết' }).click();
  await expect(page.getByTestId('option-table')).toBeVisible();
  const gto = await page.getByTestId('strategy-text').textContent();
  await page.getByRole('radio', { name: 'Điều chỉnh khai thác' }).click();
  await expect(page.getByTestId('strategy-text')).not.toHaveText(gto ?? '');

  // Multi-street heuristic tree with sizing
  await page.getByTestId('lang-en').click();
  await page.goto('/hero');
  await page.getByTestId('start-btn-ajs-35bb-open-flop-cbet').click();
  await page.getByRole('button', { name: '2.2BB' }).click();
  await page.getByTestId('action-bar').getByRole('button', { name: 'Raise to 2.2 BB' }).click();
  await expect(page.getByTestId('board')).toContainText('K');
  await page.getByTestId('action-bar').getByRole('button', { name: 'Check' }).click();
  await expect(page.getByTestId('prompt')).toContainText('Turn');
  await page.getByTestId('action-bar').getByRole('button', { name: 'Check' }).click();
  await expect(page.getByTestId('decision-sequence')).toBeVisible();
  await expect(page.getByTestId('run-complete')).toBeVisible();
  // bookmark + personal note on the finished hand
  await page.getByTestId('bookmark').click();
  await expect(page.getByTestId('bookmark')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('note-input').fill('Small open, then c-bet small with the nut flush draw');
  await page.getByTestId('note-save').click();
  await expect(page.getByTestId('notes')).toContainText('nut flush draw');

  // Villain range reading
  await page.goto('/villain');
  await page.getByTestId('start-v-k84-checkraise-combo-count').click();
  await expect(page.getByTestId('question')).toBeVisible();
  for (let i = 0; i < 8; i++) {
    const q = page.getByTestId('question');
    if (!(await q.isVisible().catch(() => false))) break;
    const prompt = await q.innerText();
    if (await page.getByTestId('number-answer').isVisible().catch(() => false)) await page.getByTestId('number-answer').fill('7');
    else if (await page.getByTestId('range-grid').isVisible().catch(() => false)) await page.getByRole('button', { name: 'AA', exact: true }).click();
    else await q.locator('button').first().click();
    await page.getByTestId('submit-answer').click();
    await expect(page.getByTestId('feedback')).toBeVisible();
    // wait for the next question or the end of the run
    await expect(async () => {
      if (await page.getByTestId('run-complete').isVisible()) return;
      expect(await page.getByTestId('question').innerText({ timeout: 1000 })).not.toBe(prompt);
    }).toPass({ timeout: 10000 });
  }
  await expect(page.getByTestId('run-complete')).toBeVisible();

  // Math Lab quiz
  await page.goto('/math?kind=mdf');
  await expect(page.getByTestId('quiz-prompt')).toContainText('minimum defense');
  await page.getByTestId('quiz-answer').fill('60');
  await page.getByTestId('quiz-submit').click();
  await expect(page.getByTestId('quiz-result')).toBeVisible();

  // Hand-history import -> spot quiz -> queue
  await page.goto('/hands');
  await page.getByTestId('hh-file').setInputFiles({ name: 'gg.txt', mimeType: 'text/plain', buffer: fixture });
  await page.getByTestId('hh-upload').click();
  await expect(page.getByTestId('import-result')).toContainText('Imported: 2');
  await expect(page.getByTestId('import-result')).toContainText('Failed: 1');
  await page.getByTestId('hands-table').getByRole('link', { name: 'Review' }).last().click();
  await page.getByTestId('spot-tabs').getByRole('button').last().click();
  await expect(page.getByTestId('spot-facts')).toContainText('24.0%');
  await page.getByTestId('action-bar').getByRole('button', { name: /^Call/ }).click();
  await expect(page.getByTestId('spot-result')).toContainText('Original action');
  await page.getByTestId('queue-spot').click();
  await expect(page.getByTestId('queue-spot')).toHaveText('Saved to queue');

  // Review queue
  await page.goto('/train');
  await expect(page.getByTestId('queue-list')).toBeVisible();

  // Review history: attempts, bookmarks, notes
  await page.goto('/history');
  await expect(page.getByTestId('history-table')).toBeVisible();
  await expect(page.getByText('★ btn-ajs-35bb-open-flop-cbet')).toBeVisible();
  await expect(page.getByTestId('all-notes')).toContainText('nut flush draw');

  // Progress, leaks, curriculum render
  await page.goto('/progress');
  await expect(page.getByText('Accuracy by street')).toBeVisible();
  await page.goto('/leaks');
  await expect(page.getByText('Leak Tracker').first()).toBeVisible();
  await page.goto('/curriculum');
  await expect(page.getByTestId('curriculum').locator('article')).toHaveCount(18);

  const rating = await page.request.get('/api/dashboard').then((r) => r.json());
  expect(rating.rating.games).toBeGreaterThanOrEqual(2);

  // Sign out, then sign in from a "second computer" (fresh browser context)
  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login/);
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await login(page2, email);
  await expect(page2.getByTestId('stat-rating')).toContainText(String(rating.rating.rating));
  await page2.goto('/hands');
  await expect(page2.getByTestId('hands-table')).toContainText('TM5000000001');
  await other.close();
});

test('another user cannot see my data', async ({ page, browser }) => {
  await register(page, 'Owner');
  await waitForContent(page);
  await page.goto('/hands');
  await page.getByTestId('hh-file').setInputFiles({ name: 'gg.txt', mimeType: 'text/plain', buffer: fixture });
  await page.getByTestId('hh-upload').click();
  await expect(page.getByTestId('import-result')).toBeVisible();
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await register(p2, 'Stranger');
  await p2.goto('/hands');
  await expect(p2.getByText('No hands imported yet.')).toBeVisible();
  await ctx.close();
});
