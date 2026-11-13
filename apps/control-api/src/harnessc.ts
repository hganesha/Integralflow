import { CompilerError, compilePackage, type ModelProfileRegistry } from "@ehf/compiler";
import { harnessPlanV2Schema, verifyHarnessPlanDigest, type HarnessPlanV2 } from "@ehf/contracts";

/** Plain file name, no separators and no traversal: this value names a package file. */
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

export class HarnessCompilerError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
  }
}

/**
 * Compile authoring sources into a plan with the plan compiler (`@ehf/compiler`, harnessc).
 *
 * The compiler is the trust root and the only thing that emits a plan: the author plane
 * never builds one itself. The package is compiled from its sources in memory -- the authored
 * package, workflow and snapshotted dependencies are exactly the package's files -- so the
 * dependency manifest and package digest are deterministic for identical sources. The
 * emitted plan is still parsed against the plan contract and its digest re-verified before
 * it is returned.
 */
export async function compileWithHarnessc(input: {
  packageSource: string;
  workflowSource: string;
  workflowFileName: string;
  sourceFiles?: Record<string, string>;
  /** The model profile registry: a registry file path or the registry document. */
  modelProfiles: string | ModelProfileRegistry;
}): Promise<HarnessPlanV2> {
  if (!SAFE_FILENAME.test(input.workflowFileName) || [".", "..", "package.yaml"].includes(input.workflowFileName)) {
    throw new HarnessCompilerError("compiler.workflow_filename_invalid", input.workflowFileName);
  }
  const sourceFiles = validateSourceFiles(input.sourceFiles, input.workflowFileName);
  let document: unknown;
  try {
    document = compilePackage({
      ...sourceFiles,
      "package.yaml": input.packageSource,
      [input.workflowFileName]: input.workflowSource,
    }, { modelProfiles: input.modelProfiles }).plan;
  } catch (error) {
    if (error instanceof CompilerError) throw new HarnessCompilerError("compiler.refused", error.message);
    throw error;
  }
  const parsed = harnessPlanV2Schema.safeParse(document);
  if (!parsed.success) {
    throw new HarnessCompilerError("compiler.plan_contract_violation", JSON.stringify(parsed.error.issues.slice(0, 8)));
  }
  if (!verifyHarnessPlanDigest(parsed.data)) {
    throw new HarnessCompilerError("compiler.plan_digest_invalid", parsed.data.planDigest);
  }
  return parsed.data;
}

/** Persist only portable package-relative text dependencies; never follow filesystem paths. */
export function validateSourceFiles(value: unknown, workflowFileName = "workflow.yaml"): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("authoring.source_files_invalid");
  for (const [path, source] of Object.entries(value)) {
    if (typeof source !== "string" || !path.split("/").every((part) => SAFE_FILENAME.test(part) && part !== "." && part !== "..")
      || path === "package.yaml" || path === workflowFileName) throw new Error(`authoring.source_file_invalid:${path}`);
  }
  return value as Record<string, string>;
}
