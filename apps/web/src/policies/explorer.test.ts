import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { addMatrixColumn, upsertOverlay } from "./edit";
import { explorerProduct, overrideCount, packLayers, productPolicy, productTree, trailText, workingDiligence } from "./explorer";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const files = (dir: string): string[] => readdirSync(dir).sort().flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : name.endsWith(".yaml") ? [path] : []; });
const layers = packLayers(files(join(root, "domains/policy/packs")).map((path) => parse(readFileSync(path, "utf8"))));
const taxonomy = JSON.parse(readFileSync(join(root, "artifacts/products/taxonomy.json"), "utf8"));
const institutions = JSON.parse(readFileSync(join(root, "artifacts/products/institutions.json"), "utf8"));
const kyc = readFileSync(join(root, "domains/kyc-agentic/policy.yaml"), "utf8");
const set = { jurisdiction: "GB", institution: "bank.synthetic", customerTypes: ["individual"] };

describe("product policy explorer", () => {
  it("places the set's products on the taxonomy, with the institution's offerings beneath", () => {
    const bank = institutions.catalogs.find((entry: { institution: { id: string } }) => entry.institution.id === "bank.synthetic");
    const tree = productTree(["card", "deposit", "payments"], taxonomy, bank.offerings);
    expect(tree.map((node) => [node.id, node.products])).toEqual([["DEP", ["deposit"]], ["PAY", ["payments"]]]);
    const pay = tree.find((node) => node.id === "PAY")!;
    expect(pay.children.map((node) => [node.id, node.name, node.products])).toEqual([["PAY.CARDS", "Cards", ["card"]]]);
    expect(pay.children[0]!.offerings.map((entry) => entry.name)).toEqual(["Debit Card"]);
    expect(tree.find((node) => node.id === "DEP")!.offerings.map((entry) => entry.offeringId)).toContain("everyday-checking");
    expect(productTree(["crypto"], taxonomy).map((node) => node.id)).toEqual(["crypto"]);
  });

  it("computes a product's effective policy from the working copy, with its trail", () => {
    const diligence = workingDiligence(kyc)!;
    const card = productPolicy({ layers, legacy: taxonomy.legacy, diligence, set, product: "card", partyType: "individual" });
    expect(card.error).toBeNull();
    const names = new Map(taxonomy.nodes.map((node: { id: string; name: string }) => [node.id, node.name]));
    expect(trailText(card.policy!, names as Map<string, string>, taxonomy.legacy)).toEqual(["Baseline", "Regulatory (GB)", "Institution", "Payments & money movement", "Cards"]);
    const controls = new Map(card.policy!.controls.map((control) => [control.controlId, control]));
    expect(controls.get("pack.screening_roles")).toMatchObject({ status: "INHERITED", source: { id: "pack.product.family.pay", target: "PAY" } });
    expect(controls.get("overlay.pep")).toMatchObject({ status: "CONDITIONAL", enforced: true });
    expect(controls.get("diligence.cell.individual.card")).toMatchObject({ status: "MODIFIED", value: "CDD" });
    expect(overrideCount(card.policy!, diligence, taxonomy.legacy)).toBe(1);
  });

  it("counts a rule scoped to the product and a product's own column as its overrides", () => {
    const scoped = upsertOverlay(kyc, { id: "overlay.card-limit", label: "Card limit", description: "", enabled: true,
      condition: { kind: "count", list: "/facts/selected/policyRecordRiskFactor", count: 1 }, effect: { addRequirements: ["EVD-SOURCE-OF-FUNDS"] }, appliesTo: { products: ["card"] } });
    const diligence = workingDiligence(scoped)!;
    const card = productPolicy({ layers, legacy: taxonomy.legacy, diligence, set, product: "card", partyType: "individual" }).policy!;
    expect(overrideCount(card, diligence, taxonomy.legacy)).toBe(2);
    const deposit = productPolicy({ layers, legacy: taxonomy.legacy, diligence, set, product: "deposit", partyType: "individual" }).policy!;
    expect(deposit.controls.find((control) => control.controlId === "overlay.card-limit")).toMatchObject({ status: "NOT_APPLICABLE", reason: "outside_products" });
  });

  it("gives a product its own column from the one it inherits", () => {
    const withColumn = addMatrixColumn(kyc, "PAY", "payments");
    const diligence = workingDiligence(withColumn)!;
    expect(diligence.products).toContain("PAY");
    expect(diligence.matrix.individual!.PAY).toBe(diligence.matrix.individual!.payments);
    expect(() => addMatrixColumn(kyc, "card", "deposit")).toThrow("already has its own column");
  });

  it("evaluates an offering as its own canonical product, inheriting what applies to its legacy type", () => {
    const bank = institutions.catalogs.find((entry: { institution: { id: string } }) => entry.institution.id === "bank.synthetic");
    const tree = productTree(["card", "deposit", "payments"], taxonomy, bank.offerings);
    const debit = tree.find((node) => node.id === "PAY")!.children[0]!.offerings[0]!;
    expect(debit).toEqual({ offeringId: "debit-card", name: "Debit Card", canonicalProductId: "PAY.CARDS.DEBIT", served: true });
    // An offering the set does not cover is shown but not evaluated (a term loan is not personal banking).
    const business = productTree(["deposit"], taxonomy, bank.offerings);
    expect(business.flatMap((node) => node.offerings).find((entry) => entry.offeringId === "everyday-checking")?.served).toBe(true);
    expect(explorerProduct("PAY.CARDS.DEBIT", ["card", "deposit", "payments"], tree)).toEqual({ product: "PAY.CARDS.DEBIT", offering: "Debit Card" });
    expect(explorerProduct("LND.SMALL_BUSINESS.TERM_LOAN", ["card", "deposit", "payments"], tree)).toEqual({ product: "card", offering: null });
    expect(explorerProduct("deposit", ["card", "deposit", "payments"], tree)).toEqual({ product: "deposit", offering: null });
    const diligence = workingDiligence(kyc)!;
    const policy = productPolicy({ layers, legacy: taxonomy.legacy, diligence, set, product: "PAY.CARDS.DEBIT", partyType: "individual" }).policy!;
    const names = new Map(taxonomy.nodes.map((node: { id: string; name: string }) => [node.id, node.name]));
    expect(trailText(policy, names as Map<string, string>, taxonomy.legacy)).toEqual(["Baseline", "Regulatory (GB)", "Institution", "Payments & money movement", "Cards"]);
    // The card column and the card layer apply to the debit card.
    expect(policy.controls.find((control) => control.controlId === "diligence.cell.individual.card")).toMatchObject({ value: "CDD" });
  });

  it("says why a product cannot be composed rather than inventing a policy", () => {
    expect(productPolicy({ layers, legacy: taxonomy.legacy, diligence: null, set, product: "correspondent", partyType: null })).toMatchObject({ policy: null, error: expect.stringContaining("policy_pack.layer_missing:product:correspondent") });
  });
});
