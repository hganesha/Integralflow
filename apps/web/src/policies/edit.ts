import { isMap, isSeq, parseDocument, type Document } from "yaml";
import { diligenceSourceSchema, checkDiligenceCoverage } from "@ehf/policy-engine/diligence";
import { humanize, policyRulebook, predicateClause, type DiligenceSummary } from "./rulebook";

/**
 * Edits to a business policy's diligence block, made on the YAML document so comments, key order
 * and the rest of the source survive. Each function takes the policy source and returns the new
 * source; nothing here evaluates a rule. The server compiles and decides.
 */

type Obj = Record<string, unknown>;

function edit(source: string, change: (doc: Document) => void): string {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors.map((error) => error.message).join("; "));
  if (!isMap(doc.getIn(["diligence"]))) throw new Error("This policy has no diligence block.");
  change(doc);
  return String(doc);
}

const plain = (doc: Document, path: Array<string | number>) => {
  const node = doc.getIn(path, true);
  return node && typeof node === "object" && "toJSON" in node ? (node as { toJSON: () => unknown }).toJSON() : node;
};

export function setMatrixCell(source: string, party: string, product: string, level: string): string {
  return edit(source, (doc) => doc.setIn(["diligence", "matrix", party, product], level));
}

/**
 * Give a product its own matrix column, starting from the column it inherits (`from`), so its base
 * levels can then be overridden without changing the products that share the inherited column.
 */
export function addMatrixColumn(source: string, product: string, from: string): string {
  return edit(source, (doc) => {
    const products = plain(doc, ["diligence", "products"]) as string[];
    if (products.includes(product)) throw new Error(`${product} already has its own column.`);
    if (!products.includes(from)) throw new Error(`${from} is not a column of the matrix.`);
    doc.setIn(["diligence", "products"], doc.createNode([...products, product]));
    const matrix = plain(doc, ["diligence", "matrix"]) as Record<string, Record<string, string>>;
    for (const [party, row] of Object.entries(matrix)) doc.setIn(["diligence", "matrix", party, product], row[from]!);
  });
}

export function setOverlayEnabled(source: string, overlayId: string, enabled: boolean): string {
  return edit(source, (doc) => {
    const overlays = plain(doc, ["diligence", "overlays"]) as Obj[];
    const index = overlays.findIndex((overlay) => overlay.id === overlayId);
    if (index < 0) throw new Error(`Overlay ${overlayId} is not in this policy.`);
    doc.setIn(["diligence", "overlays", index, "enabled"], enabled);
  });
}

/** The simple overlay shapes the condition builder writes; anything else is kept as authored. */
export type OverlayCondition =
  | { kind: "some"; list: string; field: string; op: "eq" | "ne" | "in" | "gt" | "gte" | "lt" | "lte"; value: string }
  | { kind: "count"; list: string; count: number }
  | { kind: "custom"; when: unknown; requires: string[] };
/** What a rule does when it fires: each part only adds (the engine refuses anything else). */
export type RuleEffect = {
  escalateTo?: string; escalateBy?: number; addRequirements?: string[];
  requireApproval?: { role: string; quorum: number; reason: string };
};
/** Where a rule applies; an empty list means everywhere. */
export type RuleScope = { products?: string[]; partyTypes?: string[]; jurisdictions?: string[] };
export type OverlayDraft = {
  id: string; label: string; description: string; enabled: boolean;
  condition: OverlayCondition;
  effect: RuleEffect;
  appliesTo?: RuleScope;
};

/** The effect as the policy stores it: only the parts that are set. */
export function cleanEffect(effect: RuleEffect): RuleEffect {
  return {
    ...(effect.escalateTo !== undefined ? { escalateTo: effect.escalateTo } : effect.escalateBy !== undefined ? { escalateBy: effect.escalateBy } : {}),
    ...(effect.addRequirements?.length ? { addRequirements: [...effect.addRequirements] } : {}),
    ...(effect.requireApproval ? { requireApproval: { ...effect.requireApproval } } : {}),
  };
}
/** The scope as the policy stores it, or undefined when it applies everywhere. */
export function cleanScope(scope: RuleScope | undefined): RuleScope | undefined {
  const kept = Object.fromEntries((["products", "partyTypes", "jurisdictions"] as const).flatMap((key) => scope?.[key]?.length ? [[key, [...scope[key]!]]] : []));
  return Object.keys(kept).length ? kept : undefined;
}

const scalar = (value: string): unknown => value === "true" ? true : value === "false" ? false : value;

