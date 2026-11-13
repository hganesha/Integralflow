import { expect, test, type Page } from "@playwright/test";
import { apiCall, DRAFT_B } from "./authoring-support";
import { expectAccessible, signInAs } from "./support";

// Contextboard CXT-01…04 (BUILD-SPEC v2 §10). Personas: context_architect (draft.write),
// auditor (draft.read only).

const banks = (page: Page) => page.getByRole("group", { name: "Intelligence banks" }).locator("[data-bank]");
const bankIds = (page: Page) => banks(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-bank")));

test.describe("CXT-01 · Contextboard (Play)", () => {
  test("CXT-01-AC1: twelve banks in three fixed bays; positions do not depend on readiness or agent", async ({ page }) => {
    await signInAs(page, "context_architect", "/context?view=banks");
    await expect(page.getByRole("heading", { level: 1, name: "Contextboard" })).toBeVisible();
    await expect(banks(page)).toHaveCount(12);
    for (const bay of ["Subject", "Sources", "Governance"]) await expect(page.getByRole("heading", { level: 2, name: bay })).toBeVisible();
    const all = await bankIds(page);
    expect(all.slice(0, 4)).toEqual(["identity.intelligence", "ownership.intelligence", "party360", "network.intelligence"]);
    await page.getByRole("button", { name: /^agent\.screening/ }).click();
    await expect(page).toHaveURL(/agent=agent\.screening/);
    await expect(page.locator("[data-bank][data-status]")).toHaveCount(12);
    await expect(page.locator('[data-bank="screening.intelligence"]')).toHaveAttribute("aria-label", /within ceiling/);
    expect(await bankIds(page)).toEqual(all);
    await expectAccessible(page);
  });

  test("CXT-01-AC2: each bank states readiness in words with field counts, never a percentage", async ({ page }) => {
    await signInAs(page, "context_architect", "/context?view=banks");
    const policy = page.locator('[data-bank="policy.intelligence"]');
    await expect(policy).toHaveAttribute("aria-label", /^Policy intelligence, (Within ceiling|Gaps|Unavailable), \d+ subscribed agents, \d+ objects, \d+ fields$/);
    await expect(policy).toContainText(/subscribed agents/);
    const board = page.getByRole("group", { name: "Intelligence banks" });
    await expect(board).not.toContainText("%");
    await expect(page.getByRole("list", { name: "Access coverage legend" })).toContainText("Not subscribed");
  });

  test("CXT-01-AC3: selecting an agent restricts banks to its subscriptions; the rest are not subscribed", async ({ page }) => {
    await signInAs(page, "context_architect", "/context?view=banks&agent=agent.screening");
    const { body: catalog } = await apiCall<{ agents: Array<{ id: string; context_products: string[] }> }>(page, "GET", "/v1/fincrime/catalog");
    const subscribed = catalog.agents.find((agent) => agent.id === "agent.screening")!.context_products;
    await expect(banks(page)).toHaveCount(12);
    for (const id of await bankIds(page)) {
      const bank = page.locator(`[data-bank="${id}"]`);
      if (subscribed.includes(id!)) await expect(bank).not.toHaveAttribute("data-status", "not_subscribed");
      else {
        await expect(bank).toHaveAttribute("data-status", "not_subscribed");
        await expect(bank).toHaveAttribute("aria-label", /Not subscribed/);
      }
    }
    await expect(page.locator('[data-bank="screening.intelligence"]')).toHaveAttribute("aria-label", /required fields, \d+ within ceiling/);
  });

  test("CXT-01-AC4: arrow keys move across the grid; the accessible name carries name, status and counts", async ({ page }) => {
    await signInAs(page, "context_architect", "/context?view=banks");
    const identity = page.locator('[data-bank="identity.intelligence"]');
    await identity.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-bank="ownership.intelligence"]')).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator('[data-bank="registry.intelligence"]')).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.locator('[data-bank="policy.intelligence"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-bank="policy.intelligence"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/product=policy\.intelligence/);
    const inspector = page.getByRole("complementary", { name: "Context product inspector" });
    await expect(inspector.getByRole("heading", { name: "Policy intelligence" })).toBeVisible();
    await expect(inspector.getByText("Objects and fields")).toBeVisible();
    await expect(inspector.getByText("Policy", { exact: true }).first()).toBeVisible();
    // One tab stop for the grid (roving tabindex).
    await expect(banks(page).and(page.locator('[tabindex="0"]'))).toHaveCount(1);
  });
});

