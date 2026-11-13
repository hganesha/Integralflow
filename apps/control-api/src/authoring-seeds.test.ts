import { parse } from "yaml";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@ehf/persistence";
import { seedAuthoringDrafts } from "./authoring-seeds.js";
import { loadAuthoringTemplates } from "./authoring-templates.js";

const domains = resolve(import.meta.dirname, "../../../domains");
function database() {
  const rows = new Map<string, unknown[]>();
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (!sql.includes("with seeded")) return { rows: [], rowCount: 0 };
    const id = String(values![0]);
    if (rows.has(id)) return { rows: [], rowCount: 0 };
    rows.set(id, values!);
    return { rows: [{ draft_id: id }], rowCount: 1 };
  });
  const release = vi.fn();
  const db = { connect: vi.fn(async () => ({ query, release })) } as unknown as Database;
  return { db, query, release, rows };
}

// Seeding analyzes the five real starter packages (about 350 KB of YAML each) before any write: about
// one second per seed alone, several under a parallel workspace run, so the seeding tests get room.
const SEEDING_TIMEOUT = 30_000;

describe("deployment starter processes", () => {
  it("loads real agentic workflows with their policy compile dependencies", async () => {
    const templates = (await loadAuthoringTemplates(domains)).filter(t => t.id.endsWith("agentic"));
    expect(templates.map(t => t.id)).toEqual(["kyc-agentic", "kyb-agentic", "kyc-edd-agentic", "kyb-edd-agentic", "kyb-sdd-agentic", "securities-agentic"]);
    for (const template of templates) {
      expect(template.sourceFiles["policy.yaml"]).toContain("kind: BusinessPolicy");
      const nodes = parse(template.workflowSource).spec.nodes;
      // Individuals have no ownership agent; simplified due diligence exempts it for an eligible entity.
      expect(nodes.filter((node: { kind: string }) => node.kind === "agent")).toHaveLength(template.id.startsWith("kyc") || template.id === "kyb-sdd-agentic" ? 9 : 10);
      // Three pack checkpoints and the diligence gate.
      expect(nodes.filter((node: { kind: string }) => node.kind === "gate").map((node: { id: string }) => node.id).sort()).toEqual(["diligence-level", "pack-decision-ready", "pack-disposition", "pack-intake-ready"]);
      expect(template.packageSource).toContain("agentProfiles:");
    }
  });

  it("creates tenant-scoped drafts once and preserves edits and lifecycle on retries", async () => {
    const { db, query, release, rows } = database();
    const starters = ["kyc-agentic", "kyb-agentic", "kyc-edd-agentic", "kyb-edd-agentic", "kyb-sdd-agentic"];
    expect((await seedAuthoringDrafts(db, "tenant_a", domains)).created).toEqual(starters);
    const first = [...rows.values()][0]!;
    expect(first[1]).toBe("tenant_a");
    expect(JSON.parse(String(first[10]))["policy.yaml"]).toContain("kind: BusinessPolicy");
    first[5] = "operator's edited source";
    expect((await seedAuthoringDrafts(db, "tenant_a", domains)).created).toEqual([]);
    expect([...rows.values()][0]![5]).toBe("operator's edited source");
    expect((await seedAuthoringDrafts(db, "tenant_b", domains)).created).toHaveLength(starters.length);
    expect(rows.size).toBe(2 * starters.length);
    const sql = query.mock.calls.find(([sql]) => sql.includes("with seeded"))![0];
    expect(sql).toContain("'DRAFT'");
    expect(sql).toContain("on conflict (draft_id) do nothing");
    expect(sql).not.toContain("do update");
    expect(release).toHaveBeenCalledTimes(3);
  }, SEEDING_TIMEOUT);

  it("rolls back and releases the connection if a database write fails", async () => {
    const { db, query, release } = database();
    query.mockRejectedValueOnce(new Error("unavailable"));
    await expect(seedAuthoringDrafts(db, "tenant_a", domains)).rejects.toThrow("unavailable");
    expect(query).toHaveBeenLastCalledWith("rollback");
    expect(release).toHaveBeenCalledOnce();
  }, SEEDING_TIMEOUT);

  it("requires an explicit tenant", async () => {
    const { db } = database();
    await expect(seedAuthoringDrafts(db, "", domains)).rejects.toThrow("authoring.seed_tenant_required");
    expect(db.connect).not.toHaveBeenCalled();
  });
});
