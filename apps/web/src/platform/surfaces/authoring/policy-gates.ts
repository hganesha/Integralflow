import { parse } from "yaml";
import { isRec } from "./model";

/** A gate an author can place: an authored gate of a business policy, or its diligence gate. */
export type PolicyGateOption = { gateId: string; label: string; diligence: boolean };

const sentence = (id: string) => id.replace(/[-_]+/g, " ").replace(/^./, (first) => first.toUpperCase());

/** The gates the draft's policy source defines for `policyRef`, or null when the source is not a business policy. */
export function policyGateOptions(sourceFiles: Record<string, string> | undefined, policyRef: string): PolicyGateOption[] | null {
  for (const [path, text] of Object.entries(sourceFiles ?? {})) {
    if (!/\.ya?ml$/.test(path)) continue;
    let raw: unknown;
    try { raw = parse(text); } catch { continue; }
    if (!isRec(raw) || raw.kind !== "BusinessPolicy" || !isRec(raw.metadata) || raw.metadata.id !== policyRef) continue;
    const gates = Object.keys(isRec(raw.gates) ? raw.gates : {}).map((gateId) => ({ gateId, label: sentence(gateId), diligence: false }));
    if (isRec(raw.diligence)) gates.push({ gateId: String(raw.diligence.gateId ?? "diligence-level"), label: "Diligence level (SDD, CDD or EDD)", diligence: true });
    return gates;
  }
  return null;
}

/** Skill steps that read a diligence gate's level through a parameter binding. */
export function diligenceReaders(workflow: Record<string, unknown>, gateNodeId: string): Array<{ nodeId: string; name: string; target: string }> {
  const spec = isRec(workflow.spec) ? workflow.spec : {};
  const nodes = Array.isArray(spec.nodes) ? spec.nodes.filter(isRec) : [];
  const source = `${gateNodeId}.result.outputs.diligence.level`;
  return nodes.flatMap((node) => {
    const bindings = isRec(node.config) && isRec(node.config.skillParameterBindings) ? node.config.skillParameterBindings : {};
    return Object.entries(bindings).filter(([, value]) => value === source)
      .map(([target]) => ({ nodeId: String(node.id), name: String(node.name ?? node.id), target }));
  });
}
