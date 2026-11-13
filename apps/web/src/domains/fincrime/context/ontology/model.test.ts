import { expect, it } from "vitest";
import type { OntologyObject } from "@ehf/fincrime-views";
import { ontologyLayout, sizeKey } from "./model";
const object = (id: string, product: string) => ({ id, productIds: [product], fields: [] } as OntologyObject);
it("keeps measured cards inside lanes without collisions and reserves clear edge corridors", () => {
  const objects = Array.from({ length: 89 }, (_, i) => object(`Type${String(i).padStart(2,"0")}`, ["party360", "document.intelligence", "policy.intelligence", "unassigned"][i % 4]!));
  const relations = objects.slice(1).map((o, i) => ({ id: `r${i}`, source: o.id, target: objects[i]!.id }));
  const expanded = new Set(objects.filter((_, i) => i % 2).map(o => o.id));
  const sizes = new Map(objects.map((o, i) => [sizeKey(o.id, expanded.has(o.id)), { width: 280 + i % 3 * 20, height: 140 + i % 11 * 61 }]));
  const layout = ontologyLayout(objects, [], expanded, sizes, relations);
  expect(layout.rectangles.size).toBe(89); expect(layout.lanes.map(l => l.name)).toEqual(["Subject", "Sources", "Governance", "Other types"]);
  const cards = [...layout.rectangles.values()];
  for (const [i, a] of cards.entries()) {
    const lane = layout.lanes[a.lane]!;
    expect(a.x).toBeGreaterThan(lane.x); expect(a.x + a.width).toBeLessThan(lane.x + lane.width);
    expect(a.y + a.height).toBeLessThanOrEqual(lane.y + lane.height);
    for (const b of cards.slice(i + 1)) expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false);
  }
  for (const y of layout.routes.values()) for (const card of cards) expect(y > card.y && y < card.y + card.height).toBe(false);
  const reversed = ontologyLayout([...objects].reverse(), [], expanded, sizes, [...relations].reverse());
  expect(reversed.rectangles).toEqual(layout.rectangles); expect(reversed.routes).toEqual(layout.routes);
});
