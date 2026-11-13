import { parseDocument } from "yaml";
import { roleName } from "./roles";

/**
 * A plain-language projection of the policy sources for policy owners. Like the tree model,
 * it only reads sources: matching, evaluation and compilation stay on the server.
 */

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;

/** A condition as a sentence, with nested groups kept as children. */
export type Clause = { text: string; children: Clause[] };
export type RuleEntry = { id: string; when: Clause; then: string; reasonCodes: string[]; sourcePath: string };
export type RuleSection = {
  id: string;
  title: string;
  description: string;
  path: string;
  /** How the rules combine, in words. */
  order: string;
  rules: RuleEntry[];
  otherwise: { then: string; reasonCodes: string[] } | null;
};

export type ContentField = { field: string; label: string; resolved: boolean; owner: string; note: string };
export type PolicySetSummary = {
  id: string;
  label: string;
  status: string;
  jurisdiction: string;
  institution: string;
  products: string[];
  customerTypes: string[];
  purposes: string[];
  settings: Array<{ key: string; label: string; value: string }>;
  content: ContentField[];
  /** The pack's diligence controls for this set. */
  diligence: { mandatoryOverlays: string[]; sddPermitted: boolean; floors: Record<string, string> };
};

export type DiligenceOverlaySummary = {
  id: string; label: string; description: string; enabled: boolean; effect: string; when: Clause;
  /** Sample facts that make the overlay's condition hold, or null when they cannot be derived. */
  witness: Array<{ path: string; value: unknown }> | null;
  requires: string[];
  /** Where the overlay applies, in words, or null when it applies everywhere. */
  scope: string | null;
  /** The products or taxonomy nodes the overlay is scoped to; empty when it applies to every product. */
  scopeProducts: string[];
  /** Evidence obligations the rule adds when it fires. */
  addRequirements: string[];
  /** The approval the rule requires when it fires, enforced at disposition. */
  approval: { role: string; quorum: number; reason: string } | null;
  /** The whole rule as one sentence: when, where, and what it does. */
  sentence: string;
};
/** Platform roles that decide human work, as the approval picker offers them (identity HUMAN_ROLES). */
export { APPROVAL_ROLES, requirementText, roleName } from "./roles";

function approvalOf(effect: Record<string, unknown>): DiligenceOverlaySummary["approval"] {
  const approval = object(effect.requireApproval);
  return typeof approval.role === "string" ? { role: approval.role, quorum: typeof approval.quorum === "number" ? approval.quorum : 1, reason: text(approval.reason) } : null;
}

/** "Escalate to EDD · adds 2 requirements · approval by 2 case reviewers". */
export function effectText(effect: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof effect.escalateTo === "string") parts.push(`Escalate to ${effect.escalateTo}`);
  else if (typeof effect.escalateBy === "number") parts.push(`Escalate by ${effect.escalateBy} level${effect.escalateBy === 1 ? "" : "s"}`);
  const added = list(effect.addRequirements).filter((item): item is string => typeof item === "string");
  if (added.length) parts.push(`Adds ${added.length} requirement${added.length === 1 ? "" : "s"}`);
  const approval = approvalOf(effect);
  if (approval) parts.push(`Approval by ${approval.quorum} ${roleName(approval.role).toLowerCase()}${approval.quorum === 1 ? "" : "s"}`);
  return parts.join(" · ") || "No effect";
}

const flatten = (clause: Clause): string => clause.children.length ? `${clause.text}: ${clause.children.map(flatten).join("; ")}` : clause.text;
const joinWords = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * A rule as one sentence a policy owner can check: "When a verified PEP relationship exists, for
 * products under PAY, raise the level to EDD, require EVD-SOURCE-OF-FUNDS and require approval by 2
 * case reviewers (Senior approval of a PEP relationship)."
 */
