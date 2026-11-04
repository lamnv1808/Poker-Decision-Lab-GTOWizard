import { expect, test, type Page } from '@playwright/test';
import { register, waitForContent } from './helpers';

/**
 * GTO quiz on a phone: after answering, the Next button must be on screen without scrolling — even when
 * the player had scrolled only far enough to see the answer buttons at the bottom edge (what CI showed
 * in 15/60 runs of R8: the verdict sat at the bottom edge and Next was below the fold).
 */
async function answerWithButtonsAtBottomEdge(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/gto');
  const actions = page.getByTestId('gto-actions');
  await expect(actions).toBeVisible();
  // scroll so the answer buttons end exactly at the bottom of the screen
  await page.evaluate(() => {
    const r = document.querySelector('[data-testid="gto-actions"]')!.getBoundingClientRect();
    window.scrollBy(0, r.bottom - window.innerHeight);
  });
  await expect(actions).toBeInViewport({ ratio: 1 });
  await actions.getByRole('button').first().click();
}

test('GTO quiz (phone): Next is fully on screen after answering with the buttons at the bottom edge', async ({ page }) => {
  await register(page, 'GtoNext');
  await waitForContent(page);
  for (let i = 0; i < 3; i++) {
    await answerWithButtonsAtBottomEdge(page);
    await expect(page.getByTestId('gto-quick-feedback')).toBeVisible();
    await expect(page.getByTestId('gto-next')).toBeInViewport({ ratio: 1 });
  }
});

test('GTO postflop quiz (phone): Next is fully on screen after answering with the buttons at the bottom edge', async ({ page }) => {
  await register(page, 'PfNext');
  await waitForContent(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (let i = 0; i < 3; i++) {
    await page.goto('/gto?street=postflop');
    const actions = page.getByTestId('pf-actions');
    await expect(actions).toBeVisible();
    await page.evaluate(() => {
      const r = document.querySelector('[data-testid="pf-actions"]')!.getBoundingClientRect();
      window.scrollBy(0, r.bottom - window.innerHeight);
    });
    await expect(actions).toBeInViewport({ ratio: 1 });
    await actions.getByRole('button').first().click();
    await expect(page.getByTestId('pf-quick-feedback')).toBeVisible();
    await expect(page.getByTestId('pf-next')).toBeInViewport({ ratio: 1 });
  }
});
