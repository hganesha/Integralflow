import { createHash } from "node:crypto";
import { platformSkillManifestSchema, skillBundleLockSchema, stableDigest, type SkillBundleLock } from "@ehf/contracts";
import type { SampleSkill } from "./skills.js";

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const digestOf = (value: unknown) => `sha256:${stableDigest(value)}`;

export const REFERENCE_BUNDLE_ID = "ehf-reference-skills";
export const REFERENCE_BUNDLE_VERSION = "0.1.0";

/**
 * The reference bundle's lock (§8). Deterministic, so a plan can pin its `bundle_digest`.
 * `manifest_digest` is the platform skill registry's digest of the manifest (sha256 over its
 * canonical JSON). The image, SBOM and code digests are synthetic stand-ins: this host is not
 * built from a released skill library.
 */
export function buildBundleLock(skills: readonly SampleSkill[]): SkillBundleLock {
  const entries = skills.map((skill) => {
    const manifest = platformSkillManifestSchema.parse(skill.manifest);
    return {
      id: manifest.id,
      version: manifest.semver,
      maturity: manifest.maturity ?? "implemented_synthetic",
      manifest_digest: digestOf(manifest),
      instructions_digest: sha(skill.instructions),
      code_digest: sha(skill.codeRevision),
      input_schema_digest: digestOf(manifest.input_schema),
      output_schema_digest: digestOf(manifest.output_schema),
      dependencies: { capabilities: manifest.package?.dependencies?.capabilities ?? [], skills: [] },
      effects: skill.effects,
      evaluation_report_digest: null,
    };
  }).sort((left, right) => (left.id < right.id ? -1 : 1));
  const body = {
    bundle_id: REFERENCE_BUNDLE_ID,
    bundle_version: REFERENCE_BUNDLE_VERSION,
    image_digest: sha(`${REFERENCE_BUNDLE_ID}:image:synthetic`),
    python: "n/a (TypeScript reference host)",
    skills: entries,
    sbom_digest: sha(`${REFERENCE_BUNDLE_ID}:sbom:synthetic`),
  };
  return skillBundleLockSchema.parse({ ...body, bundle_digest: digestOf(body) });
}