export function overlayFromDraft(draft: OverlayDraft): Obj {
  const condition = draft.condition;
  let when: unknown, requires: string[];
  if (condition.kind === "some") {
    const value = condition.op === "in" ? condition.value.split(",").map((part) => part.trim()).filter(Boolean).map(scalar) : scalar(condition.value.trim());
    when = { some: { path: condition.list, where: { path: condition.field, op: condition.op, value } } };
    requires = [condition.list];
  } else if (condition.kind === "count") {
    when = { path: condition.list, op: "count_gte", value: condition.count };
    requires = [condition.list];
  } else {
    when = condition.when;
    requires = condition.requires;
  }
  const appliesTo = cleanScope(draft.appliesTo);
  return {
    id: draft.id, label: draft.label, ...(draft.description ? { description: draft.description } : {}),
    enabled: draft.enabled, ...(appliesTo ? { appliesTo } : {}), requires, when, effect: cleanEffect(draft.effect),
  };
}

export function draftFromOverlay(raw: Obj): OverlayDraft {
  const when = (raw.when ?? {}) as Obj;
  const requires = Array.isArray(raw.requires) ? raw.requires.filter((item): item is string => typeof item === "string") : [];
  const some = when.some as Obj | undefined;
  const where = some?.where as Obj | undefined;
  const ops = ["eq", "ne", "in", "gt", "gte", "lt", "lte"];
  let condition: OverlayCondition = { kind: "custom", when, requires };
  if (some && where && typeof some.path === "string" && typeof where.path === "string" && ops.includes(String(where.op)) && where.value !== undefined
    && requires.length === 1 && requires[0] === some.path && Object.keys(some).every((key) => key === "path" || key === "where")) {
    const value = Array.isArray(where.value) ? where.value.map(String).join(", ") : String(where.value);
    condition = { kind: "some", list: some.path, field: where.path, op: where.op as "eq", value };
  } else if (typeof when.path === "string" && when.op === "count_gte" && typeof when.value === "number" && requires.length === 1 && requires[0] === when.path) {
    condition = { kind: "count", list: when.path, count: when.value };
  }
  const effect = (raw.effect ?? {}) as Obj;
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const approval = effect.requireApproval as Obj | undefined;
  const appliesTo = cleanScope({ products: strings((raw.appliesTo as Obj | undefined)?.products), partyTypes: strings((raw.appliesTo as Obj | undefined)?.partyTypes),
    jurisdictions: strings((raw.appliesTo as Obj | undefined)?.jurisdictions) });
  return {
    id: String(raw.id ?? ""), label: String(raw.label ?? ""), description: String(raw.description ?? ""), enabled: raw.enabled === true, condition,
    effect: cleanEffect({
      ...(typeof effect.escalateTo === "string" ? { escalateTo: effect.escalateTo } : typeof effect.escalateBy === "number" ? { escalateBy: effect.escalateBy } : {}),
      addRequirements: strings(effect.addRequirements),
      ...(approval ? { requireApproval: { role: String(approval.role ?? ""), quorum: Number(approval.quorum ?? 1), reason: String(approval.reason ?? "") } } : {}),
    }),
    ...(appliesTo ? { appliesTo } : {}),
  };
}

/** Add an overlay, or replace the one whose id is `replacing`. */
export function upsertOverlay(source: string, draft: OverlayDraft, replacing?: string): string {
  return edit(source, (doc) => {
    const overlays = (plain(doc, ["diligence", "overlays"]) ?? []) as Obj[];
    const index = replacing === undefined ? -1 : overlays.findIndex((overlay) => overlay.id === replacing);
    if (replacing !== undefined && index < 0) throw new Error(`Overlay ${replacing} is not in this policy.`);
    if (overlays.some((overlay, at) => overlay.id === draft.id && at !== index)) throw new Error(`An overlay with id ${draft.id} already exists.`);
    // The draft carries the whole rule, scope included.
    const node = doc.createNode(overlayFromDraft(draft));
    if (index >= 0) doc.setIn(["diligence", "overlays", index], node);
    else if (isSeq(doc.getIn(["diligence", "overlays"]))) doc.addIn(["diligence", "overlays"], node);
    else doc.setIn(["diligence", "overlays"], doc.createNode([overlayFromDraft(draft)]));
  });
}

export function removeOverlay(source: string, overlayId: string): string {
  return edit(source, (doc) => {
    const overlays = plain(doc, ["diligence", "overlays"]) as Obj[];
    const index = overlays.findIndex((overlay) => overlay.id === overlayId);
    if (index >= 0) doc.deleteIn(["diligence", "overlays", index]);
  });
}

export type PartyDraft = { id: string; label: string; customerType: "individual" | "corporate"; legalForms: string[] };

