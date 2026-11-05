import { expect, test } from '@playwright/test';
import { injectDecisionMaths } from './decision-maths';
import { register, waitForContent } from './helpers';

test('desktop: Decision Maths sits in the detailed analysis, separated by evidence, with no grade', async ({ page }) => {
  await register(page, 'DMDesk');
  await waitForContent(page);
  await injectDecisionMaths(page);
  await page.goto('/play');
  await page.getByTestId('sim-deal').click();
  const bar = page.getByTestId('action-bar');
  await expect(bar).toBeVisible();
  const cc = bar.locator('button:not([disabled])').filter({ hasText: /^(Check|Call)/ });
  await Promise.all([page.waitForResponse((r) => r.url().includes('/act') && r.request().method() === 'POST'), cc.first().click()]);
  await expect(page.getByTestId('quick-feedback').first()).toBeVisible();
  // quick feedback stays concise: the maths is only inside the detailed analysis
  await expect(page.getByTestId('decision-maths')).toHaveCount(0);
  if (!(await page.getByTestId('qf-details').isVisible())) await page.getByTestId('qf-details-toggle').click();
  const dm = page.getByTestId('qf-sec-odds').getByTestId('decision-maths');
  await expect(dm).toBeVisible();
  await expect(dm.getByTestId('dm-requiredEquity')).toContainText('25.0%');
  await expect(dm.getByTestId('dm-verdict')).toContainText('not established');
  await expect(dm).not.toContainText(/mistake|blunder|EV loss/i);
  await dm.getByTestId('dm-conditional').locator('summary').click();
  await expect(dm.getByTestId('dm-conditional')).toContainText('zero equity');
  await page.screenshot({ path: 'test-results/decision-maths-desktop.png', fullPage: true });
});
