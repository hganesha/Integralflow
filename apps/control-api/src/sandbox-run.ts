import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessPlanV2 } from "@ehf/contracts";
import { readManifest, readParty, validateParty, type PartyDossier, type SeedOptions, type SeedResult } from "@ehf/context-corpus";
import { planScope } from "@ehf/flow-composer";
import {
  activateSandboxRelease, admitPlan, createRun, sandboxReleaseManifest, sandboxReleasesAllowed, type Database,
} from "@ehf/persistence";
import { casePolicyContextFromRelationship, loadProductTaxonomy, productSourceRoot, selectPolicyPack } from "@ehf/policy-engine";
import { compileAuthoredPolicy } from "./policy-authoring.js";

/**
 * A sandbox run: a draft's compiled plan on the real runtime, against a fresh copy of a synthetic
 * test party, under a sandbox release (packages/persistence governance.ts, migration 063).
 *
 * It is a rehearsal, never a release. The release is approved by a system identity, carries no
 * evaluation attestation, may decide under a policy that still has release blockers, and is
 * refused under the production profile. The only cases it can run on are the ones it creates
 * here from the synthetic test corpus, so no real case is ever touched.
 */

/** Where the synthetic test corpus is: the repository's fixtures, or SANDBOX_CORPUS_ROOT in an image. */
export function sandboxCorpusRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SANDBOX_CORPUS_ROOT ?? fileURLToPath(new URL("../../../fixtures/context-corpus", import.meta.url));
}

export type SandboxParty = { id: string; name: string; customerType: "individual" | "business"; records: number };

/** The test parties a sandbox run can use, from each party's case file (no record is read). */
export function listSandboxParties(root: string): SandboxParty[] {
  if (!existsSync(join(root, "manifest.json"))) return [];
  return readManifest(root).parties.flatMap((entry) => {
    try {
      const bootstrap = JSON.parse(readFileSync(join(root, "parties", entry.id, "case.json"), "utf8")) as { customer_entity_id: string;
        subjects: Array<{ entity_id: string; name: string; subject_type: string }> };
      const customer = bootstrap.subjects.find((subject) => subject.entity_id === bootstrap.customer_entity_id) ?? bootstrap.subjects[0];
      if (!customer) return [];
      return [{ id: entry.id, name: customer.name, customerType: customer.subject_type === "individual" ? "individual" as const : "business" as const, records: entry.record_count }];
    } catch { return []; }
  });
}

/** Why a sandbox run cannot be offered here, or null when it can. */
export function sandboxUnavailableReason(env: NodeJS.ProcessEnv, root: string): string | null {
  if (!sandboxReleasesAllowed(env.RELEASE_ENVIRONMENT ?? "development", env)) return "Sandbox runs are disabled in production.";
  if (!listSandboxParties(root).length) return "No synthetic test parties are installed with this service.";
  return null;
}

export type SandboxRunResult = {
  runId: string; caseId: string; party: string; releaseId: string; planDigest: string;
  policyPack: string; policyBlockers: number; records: number;
  /** The party's source documents loaded into the evidence pipeline for the case, and those that could not be rebuilt. */
  documents: number; documentsSkipped: number;
};

export type SandboxDocument = { filename: string; content: Buffer; sha256: string };

/**
 * The party's source documents, rebuilt from its document records. The corpus keeps each
 * document as a DocumentVersion (file name, artifact hash) and its decoded pages, not as a file. A
 * single-page text document's bytes are its page text, which is accepted only when it hashes to
 * the recorded artifact hash; anything else (several pages, another format) cannot be rebuilt
 * and is counted as skipped, never approximated.
 */
