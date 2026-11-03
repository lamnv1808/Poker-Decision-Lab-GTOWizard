import { expect, test } from '@playwright/test';
import { register, waitForContent } from './helpers';

/** Mixed Training: start → items carry the session → summary counts each answer once. */
test('mixed training session with summary', async ({ page }) => {
  await register(page, 'Mixer');
  await waitForContent(page);
  await page.goto('/train');
  await expect(page.getByTestId('train-continue')).toBeVisible();
  await page.goto('/mixed');
  // maths only, so the item type is predictable
  for (const f of ['fullhand', 'preflop', 'postflop', 'villain', 'replay']) await page.getByTestId(`mixed-focus-${f}`).uncheck({ force: true });
  await page.getByTestId('mixed-start').click();
  await expect(page).toHaveURL(/\/math\?level=\d&mixed=/);
  await expect(page.getByTestId('mixed-bar')).toBeVisible();
  await page.getByTestId('quiz-answer').fill('10');
  await page.getByTestId('quiz-submit').click();
  await expect(page.getByTestId('quiz-result')).toBeVisible();
  await expect(page.getByTestId('mixed-bar')).toContainText('1');
  await Promise.all([page.waitForResponse((r) => r.url().includes('/api/math/quiz?')), page.getByTestId('mixed-bar-next').click()]);
  await expect(page).toHaveURL(/mixed=/);
  // the next item has the same URL (/math?level=…&mixed=…): it must be a fresh, unanswered quiz
  await expect(page.getByTestId('quiz-result')).toHaveCount(0);
  await expect(page.getByTestId('quiz-answer')).toHaveValue('');
  await page.getByTestId('mixed-bar').getByRole('link').click();
  await expect(page.getByTestId('mixed-summary')).toBeVisible();
  await expect(page.getByTestId('mixed-summary')).toContainText('Maths');
});

/**
 * The repeated-AKo report: Mixed Training can serve two push/fold spots in a row, which is the same
 * URL (/gto?mixed=…). The second item must be a new spot, not the answered one left on screen.
 */
test('a second push/fold item in a row is a new spot, not the previous one', async ({ page }) => {
  await register(page, 'SameUrl');
  await waitForContent(page);
  await page.goto('/mixed');
  for (const f of ['fullhand', 'postflop', 'math', 'villain', 'replay']) await page.getByTestId(`mixed-focus-${f}`).uncheck({ force: true });
  await page.getByTestId('mixed-start').click();
  await expect(page).toHaveURL(/\/gto\?.*mixed=/);
  const sid = new URL(page.url()).searchParams.get('mixed')!;
  const tokens: string[] = [];
  page.on('response', async (r) => {
    if (r.url().includes('/api/gto/spot')) tokens.push((await r.json()).token);
  });
  await expect(page.getByTestId('gto-actions')).toBeVisible();
  await page.getByTestId('gto-actions').getByRole('button').first().click();
  await expect(page.getByTestId('gto-result')).toBeVisible();
  // force the session's next item to be push/fold again (the server may legitimately do this)
  await page.route(`**/api/mixed/sessions/${sid}/next`, (r) => r.fulfill({ json: { done: false, type: 'gto', href: `/gto?mixed=${sid}`, remainingSec: 300, served: 2 } }));
  const before = tokens.length;
  await page.getByTestId('mixed-bar-next').click();
  await expect(page.getByTestId('gto-result')).toHaveCount(0);
  await expect(page.getByTestId('gto-actions')).toBeVisible();
  await expect.poll(() => tokens.length).toBeGreaterThan(before);
  expect(tokens[tokens.length - 1]).not.toBe(tokens[before - 1]);
});
