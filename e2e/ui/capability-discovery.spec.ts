import { test, expect } from '@playwright/test';
import { expectAccessible, signInAs } from './support';

test('capability collections preserve technical-domain links and scoped pagination', async ({ page }) => {
  await signInAs(page, 'agent_architect', '/catalogs/external-capabilities');
  const collections = page.getByRole('region', { name: 'Browse capability collections' });
  await expect(collections.getByRole('button')).toHaveCount(9);
  await collections.getByRole('button', { name: 'Identity and credentials, 12 capabilities', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Identity and credentials', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('collection')).toBe('Identity and credentials');
  await page.getByRole('button', { name: 'All capability collections', exact: true }).click();
  await expect(collections).toBeVisible();
  await page.goto('/catalogs/external-capabilities?group=Identity');
  await expect(page.getByRole('combobox', { name: 'Browse by', exact: true })).toHaveValue('domain');
  await expect(page.getByRole('table', { name: 'Identity', exact: true })).toBeVisible();
  await expectAccessible(page);
});

test('provider tiers, counts and public evidence remain separate from execution readiness', async ({ page }) => {
  await signInAs(page, 'platform_admin', '/catalogs/external-capabilities?inventory=provider');
  const inventory = await page.evaluate(async () => (await fetch('/api/v1/external-providers')).json());
  expect(inventory.items.filter((provider: { discovery?: unknown }) => provider.discovery)).toHaveLength(376);
  await expect(page.getByRole('status').filter({ hasText: `${inventory.items.length} matching providers` })).toBeVisible();
  await expect(page.getByLabel('Source inventory counts')).toContainText('825');
  await expect(page.getByLabel('Source inventory counts')).toContainText('748');
  await page.getByRole('combobox', { name: 'Research lane', exact: true }).selectOption('core');
  await expect(page.getByRole('status').filter({ hasText: '29 matching providers' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search providers', exact: true }).fill('persona');
  await page.getByRole('button', { name: 'Persona', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Persona', exact: true });
  await dialog.getByRole('radio', { name: 'Research', exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'Versioned inquiry documentation', exact: true })).toHaveAttribute('href', 'https://docs.withpersona.com/2026-09-29/api-reference/inquiries');
  await expect(dialog).toContainText('Source jurisdiction unresolved');
  await expect(dialog).toContainText('Native operation mapping missing');
  await expect(dialog).toContainText('Core shortlist · Proposed');
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Research lane', exact: true })).toHaveValue('core');
  await expect(page.getByRole('textbox', { name: 'Search providers', exact: true })).toHaveValue('persona');
});

test('sources and the research queue retain all candidates, scoped corrections and quarantine', async ({ page }) => {
  await signInAs(page, 'platform_admin', '/catalogs/external-capabilities?inventory=source');
  await expect(page.getByRole('status').filter({ hasText: '88 matching providers' })).toBeVisible();
  await page.getByRole('radio', { name: 'Research queue', exact: true }).click();
  const inventory = await page.evaluate(async () => (await fetch('/api/v1/external-providers')).json());
  const unreviewed = inventory.items.filter((provider: { discovery?: { researchState: string } }) => provider.discovery?.researchState !== 'public_material_reviewed').length;
  await page.getByRole('combobox', { name: 'Research need', exact: true }).selectOption('not_reviewed');
  expect(unreviewed).toBeGreaterThanOrEqual(327);
  await expect(page.getByRole('status').filter({ hasText: `${unreviewed} matching providers` })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('combobox', { name: 'Research need', exact: true }).selectOption('correction');
  await page.getByRole('textbox', { name: 'Search providers', exact: true }).fill('FinCEN');
  await expect(page.getByRole('button', { name: 'FinCEN BOI', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search providers', exact: true }).fill('Finantier');
  await page.getByRole('button', { name: 'Finantier', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Finantier', exact: true });
  await expect(dialog).toContainText('This provider is quarantined');
  await expect(dialog.getByRole('button', { name: 'Add connection', exact: true })).toHaveCount(0);
});

test('family browsing and provider research remain usable on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, 'agent_architect', '/catalogs/external-capabilities?inventory=provider&providerFamily=lexisnexis-risk-solutions');
  await expect(page.getByRole('status').filter({ hasText: '5 matching providers' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add provider', exact: true })).toBeDisabled();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expectAccessible(page);
});

test('existing provider connection drafts can still be created and edited', async ({ page }) => {
  await signInAs(page, 'platform_admin', '/catalogs/external-capabilities?inventory=provider&provider=persona');
  const dialog = page.getByRole('dialog', { name: 'Persona', exact: true });
  await dialog.getByRole('button', { name: 'Add connection', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Connection name', exact: true }).fill('Catalog regression sandbox');
  await dialog.getByRole('textbox', { name: 'Connection ID', exact: true }).fill('catalog-regression');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save connection draft', exact: true }).click();
  await expect(dialog).toContainText('Catalog regression sandbox');
  await dialog.getByRole('radio', { name: /^Connections/ }).click();
  await dialog.getByRole('button', { name: 'Edit Catalog regression sandbox', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Connection name', exact: true })).toHaveValue('Catalog regression sandbox');
});
