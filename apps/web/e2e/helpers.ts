import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'correct horse battery';

export async function register(page: Page, name = 'E2E') {
  const email = `${name.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.dev`;
  await page.goto('/login');
  await page.getByTestId('tab-register').click();
  await page.fill('input[name=name]', name);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PASSWORD);
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('stat-rating')).toBeVisible();
  return email;
}

export async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PASSWORD);
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('stat-rating')).toBeVisible();
}

/** Wait until scenarios are seeded (server seeds at boot). */
export async function waitForContent(page: Page) {
  for (let i = 0; i < 60; i++) {
    const r = await page.request.get('/api/scenarios?mode=hero');
    if (r.ok() && ((await r.json()) as unknown[]).length >= 30) return;
    await page.waitForTimeout(1000);
  }
  throw new Error('content not seeded');
}
