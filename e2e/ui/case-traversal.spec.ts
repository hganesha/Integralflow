import { expect, test } from "@playwright/test";
import { expectAccessible, signInAs } from "./support";
const path = `/context/cases?case=case-demo&plan=${"a".repeat(64)}&node=case-assessment`;
// Test-only transport fixture. Production/mock mode refuses traversal without the case service.
async function traversalTransport(page: import("@playwright/test").Page, denyNext = false) {
  await page.addInitScript(({ denyNext }) => {
    const original = window.fetch.bind(window);
    (window as any).traversalRequests = [];
    window.fetch = async (input, init) => {
      if (!(input instanceof Request ? input.url : String(input)).endsWith("/cases/case-demo/context:traverse")) return original(input, init);
      const request = input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body)); (window as any).traversalRequests.push(request);
      if (request.query.cursor && denyNext) return new Response(JSON.stringify({ error: "context.traversal_source_use_denied", status: 403, correlationId: "test", retryable: false }), { status: 403, headers: { "content-type": "application/json" } });
      const node = (type: string, id: string, data: object) => ({ key: id, objectType: type, objectId: id, versionId: "v1", classification: "CONFIDENTIAL", subjectIds: ["subject"], observedAt: "2026-11-09T12:00:00Z", recordedAt: "2026-11-09T12:00:00Z", validFrom: null, validTo: null, data });
      const entity = node("Entity", "entity-demo", { name: "Acme" }); const party = node("Party", "party-demo", { entity_id: "entity-demo", role: "customer" });
      const pivot = request.query.root?.objectId === party.objectId;
      const graph = { scope: "authorized_case", snapshotDigest: "b".repeat(64), relationshipDigest: "c".repeat(64), asOf: "2026-11-09T12:00:00Z", knowledgeCutoff: "2026-11-09T12:00:00Z", purpose: "KYB_ONBOARDING", subjects: ["subject"], root: pivot ? party : entity,
        nodes: pivot ? [party, entity] : request.query.cursor ? [party] : [entity], edges: request.query.cursor || pivot ? [{ id: "relationship", source: "party-demo", target: "entity-demo", relationId: "Party.entity_id.Entity", label: "represents", field: "entity_id" }] : [], unresolved: [], nextCursor: request.query.cursor || pivot ? null : "signed-cursor", complete: Boolean(request.query.cursor || pivot), truncated: false, limitations: ["Authorized projection only."] };
      return new Response(JSON.stringify(graph), { status: 200, headers: { "content-type": "application/json" } });
    };
  }, { denyNext });
}
test("pages the authorized graph and pivots from an exact record without changing the frozen scope", async ({ page }) => {
  await traversalTransport(page); await signInAs(page, "context_architect", path);
  await page.getByRole("button", { name: "Explore case", exact: true }).click();
  await expect(page.getByTestId("case-traversal-canvas")).toBeVisible();
  await expect(page.getByText(/1 loaded record versions/)).toBeVisible();
  await page.getByRole("textbox", { name: "Plan step / node ID" }).fill("edited-unsent-step");
  await page.getByRole("button", { name: "Load more relationships" }).click();
  await expect(page.getByText(/2 loaded record versions · 1 relationships/)).toBeVisible();
  await page.getByTestId("case-traversal-canvas").scrollIntoViewIfNeeded();
  await expect(page.locator('.react-flow__node[data-id="entity-demo"]')).toBeInViewport({ ratio: .9 });
  await expect(page.locator('.react-flow__node[data-id="party-demo"]')).toBeInViewport({ ratio: .9 });
  await page.screenshot({ path: "/tmp/ehf-case-traversal-graph.png", fullPage: true });
  await page.getByRole("button", { name: "Show record list" }).click();
  await page.getByRole("button", { name: "Party · party-demo", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Case record inspector" });
  await expect(inspector.getByText(/Version v1/)).toBeVisible();
  await inspector.getByRole("button", { name: "Explore from this record" }).click();
  await expect(page.getByText(/Requested neighborhood loaded/)).toBeVisible();
  const requests = await page.evaluate(() => (window as any).traversalRequests);
  expect(requests).toHaveLength(3); expect(requests[1].nodeId).toBe("case-assessment"); expect(requests[2].nodeId).toBe("case-assessment");
  expect(requests[1].query).toMatchObject({ cursor: "signed-cursor", asOf: "2026-11-09T12:00:00Z" });
  expect(requests[2].query.root).toEqual({ objectType: "Party", objectId: "party-demo", versionId: "v1" });
  expect(requests[2].query).not.toHaveProperty("cursor");
  await page.screenshot({ path: "/tmp/ehf-case-traversal.png", fullPage: true });
  await expectAccessible(page);
});
test("keeps the loaded page but stops pagination after source authorization is denied", async ({ page }) => {
  await traversalTransport(page, true); await signInAs(page, "context_architect", path);
  await page.getByRole("button", { name: "Explore case", exact: true }).click();
  await page.getByRole("button", { name: "Load more relationships" }).click();
  await expect(page.getByText(/context.traversal_source_use_denied/)).toBeVisible();
  await expect(page.getByText(/1 loaded record versions/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more relationships" })).toBeDisabled();
});
