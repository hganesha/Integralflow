import { describe, expect, it } from "vitest";
import { BAYS, bankLabel, layoutFor, moveInGrid, readBank, rollUp, type Matrix } from "./model";

const product = { id: "screening.intelligence", description: "", version: "1.0.0", objects: { ScreeningHit: ["a", "b"], WatchlistEntry: ["c"] } };
const cell = (agentId: string, status: Matrix["cells"][number]["status"], gaps: string[] = []) => ({
  agentId, productId: product.id, subscribed: status !== "not_subscribed", requiredFields: 5, ceilingFields: status === "gaps" ? 4 : 5, status, gaps,
});
const matrix: Matrix = {
  products: [product.id],
  agents: ["a1", "a2", "a3"],
  cells: [cell("a1", "ready"), cell("a2", "gaps", ["ScreeningHit.b"]), cell("a3", "not_subscribed")],
};

describe("Contextboard readiness (CXT-01)", () => {
  it("AC1: has twelve banks in three fixed bays, whatever the readiness", () => {
    expect(BAYS.map((bay) => bay.banks.length)).toEqual([4, 5, 3]);
    const ids = BAYS.flatMap((bay) => bay.banks.map((bank) => bank.productId));
    expect(layoutFor([...ids].reverse()).flatMap((bay) => bay.banks.map((bank) => bank.productId))).toEqual(ids);
    expect(layoutFor([...ids, "zeta.new", "alpha.new"]).at(-1)?.banks.map((bank) => bank.productId)).toEqual(["alpha.new", "zeta.new"]);
  });

  it("AC2: all agents rolls up to the worst subscribed status and counts in words, never a percentage", () => {
    const reading = readBank(matrix, product.id, product, null);
    expect(reading.status).toBe("gaps");
    expect(reading.summary).toBe("Gaps for 1 of 2 subscribed agents");
    expect(reading.counts).toEqual([{ label: "subscribed agents", value: 2 }, { label: "objects", value: 2 }, { label: "fields", value: 3 }]);
    expect(JSON.stringify(reading)).not.toMatch(/%|percent/);
    expect(bankLabel("Screening", reading)).toBe("Screening intelligence, Gaps, 2 subscribed agents, 2 objects, 3 fields");
  });

  it("AC3: a selected agent reads its own cell; unsubscribed is neutral", () => {
    expect(readBank(matrix, product.id, product, "a2")).toMatchObject({ status: "gaps", gaps: ["ScreeningHit.b"], counts: [{ value: 5 }, { value: 4 }] });
    expect(readBank(matrix, product.id, product, "a3").status).toBe("not_subscribed");
    expect(rollUp([])).toBe("not_subscribed");
    expect(rollUp([cell("a1", "ready"), cell("a4", "unavailable")])).toBe("unavailable");
  });

  it("AC4: arrow keys move across the grid and between bays", () => {
    const bays = BAYS;
    expect(moveInGrid(bays, { bay: 0, bank: 3 }, "ArrowRight")).toEqual({ bay: 1, bank: 0 });
    expect(moveInGrid(bays, { bay: 1, bank: 0 }, "ArrowLeft")).toEqual({ bay: 0, bank: 3 });
    expect(moveInGrid(bays, { bay: 1, bank: 4 }, "ArrowDown")).toEqual({ bay: 2, bank: 2 });
    expect(moveInGrid(bays, { bay: 0, bank: 1 }, "ArrowUp")).toEqual({ bay: 0, bank: 1 });
    expect(moveInGrid(bays, { bay: 2, bank: 1 }, "Home")).toEqual({ bay: 0, bank: 0 });
    expect(moveInGrid(bays, { bay: 0, bank: 0 }, "End")).toEqual({ bay: 2, bank: 2 });
    expect(moveInGrid(bays, { bay: 0, bank: 0 }, "Enter")).toBeNull();
  });
});