export function ruleSentence(raw: Record<string, unknown>, parties: Array<Record<string, unknown>> = []): string {
  const effect = object(raw.effect);
  const actions: string[] = [];
  if (typeof effect.escalateTo === "string") actions.push(`raise the level to ${effect.escalateTo}`);
  else if (typeof effect.escalateBy === "number") actions.push(`raise the level by ${effect.escalateBy} step${effect.escalateBy === 1 ? "" : "s"}`);
  const added = list(effect.addRequirements).filter((item): item is string => typeof item === "string");
  if (added.length) actions.push(`require ${joinWords(added)}`);
  const approval = approvalOf(effect);
  if (approval) actions.push(`require approval by ${approval.quorum} ${roleName(approval.role).toLowerCase()}${approval.quorum === 1 ? "" : "s"}${approval.reason ? ` (${approval.reason.replace(/\.$/, "")})` : ""}`);
  const scope = overlayScope(object(raw.appliesTo ?? {}), parties);
  const condition = flatten(predicateClause(raw.when)).replace(/^./, (first) => first.toLowerCase());
  return `When ${condition}${scope ? `, ${scope.replace(/^Only for /, "for ")}` : ""}, ${joinWords(actions) || "do nothing"}.`;
}

/** "Only for products under PAY, for Company, in GB": an overlay's `appliesTo` in words. */
function overlayScope(to: Record<string, unknown>, parties: Array<Record<string, unknown>>): string | null {
  const strings = (value: unknown) => list(value).filter((item): item is string => typeof item === "string");
  const parts: string[] = [];
  const products = strings(to.products);
  const partyTypes = strings(to.partyTypes);
  const jurisdictions = strings(to.jurisdictions);
  if (products.length) parts.push(`products under ${products.join(", ")}`);
  if (partyTypes.length) parts.push(`${partyTypes.map((id) => text(parties.find((party) => party.id === id)?.label, humanize(id))).join(", ")}`);
  if (jurisdictions.length) parts.push(`in ${jurisdictions.join(", ")}`);
  return parts.length ? `Only for ${parts.join("; ")}` : null;
}

export type DiligenceSummary = {
  gateId: string; inputProfile: string; levels: string[]; simplifiedLevel: string | null;
  partyTypes: Array<{ id: string; label: string; customerType: string; legalForms: string[] }>;
  products: string[];
  matrix: Record<string, Record<string, string>>;
  overlays: DiligenceOverlaySummary[];
  requirements: Record<string, string[]>;
};

export type Rulebook = {
  kind: "business" | "archived" | "none";
  title: string;
  version: string;
  owner: string;
  sections: RuleSection[];
  policySets: PolicySetSummary[];
  diligence: DiligenceSummary | null;
  errors: Array<{ path: string; message: string }>;
};

const ACRONYMS = new Set(["pep", "edd", "cdd", "sdd", "kyc", "kyb", "tin", "id", "ubo", "ofac", "uk", "us", "gb", "qa"]);

/** "policyRecordFinding" or "required_screening_lists" → "policy record finding" / "required screening lists". */
export function humanize(value: string): string {
  const words = value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase());
  return words.join(" ");
}

export const sentenceCase = (value: string) => value ? value[0]!.toUpperCase() + value.slice(1) : value;

/** "/facts/selected/risk/jurisdictionRisk" → "jurisdiction risk"; row-relative paths read as "its …". */
export function describePath(path: string): string {
  if (path === "") return "the item";
  const parts = path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  const [root, ...rest] = parts;
  const named = rest.filter((part) => part !== "selected" && !/^\d+$/.test(part));
  if (root === "configuration") return `the configured ${humanize(named.join(" ") || "policy")}`.replace(/^the configured content$/, "installation policy content");
  // Selector ids name the record type they select (policyRecordPEPRelationship, policyCaseFindings, packOwnership).
  if (root === "facts" || root === "observations") return humanize((named.at(-1) ?? root).replace(/^(?:policyRecord|policyCase|pack)(?=[A-Z])/, ""));
  if (root === "subjectIds") return "the subjects";
  if (root === "scope") return `the case's ${humanize(named.join(" "))}`;
  // Canonical records keep their fields under `data`.
  return `its ${humanize((parts[0] === "data" && parts.length > 1 ? parts.slice(1) : parts).join(" "))}`;
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(describeValue).join(", ");
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "nothing";
}

function duration(seconds: unknown): string {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return `${describeValue(seconds)} seconds`;
  if (value % 86400 === 0) return `${value / 86400} day${value === 86400 ? "" : "s"}`;
  if (value % 3600 === 0) return `${value / 3600} hour${value === 3600 ? "" : "s"}`;
  return `${value} seconds`;
}

