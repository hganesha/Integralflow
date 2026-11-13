import { readFileSync } from "node:fs";
import { azureManagedIdentityToken, decideSystem1, parseSystem1Bindings, resolveSystem1Binding, type System1BindingConfig } from "@ehf/adapters";
import { system1DecisionRequestSchema } from "@ehf/contracts/intelligence-adapters";
import type { CapabilityAdapterModule } from "./types.js";

/** The capability a question set's bindings serve: `document.advisory.v1` → `decision.document.advisory.v1`. */
export const decisionCapabilityId = (questionSet: string) => `decision.${questionSet}`;
export const DECISION_BINDINGS_PATH_ENV = "DECISION_BINDINGS_PATH";

function loadBindings(env: NodeJS.ProcessEnv): System1BindingConfig[] {
  return parseSystem1Bindings(JSON.parse(readFileSync(env[DECISION_BINDINGS_PATH_ENV] ?? "config/decision-bindings.json", "utf8")));
}

/**
 * System 1 decision bindings (`decisions:<binding id>`, `decision.system1.v1`; document factory plan §6.6).
 * Each binding pins its adapter, model and returned model revision; switching provider means a different
 * connector in the compiled plan. The result is the canonical System 1 batch result, answered or abstained
 * with a reason. An answer is advice for review and never an action; this adapter cannot write anything.
 * Off by default (`GATEWAY_ADAPTERS=default,decisions`), so the alpha Decisions API stays removable.
 */
export const decisionsModule: CapabilityAdapterModule = {
  id: "decisions",
  cloud: "any",
  label: "System 1 decisions",
  supportedKinds: ["model"],
  enabledByDefault: false,
  connectorTemplate: {
    bindingPattern: /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    capabilityIds: ["decision.document.advisory.v1"],
    configEnv: ["DECISION_BINDINGS_PATH", "OPENROUTER_API_KEY", "DECISION_FOUNDRY_ENDPOINT", "DECISION_FOUNDRY_AUTH"],
    description: "A pinned System 1 decision binding from config/decision-bindings.json (decisions:<binding id>): OpenRouter Decisions or an Azure AI Foundry deployment; answers only add review.",
  },
  create: ({ env, fetch }) => {
    const bindings = () => new Map(loadBindings(env).map(binding => [binding.id, binding]));
    const identity = (scope: string) => azureManagedIdentityToken(env, fetch, scope);
    const binding = (name: string) => {
      const found = bindings().get(name);
      if (!found) throw new Error("gateway.decision_binding_unknown");
      return found;
    };
    return {
      descriptor: async () => {
        const all = [...bindings().values()];
        const configured = all.filter(item => !("missing" in resolveSystem1Binding(item, env, identity)));
        return {
          id: "decisions", label: "System 1 decisions", supportedKinds: ["model"],
          credentialState: configured.length ? "Configured" : "Missing",
          bindingOptions: all.map(item => ({ value: item.id, label: item.id, description: item.description })),
        };
      },
      acceptsBinding: (name) => bindings().has(name),
      assertCapability: (capability, name) => {
        if (capability.id !== decisionCapabilityId(binding(name).questionSet)) throw new Error("gateway.decision_binding_capability_mismatch");
      },
      invoke: async (name, capability, input) => {
        const config = binding(name);
        if (capability.id !== decisionCapabilityId(config.questionSet)) throw new Error("gateway.decision_binding_capability_mismatch");
        const parsed = system1DecisionRequestSchema.safeParse(input && typeof input === "object" && "input" in input ? (input as { input: unknown }).input : input);
        if (!parsed.success) throw new Error("adapter.input_invalid");
        const resolved = resolveSystem1Binding(config, env, identity);
        if ("missing" in resolved) throw new Error("gateway.decision_binding_not_configured");
        const result = await decideSystem1({ binding: resolved.binding, auth: resolved.auth, request: parsed.data, fetch });
        return {
          output: { ...result, binding: config.id, questionSet: config.questionSet, returnedModel: config.returnedModel, deploymentType: config.deploymentType ?? null },
          provider: config.adapter, model: result.actualModel ?? config.model, providerRequestId: result.telemetry.requestId,
          inputTokens: result.telemetry.inputTokens, outputTokens: result.telemetry.outputTokens, costUsd: result.telemetry.costUsd,
        };
      },
    };
  },
};