/**
 * Replace the party types. Kept rows keep their cells; a new party type starts every product at
 * the second level (CDD in SDD < CDD < EDD), never the simplified one.
 */
export function setPartyTypes(source: string, parties: PartyDraft[]): string {
  return edit(source, (doc) => {
    const levels = plain(doc, ["diligence", "levels"]) as string[];
    const products = plain(doc, ["diligence", "products"]) as string[];
    const matrix = (plain(doc, ["diligence", "matrix"]) ?? {}) as Record<string, Record<string, string>>;
    const start = levels[1] ?? levels[0]!;
    doc.setIn(["diligence", "partyTypes"], doc.createNode(parties.map((party) => ({ id: party.id, label: party.label, customerType: party.customerType, legalForms: party.legalForms }))));
    for (const id of Object.keys(matrix)) if (!parties.some((party) => party.id === id)) doc.deleteIn(["diligence", "matrix", id]);
    for (const party of parties) if (!matrix[party.id]) doc.setIn(["diligence", "matrix", party.id], doc.createNode(Object.fromEntries(products.map((product) => [product, start]))));
  });
}

/** Set what each level adds; the stored lists are rebuilt cumulatively from the lowest level. */
export function setRequirementAdditions(source: string, additions: Record<string, string[]>): string {
  return edit(source, (doc) => {
    const levels = plain(doc, ["diligence", "levels"]) as string[];
    let running: string[] = [];
    for (const level of levels) {
      running = [...running, ...(additions[level] ?? []).filter((obligation) => !running.includes(obligation))];
      doc.setIn(["diligence", "requirements", level], doc.createNode([...running]));
    }
  });
}

/** What each level adds over the level below it. */
export function requirementAdditions(diligence: DiligenceSummary): Record<string, string[]> {
  return Object.fromEntries(diligence.levels.map((level, index) => {
    const below = index > 0 ? diligence.requirements[diligence.levels[index - 1]!] ?? [] : [];
    return [level, (diligence.requirements[level] ?? []).filter((obligation) => !below.includes(obligation))];
  }));
}

/** The raw overlay as authored, for the editor. */
export function overlaySource(source: string, overlayId: string): Obj | null {
  const doc = parseDocument(source);
  const overlays = (doc.toJS() as Obj)?.diligence as Obj | undefined;
  return (Array.isArray(overlays?.overlays) ? overlays.overlays as Obj[] : []).find((overlay) => overlay.id === overlayId) ?? null;
}

/**
 * Problems the server would refuse, shown while editing. The compiled policy remains the authority;
 * these are the same schema and coverage checks the engine runs.
 */
export function diligenceProblems(source: string): string[] {
  try {
    const raw = parseDocument(source).toJS() as Obj;
    if (!raw?.diligence) return [];
    const parsed = diligenceSourceSchema.safeParse(raw.diligence);
    if (!parsed.success) return [...new Set(parsed.error.issues.map((issue) => issue.message))];
    const sets = (Array.isArray(raw.policySets) ? raw.policySets : []) as Array<{ id: string; scope: { products: string[]; customerTypes: string[] }; configuration: Obj }>;
    return checkDiligenceCoverage(parsed.data, sets);
  } catch (error) {
    return [error instanceof Error ? error.message : "The policy source could not be read."];
  }
}

const PROBLEM_WORDS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/^policy\.diligence_matrix_cell_missing:(.+):(.+)$/, (m) => `${humanize(m[1]!)} has no level for ${humanize(m[2]!)}.`],
  [/^policy\.diligence_legal_form_ambiguous$/, () => "A legal form belongs to more than one party type."],
  [/^policy\.diligence_party_type_duplicate$/, () => "Two party types share an id."],
  [/^policy\.diligence_overlay_duplicate$/, () => "Two overlays share an id."],
  [/^policy\.diligence_customer_type_uncovered:(.+):(.+)$/, (m) => `No party type covers ${humanize(m[2]!)} customers, which policy set ${m[1]} serves.`],
  [/^policy\.diligence_mandatory_overlay_unknown:(.+):(.+)$/, (m) => `Policy set ${m[1]} requires overlay ${m[2]}, which is missing.`],
  [/^policy\.diligence_product_uncovered:(.+):(.+)$/, (m) => `Policy set ${m[1]} serves ${humanize(m[2]!)}, which has no column.`],
];
export const describeProblem = (problem: string) => {
  for (const [pattern, words] of PROBLEM_WORDS) { const match = problem.match(pattern); if (match) return words(match); }
  return problem;
};

// ---- versions ---------------------------------------------------------------------------