const OPERATORS: Record<string, string> = {
  eq: "is", ne: "is not", in: "is one of", contains: "includes", gt: "is more than", gte: "is at least",
  lt: "is less than", lte: "is at most",
};

/** A business-policy predicate (`harness.factory/business-policy-v2`) as a sentence. */
export function predicateClause(raw: unknown, depth = 0): Clause {
  const entry = object(raw);
  if (depth > 32) return { text: "A deeply nested condition (open the source)", children: [] };
  if (Array.isArray(entry.all)) return { text: "All of these hold", children: entry.all.map((child) => predicateClause(child, depth + 1)) };
  if (Array.isArray(entry.any)) return { text: "Any of these holds", children: entry.any.map((child) => predicateClause(child, depth + 1)) };
  for (const quantifier of ["every", "some"] as const) if (entry[quantifier] !== undefined) {
    const body = object(entry[quantifier]);
    const subject = describePath(text(body.path));
    const lead = quantifier === "every" ? `Every entry in ${subject}${body.allowEmpty ? " (if there are any)" : ""} matches` : `At least one entry in ${subject} matches`;
    return { text: lead, children: [predicateClause(body.where, depth + 1)] };
  }
  const subject = describePath(text(entry.path));
  const op = text(entry.op, text(entry.operator));
  const expected = entry.valueFrom !== undefined ? describePath(text(entry.valueFrom))
    : entry.valueFromParent !== undefined ? `the enclosing entry's ${describePath(text(object(entry.valueFromParent).path)).replace(/^its /, "")}`
    : describeValue(entry.value);
  if (op === "present") return { text: `${sentenceCase(subject)} is provided`, children: [] };
  if (op === "missing") return { text: `${sentenceCase(subject)} is missing`, children: [] };
  if (op === "count_gte") return { text: `${sentenceCase(subject)} has at least ${expected} entries`, children: [] };
  if (op === "age_lte_seconds") return { text: `${sentenceCase(subject)} is no older than ${entry.value !== undefined ? duration(entry.value) : expected}`, children: [] };
  if (OPERATORS[op]) return { text: `${sentenceCase(subject)} ${OPERATORS[op]} ${expected}`, children: [] };
  return { text: "A source expression (open the source)", children: [] };
}

const STATE_WORDS: Record<string, string> = {
  DECIDED: "Decided", NEEDS_EVIDENCE: "Needs more evidence", NEEDS_HUMAN: "Needs a person", NOT_APPLICABLE: "Not applicable",
  UNRESOLVED: "Unresolved", ALLOW: "Allow", REVIEW: "Send for review", BLOCK: "Block", ERROR: "Stop with an error", UNKNOWN: "Unknown",
};
export const stateWords = (state: string) => STATE_WORDS[state] ?? humanize(state);

/** A business decision result as a short sentence. */
export function resultSentence(raw: unknown): { then: string; reasonCodes: string[] } {
  const result = object(raw);
  const state = text(result.state, "UNRESOLVED");
  const human = object(result.humanRequirement);
  const role = text(human.role, text(human.roleId, text(human.queue)));
  const actions = list(result.actions).length;
  const parts = [stateWords(state) + (state === "NEEDS_HUMAN" && role ? `: ${humanize(role)}` : "")];
  if (actions) parts.push(`${actions} action${actions === 1 ? "" : "s"}`);
  return { then: parts.join(" · "), reasonCodes: list(result.reasonCodes).filter((code): code is string => typeof code === "string") };
}

function parseSource(source: unknown): Obj {
  if (typeof source !== "string") return object(source);
  if (source.length > 2_000_000) throw new Error("Source is too large to read here.");
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("; "));
  const value = object(document.toJS({ maxAliasCount: 50 }));
  JSON.stringify(value); // Reject cyclic aliases.
  return value;
}