export function sandboxDocuments(dossier: PartyDossier): { documents: SandboxDocument[]; skipped: number } {
  const rows = dossier.documents ?? [];
  const pages = new Map<string, string[]>();
  for (const row of rows) {
    if (row.object_type !== "DocumentPage") continue;
    const version = String(row.data.document_version ?? "");
    pages.set(version, [...(pages.get(version) ?? []), String(row.data.text ?? "")]);
  }
  const documents: SandboxDocument[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (row.object_type !== "DocumentVersion") continue;
    const sha256 = String(row.data.artifact_hash ?? "");
    const connector = (row.data.extensions as { "ehf.connector"?: { value?: { filename?: unknown } } } | undefined)?.["ehf.connector"]?.value;
    const filename = typeof connector?.filename === "string" ? connector.filename : "";
    const text = pages.get(sha256);
    const content = text?.length === 1 ? Buffer.from(text[0]!, "utf8") : null;
    if (!content || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(filename) || createHash("sha256").update(content).digest("hex") !== sha256) {
      skipped += 1;
      continue;
    }
    documents.push({ filename, content, sha256 });
  }
  return { documents, skipped };
}

/**
 * Put the plan in effect as a sandbox release, load the party as a new case pinned as case-time
 * selection pins one (to the plan, and to the one policy pack the plan pinned for the party's
 * relationship), and start a run on it. `seed` writes the case through the case service.
 */
export async function startSandboxRun(input: {
  db: Database; env: NodeJS.ProcessEnv; tenantId: string; actor: string;
  plan: HarnessPlanV2; policyFiles: Record<string, string>; party: string; corpusRoot: string; opaVersion: string;
  seed(dossier: PartyDossier, pins: Pick<SeedOptions, "tenantId" | "copy" | "caseType" | "jurisdiction" | "harnessPlanDigest" | "policySnapshotDigest" | "policyAuthority" | "permissionEnvelopeDigest">): Promise<SeedResult>;
  /**
   * Hands one source document to the evidence pipeline for the new case, so the flow's document
   * acquisition finds what a customer would have uploaded. Omitted where no pipeline is configured:
   * the run then stops at document acquisition, as a case with no uploaded documents does.
   */
  loadDocument?(caseId: string, document: SandboxDocument): Promise<void>;
  recordLaunch?(planDigest: string, execute: (copyId: string) => Promise<SandboxRunResult>): Promise<SandboxRunResult>;
}): Promise<SandboxRunResult> {
  const { db, env, tenantId, plan } = input;
  const environment = env.RELEASE_ENVIRONMENT ?? "development";
  if (!sandboxReleasesAllowed(environment, env)) throw new Error("sandbox.not_available");
  if (plan.policyBundles.length !== 1) throw new Error("sandbox.single_policy_required");
  const digest = (value: string) => value.replace(/^sha256:/, "");
  const compiled = compileAuthoredPolicy({ files: input.policyFiles, release: "candidate" }, input.opaVersion);
  if (digest(compiled.manifest.bundleDigest) !== digest(plan.policyBundles[0]!.bundleDigest)) throw new Error("sandbox.policy_digest_mismatch");

  // The party and its pin are resolved before anything is written, so a party the plan does not cover changes nothing.
  const dossier = readParty(input.corpusRoot, input.party);
  const invalid = validateParty(dossier);
  if (invalid.length) throw new Error(`sandbox.party_invalid: ${invalid.slice(0, 3).join("; ")}`);
  const relationship = dossier.records.find((record) => record.object_type === "BankingRelationship")?.data;
  if (!relationship) throw new Error("sandbox.banking_relationship_missing");
  const composed = planScope(plan);
  if (!composed) throw new Error("sandbox.plan_scope_missing");
  const legacy = loadProductTaxonomy(productSourceRoot(env)).legacy;
  const selection = selectPolicyPack(composed.packs, casePolicyContextFromRelationship(relationship, { catalog: null, legacy }), legacy);
  if (selection.status !== "selected") throw new Error(`sandbox.party_not_covered: ${selection.reason}`);
  const pack = selection.pack;

  const execute = async (copy: string): Promise<SandboxRunResult> => {
    await admitPlan(db, plan, tenantId);
    const release = await activateSandboxRelease(db, {
      tenantId, actor: input.actor, manifest: sandboxReleaseManifest(plan, { tenantId, environment }),
      policies: [{ workspaceId: `sandbox:${plan.policyBundles[0]!.policyId}`, files: input.policyFiles, bundle: compiled.manifest, releaseBlockers: compiled.releaseBlockers }],
    }, env);

    const seeded = await input.seed({ ...dossier, case: { ...dossier.case, tenant_id: tenantId } }, {
      tenantId, copy, caseType: plan.metadata.domain === "kyb" ? "kyb_onboarding" : "kyc_onboarding",
      jurisdiction: pack.scope.jurisdiction, harnessPlanDigest: digest(plan.planDigest), policySnapshotDigest: compiled.manifest.sourceDigest,
      policyAuthority: { policyId: pack.id, policyVersion: pack.version, policyBundleDigest: pack.digest, dependencyDigest: plan.dependencyManifestDigest },
      // Records are written outside a run, so no node envelope exists; the digest names the sandbox release.
      permissionEnvelopeDigest: release.manifest.manifestDigest,
    });

    const source = sandboxDocuments(dossier);
    let loaded = 0;
    if (input.loadDocument) {
      for (const document of source.documents) {
        await input.loadDocument(seeded.caseId, document);
        loaded += 1;
      }
    }

    // What the run input carries beyond the case identity:
    // - the policy pin: a node that writes to the case without reading case context (the flow's stop
    //   exit) has no snapshot to take it from. The case service checks it.
    // - the policy jurisdiction: every skill's context envelope needs one, and the corpus subjects
    //   carry no country attribute to fall back on. Without it no skill is called (CONTEXT_MISSING).
    const started = await createRun(db, {
      planDigest: digest(plan.planDigest), tenantId, idempotencyKey: `sandbox:${seeded.caseId}`, sandboxCapture: true,
      runInput: { tenantId, caseId: seeded.caseId, sandboxObservation: true, policySnapshotDigest: compiled.manifest.sourceDigest, jurisdiction: pack.scope.jurisdiction },
    });
    return { runId: started.run.runId, caseId: seeded.caseId, party: input.party, releaseId: release.manifest.releaseId,
      planDigest: digest(plan.planDigest), policyPack: pack.id, policyBlockers: compiled.releaseBlockers.length, records: seeded.recordsWritten,
      documents: loaded, documentsSkipped: source.skipped + (input.loadDocument ? 0 : source.documents.length) };
  };
  return input.recordLaunch ? input.recordLaunch(digest(plan.planDigest), execute) : execute(`sandbox-${randomUUID()}`);
}

