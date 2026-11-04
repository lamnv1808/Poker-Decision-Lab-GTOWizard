import { expect, test, type Page, type Route } from '@playwright/test';
import { register, waitForContent } from './helpers';

/**
 * F1 in a real browser against the real server and database: the first answer reaches the server and is
 * committed, but its response is lost (connection reset after the server answered). Retrying, reloading
 * or tapping again must never record or rate that decision twice, and never move it to the next decision.
 */
type Sent = { clientAttemptId: string; decisionIndex?: number };

/** Let the first matching request reach the server, then drop its response; later ones pass through. */
async function loseFirstResponse(page: Page, pattern: string) {
  const sent: Sent[] = [];
  let lost = false;
  await page.route(pattern, async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(route.request().postDataJSON() as Sent);
    if (!lost) {
      lost = true;
      await route.fetch(); // the server commits the answer
      return route.abort('connectionreset'); // …and the page never sees the response
    }
    return route.continue();
  });
  return sent;
}

async function attempts(page: Page) {
  return ((await (await page.request.get('/api/history?limit=200')).json()) as { attempts: { itemRef: string; ratingApplied: boolean }[] }).attempts;
}

test('GTO quiz: lost response, then tapping again shows the result and records the answer once', async ({ page }) => {
  await register(page, 'LostGto');
  await waitForContent(page);
  const sent = await loseFirstResponse(page, '**/api/gto/answer');
  await page.goto('/gto');
  const button = page.getByTestId('gto-actions').getByRole('button').first();
  await button.click();
  await expect(page.getByTestId('error-note')).toBeVisible();
  expect(await attempts(page)).toHaveLength(1); // committed although the page saw an error
  await button.click(); // the user taps again
  await expect(page.getByTestId('gto-result')).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[1]!.clientAttemptId).toBe(sent[0]!.clientAttemptId); // same logical decision, same id
  const after = await attempts(page);
  expect(after).toHaveLength(1);
  // the next spot is a new decision with a new id
  await page.getByTestId('gto-next').click();
  await page.getByTestId('gto-actions').getByRole('button').first().click();
  await expect(page.getByTestId('gto-result')).toBeVisible();
  expect(sent[2]!.clientAttemptId).not.toBe(sent[0]!.clientAttemptId);
  expect(await attempts(page)).toHaveLength(2);
});

/** A rated heads-up hand where Hero is to act (created through the API with the page's session). */
async function newHand(page: Page) {
  for (let i = 0; i < 40; i++) {
    const v = await (await page.request.post('/api/sim/hands', { data: { tableSize: 2, stackBB: 40, mode: 'rated', feedback: 'guided' } })).json();
    if (v.legal) return v as { id: string; decisionIndex: number };
  }
  throw new Error('no playable hand');
}
const passive = (page: Page) => page.getByTestId('action-bar').locator('button:not([disabled])').filter({ hasText: /^(Check|Call)/ }).first();
const hand = async (page: Page, id: string) => (await (await page.request.get(`/api/sim/hands/${id}`)).json()) as { status: string; decisionIndex: number | null; decisions: { action?: unknown }[] };
const acted = (h: { decisions: { action?: unknown }[] }) => h.decisions.filter((d) => d.action).length;

test('Full hand: lost response, then tapping again shows the feedback and records one step', async ({ page }) => {
  await register(page, 'LostSim');
  await waitForContent(page);
  const v = await newHand(page);
  const sent = await loseFirstResponse(page, '**/api/sim/hands/*/act');
  await page.goto(`/play/${v.id}`);
  await expect(page.getByTestId('action-bar')).toBeVisible();
  await passive(page).click();
  await expect(page.getByTestId('error-note')).toBeVisible();
  expect(acted(await hand(page, v.id))).toBe(1); // committed on the server
  // the page still shows decision 0; tapping again must not act on decision 1
  await passive(page).click();
  await expect(page.getByTestId('quick-feedback')).toBeVisible();
  expect(sent[1]!.clientAttemptId).toBe(sent[0]!.clientAttemptId);
  expect(sent[1]!.decisionIndex).toBe(0);
  const h = await hand(page, v.id);
  expect(acted(h)).toBe(1);
  const mine = (await attempts(page)).filter((a) => a.itemRef.startsWith(`sim:${v.id}:`));
  expect(mine.length).toBeLessThanOrEqual(1);
});

test('Full hand: lost response, then a reload resumes at the next decision with nothing duplicated', async ({ page }) => {
  await register(page, 'LostReload');
  await waitForContent(page);
  const v = await newHand(page);
  await loseFirstResponse(page, '**/api/sim/hands/*/act');
  await page.goto(`/play/${v.id}`);
  await expect(page.getByTestId('action-bar')).toBeVisible();
  await passive(page).click();
  await expect(page.getByTestId('error-note')).toBeVisible();
  const committed = await hand(page, v.id);
  expect(acted(committed)).toBe(1);
  await page.unroute('**/api/sim/hands/*/act');
  await page.reload(); // session recovery: the page reloads the hand from the server
  await expect(page.getByTestId('poker-table')).toBeVisible();
  const resumed = await hand(page, v.id);
  expect(acted(resumed)).toBe(1);
  if (resumed.status === 'active' && resumed.decisionIndex !== null) {
    expect(resumed.decisionIndex).toBe(1);
    await expect(page.getByTestId('action-bar')).toBeVisible();
    await Promise.all([page.waitForResponse((r) => r.url().includes('/act') && r.request().method() === 'POST'), passive(page).click()]);
    expect(acted(await hand(page, v.id))).toBe(2);
  }
  const mine = (await attempts(page)).filter((a) => a.itemRef.startsWith(`sim:${v.id}:`));
  expect(new Set(mine.map((a) => a.itemRef)).size).toBe(mine.length); // at most one attempt per decision
});
