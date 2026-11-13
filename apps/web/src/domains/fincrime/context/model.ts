import type { Schemas } from "@ehf/ui-contracts";
import type { IconName } from "@ehf/ui-kit";

export type Matrix = Schemas["ContextReadinessMatrix"];
export type Cell = Matrix["cells"][number];
export type CellStatus = Cell["status"];
export type ContextProduct = Schemas["ContextProduct.schema"];

export type BankDef = { productId: string; name: string; icon: IconName };
export type BayDef = { id: string; name: string; banks: readonly BankDef[] };

/**
 * The fixed instrument layout (CXT-01): three bays, twelve banks. Positions never depend on
 * readiness (AC1). A product the catalog adds later lands in a trailing "Other" bay in id
 * order, so known banks never move.
 */
export const BAYS: readonly BayDef[] = [
  { id: "subject", name: "Subject", banks: [
    { productId: "identity.intelligence", name: "Identity", icon: "fingerprint" },
    { productId: "ownership.intelligence", name: "Ownership", icon: "branch" },
    { productId: "party360", name: "Party 360", icon: "users" },
    { productId: "network.intelligence", name: "Network", icon: "graph" },
  ] },
  { id: "sources", name: "Sources", banks: [
    { productId: "document.intelligence", name: "Documents", icon: "copy" },
    { productId: "registry.intelligence", name: "Registry", icon: "building" },
    { productId: "screening.intelligence", name: "Screening", icon: "shieldcheck" },
    { productId: "transaction.intelligence", name: "Transactions", icon: "swap" },
    { productId: "evidence.intelligence", name: "Evidence", icon: "file" },
  ] },
  { id: "governance", name: "Governance", banks: [
    { productId: "risk.intelligence", name: "Risk", icon: "gauge" },
    { productId: "case.intelligence", name: "Case", icon: "inbox" },
    { productId: "policy.intelligence", name: "Policy", icon: "book" },
  ] },
];

const KNOWN = new Set(BAYS.flatMap((bay) => bay.banks.map((bank) => bank.productId)));

/** The layout for the products the catalog has: fixed bays first, unknown products after. */
export function layoutFor(productIds: readonly string[]): BayDef[] {
  const present = new Set(productIds);
  const bays: BayDef[] = BAYS.map((bay) => ({ ...bay, banks: bay.banks.filter((bank) => present.has(bank.productId)) })).filter((bay) => bay.banks.length);
  const extra = [...present].filter((id) => !KNOWN.has(id)).sort();
  if (extra.length) bays.push({ id: "other", name: "Other", banks: extra.map((productId) => ({ productId, name: productId, icon: "layers" as IconName })) });
  return bays;
}

export function bankName(productId: string): string {
  for (const bay of BAYS) for (const bank of bay.banks) if (bank.productId === productId) return bank.name;
  return productId;
}

export const STATUS_WORDS: Record<CellStatus, string> = {
  ready: "Within ceiling",
  gaps: "Gaps",
  not_subscribed: "Not subscribed",
  unavailable: "Unavailable",
};

/** What one bank shows. Counts are counts; there is never a percentage (AC2). */
export type BankReading = {
  productId: string;
  status: CellStatus;
  /** One sentence in words, e.g. "Ready for 2 of 2 subscribed agents". */
  summary: string;
  counts: { label: string; value: number }[];
  gaps: string[];
};

const SEVERITY: CellStatus[] = ["unavailable", "gaps", "ready"];

const isSubscribed = (cell: Cell) => cell.subscribed && cell.status !== "not_subscribed";

/** The worst status among subscribed cells; not_subscribed when no agent subscribes. */
export function rollUp(cells: readonly Cell[]): CellStatus {
  const subscribed = cells.filter(isSubscribed);
  if (!subscribed.length) return "not_subscribed";
  return SEVERITY.find((status) => subscribed.some((cell) => cell.status === status)) ?? "unavailable";
}

export function fieldCount(product: ContextProduct | undefined): number {
  return product ? Object.values(product.objects).reduce((sum, fields) => sum + fields.length, 0) : 0;
}

/**
 * Readiness of one bank. With an agent selected it is that agent's cell (product × agent
 * ceiling); with "All agents" it rolls up the subscribed cells and says how many agents count.
 */
export function readBank(matrix: Matrix, productId: string, product: ContextProduct | undefined, agentId: string | null): BankReading {
  const cells = matrix.cells.filter((cell) => cell.productId === productId && (!agentId || cell.agentId === agentId));
  const objects = product ? Object.keys(product.objects).length : 0;
  if (agentId) {
    const cell = cells[0];
    if (!cell || !isSubscribed(cell)) {
      return {
        productId, status: "not_subscribed", summary: "This agent does not subscribe to this product",
        counts: [{ label: "objects", value: objects }, { label: "fields", value: fieldCount(product) }], gaps: [],
      };
    }
    const summary = cell.status === "ready"
      ? "Every required field is inside the agent's ceiling"
      : cell.status === "gaps"
        ? `${cell.gaps.length} required field${cell.gaps.length === 1 ? "" : "s"} outside the agent's ceiling`
        : "The product is unavailable to this agent";
    return {
      productId, status: cell.status, summary,
      counts: [{ label: "required fields", value: cell.requiredFields }, { label: "within ceiling", value: cell.ceilingFields }],
      gaps: [...cell.gaps],
    };
  }
  const status = rollUp(cells);
  const subscribed = cells.filter(isSubscribed);
  const inStatus = subscribed.filter((cell) => cell.status === status).length;
  const summary = status === "not_subscribed"
    ? "No agent subscribes to this product"
    : `${STATUS_WORDS[status]} for ${inStatus} of ${subscribed.length} subscribed agent${subscribed.length === 1 ? "" : "s"}`;
  return {
    productId, status, summary,
    counts: [{ label: "subscribed agents", value: subscribed.length }, { label: "objects", value: objects }, { label: "fields", value: fieldCount(product) }],
    gaps: [...new Set(subscribed.flatMap((cell) => cell.gaps))].sort(),
  };
}

/** Accessible name for a bank: name, status in words and every count (AC4). */
export function bankLabel(name: string, reading: BankReading): string {
  return `${name} intelligence, ${STATUS_WORDS[reading.status]}, ${reading.counts.map((count) => `${count.value} ${count.label}`).join(", ")}`;
}

export type GridPos = { bay: number; bank: number };

/**
 * Arrow-grid navigation over bays (AC4): Left/Right walk banks in reading order, Up/Down move
 * to the same column in the previous/next bay (clamped to its last bank), Home/End jump.
 * Returns null for keys the grid does not handle.
 */
export function moveInGrid(bays: readonly { banks: readonly unknown[] }[], from: GridPos, key: string): GridPos | null {
  const flat = bays.flatMap((bay, b) => bay.banks.map((_bank, k) => ({ bay: b, bank: k })));
  const index = flat.findIndex((entry) => entry.bay === from.bay && entry.bank === from.bank);
  if (index < 0) return null;
  switch (key) {
    case "ArrowRight": return flat[Math.min(index + 1, flat.length - 1)]!;
    case "ArrowLeft": return flat[Math.max(index - 1, 0)]!;
    case "Home": return flat[0]!;
    case "End": return flat[flat.length - 1]!;
    case "ArrowDown":
    case "ArrowUp": {
      const target = from.bay + (key === "ArrowDown" ? 1 : -1);
      const bay = bays[target];
      if (!bay || !bay.banks.length) return from;
      return { bay: target, bank: Math.min(from.bank, bay.banks.length - 1) };
    }
    default: return null;
  }
}