/**
 * The evidence pipeline's document ingest for a sandbox case, or undefined where none is configured
 * (EVIDENCE_PIPELINE_URL and EVIDENCE_PIPELINE_TOKEN, as Document Studio uses). Only synthetic corpus
 * documents travel this way; a real case's documents reach the pipeline through the capability gateway.
 */
export function sandboxDocumentLoader(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): ((caseId: string, document: SandboxDocument) => Promise<void>) | undefined {
  const base = env.EVIDENCE_PIPELINE_URL?.trim().replace(/\/$/, "");
  const token = env.EVIDENCE_PIPELINE_TOKEN?.trim();
  if (!base || !token) return undefined;
  return async (caseId, document) => {
    let response: Response;
    try {
      response = await fetcher(`${base}/v1/cases/${encodeURIComponent(caseId)}/documents`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ filename: document.filename, content_base64: document.content.toString("base64") }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new Error("sandbox.evidence_pipeline_unreachable");
    }
    if (!response.ok) throw new Error(`sandbox.document_load_failed: ${document.filename} (${response.status})`);
    const body = await response.json().catch(() => ({})) as { document_sha256?: unknown };
    if (body.document_sha256 !== document.sha256) throw new Error(`sandbox.document_hash_mismatch: ${document.filename}`);
  };
}
