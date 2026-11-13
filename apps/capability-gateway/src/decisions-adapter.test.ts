import { describe, expect, it } from "vitest";
import { decisionsModule } from "./adapters/decisions.js";

const deps = (env: NodeJS.ProcessEnv, fetch: typeof globalThis.fetch) =>
  decisionsModule.create({ env, fetch, db: {} as never, modelProfilesPath: "", workloadToken: (() => { throw new Error("unused"); }) as never, delegate: (() => { throw new Error("unused"); }) as never });
const capability = { id: "decision.document.advisory.v1" } as never;
const request = { state: { left: "ACME HOLDINGS LIMITED", right: "Acme Holdings Ltd" },
  questions: { same_value: { type: "choice", instructions: "Same entity?", criteria: { same: "Same", different: "Different", cannot_tell: "Not decidable" } } } };
const env = { DECISION_BINDINGS_PATH: new URL("../../../config/decision-bindings.json", import.meta.url).pathname };

describe("System 1 decisions adapter", () => {
  it("is off by default and reports missing credentials until configured", async () => {
    expect(decisionsModule.enabledByDefault).toBe(false);
    const adapter = deps(env, globalThis.fetch);
    expect((await adapter.descriptor("t")).credentialState).toBe("Missing");
    expect(adapter.acceptsBinding!("document.advisory.jev")).toBe(true);
    expect(adapter.acceptsBinding!("document.advisory.other")).toBe(false);
    expect(() => adapter.assertCapability!({ id: "model.general.inference.v1" } as never, "document.advisory.jev")).toThrow("gateway.decision_binding_capability_mismatch");
    await expect(adapter.invoke("document.advisory.foundry_openai", capability, request, { tenantId: "t" })).rejects.toThrow("gateway.decision_binding_not_configured");
  });

  it("answers through the pinned binding and returns the canonical result with its pins", async () => {
    const fetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      return new Response(JSON.stringify({ id: "gen-dec-1", model: "typesafe/jev-1.13-20260917", provider: "TypeSafe", usage: { input_tokens: 10, output_tokens: 2, cost: 0.00001 },
        answers: { same_value: { type: "choice", choice: "same", probabilities: { same: 0.99, different: 0, cannot_tell: 0.01 }, confidence: 0.98 } } }));
    }) as unknown as typeof globalThis.fetch;
    const result = await deps({ ...env, OPENROUTER_API_KEY: "test-key" }, fetch).invoke("document.advisory.jev", capability, request, { tenantId: "t" });
    expect(result).toMatchObject({ provider: "openrouter_decisions", model: "typesafe/jev-1.13-20260917", providerRequestId: "gen-dec-1", costUsd: 0.00001,
      output: { status: "answered", binding: "document.advisory.jev", questionSet: "document.advisory.v1", answers: { same_value: { status: "answered", answer: { value: "same" } } } } });
    await expect(deps({ ...env, OPENROUTER_API_KEY: "k" }, fetch).invoke("document.advisory.jev", capability, { state: {} }, { tenantId: "t" })).rejects.toThrow("adapter.input_invalid");
  });
});