function businessSections(raw: Obj, path: string): RuleSection[] {
  return Object.entries(object(raw.gates)).sort(([a], [b]) => a.localeCompare(b)).map(([gateId, data]) => {
    const gate = object(data);
    const rules = list(gate.rules).map((rule, index) => {
      const entry = object(rule);
      const result = resultSentence(entry.result);
      return { id: text(entry.id, `${gateId} rule ${index + 1}`), when: predicateClause(entry.when), then: result.then, reasonCodes: result.reasonCodes, sourcePath: `/gates/${gateId}/rules/${index}` };
    });
    const otherwise = gate.otherwise === undefined ? null : resultSentence(gate.otherwise);
    return {
      id: gateId, title: sentenceCase(humanize(gateId)), path,
      description: `Reads the ${text(gate.inputProfile, "declared")} input.`,
      order: "Rules are checked in order and the first that matches decides.",
      rules,
      otherwise,
    };
  });
}

function tableSection(raw: Obj, path: string): RuleSection {
  const metadata = object(raw.metadata), spec = object(raw.spec);
  const rules = list(spec.rows).map((row, index) => {
    const entry = object(row);
    const children = Object.entries(object(entry.when)).map(([key, token]) => {
      const label = humanize(key);
      return { text: `${sentenceCase(label)} ${Array.isArray(token) ? "is one of" : "is"} ${describeValue(token)}`, children: [] };
    });
    const when: Clause = children.length === 1 ? children[0]! : { text: children.length ? "All of these hold" : "Always", children };
    const reason = text(entry.reasonCode);
    return { id: text(entry.id, `Row ${index + 1}`), when, then: stateWords(text(entry.outcome, "UNKNOWN")), reasonCodes: reason ? [reason] : [], sourcePath: `/spec/rows/${index}` };
  });
  const fallback = object(spec.default);
  const defaultOutcome = typeof spec.default === "string" ? spec.default : text(fallback.outcome, text(fallback.result));
  const hitPolicy = text(spec.hitPolicy);
  return {
    id: text(metadata.id, path), title: sentenceCase(humanize(text(metadata.gate, text(metadata.id, path)))), path,
    description: text(metadata.description),
    order: hitPolicy === "first" ? "Rows are checked in order and the first that matches decides." : hitPolicy ? `Hit policy: ${hitPolicy}.` : "Rows follow their source order.",
    rules,
    otherwise: defaultOutcome ? { then: stateWords(defaultOutcome), reasonCodes: text(fallback.reasonCode) ? [text(fallback.reasonCode)] : [] } : null,
  };
}

function settingValue(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length) return "None";
  if (Array.isArray(value)) return value.length ? value.map((item) => typeof item === "string" ? humanize(item) : describeValue(item)).join(", ") : "None";
  if (value && typeof value === "object") return Object.entries(value).map(([key, item]) => `${humanize(key)}: ${settingValue(item)}`).join("; ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return describeValue(value);
}

