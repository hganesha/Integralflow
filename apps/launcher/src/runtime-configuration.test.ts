import { beforeEach, expect, it, vi } from "vitest";
import { defaultDeploymentProfile } from "@ehf/contracts/deployment";

const state = vi.hoisted(() => ({ queries: [] as string[], privileged: false }));
vi.mock("pg", () => ({ default: {
  Pool: class {},
  escapeIdentifier: (value: string) => `"${value}"`,
  Client: class {
    async connect() {}
    async end() {}
    async query(sql: string) {
      state.queries.push(sql);
      if (sql.startsWith("select rolsuper")) return { rowCount: 1, rows: [{ rolsuper: state.privileged, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false }] };
      if (sql.startsWith("select quote_literal")) return { rows: [{ value: "'test-password'" }] };
      // Azure rejects ALTER of these attributes even when repeating false values.
      if (sql.startsWith("alter role") && /nosuperuser|nobypassrls|nocreatedb|nocreaterole/.test(sql)) throw new Error("permission denied to alter role");
      return { rows: [] };
    }
  },
} }));
import { provisionRuntimeLogins, SERVICE_DATABASE_GRANTS } from "./runtime-configuration.js";

const profile = defaultDeploymentProfile({ provider: "azure", scopeId: "test", region: "centralus", recipe: "azure-container-apps-bootstrap-v1" });
const targets = [{ store: "control" as const, database: "control", connectionString: "postgresql://operator@db/control" }];
const logins = Object.fromEntries(Object.keys(SERVICE_DATABASE_GRANTS).map((service, index) => [service, { login: `if_${profile.environmentId.replaceAll("-", "_")}_${index}_test`, password: String(index).repeat(64) }]));
beforeEach(() => { state.queries = []; state.privileged = false; });

it("rotates existing restricted logins on managed PostgreSQL without altering privilege attributes", async () => {
  await provisionRuntimeLogins(targets, logins, profile);
  expect(state.queries.filter(sql => sql.startsWith("alter role"))).toHaveLength(5);
  expect(state.queries).toContain("commit");
});

it("refuses a privileged existing login before any password or grant changes", async () => {
  state.privileged = true;
  await expect(provisionRuntimeLogins(targets, logins, profile)).rejects.toThrow("database.existing_login_privileged");
  expect(state.queries.some(sql => sql.startsWith("alter role") || sql.startsWith("grant "))).toBe(false);
  expect(state.queries).toContain("rollback");
});