test.describe("CXT-02 · Composition (Tune)", () => {
  test("CXT-02-AC1: with no draft chosen, Tune asks for one and links to Drafts; Play readiness is untouched", async ({ page }) => {
    await signInAs(page, "context_architect", "/context?mode=tune");
    await expect(page.getByRole("heading", { name: "Choose a draft to compose context for" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Drafts" })).toHaveAttribute("href", "/studio/drafts");
    await expect(page.getByText(/the readiness in Play does not change/)).toBeVisible();
    await expectAccessible(page);
  });

  test("CXT-02-AC2: saving sends the revision it was based on and confirms after the refetch", async ({ page }) => {
    await signInAs(page, "context_architect", `/context?mode=tune&draft=${DRAFT_B}`);
    const before = (await apiCall<{ revision: number }>(page, "GET", `/v1/authoring/drafts/${DRAFT_B}`)).body.revision;
    const selectors = page.getByRole("region", { name: "Context selectors" });
    await selectors.getByRole("button", { name: "Add selector" }).click();
    await selectors.getByLabel("Path").fill("case.subject.name");
    await selectors.getByRole("button", { name: "Save selectors" }).click();
    await expect(selectors.getByText("Saved 1 selector to the draft.")).toBeVisible();
    await expect(page.getByText(`revision ${before + 1}`, { exact: true })).toBeVisible();
    const after = await apiCall<{ parsedPackage: { contextSelectors: Array<{ path: string }> } }>(page, "GET", `/v1/authoring/drafts/${DRAFT_B}`);
    expect(after.body.parsedPackage.contextSelectors.map((selector) => selector.path)).toEqual(["case.subject.name"]);
  });

  test("CXT-02-AC3: without draft.write the selectors are read-only, with the reason", async ({ page }) => {
    await signInAs(page, "auditor", `/context?mode=tune&draft=${DRAFT_B}`);
    await expect(page.getByText("Read-only: composing context needs draft.write.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add selector" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save selectors" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add rule" })).toBeDisabled();
  });
});

test.describe("CXT-03 · Engineer", () => {
  test("CXT-03-AC1: the field requirements table lists object, field, required, min count, on missing, freshness and skill", async ({ page }) => {
    await signInAs(page, "context_architect", "/context?mode=engineer&product=screening.intelligence");
    const tables = page.getByRole("table", { name: "Field requirements for screening.intelligence" });
    const table = tables.first();
    await expect(table).toBeVisible();
    for (const header of ["Object", "Field", "Required", "Min count", "On missing", "Freshness", "Skill"]) {
      await expect(table.getByRole("columnheader", { name: header, exact: true })).toBeVisible();
    }
    expect(await table.getByRole("row").count()).toBeGreaterThan(1);
    await expectAccessible(page);
  });

  test("CXT-03-AC2: pending upstream binding readiness is a neutral disclosure; gateway lists are read-only", async ({ page }) => {
    await signInAs(page, "context_architect", "/context?mode=engineer&product=screening.intelligence");
    await expect(page.getByText("Provider binding readiness is pending upstream")).toBeVisible();
    await expect(page.getByText("pending_upstream")).toBeVisible();
    await expect(page.getByRole("table", { name: "Gateway capabilities" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Adapters" })).toBeVisible();
    const gateway = page.getByRole("region", { name: "Gateway capabilities and adapters" });
    await expect(gateway.getByRole("button")).toHaveCount(0);
    await expect(gateway.getByRole("textbox")).toHaveCount(0);
  });

  test("CXT-03-AC3: credentials appear only as a state; no secret value is rendered", async ({ page }) => {
    await signInAs(page, "context_architect", "/context?mode=engineer&product=screening.intelligence");
    const adapters = page.getByRole("table", { name: "Adapters" });
    await expect(adapters).toBeVisible();
    const cells = await adapters.locator("tbody td:nth-child(3)").allInnerTexts();
    for (const cell of cells) expect(cell.trim()).toMatch(/^(Credential configured|Credential missing|No credential needed)$/);
    await expect(page.locator("input[type=password]")).toHaveCount(0);
    expect(await page.locator("main").innerText()).not.toMatch(/sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9]/);
  });
});

test.describe("CXT-04 · Context preview", () => {
  test("CXT-04-AC1: recorded preview explains its mode and shows no fabricated packet", async ({ page }) => {
    await signInAs(page, "context_architect", `/context/preview?agent=agent.screening&task=task.screening&case=KYB-1042&plan=${"a".repeat(64)}&node=screening`);
    await expect(page.getByRole("heading", { level: 1, name: "Context preview" })).toBeVisible();
    await page.getByRole("button", { name: "Preview context packet" }).click();
    const result = page.getByRole("region", { name: "Packet" });
    await expect(result.getByText("Preview is unavailable in recorded mode")).toBeVisible();
    await expect(result.getByText(/Recorded mode does not assemble runtime context packets/)).toBeVisible();
    await expect(result).not.toContainText("A packet was produced");
    await expectAccessible(page);
  });
});
