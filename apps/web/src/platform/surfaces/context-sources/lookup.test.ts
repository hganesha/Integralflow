import { expect, it } from "vitest";
import { applyLookupFilter } from "./lookup";

it("adds or replaces only the selected lookup filter and preserves projection and other filters", () => {
  const query =
    "SELECT id, name, observed_at FROM dbo.customers WHERE region = :region";
  expect(applyLookupFilter(query, "customer_key", "customer_id")).toBe(
    query + " AND customer_key = :customer_id",
  );
  expect(
    applyLookupFilter(
      query + " AND old_key = :customer_id",
      "customer_key",
      "customer_id",
    ),
  ).toBe(query + " AND customer_key = :customer_id");
  expect(
    applyLookupFilter("SELECT * FROM customers", "customer_key", "customer_id"),
  ).toBe("SELECT * FROM customers WHERE customer_key = :customer_id");
});
it("refuses to rewrite unsupported or ambiguous queries and refuses untrusted identifiers", () => {
  for (const query of [
    "SELECT fn(id) FROM customers",
    "SELECT id AS alias FROM customers",
    "SELECT id name FROM customers",
    "SELECT * FROM customers; DELETE FROM customers",
    "SELECT * FROM customers WHERE id = :id OR name = :name",
    "SELECT * FROM customers WHERE id = :id AND alias = :id",
    "SELECT * FROM customers WHERE id = :id -- comment",
  ])
    expect(() => applyLookupFilter(query, "customer_key", "id")).toThrow();
  expect(() =>
    applyLookupFilter("SELECT * FROM customers", "id; DELETE", "customer_id"),
  ).toThrow();
});
