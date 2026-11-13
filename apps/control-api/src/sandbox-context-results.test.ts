import type { ContextPack } from "@ehf/context-plane";
import { expect, it } from "vitest";
import { projectContextResults } from "./sandbox-context-results.js";

it("shows the recorded synthetic company result and leaves private values out", () => {
  const pack = {
    budget: { droppedSectionIds: ["dropped"] },
    sections: [
      { id: "party", kind: "case", value: [{
        synthetic: true, object_type: "Party", data: {
          role: "customer", customer_type: "private_company",
          profile: { legal_name: "Example Fabrication Ltd", employees: 34, business_purpose: "private-free-text" },
        },
      }] },
      { id: "quarantined", quarantined: true, value: [{ employees: 987 }] },
      { id: "dropped", value: [{ employees: 654 }] },
    ],
  } as unknown as ContextPack;
  const output = { computation: { business_status: "COMPLETED", payload: {
    profiles: [{ legal_name: "Example Fabrication Ltd", employees: 34, role: "customer", entity_id: "private-id" }],
    findings: [{ legal_name: "Unverified free text", status: "hidden-token" }],
  } } };
  const projected = projectContextResults(pack, output, "COMPLETED");
  expect(projected.context.map(section => section.id)).toEqual(["party"]);
  expect(projected.outcome?.groups[0]).toMatchObject({
    label: "Profiles", count: 1, fields: expect.arrayContaining([
      { label: "Role", value: "customer" }, { label: "Employees", value: 34 }, { label: "Legal name", value: "Example Fabrication Ltd" },
    ]),
  });
  expect(projected.outcome?.status).toBe("COMPLETED");
  expect(JSON.stringify(projected)).not.toMatch(/private-free-text|private-id|hidden-token|Unverified free text|quarantined|dropped/);
  expect(projectContextResults(null, output, "COMPLETED").outcome?.groups[0]?.fields)
    .not.toContainEqual({ label: "Legal name", value: "Example Fabrication Ltd" });
});