export type DiligenceChange = { area: "Matrix" | "Overlays" | "Party types" | "Requirements" | "Policy"; text: string };

const json = (value: unknown) => JSON.stringify(value);
const clauseText = (when: unknown) => {
  const clause = predicateClause(when);
  const flat = (entry: typeof clause): string => entry.children.length ? `${entry.text}: ${entry.children.map(flat).join("; ")}` : entry.text;
  return flat(clause);
};

/** What changed between two versions of a policy, as matrix and overlay changes rather than YAML. */
export function diligenceDiff(before: Record<string, string>, after: Record<string, string>): DiligenceChange[] {
  const read = (files: Record<string, string>) => { try { return parseDocument(files["policy.yaml"] ?? "").toJS() as Obj | null; } catch { return null; } };
  const a = read(before), b = read(after);
  const da = policyRulebook(before).diligence, db = policyRulebook(after).diligence;
  const changes: DiligenceChange[] = [];
  if (da && db) {
    const parties = new Map([...da.partyTypes, ...db.partyTypes].map((party) => [party.id, party.label]));
    for (const party of db.partyTypes) for (const product of db.products) {
      const was = da.matrix[party.id]?.[product], now = db.matrix[party.id]?.[product];
      if (was !== undefined && now !== undefined && was !== now) changes.push({ area: "Matrix", text: `${party.label} × ${humanize(product)}: ${was} → ${now}` });
    }
    for (const party of db.partyTypes) {
      const old = da.partyTypes.find((entry) => entry.id === party.id);
      if (!old) changes.push({ area: "Party types", text: `Added ${party.label} (${party.legalForms.map(humanize).join(", ")})` });
      else if (json(old) !== json(party)) changes.push({ area: "Party types", text: `Changed ${party.label}: ${party.legalForms.map(humanize).join(", ")}` });
    }
    for (const party of da.partyTypes) if (!db.partyTypes.some((entry) => entry.id === party.id)) changes.push({ area: "Party types", text: `Removed ${parties.get(party.id)}` });
    const rawOverlays = (doc: Obj | null) => new Map((((doc?.diligence as Obj | undefined)?.overlays ?? []) as Obj[]).map((overlay) => [String(overlay.id), overlay]));
    const oa = rawOverlays(a), ob = rawOverlays(b);
    for (const [id, overlay] of ob) {
      const old = oa.get(id);
      const label = String(overlay.label ?? id);
      if (!old) { changes.push({ area: "Overlays", text: `Added ${label}${overlay.enabled ? "" : " (off)"}` }); continue; }
      if (old.enabled !== overlay.enabled) changes.push({ area: "Overlays", text: `${label} switched ${overlay.enabled ? "on" : "off"}` });
      if (json(old.effect) !== json(overlay.effect)) changes.push({ area: "Overlays", text: `${label}: effect changed` });
      if (json(old.when) !== json(overlay.when)) changes.push({ area: "Overlays", text: `${label}: now when ${clauseText(overlay.when).replace(/^./, (first) => first.toLowerCase())}` });
      if (old.label !== overlay.label) changes.push({ area: "Overlays", text: `${String(old.label)} renamed to ${label}` });
    }
    for (const [id, overlay] of oa) if (!ob.has(id)) changes.push({ area: "Overlays", text: `Removed ${String(overlay.label ?? id)}` });
    for (const level of db.levels) {
      const was = da.requirements[level] ?? [], now = db.requirements[level] ?? [];
      const added = now.filter((item) => !was.includes(item)), removed = was.filter((item) => !now.includes(item));
      if (added.length) changes.push({ area: "Requirements", text: `${level} now requires ${added.join(", ")}` });
      if (removed.length) changes.push({ area: "Requirements", text: `${level} no longer requires ${removed.join(", ")}` });
    }
  } else if (Boolean(da) !== Boolean(db)) changes.push({ area: "Policy", text: db ? "Diligence block added" : "Diligence block removed" });
  const rest = (doc: Obj | null) => { if (!doc) return null; const { diligence: _skip, ...other } = doc; return json(other); };
  if (rest(a) !== rest(b)) changes.push({ area: "Policy", text: "Other policy changes outside the diligence design (gates, policy sets or metadata); compare the source under Advanced." });
  const otherFiles = new Set([...Object.keys(before), ...Object.keys(after)].filter((path) => path !== "policy.yaml" && before[path] !== after[path]));
  if (otherFiles.size) changes.push({ area: "Policy", text: `${otherFiles.size} other source file${otherFiles.size === 1 ? "" : "s"} changed.` });
  return changes;
}
