import { expect, test } from "@playwright/test";
import { expectAccessible, signInAs } from "./support";

test("canonical ontology is the default and retains cross-product relationships and field contracts", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await signInAs(page, "context_architect", "/context");
  await expect(page.getByTestId("context-ontology-canvas")).toBeVisible();
  await expect(page.getByText("89 canonical types", { exact: false })).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="Party"]')).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="Entity"]')).toBeVisible();
  await page.getByTestId("rf__edge-Party.entity_id.Entity").press("Enter");
  const inspector = page.getByRole("complementary", { name: "Context inspector" });
  await expect(inspector.getByRole("heading", { name: "represents", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/relation=Party.entity_id.Entity/);
  await inspector.getByRole("button", { name: "Entity", exact: true }).click();
  await expect(page).toHaveURL(/object=Entity/);
  await expect(inspector.getByRole("heading", { name: "Entity", exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/ehf-context-ontology.png", fullPage: true });
  await expectAccessible(page);
  expect(errors).toEqual([]);
});

test("object list supports field and relation inspection, preserved URL perspective, and read-only access", async ({ page }) => {
  await signInAs(page, "auditor", "/context?view=list&product=party360&agent=agent.screening&draft=selected-draft");
  await page.getByRole("button", { name: "Party", exact: true }).first().click();
  const inspector = page.getByRole("complementary", { name: "Context inspector" });
  await inspector.getByRole("button", { name: "entity_id", exact: true }).click();
  await expect(page).toHaveURL(/field=entity_id/);
  await expect(page).toHaveURL(/agent=agent.screening/);
  await expect(page).toHaveURL(/draft=selected-draft/);
  await page.reload();
  await expect(inspector.getByText("Party.entity_id", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add entity", exact: true })).toHaveCount(0);
  await expectAccessible(page);
  await page.getByRole("button", { name: "Access banks", exact: true }).click();
  await expect(page.locator("[data-bank]")).toHaveCount(12);
});

test("full ontology can be searched without inventing sample entities or product relationships", async ({ page }) => {
  await signInAs(page, "context_architect", "/context?view=list&product=all");
  await page.getByRole("textbox", { name: "Search ontology", exact: true }).fill("Transaction");
  await expect(page.getByRole("button", { name: "Transaction", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Transaction", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Context inspector" });
  await expect(inspector.getByText(/No typed relationships are declared/)).toBeVisible();
  await inspector.getByRole("button", { name: "amount", exact: true }).click();
  await expect(inspector.getByText(/pattern:/)).toBeVisible();
});

async function expectNoCardCollisions(page: import("@playwright/test").Page, count: number) {
  await expect(page.locator(".react-flow__node-object")).toHaveCount(count);
  await expect.poll(() => page.locator(".react-flow__node-object").evaluateAll(elements => {
    const cards = elements.map(e => ({ id: e.getAttribute("data-id"), rect: e.getBoundingClientRect() }));
    return cards.flatMap((a, i) => cards.slice(i + 1).filter(b => a.rect.left < b.rect.right - .5 && a.rect.right > b.rect.left + .5 && a.rect.top < b.rect.bottom - .5 && a.rect.bottom > b.rect.top + .5).map(b => `${a.id}/${b.id}`));
  })).toEqual([]);
}
test("fixed lanes prevent collisions for the full expanded ontology and after filtering/resizing", async ({ page }) => {
  await signInAs(page, "context_architect", "/context?product=all");
  await expect(page.getByRole("navigation", { name: "Graph lanes" })).toBeVisible();
  await expectNoCardCollisions(page, 89);
  await page.getByRole("button", { name: "Expand fields", exact: true }).click();
  await expect(page.locator(".react-flow__node-object button[aria-expanded=true]")).toHaveCount(89);
  await expectNoCardCollisions(page, 89);
  await expect.poll(() => page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".react-flow__node-object")).map(e => e.getBoundingClientRect());
    return Array.from(document.querySelectorAll<SVGPathElement>(".react-flow__edge-path")).flatMap(path => {
      const matrix = path.getScreenCTM(); if (!matrix) return ["missing transform"];
      const length = path.getTotalLength();
      for (let distance = 5; distance < length - 5; distance += 8) {
        const p = path.getPointAtLength(distance); const point = new DOMPoint(p.x, p.y).matrixTransform(matrix);
        if (cards.some(r => point.x > r.left + 2 && point.x < r.right - 2 && point.y > r.top + 2 && point.y < r.bottom - 2)) return [path.id];
      }
      return [];
    });
  })).toEqual([]);
  await page.getByRole("button", { name: "Fit graph", exact: true }).click();
  await page.screenshot({ path: "/tmp/ehf-ontology-lanes-expanded.png", fullPage: true });
  await page.getByRole("button", { name: "Collapse fields", exact: true }).click();
  await expectNoCardCollisions(page, 89);
  await page.getByRole("button", { name: "Readable view", exact: true }).click();
  await page.getByTestId("context-ontology-canvas").scrollIntoViewIfNeeded();
  const alias = page.locator('.react-flow__node-object[data-id="Alias"]');
  const position = await alias.evaluate(e => (e as HTMLElement).style.transform);
  const box = await alias.boundingBox();
  if (!box) throw new Error("Alias has no rendered bounds");
  await page.mouse.move(box.x + 60, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 130, { steps: 8 }); await page.mouse.up();
  expect(await alias.evaluate(e => (e as HTMLElement).style.transform)).toBe(position);
  await expectNoCardCollisions(page, 89);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectNoCardCollisions(page, 89);
  await page.getByRole("textbox", { name: "Search ontology", exact: true }).fill("Party");
  await expect.poll(() => page.locator(".react-flow__node-object").count()).toBeLessThan(89);
  const filtered = await page.locator(".react-flow__node-object").count(); await expectNoCardCollisions(page, filtered);
  await page.getByRole("textbox", { name: "Search ontology", exact: true }).clear();
  await expectNoCardCollisions(page, 89);
});
test("narrow screens use an inspectable hierarchy and preserve state when returning to lanes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, "context_architect", "/context?product=party360&agent=agent.screening");
  const tree = page.getByRole("region", { name: "Ontology hierarchy" });
  await expect(tree).toBeVisible(); await expect(page.getByTestId("context-ontology-canvas")).toHaveCount(0);
  const party = tree.locator("details").filter({ has: page.locator(":scope > summary", { hasText: /^Party / }) }).last();
  await party.locator(":scope > summary").click();
  await party.getByRole("list", { name: "Party fields", exact: true }).getByRole("button", { name: /^entity_id\b/ }).click();
  await expect(page).toHaveURL(/field=entity_id/); await expect(page).toHaveURL(/agent=agent.screening/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/ehf-ontology-hierarchy-mobile.png", fullPage: true });
  await expectAccessible(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("context-ontology-canvas")).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="Party"] button[aria-expanded=true]')).toBeVisible();
  await expect(page).toHaveURL(/field=entity_id/);
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(tree).toBeVisible(); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
