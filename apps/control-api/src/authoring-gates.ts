import { parse } from "yaml";
import { compileBusinessPolicy, isBusinessPolicyFiles } from "@ehf/policy-engine";

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const NON_DECIDED = ["NEEDS_EVIDENCE", "NEEDS_HUMAN", "NOT_APPLICABLE", "UNRESOLVED"] as const;

/** What a business-policy gate needs beyond its policy and gate ids, and where its other outcomes go. */
export type BusinessGateTemplate = {
  config: Obj;
  contextSelectorIds: string[];
  /** Outcomes that do not continue, and the node they route to (a workflow's existing stop). */
  stops: { outcomes: string[]; target: string } | null;
};

/** The gates a business policy in the draft defines, by policy id: authored gates and its diligence gate. */
export function businessPolicyGates(sourceFiles: Record<string, string> | undefined) {
  const policies: Array<{ path: string; policyId: string; source: Obj; gates: Array<{ gateId: string; inputProfile: string; diligence: boolean }> }> = [];
  for (const [path, text] of Object.entries(sourceFiles ?? {})) {
    if (!/\.ya?ml$/.test(path)) continue;
    let raw: unknown;
    try { raw = parse(text); } catch { continue; }
    if (!object(raw) || raw.kind !== "BusinessPolicy" || !object(raw.metadata) || typeof raw.metadata.id !== "string") continue;
    const gates = Object.entries(object(raw.gates) ? raw.gates : {}).map(([gateId, gate]) => ({ gateId, inputProfile: String((gate as Obj).inputProfile ?? ""), diligence: false }));
    if (object(raw.diligence)) gates.push({ gateId: String(raw.diligence.gateId ?? "diligence-level"), inputProfile: String(raw.diligence.inputProfile ?? ""), diligence: true });
    policies.push({ path, policyId: raw.metadata.id, source: raw, gates });
  }
  return policies;
}

/**
 * Complete a policy gate an author places in a process. For a business policy the gate must
 * evaluate as `business-v2` with the policy's input profile, the relationship that scopes it and
 * the policy sets it may use; it continues on DECIDED and every other outcome goes where the
 * process's existing gates send theirs. Returns null for a policy that is not a business policy.
 */
export function businessGateTemplate(input: {
  sourceFiles: Record<string, string> | undefined; packageDocument: Obj; workflowNodes: Obj[]; workflowEdges: Obj[];
  gate: { policyRef: string; gateId: string };
}): BusinessGateTemplate | null {
  const policy = businessPolicyGates(input.sourceFiles).find((entry) => entry.policyId === input.gate.policyRef);
  if (!policy) return null;
  const gate = policy.gates.find((entry) => entry.gateId === input.gate.gateId);
  if (!gate) throw new Error("authoring.gate_unknown");
  if (!isBusinessPolicyFiles({ "policy.yaml": input.sourceFiles![policy.path]! })) return null;
  const compiled = compileBusinessPolicy(input.sourceFiles![policy.path]!, { opaVersion: "1.9.0" });
  const sibling = input.workflowNodes.find((node) => node.kind === "gate" && object(node.config) && node.config.businessDecision === "v2" && node.config.policyRef === input.gate.policyRef);
  const selectors = Array.isArray(input.packageDocument.contextSelectors) ? input.packageDocument.contextSelectors.filter(object) : [];
  const scopeSelectorId = object(sibling?.config) && typeof sibling.config.scopeSelectorId === "string" ? sibling.config.scopeSelectorId
    : selectors.find((selector) => selector.path === "records.BankingRelationship")?.id;
  if (typeof scopeSelectorId !== "string") throw new Error("authoring.gate_scope_selector_missing");
  const contextSelectorIds = Array.isArray(sibling?.contextSelectorIds) ? sibling.contextSelectorIds.map(String) : [scopeSelectorId];
  const stopTarget = sibling ? input.workflowEdges.find((edge) => edge.from === sibling.id && edge.outcome === "UNRESOLVED")?.to : undefined;
  const allowed = compiled.manifest.gates.find((entry) => entry.gateId === gate.gateId)?.allowedOutcomes ?? [];
  return {
    config: { businessDecision: "v2", inputProfile: gate.inputProfile, scopeSelectorId, gateId: gate.gateId, policyRef: input.gate.policyRef,
      effectivePolicySetDigests: compiled.policySets.map((set) => set.setDigest) },
    contextSelectorIds: [...new Set([...contextSelectorIds, scopeSelectorId])],
    stops: typeof stopTarget === "string" ? { outcomes: NON_DECIDED.filter((outcome) => (allowed as readonly string[]).includes(outcome)), target: stopTarget } : null,
  };
}
