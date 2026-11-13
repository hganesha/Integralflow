import { test, expect } from '@playwright/test';
import { expectAccessible, signInAs, mock } from './support';
test('skill categories survive responsive reflow in table mode', async ({page})=>{
    await signInAs(page,'agent_architect','/catalogs/skills?view=table&q=ownership');
    for(const width of [1440,1200,768,390]) {
        await page.setViewportSize({width,height:900});
        await expect(page.getByRole('heading',{name:'Ownership',exact:true})).toBeVisible();
        await expect(page.getByRole('heading',{name:'Monitoring',exact:true})).toBeVisible();
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
        if(width>=768) { const navigation = await page.getByRole('navigation',{name:'Experiences'}).evaluate(element=>({scroll:element.querySelector('ul')!.scrollWidth, width:element.clientWidth})); expect(navigation.scroll, JSON.stringify({viewportWidth:width,...navigation})).toBeLessThanOrEqual(navigation.width); }
        if(width===390)await expect(page.getByText("Scroll table horizontally to see all columns.").first()).toBeVisible();
        await page.mouse.move(width - 2, 250);
        await page.screenshot({path:`../../docs/audits/2026-11-09-ui/implementation/screenshots/skills-${width}.png`});
    }
});
test('catalog categories and controls survive 200% equivalent reflow and compact density', async ({page})=>{
    // A 1440×900 display at 200% presents 720×450 CSS pixels. Exercise that layout
    // with the actual compact-density tokens, including the grouped table's own scroll area.
    await page.setViewportSize({width:720,height:450});
    await signInAs(page,'agent_architect','/catalogs/skills?view=table&q=ownership');
    await page.locator('html').evaluate(element=>element.setAttribute('data-density','compact'));
    await expect(page.getByRole('heading',{name:'Monitoring',exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Ownership',exact:true})).toBeAttached();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.getByRole('textbox',{name:'Search this catalog'}).fill('beneficial owners');
    await page.getByRole('link',{name:'Resolve beneficial owners',exact:true}).click();
    await expect(page).toHaveURL(/studio\/skills\?source=ownership.ubo.resolve/);
    await expect(page.getByRole('tablist', {name:'Skill sections'})).toBeVisible();
    await page.getByRole('button', {name:'Browse skills and workspaces',exact:true}).click();
    await expect(page.getByRole('link', {name: /Resolve beneficial owners/})).toHaveAttribute('aria-current','page');
    await expectAccessible(page);
});
test('catalog landing cards keep their size and content aligned across breakpoints', async ({ page }) => {
    await signInAs(page, 'agent_architect', '/catalogs');
    const cards = page.getByRole('region', { name: 'Explore the catalogs' }).getByRole('link');
    await expect(cards).toHaveCount(7);
    const icons = await cards.evaluateAll(links => links.map(link => link.querySelector('svg')?.innerHTML));
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(7);
    await expect(cards.filter({ hasText: 'Explore external capabilities' })).toContainText(/capability definitions.*provider records.*provider bindings/);
    await expect(cards.filter({ hasText: 'Explore documents' })).toContainText(/document types.*fields/);

    await page.evaluate(() => document.fonts.ready);
    for (const width of [1440, 1200, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const layouts = await cards.evaluateAll(links => links.map(link => {
            const card = link.getBoundingClientRect();
            const offset = (selector: string) => Math.round(link.querySelector(selector)!.getBoundingClientRect().top - card.top);
            return {
                width: Math.round(card.width), height: Math.round(card.height),
                icon: offset('svg'), count: offset('strong'), title: offset('h3'),
                description: offset('p'), action: offset(':scope > span'),
            };
        }));
        expect(layouts, `${width}px viewport`).toEqual(Array(7).fill(layouts[0]));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
});
test('all seven catalogs are discoverable and preserve navigation, selection and filters', async ({ page }) => {
    await signInAs(page, 'agent_architect', '/catalogs');
    await expect(page.getByRole('heading', { name: 'Everything your work is built on.' })).toBeVisible();
    const navigation = page.getByRole('navigation', { name: 'Catalog navigation' });
    for (const name of ['Context', 'Skills', 'Agents', 'External capabilities', 'Policies', 'Documents', 'Products'])
        await expect(navigation.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
    await navigation.getByRole('link', { name: /^Skills/ }).click();
    await page.getByRole('textbox', { name: 'Search this catalog' }).fill('beneficial owners');
    const resolve = page.getByRole('link', { name: 'Resolve beneficial owners', exact: true });
    await expect(resolve).toBeVisible();
    await resolve.click();
    await expect(page).toHaveURL(/studio\/skills\?source=ownership.ubo.resolve/);
    await expect(page.getByRole('heading', {name:'Skill Studio',exact:true})).toBeVisible();
    await expect(page.getByRole('link', {name: /Resolve beneficial owners/})).toHaveAttribute('aria-current','page');
    await page.goBack();
    await expect(page).toHaveURL(/catalogs\/skills/);
    await expect(page.getByRole('textbox', { name: 'Search this catalog' })).toHaveValue('beneficial owners');
    await expectAccessible(page);
});
test('analysts discover documents and policies without author or admin access', async ({ page }) => {
    await signInAs(page, 'cdd_analyst', '/catalogs');
    const navigation = page.getByRole('navigation', { name: 'Catalog navigation' });
    await expect(navigation.getByRole('link', { name: /^Documents/ })).toBeVisible();
    await expect(navigation.getByRole('link', { name: /^Skills/ })).toHaveCount(0);
    await navigation.getByRole('link', { name: /^Documents/ }).click();
    await page.getByRole('textbox', { name: 'Search this catalog' }).fill('passport');
    await page.getByRole('button', { name: 'Passport', exact: true }).click();
    for (const width of [1440, 1024, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const inspector = width >= 1440
            ? page.getByRole('complementary', { name: 'Document type inspector' })
            : page.getByRole('dialog', { name: 'Document type details' });
        await expect(inspector.getByRole('heading', { name: 'Passport', exact: true })).toBeVisible();
        const keyFields = inspector.locator('details').filter({ hasText: 'Key fields' });
        await expect(keyFields.getByRole('listitem')).toHaveText(['document_number', 'person_name', 'date_of_birth', 'expiry_date']);
        await expect(keyFields.getByText('expiry_date', { exact: true })).toBeInViewport();
    }
    const details = page.getByRole('dialog', { name: 'Document type details' });
    await details.getByRole('radio', { name: /Fields and requirements/ }).click();
    await expect(details.getByRole('listitem').first()).toContainText('document_number');
    await expect(details.getByText('document_number', { exact: true })).toBeVisible();
    const forbidden = await page.evaluate(async () => { const response = await fetch('/api/v1/catalogs?kind=skills'); return response.status; });
    expect(forbidden).toBe(403);
});
test('analysts browse the canonical product taxonomy by domain and follow its hierarchy', async ({ page }) => {
    await signInAs(page, 'cdd_analyst', '/catalogs');
    const navigation = page.getByRole('navigation', { name: 'Catalog navigation' });
    await navigation.getByRole('link', { name: /^Products/ }).click();
    await expect(page).toHaveURL(/catalogs\/products/);
    await page.getByRole('textbox', { name: 'Search this catalog' }).fill('prime brokerage');
    await page.getByRole('button', { name: 'Prime brokerage', exact: true }).click();
    const detail = page.getByRole('heading', { name: 'Prime brokerage', exact: true });
    await expect(detail).toBeVisible();
    await expect(page.getByText(/never decides a due-diligence level/).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open permanent link' })).toHaveAttribute('href', /catalogs\/products\/BRK\.PRIME\b/);
    await expectAccessible(page);
    await page.getByRole('link', { name: 'Institutional prime brokerage', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Institutional prime brokerage', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/selected=BRK\.PRIME\.INSTITUTIONAL/);
    await page.screenshot({ path: test.info().outputPath('product-catalog.png'), fullPage: true });
});
test('saved views survive refresh and are scoped to the account', async ({ page }) => {
    await signInAs(page, 'agent_architect', '/catalogs/skills?q=ownership');
    await page.getByRole('button', { name: 'Save view', exact: true }).click();
    await page.getByRole('textbox', { name: 'View name' }).fill('Ownership work');
    await page.getByRole('dialog').getByRole('button', { name: 'Save view', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Ownership work', exact: true })).toBeVisible();
    await mock(page, 'PUT', '/mock/session', { personaId: 'context_architect' });
    await expect(page.getByLabel('Account: M. Lindqvist', { exact: true })).toBeVisible();
    await page.goto('/catalogs/skills');
    await expect(page.getByRole('button', { name: 'Ownership work', exact: true })).toHaveCount(0);
});
test('laptop catalog inspector is a dismissible sheet and legacy context navigation remains accessible', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await signInAs(page, 'context_architect', '/catalogs/context');
    await page.getByRole('button', { name: 'Ownership', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Context product details' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ownership', exact: true })).toBeFocused();
    await page.goto('/context');
    await page.getByRole('button', { name: 'Navigation', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('link', { name: 'Context catalog', exact: true })).toBeVisible();
    await expectAccessible(page);
});
test('document fields and provider bindings are distinct searchable inventories', async ({ page }) => {
    await signInAs(page, 'agent_architect', '/catalogs/documents');
    await page.getByRole('radio', { name: 'Field library', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search this catalog' }).fill('document_number');
    await page.getByRole('button', { name: 'Document number', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Document number', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Find related documents', exact: true }).fill('passport');
    await expect(page.getByRole('complementary').getByRole('link', { name: 'Passport', exact: true })).toBeVisible();
    await page.getByRole('complementary').getByRole('link', { name: 'Passport', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Document types', exact: true })).toBeChecked();
    await page.goto('/catalogs/external-capabilities');
    await page.getByRole('radio', { name: 'Provider bindings', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search this catalog' }).fill('companies-house');
    await expect(page.getByRole('button', { name: /Companies House/ }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Not enabled', exact: true }).first()).toBeVisible();
});
test('global search opens field and binding results in their matching inventory', async ({ page }) => {
    await signInAs(page, 'agent_architect', '/catalogs');
    await page.getByRole('button', { name: /^Search/ }).click();
    await page.getByRole('combobox', { name: 'Search', exact: true }).fill('Capital currency');
    await page.getByRole('option').filter({ has: page.getByText('Capital currency', { exact: true }) }).click();
    await expect(page.getByRole('radio', { name: 'Field library', exact: true })).toBeChecked();
    await expect(page.getByRole('heading', { name: 'Capital currency', exact: true })).toBeVisible();
    const routes = await page.evaluate(async () => (await (await fetch('/api/v1/search?q=companies-house')).json()).groups.flatMap((group: { items: { route: string }[] }) => group.items.map(item => item.route)));
    expect(routes.some((route: string) => route.includes('inventory=binding'))).toBe(true);
});
test('empty results and missing definitions retain a clear route back to the catalog', async ({ page }) => {
    await signInAs(page, 'context_architect', '/catalogs/context?q=no-such-context-937');
    await expect(page.getByRole('heading', { name: 'No definitions match your filters' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Ownership', exact: true })).toBeVisible();
    await page.goto('/catalogs/context/not-a-product');
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close definition', exact: true }).click();
    await expect(page).toHaveURL(/\/catalogs\/context$/);
    await expect(page.getByRole('button', { name: 'Ownership', exact: true })).toBeVisible();
});
test('catalog navigation and details remain usable at 320 CSS pixels', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await signInAs(page, 'context_architect', '/catalogs/context');
    await expect(page.getByRole('button', { name: 'Ownership', exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Ownership', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Context product details' })).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Ownership', exact: true })).toBeFocused();
});
test('documents start with complete family counts and support drilling down and Back', async ({ page }) => {
    await signInAs(page, 'cdd_analyst', '/catalogs/documents');
    await expect(page.getByRole('radio', { name: 'Groups', exact: true })).toBeChecked();
    const families = page.getByRole('region', { name: 'Browse document families' });
    await expect(families.getByRole('button')).toHaveCount(38);
    const familyIcons = await families.getByRole('button').evaluateAll(buttons => buttons.map(button => button.querySelector('svg')?.innerHTML));
    expect(familyIcons.every(Boolean)).toBe(true);
    expect(new Set(familyIcons).size).toBeGreaterThan(10);
    const identityIcon = await families.getByRole('button', { name: 'Personal identity, 9 document types', exact: true }).locator('svg').first().innerHTML();
    await page.getByRole('combobox', { name: 'Sort groups', exact: true }).selectOption('name-desc');
    await expect(families.getByRole('button').first()).toHaveAccessibleName(/^Wealth and EDD declarations/);
    await families.getByRole('button', { name: 'Personal identity, 9 document types', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Personal identity', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Passport', exact: true })).toBeVisible();
    expect(await page.getByRole('button', { name: 'Passport', exact: true }).locator('svg').innerHTML()).toBe(identityIcon);
    expect(new URL(page.url()).searchParams.get('group')).toBe('Personal identity');
    await page.goBack();
    await expect(families).toBeVisible();
    await page.getByRole('radio', { name: 'Field library', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Browse field sections', exact: true })).toBeVisible();
    const sections = page.getByRole('region', { name: 'Browse field sections' });
    await expect(sections.getByRole('button')).toHaveCount(18);
    expect(new Set(await sections.getByRole('button').evaluateAll(buttons => buttons.map(button => button.querySelector('svg')?.innerHTML))).size).toBeGreaterThan(10);
    await expectAccessible(page);
});
test('capability definitions and provider bindings browse by functional domain with scoped pagination', async ({ page }) => {
    await signInAs(page, 'agent_architect', '/catalogs/external-capabilities');
    await page.getByRole('combobox', { name: 'Browse by', exact: true }).selectOption('domain');
    const domains = page.getByRole('region', { name: 'Browse capability domains' });
    await expect(domains.getByRole('button')).toHaveCount(20);
    await domains.getByRole('button', { name: 'Identity, 10 capabilities', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Identity', exact: true })).toBeVisible();
    await page.getByRole('radio', { name: 'Provider bindings', exact: true }).click();
    await expect(domains).toBeVisible();
    await domains.getByRole('button', { name: /^Business, \d+ provider bindings$/ }).click();
    await expect(page.getByRole('table', { name: 'Business', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    expect(new URL(page.url()).searchParams.get('group')).toBe('Business');
    await expect(page.getByRole('button', { name: 'Back to first page', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'All capability domains', exact: true }).click();
    await expect(domains).toBeVisible();
    expect(new URL(page.url()).searchParams.has('cursor')).toBe(false);
    await expectAccessible(page);
});
