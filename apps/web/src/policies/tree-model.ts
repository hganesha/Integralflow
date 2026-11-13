import { parseDocument } from "yaml";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const display = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value) ?? "Not declared";
const pointer = (part: string | number) => String(part).replaceAll("~", "~0").replaceAll("/", "~1");
export type PolicyTreeKind = "policy" | "gate" | "rule" | "all" | "any" | "condition" | "outcome" | "reference";
export type PolicyTreeNode = { id: string; kind: PolicyTreeKind; title: string; description: string; sourcePath: string; raw: unknown; children: Array<{ label: string; node: PolicyTreeNode }> };
export type PolicyBranch = { id: string; label: string; description: string; node: PolicyTreeNode };
export type PolicyTreeDocument = { path: string; id: string; title: string; description: string; hitPolicy: string | null; branches: PolicyBranch[]; raw: ObjectValue };
export type PolicyTreeModel = { documents: PolicyTreeDocument[]; errors: Array<{ path: string; message: string }> };

/** A source projection only. Matching, evaluation and compilation stay on the server. */
export function policyTreeModel(sources: Record<string, unknown>): PolicyTreeModel {
  const model: PolicyTreeModel = { documents: [], errors: [] };
  for (const [path, source] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))) {
    try {
      let value = source;
      if (typeof source === "string") {
        if (source.length > 2_000_000) throw new Error("Source is too large for the tree viewer.");
        const document = parseDocument(source, { uniqueKeys: true });
        if (document.errors.length) throw new Error(document.errors.map(error => error.message).join("; "));
        value = document.toJS({ maxAliasCount: 50 });
      }
      const raw = object(value);
      if (raw.kind !== "Policy" && raw.kind !== "DecisionTable" && raw.kind !== "BusinessPolicy") continue;
      JSON.stringify(raw); // Reject cyclic YAML aliases before passing source to the inspector.
      const metadata = object(raw.metadata), spec = object(raw.spec);
      let count = 0;
      const make = (kind: PolicyTreeKind, title: string, sourcePath: string, data: unknown, description = ""): PolicyTreeNode => {
        if (++count > 2_000) throw new Error("This policy is too large for a single tree. Open its source instead.");
        return { id: `${path}#${kind}:${sourcePath}`, kind, title, description, sourcePath, raw: data, children: [] };
      };
      const outcome = (data: unknown, at: string) => {
        const entry = object(data);
        const result = typeof data === "string" ? data : string(entry.result, string(entry.outcome, string(entry.state)));
        const reasons = list(entry.reasonCodes).filter((code): code is string => typeof code === "string").join(", ");
        return make("outcome", result || "Declared outcome", at, data, string(entry.reasonCode, reasons));
      };
      const expression = (data: unknown, at: string, depth = 0): PolicyTreeNode => {
        if (depth > 32) throw new Error("The assertion tree exceeds 32 levels. Open its source instead.");
        const entry = object(data);
        for (const operator of ["all", "any"] as const) if (Array.isArray(entry[operator])) {
          const group = make(operator, operator === "all" ? "All conditions" : "Any condition", at, data);
          group.children = list(entry[operator]).map((child, index) => ({ label: String(index + 1), node: expression(child, `${at}/${operator}/${index}`, depth + 1) }));
          return group;
        }
        return make("condition", [string(entry.path), string(entry.operator, string(entry.op)), "value" in entry ? display(entry.value) : "valueFrom" in entry ? display(entry.valueFrom) : ""].filter(Boolean).join(" ") || "Source expression", at, data, string(entry.description));
      };
      const branches: PolicyBranch[] = [];
      if (raw.kind === "DecisionTable") {
        const definitions = list(spec.conditions).map(object);
        list(spec.rows).forEach((data, index) => {
          const row = object(data), at = `/spec/rows/${index}`;
          const branch = make("rule", string(row.id, `Row ${index + 1}`), at, data, string(row.description));
          const when = object(row.when), group = make("all", "All row conditions", `${at}/when`, row.when);
          group.children = Object.entries(when).map(([key, token]) => {
            const definition = definitions.find(condition => condition.id === key);
            const condition = make("condition", `${key} = ${display(token)}`, `${at}/when/${pointer(key)}`, { token, ...(definition ? { definition } : {}) }, string(definition?.description));
            return { label: key, node: condition };
          });
          branch.children.push({ label: "When", node: group }, { label: "Then", node: outcome(row, at) });
          branches.push({ id: at, label: `${index + 1}. ${branch.title}`, description: display(row.outcome), node: branch });
        });
        if (spec.default !== undefined) {
          const node = outcome(spec.default, "/spec/default");
          branches.push({ id: node.sourcePath, label: "Default", description: node.title, node });
        }
      } else {
        const business = raw.kind === "BusinessPolicy";
        for (const [gateId, data] of Object.entries(object(business ? raw.gates : spec.gates))) {
          const gate = object(data), at = `${business ? "" : "/spec"}/gates/${pointer(gateId)}`;
          const node = make("gate", gateId, at, data, string(gate.description));
          if (typeof gate.table === "string") node.children.push({ label: "Decision table", node: make("reference", gate.table, `${at}/table`, gate.table) });
          for (const key of ["preconditions", "requirements", "rules"] as const) list(gate[key]).forEach((data, index) => {
            const rule = object(data), ruleAt = `${at}/${key}/${index}`;
            const item = make("rule", string(rule.id, `${key} ${index + 1}`), ruleAt, data, string(rule.description));
            for (const condition of ["assert", "when", "require"] as const) if (rule[condition] !== undefined) item.children.push({ label: condition === "assert" ? "Assert" : condition === "when" ? "When" : "Required after match", node: expression(rule[condition], `${ruleAt}/${condition}`) });
            for (const result of ["onFailure", "outcome", "result", "onRequirementFailure"] as const) if (rule[result] !== undefined) item.children.push({ label: result === "outcome" || result === "result" ? "Then" : result === "onFailure" ? "On failure" : "On unmet requirement", node: outcome(rule[result], `${ruleAt}/${result}`) });
            node.children.push({ label: key === "rules" ? `Rule ${index + 1}${rule.priority !== undefined ? ` · priority ${display(rule.priority)}` : ""}` : `Requirement ${index + 1}`, node: item });
          });
          for (const result of ["onPass", "otherwise"] as const) if (gate[result] !== undefined) node.children.push({ label: result === "onPass" ? "On pass" : "Otherwise", node: outcome(gate[result], `${at}/${result}`) });
          branches.push({ id: at, label: gateId, description: string(gate.description), node });
        }
      }
      model.documents.push({ path, id: string(metadata.id, path), title: string(metadata.name, string(metadata.id, path)), description: string(metadata.description), hitPolicy: raw.kind === "DecisionTable" ? string(spec.hitPolicy, "Not declared") : raw.kind === "BusinessPolicy" ? "first" : null, branches, raw });
    } catch (error) {
      model.errors.push({ path, message: error instanceof Error ? error.message : "Source could not be read." });
    }
  }
  model.documents.sort((a, b) => Number(b.raw.kind !== "DecisionTable") - Number(a.raw.kind !== "DecisionTable") || a.path.localeCompare(b.path));
  return model;
}

export function policyTreeNodes(root: PolicyTreeNode): PolicyTreeNode[] {
  return [root, ...root.children.flatMap(child => policyTreeNodes(child.node))];
}
