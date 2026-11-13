import { productCovered, type EffectivePolicy, type InstitutionOffering, type ProductTaxonomy } from "@ehf/contracts/products";
import { diligenceSourceSchema, type DiligenceSource } from "@ehf/policy-engine/diligence";
import { effectivePolicy, policyPackLayerSchema, productLineageOf, type PolicyPackLayer } from "@ehf/policy-engine/effective";
import { parse } from "yaml";

/**
 * The Product Policy Explorer's model (Product Policy Studio phase E): the products a policy set
 * serves, placed on the product taxonomy, and each product's effective policy. Computed in the
 * browser from the working copy's diligence block and the pack layers, with the same composition
 * the packs compile with; nothing here decides a case.
 */

export type ExplorerNode = {
  /** The taxonomy node (or, for a product the taxonomy does not map, the product id). */
  id: string;
  name: string;
  /** The policy set's products that sit at this node (`card` sits at PAY.CARDS). */
  products: string[];
  /**
   * The institution's offerings that map to this node or below it, when no deeper node is shown. Each
   * is evaluated as its own canonical product; `served` says whether the policy set covers it.
   */
  offerings: Array<{ offeringId: string; name: string; canonicalProductId: string; served: boolean }>;
  children: ExplorerNode[];
};

type TaxonomyView = Pick<ProductTaxonomy, "nodes" | "legacy">;

/** The taxonomy nodes the set's products reach, as a tree; unmapped products sit at the root. */
export function productTree(products: readonly string[], taxonomy: TaxonomyView, offerings: readonly Pick<InstitutionOffering, "offeringId" | "name" | "canonicalProductId" | "status">[] = []): ExplorerNode[] {
  const names = new Map(taxonomy.nodes.map((node) => [node.id, node.name]));
  const nodes = new Map<string, ExplorerNode>();
  const ensure = (id: string): ExplorerNode => {
    let node = nodes.get(id);
    if (!node) { node = { id, name: names.get(id) ?? id, products: [], offerings: [], children: [] }; nodes.set(id, node); }
    return node;
  };
  for (const product of [...new Set(products)].sort()) {
    const home = taxonomy.legacy[product] ?? (names.has(product) ? product : null);
    if (!home) { ensure(product).products.push(product); continue; }
    for (const id of productLineageOf(home).reverse()) ensure(id);
    ensure(home).products.push(product);
  }
  for (const offering of offerings.filter((entry) => entry.status !== "RETIRED")) {
    const deepest = productLineageOf(offering.canonicalProductId).find((id) => nodes.has(id));
    if (deepest) nodes.get(deepest)!.offerings.push({ offeringId: offering.offeringId, name: offering.name, canonicalProductId: offering.canonicalProductId,
      served: productCovered(offering.canonicalProductId, products, taxonomy.legacy) });
  }
  const roots: ExplorerNode[] = [];
  for (const node of [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const parent = node.id.includes(".") ? nodes.get(node.id.slice(0, node.id.lastIndexOf("."))) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

/** The working copy's diligence block, when it parses. */
export function workingDiligence(policyYaml: string | undefined): DiligenceSource | null {
  if (!policyYaml) return null;
  try {
    const parsed = diligenceSourceSchema.safeParse((parse(policyYaml) as { diligence?: unknown } | null)?.diligence);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function packLayers(raw: readonly unknown[]): PolicyPackLayer[] {
  return raw.flatMap((entry) => { const parsed = policyPackLayerSchema.safeParse(entry); return parsed.success ? [parsed.data] : []; });
}

export type ProductPolicy = { policy: EffectivePolicy; error: null } | { policy: null; error: string };

/** One product's effective policy under a policy set, or why it cannot be composed. */
export function productPolicy(input: {
  layers: PolicyPackLayer[]; legacy: Readonly<Record<string, string>>; diligence: DiligenceSource | null;
  set: { jurisdiction: string; institution: string; customerTypes: string[] }; product: string; partyType: string | null;
}): ProductPolicy {
  const party = input.diligence?.partyTypes.find((entry) => entry.id === input.partyType);
  try {
    return { policy: effectivePolicy(input.layers, {
      jurisdiction: input.set.jurisdiction, institution: input.set.institution, product: input.product,
      ...(party ? { partyType: party.id, customerType: party.customerType } : {}),
    }, {
      lineage: (product) => productLineageOf(product, input.legacy),
      ...(input.diligence && party ? { diligence: { source: input.diligence, id: "working copy", version: "draft", status: "CANDIDATE" } } : {}),
    }), error: null };
  } catch (error) {
    return { policy: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether a node or id is this product's own (the product or the node it maps to), not an ancestor's. */
export const ownTarget = (product: string, target: string | null, legacy: Readonly<Record<string, string>>) =>
  target !== null && (target === product || target === legacy[product]);

/**
 * How many controls the product sets for itself: values modified at its own node, its own matrix
 * column, and rules scoped to it by name.
 */
export function overrideCount(policy: EffectivePolicy, diligence: DiligenceSource | null, legacy: Readonly<Record<string, string>>): number {
  const product = policy.scope.product;
  const modified = policy.controls.filter((control) => control.status === "MODIFIED").length;
  const rules = (diligence?.overlays ?? []).filter((overlay) => (overlay.appliesTo?.products ?? []).some((target) => ownTarget(product, target, legacy))).length;
  return modified + rules;
}

export const STATUS_LABEL: Record<EffectivePolicy["controls"][number]["status"], string> = {
  PROTECTED: "Protected", INHERITED: "Inherited", MODIFIED: "Override", CONDITIONAL: "Conditional", NOT_APPLICABLE: "Not applicable",
};

/** "Regulatory › Institution › Payments › Cards": the trail's layers in words. */
export function trailText(policy: EffectivePolicy, names: ReadonlyMap<string, string>, legacy: Readonly<Record<string, string>> = {}): string[] {
  const steps: string[] = [];
  for (const entry of policy.trail) {
    const label = entry.layer === "baseline" ? "Baseline" : entry.layer === "jurisdiction" ? `Regulatory (${policy.scope.jurisdiction})`
      : entry.layer === "institution" ? "Institution" : entry.layer === "business_line" ? "Business line"
      : entry.target === "*" ? "All products" : names.get(entry.target ?? "") ?? names.get(legacy[entry.target ?? ""] ?? "") ?? entry.target ?? entry.id;
    if (steps.at(-1) !== label) steps.push(label);
  }
  return steps;
}

/**
 * The product the explorer shows: one of the set's products, or the canonical product of an offering
 * the set serves (evaluated as itself, so a debit card offering reads PAY.CARDS.DEBIT, which inherits
 * what applies to `card`). Anything else falls back to the set's first product.
 */
export function explorerProduct(requested: string | null | undefined, setProducts: readonly string[], tree: readonly ExplorerNode[]): { product: string; offering: string | null } {
  const offerings = (nodes: readonly ExplorerNode[]): ExplorerNode["offerings"] => nodes.flatMap((node) => [...node.offerings, ...offerings(node.children)]);
  if (requested && setProducts.includes(requested)) return { product: requested, offering: null };
  const offering = requested ? offerings(tree).find((entry) => entry.canonicalProductId === requested && entry.served) : undefined;
  return offering ? { product: offering.canonicalProductId, offering: offering.name } : { product: setProducts[0]!, offering: null };
}
