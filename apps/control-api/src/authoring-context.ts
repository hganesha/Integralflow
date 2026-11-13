import {
  caseReadGrantSchema,
  contextClassificationPolicySchema,
  type CaseReadGrant,
  type ContextClassificationPolicy,
} from "@ehf/contracts";
import { parse, stringify } from "yaml";

type JsonMap = Record<string, unknown>;

function object(value: unknown): value is JsonMap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Replace package-level case-read contracts while preserving all other authored YAML. */
export function updateAuthoringContextSelectors(packageSource: string, rawSelectors: unknown): string {
  if (!Array.isArray(rawSelectors)) throw new Error("authoring.context_selectors_array_required");
  const selectors = rawSelectors.map((value, index) => {
    const parsed = caseReadGrantSchema.safeParse(value);
    if (!parsed.success) throw new Error(`authoring.context_selector_invalid:${index}`);
    return parsed.data;
  });
  if (new Set(selectors.map((selector) => selector.id)).size !== selectors.length) {
    throw new Error("authoring.context_selector_duplicate");
  }
  const pkg = parse(packageSource) as unknown;
  if (!object(pkg)) throw new Error("authoring.package_source_invalid");
  pkg.contextSelectors = selectors satisfies CaseReadGrant[];
  return stringify(pkg, { lineWidth: 120 });
}

/** Replace package-level classification treatments while preserving authored YAML. */
export function updateAuthoringContextClassificationPolicies(packageSource: string, rawPolicies: unknown): string {
  if (!Array.isArray(rawPolicies)) throw new Error("authoring.context_classification_policies_array_required");
  const policies = rawPolicies.map((value, index) => {
    const parsed = contextClassificationPolicySchema.safeParse(value);
    if (!parsed.success) throw new Error(`authoring.context_classification_policy_invalid:${index}`);
    return parsed.data;
  });
  if (new Set(policies.map((policy) => policy.classification)).size !== policies.length) {
    throw new Error("authoring.context_classification_policy_duplicate");
  }
  const pkg = parse(packageSource) as unknown;
  if (!object(pkg)) throw new Error("authoring.package_source_invalid");
  pkg.contextClassificationPolicies = policies satisfies ContextClassificationPolicy[];
  return stringify(pkg, { lineWidth: 120 });
}
