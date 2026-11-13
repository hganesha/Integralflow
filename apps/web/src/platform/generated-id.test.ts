import { expect, it } from "vitest";
import { generatedId } from "./generated-id";

it("creates valid connection and node identities from numeric, accented and non-Latin display names", () => {
  for (const name of ["360° Customer data", "Évidence / résumé", "審査", "", "a".repeat(200)]) {
    const id = generatedId(name, "abc12345", "", 64);
    expect(id).toMatch(/^[a-z][a-z0-9-]{1,63}$/);
    expect(id.endsWith("-abc12345")).toBe(true);
  }
});

it("retains uniqueness and version suffixes when long display names reach contract limits", () => {
  const name = "Document review ".repeat(20);
  const first = generatedId(name, "abc12345", "document.", 100);
  const second = generatedId(name, "def67890", "document.", 100);
  expect(first.length).toBeLessThanOrEqual(100);
  expect(first).not.toBe(second);
  expect(first.endsWith("-abc12345")).toBe(true);
  expect(second.endsWith("-def67890")).toBe(true);
  const agent = generatedId(name, "abc12345", "agent.", 100, ".v1");
  expect(agent.length).toBeLessThanOrEqual(100);
  expect(agent.endsWith("-abc12345.v1")).toBe(true);
});