function policySets(raw: Obj): PolicySetSummary[] {
  return list(raw.policySets).map(object).map((set) => {
    const scope = object(set.scope), configuration = object(set.configuration), content = object(configuration.content);
    const fields = object(content.fields);
    const required = list(content.requiredFields).filter((field): field is string => typeof field === "string");
    const names = [...new Set([...required, ...Object.keys(fields)])].sort();
    const strings = (value: unknown) => list(value).filter((item): item is string => typeof item === "string");
    const customerTypes = strings(scope.customerTypes), products = strings(scope.products);
    return {
      id: text(set.id), status: text(set.status, "CANDIDATE"),
      jurisdiction: text(scope.jurisdiction), institution: text(scope.institution), products, customerTypes, purposes: strings(scope.purposes),
      label: [text(scope.jurisdiction), humanize(customerTypes.join(" and ")), products.map(humanize).join(", ")].filter(Boolean).join(" · "),
      settings: Object.entries(configuration).filter(([key]) => key !== "content" && key !== "jurisdiction")
        .map(([key, value]) => ({ key, label: sentenceCase(humanize(key)), value: settingValue(value) })),
      content: names.map((field) => {
        const entry = object(fields[field]);
        // DERIVED content is computed from the diligence design when the policy compiles (combined with
        // its base content, such as SYNTHETIC placeholders, when it has one).
        const base = object(entry.base);
        const derivedNote = entry.base ? `${text(base.basis)} Combined, when the policy compiles, with what the diligence design derives.` : "Derived from the diligence design when the policy compiles.";
        const resolved = entry.status === "RESOLVED" || entry.status === "DERIVED";
        return { field, label: sentenceCase(humanize(field)), resolved, owner: text(entry.owner, "Not assigned"),
          note: entry.status === "DERIVED" ? derivedNote : resolved ? text(entry.basis) : text(entry.reason, "No entry in the policy source.") };
      }),
      diligence: {
        mandatoryOverlays: strings(configuration.mandatory_overlays),
        sddPermitted: configuration.simplified_due_diligence_permitted === true,
        floors: Object.fromEntries(Object.entries(object(configuration.diligence_floors)).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      },
    };
  });
}

function diligenceSummary(raw: Obj): DiligenceSummary {
  const strings = (value: unknown) => list(value).filter((item): item is string => typeof item === "string");
  const levels = strings(raw.levels);
  return {
    gateId: text(raw.gateId, "diligence-level"), inputProfile: text(raw.inputProfile), levels,
    simplifiedLevel: typeof raw.simplifiedLevel === "string" ? raw.simplifiedLevel : null,
    partyTypes: list(raw.partyTypes).map(object).map((party) => ({ id: text(party.id), label: text(party.label, humanize(text(party.id))), customerType: text(party.customerType), legalForms: strings(party.legalForms) })),
    products: strings(raw.products),
    matrix: Object.fromEntries(Object.entries(object(raw.matrix)).map(([party, row]) => [party, Object.fromEntries(Object.entries(object(row)).map(([product, level]) => [product, text(level)]))])),
    overlays: list(raw.overlays).map(object).map((overlay) => {
      const effect = object(overlay.effect);
      return {
        id: text(overlay.id), label: text(overlay.label, humanize(text(overlay.id))), description: text(overlay.description), enabled: overlay.enabled === true,
        effect: effectText(effect),
        when: predicateClause(overlay.when), witness: predicateWitness(overlay.when), requires: strings(overlay.requires),
        scope: overlayScope(object(overlay.appliesTo ?? {}), list(raw.partyTypes).map(object)),
        scopeProducts: strings(object(overlay.appliesTo ?? {}).products),
        addRequirements: strings(effect.addRequirements), approval: approvalOf(effect),
        sentence: ruleSentence(overlay, list(raw.partyTypes).map(object)),
      };
    }),
    requirements: Object.fromEntries(levels.map((level) => [level, strings(object(raw.requirements)[level])])),
  };
}

/**
 * Facts that satisfy a predicate, for a what-if: one record per `some`, the first branch of an
 * `any`, every branch of an `all`. Returns null for conditions it cannot satisfy by construction
 * (the compiled policy still decides; a witness that does not hold just leaves the overlay off).
 */
export function predicateWitness(raw: unknown): Array<{ path: string; value: unknown }> | null {
  const patches: Array<{ path: string; value: unknown }> = [];
  const record = (predicate: unknown, depth = 0): Obj | null => {
    const entry = object(predicate);
    if (depth > 16) return null;
    if (Array.isArray(entry.all)) {
      let merged: Obj = {};
      for (const child of entry.all) { const part = record(child, depth + 1); if (!part) return null; merged = deepMerge(merged, part); }
      return merged;
    }
    if (Array.isArray(entry.any)) return entry.any.length ? record(entry.any[0], depth + 1) : null;
    const value = leafValue(entry);
    if (value === undefined || typeof entry.path !== "string") return null;
    return setPointer({}, entry.path, value);
  };
  const top = (predicate: unknown, depth = 0): boolean => {
    const entry = object(predicate);
    if (depth > 16) return false;
    if (Array.isArray(entry.all)) return entry.all.every((child) => top(child, depth + 1));
    if (Array.isArray(entry.any)) return entry.any.length > 0 && top(entry.any[0], depth + 1);
    if (entry.some !== undefined) {
      const body = object(entry.some);
      const item = record(body.where);
      if (!item || typeof body.path !== "string" || !body.path.startsWith("/facts/")) return false;
      patches.push({ path: body.path, value: [item] });
      return true;
    }
    if (typeof entry.path !== "string" || !entry.path.startsWith("/facts/")) return false;
    if (entry.op === "count_gte" && typeof entry.value === "number") { patches.push({ path: entry.path, value: Array.from({ length: entry.value }, (_, index) => ({ id: `sample-${index + 1}` })) }); return true; }
    const value = leafValue(entry);
    if (value === undefined) return false;
    patches.push({ path: entry.path, value });
    return true;
  };
  return top(raw) ? patches : null;
}

function leafValue(entry: Obj): unknown {
  if (entry.valueFrom !== undefined || entry.valueFromParent !== undefined) return undefined;
  switch (entry.op) {
    case "eq": case "gte": case "lte": return entry.value;
    case "in": return Array.isArray(entry.value) && entry.value.length ? entry.value[0] : undefined;
    case "present": return true;
    case "gt": return typeof entry.value === "number" ? entry.value + 1 : typeof entry.value === "string" && Number.isFinite(Number(entry.value)) ? String(Number(entry.value) + 1) : undefined;
    case "lt": return typeof entry.value === "number" ? entry.value - 1 : undefined;
    case "contains": return [entry.value];
    default: return undefined;
  }
}

function deepMerge(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])
    ? deepMerge(out[key] as Obj, value as Obj) : value;
  return out;
}

