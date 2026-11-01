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
  for (const f of ['fullhand', 'preflop', 'postflop']) await page.getByTestId(`mixed-focus-${f}`).uncheck({ force: true });
  await page.getByTestId('mixed-start').click();
  await expect(page).toHaveURL(/\/math\?level=\d&mixed=/);
  await expect(page.getByTestId('mixed-bar')).toBeVisible();
  await page.getByTestId('quiz-answer').fill('10');
  await page.getByTestId('quiz-submit').click();
  await expect(page.getByTestId('quiz-result')).toBeVisible();
  await expect(page.getByTestId('mixed-bar')).toContainText('1');
  await page.getByTestId('mixed-bar-next').click();
  await expect(page).toHaveURL(/mixed=/);
  await page.getByTestId('mixed-bar').getByRole('link').click();
  await expect(page.getByTestId('mixed-summary')).toBeVisible();
  await expect(page.getByTestId('mixed-summary')).toContainText('Maths');
});
