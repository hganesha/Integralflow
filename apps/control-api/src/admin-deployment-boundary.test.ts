import { describe, expect, it, vi } from "vitest";
import type { Database } from "@ehf/persistence";
import { writeModelProfile, writeProvider, writeSettingSection } from "./admin-config.js";

describe("production immutable administration boundary", () => {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const deps = { env: { SECURITY_PROFILE: "production" }, db: { query } as unknown as Database };
  const input = { tenantId: "env", actor: { subjectId: "admin", roles: ["Platform.Admin"] } };
  it.each(["runtime", "observability"])("rejects mutable %s infrastructure without writing", async (section) => {
    query.mockClear();
    await expect(writeSettingSection(deps, { ...input, section, body: { value: {}, reason: "attempted change" } })).rejects.toThrow("immutable_infrastructure_requires_deployment");
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects provider credentials and new model bindings instead of granting deployment authority", async () => {
    await expect(writeProvider(deps, { ...input, providerId: "other", body: { provider: { credentialRef: "SECRET" } } })).rejects.toThrow("immutable_provider_binding_requires_deployment");
    await expect(writeModelProfile(deps, { ...input, profileId: "other", body: { profile: { provider: "other", model: "other" } } })).rejects.toThrow("model_deployment_change_requires_deployment");
  });
  it("rejects recorded fallbacks and requires a reason for permitted operational writes", async () => {
    await expect(writeSettingSection(deps, { ...input, section: "gateway", body: { value: { recordedFallback: "allow" }, reason: "allow test" } })).rejects.toThrow("recorded_fallback_forbidden_in_production");
    await expect(writeSettingSection(deps, { ...input, section: "database", body: { value: { poolMax: 8 } } })).rejects.toThrow("change_reason_required");
  });
});