function setPointer(root: Obj, pointer: string, value: unknown): Obj {
  const parts = pointer.slice(1).split("/").filter(Boolean).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (!parts.length) return root;
  const next = structuredClone(root);
  let cursor = next;
  parts.slice(0, -1).forEach((part) => { if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) cursor[part] = {}; cursor = cursor[part] as Obj; });
  cursor[parts.at(-1)!] = value;
  return next;
}

/**
 * Facts for a diligence what-if: every input an active overlay requires is present (empty),
 * and each chosen risk factor adds its witness. Patches to the same list are concatenated.
 */
export function diligenceFacts(diligence: DiligenceSummary, active: string[], chosen: string[], asOf: string): Obj {
  let facts: Obj = { asOf };
  for (const overlay of diligence.overlays) if (active.includes(overlay.id)) for (const pointer of overlay.requires)
    if (pointer.startsWith("/facts/") && pointer !== "/facts/asOf") facts = setFact(facts, pointer, []);
  for (const overlay of diligence.overlays) {
    if (!chosen.includes(overlay.id) || !overlay.witness) continue;
    for (const patch of overlay.witness) {
      const parts = patch.path.replace(/^\/facts\/?/, "").split("/").filter(Boolean);
      let existing: unknown = facts;
      for (const part of parts) existing = existing && typeof existing === "object" ? (existing as Obj)[part] : undefined;
      facts = setFact(facts, patch.path, Array.isArray(existing) && Array.isArray(patch.value) ? [...existing, ...patch.value] : patch.value);
    }
  }
  return facts;
}

/** Read the workspace's sources into sections of plain-language rules. */
export function policyRulebook(sources: Record<string, unknown>): Rulebook {
  const book: Rulebook = { kind: "none", title: "Policy", version: "", owner: "", sections: [], policySets: [], diligence: null, errors: [] };
  const tables: RuleSection[] = [];
  for (const [path, source] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))) {
    try {
      if (!path.endsWith(".yaml") && !path.endsWith(".yml") && !path.endsWith(".json")) continue;
      const raw = parseSource(source);
      const metadata = object(raw.metadata);
      if (raw.kind === "BusinessPolicy") {
        Object.assign(book, { kind: "business", title: text(metadata.name, text(metadata.id, "Installation policy")), version: text(metadata.version), owner: text(metadata.owner) });
        book.sections.push(...businessSections(raw, path));
        book.policySets.push(...policySets(raw));
        if (raw.diligence !== undefined) book.diligence = diligenceSummary(object(raw.diligence));
      } else if (raw.kind === "Policy") {
        Object.assign(book, { kind: "archived", title: text(metadata.name, text(metadata.id, "Policy")), version: text(metadata.version), owner: text(metadata.owner) });
      } else if (raw.kind === "DecisionTable") {
        if (book.kind === "none") book.kind = "archived";
        tables.push(tableSection(raw, path));
      }
    } catch (error) {
      book.errors.push({ path, message: error instanceof Error ? error.message : "Source could not be read." });
    }
  }
  const stage = ["intake", "screening", "decision", "disposition"];
  const rank = (section: RuleSection) => { const index = stage.findIndex((name) => section.id.includes(name)); return index < 0 ? stage.length : index; };
  book.sections.push(...tables.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id)));
  if (book.kind === "business") book.sections.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  return book;
}

