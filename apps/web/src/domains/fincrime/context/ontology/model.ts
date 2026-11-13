import { BAYS } from "../model";
import type { OntologyView, OntologyObject } from "@ehf/fincrime-views";
export const PRODUCT_COLORS: Record<string, string> = {
  "identity.intelligence": "var(--context-product-identity)", "ownership.intelligence": "var(--context-product-ownership)", party360: "var(--context-product-party360)", "network.intelligence": "var(--context-product-network)",
  "document.intelligence": "var(--context-product-document)", "registry.intelligence": "var(--context-product-registry)", "screening.intelligence": "var(--context-product-screening)", "transaction.intelligence": "var(--context-product-transaction)",
  "evidence.intelligence": "var(--context-product-evidence)", "risk.intelligence": "var(--context-product-risk)", "case.intelligence": "var(--context-product-case)", "policy.intelligence": "var(--context-product-policy)",
};
export function consumerFields(view: OntologyView, agentId: string | null, object: OntologyObject) {
  const agent = view.agents.find(a => a.id === agentId);
  const reqs = view.requirements.filter(r => r.object_type === object.id && (!agentId || agent?.skills.includes(r.skill_id)));
  return {
    required: new Set(reqs.filter(r => r.required).map(r => r.field)),
    ceiling: agent ? new Set(agent.ceilings[object.id] ?? []) : null,
    requirements: reqs,
  };
}
export const CARD_WIDTH = 280;
export type CardSize = { width: number; height: number };
export type LayoutRect = CardSize & { x: number; y: number; lane: number; row: number };
export type ObjectLane = { id: string; name: string; objects: OntologyObject[] };
/** One visual home per type. Product membership remains metadata, never an inferred relation. */
export function ontologyLanes(objects: OntologyObject[], productOrder: string[]): ObjectLane[] {
  const rank = (object: OntologyObject) => productOrder.indexOf(object.productIds[0] ?? "");
  const ordered = [...objects].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  return [...BAYS, { id: "other", name: "Other types", banks: [] }].map(bay => ({
    id: bay.id, name: bay.name, objects: ordered.filter(object => {
      const home = BAYS.find(b => b.banks.some(bank => bank.productId === object.productIds[0]));
      return (home?.id ?? "other") === bay.id;
    }),
  })).filter(lane => lane.objects.length);
}
export const sizeKey = (id: string, expanded: boolean) => JSON.stringify([id, expanded]);
/** Aligned rows leave dedicated cross-lane routing corridors clear of every card. */
export function ontologyLayout(objects: OntologyObject[], productOrder: string[], expanded: Set<string>, measured: Map<string, CardSize>, relations: Array<{ id: string; source: string; target: string }>) {
  const lanes = ontologyLanes(objects, productOrder);
  const homes = new Map(lanes.flatMap((lane, i) => lane.objects.map((o, row) => [o.id, { lane: i, row }] as const)));
  const sizes = new Map(objects.map(o => [o.id, measured.get(sizeKey(o.id, expanded.has(o.id))) ?? {
    width: CARD_WIDTH, height: 198 + (expanded.has(o.id) ? Math.min(8, o.fields.filter(f => f.depth === 0).length) * 44 : 0),
  }]));
  const laneWidths = lanes.map(lane => Math.max(CARD_WIDTH, ...lane.objects.map(o => sizes.get(o.id)!.width)) + 64);
  const laneX = laneWidths.map((_, i) => 24 + laneWidths.slice(0, i).reduce((sum, w) => sum + w + 112, 0));
  const rectangles = new Map<string, LayoutRect>();
  const routes = new Map<string, number>();
  let y = 104;
  for (let row = 0; row < Math.max(0, ...lanes.map(l => l.objects.length)); row++) {
    let rowHeight = 0;
    lanes.forEach((lane, i) => {
      const object = lane.objects[row]; if (!object) return;
      const size = sizes.get(object.id)!; rowHeight = Math.max(rowHeight, size.height);
      rectangles.set(object.id, { x: laneX[i]! + 32, y, ...size, lane: i, row });
    });
    const crossing = relations.filter(r => homes.get(r.source)?.row === row && homes.has(r.target)).sort((a, b) => a.id.localeCompare(b.id));
    crossing.forEach((r, i) => routes.set(r.id, y + rowHeight + 28 + i * 28));
    y += rowHeight + Math.max(64, 56 + crossing.length * 28);
  }
  return { rectangles, routes, width: laneX.length ? laneX.at(-1)! + laneWidths.at(-1)! + 24 : 0, height: y,
    lanes: lanes.map((lane, i) => ({ ...lane, x: laneX[i]!, y: 24, width: laneWidths[i]!, height: y - 24 })),
  };
}