export const ruleCount = (book: Rulebook) => book.sections.reduce((total, section) => total + section.rules.length, 0);

/** A case fact a gate's rules read, with the values the rules compare it to. */
export type FactInput = { path: string; label: string; kind: "presence" | "choice" | "number" | "text"; options: string[] };

/** The `/facts/…` paths the gate's rules read, so a what-if can ask for them by name. */
export function gateFactInputs(sources: Record<string, unknown>, gateId: string): FactInput[] {
  const found = new Map<string, FactInput>();
  const visit = (raw: unknown, depth: number) => {
    if (depth > 32) return;
    const entry = object(raw);
    for (const key of ["all", "any"] as const) if (Array.isArray(entry[key])) entry[key].forEach((child) => visit(child, depth + 1));
    for (const key of ["every", "some"] as const) if (entry[key] !== undefined) {
      const body = object(entry[key]);
      const path = text(body.path);
      if (path.startsWith("/facts/") && !found.has(path)) found.set(path, { path, label: sentenceCase(describePath(path)), kind: "text", options: [] });
    }
    const path = text(entry.path), op = text(entry.op);
    if (!path.startsWith("/facts/") || path === "/facts/asOf") return;
    const current = found.get(path) ?? { path, label: sentenceCase(describePath(path)), kind: "presence" as FactInput["kind"], options: [] as string[] };
    if (["eq", "ne", "in", "contains"].includes(op) && entry.value !== undefined) {
      const values = (Array.isArray(entry.value) ? entry.value : [entry.value]).map(describeValue);
      current.kind = "choice";
      current.options = [...new Set([...current.options, ...values])];
    } else if (["gt", "gte", "lt", "lte", "count_gte"].includes(op) && current.kind !== "choice") current.kind = "number";
    found.set(path, current);
  };
  for (const source of Object.values(sources)) {
    try {
      const raw = typeof source === "string" ? parseDocument(source).toJS() as unknown : source;
      const gate = object(object(object(raw).gates)[gateId]);
      list(gate.rules).forEach((rule) => visit(object(rule).when, 0));
    } catch { /* Unreadable sources are reported by the rulebook. */ }
  }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Set a JSON-pointer path under `/facts` in a facts object, creating parents. */
export function setFact(facts: Obj, path: string, value: unknown): Obj {
  const parts = path.replace(/^\/facts\/?/, "").split("/").filter(Boolean).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (!parts.length) return facts;
  const next = structuredClone(facts);
  let cursor: Obj = next;
  parts.slice(0, -1).forEach((part) => {
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as Obj;
  });
  cursor[parts.at(-1)!] = value;
  return next;
}

/** The single next lifecycle step for the loaded revision, and why it is unavailable. */
export type NextStep = { id: "save" | "compile" | "approve" | "publish" | "done"; label: string; reason: string | null };
export const SEPARATION = "Needs a different approver (separation of duties)";

export function nextStep(input: {
  revision: { revision: number; status: string; author: string | null } | null;
  dirty: boolean;
  actions: readonly string[];
  subjectId: string;
}): NextStep {
  const { revision, dirty, actions, subjectId } = input;
  if (!revision || dirty) {
    return { id: "save", label: "Save revision", reason: actions.includes("draft.write") ? null : "Your role cannot save revisions (needs draft.write)." };
  }
  const status = revision.status;
  if (status === "DRAFT") {
    return { id: "compile", label: "Compile revision", reason: actions.includes("draft.compile") ? null : "Your role cannot compile (needs draft.compile)." };
  }
  if (status === "COMPILED" || status === "EVALUATED") {
    const reason = revision.author === subjectId ? `${SEPARATION}: you authored revision ${revision.revision}.`
      : !actions.includes("draft.approve") ? `${SEPARATION}: your role does not hold draft.approve.` : null;
    return { id: "approve", label: "Approve revision", reason };
  }
  if (status === "APPROVED") {
    return { id: "publish", label: "Publish", reason: actions.includes("draft.publish") ? null : `${SEPARATION}: your role does not hold draft.publish.` };
  }
  return { id: "done", label: "Published", reason: `Revision ${revision.revision} is ${status.toLowerCase()}. Edit the policy to start a new revision.` };
}
