import { join } from "node:path";
import { normalizeTransactionMonitoring, normalizeTransactionStatements, normalizeWiringResult, type MonitorInput, type TransactionScope } from "@ehf/adapters";
import { readManifest, readParty, readSourceFile, type CaseBootstrap, type CorpusRecord } from "@ehf/context-corpus";
import type { AdapterBindingOption, CapabilityAdapterModule } from "./types.js";

export const CORPUS_ROOT_ENV = "CORPUS_ROOT";

export const corpusOperations: AdapterBindingOption[] = [
  { value: "financial.transactions.v1", label: "Corpus transactions (camt.053 replay)", description: "Serves a party's ISO 20022 statements and stated scope, normalized to Transaction and DatasetScope." },
  { value: "business.ownership.discover.v1", label: "Corpus ownership discovery (replay)", description: "Serves a party's registry-style ownership result, normalized to OwnershipInterest, ControlRight and Entity." },
  { value: "screening.sanctions.v1", label: "Corpus sanctions screening (replay)", description: "Serves a screened subject's result over the corpus lists, normalized to ScreeningExecution, WatchlistEntry, ScreeningHit or NegativeSearchEvidence." },
  { value: "screening.pep.v1", label: "Corpus PEP screening (replay)", description: "As sanctions screening, over the corpus PEP list." },
  { value: "transaction.monitor.v1", label: "Corpus monitoring alerts (replay)", description: "Serves a party's monitoring alerts, normalized to Alert." },
];

type Input = { subject?: unknown; accounts?: unknown };

/** The party whose case names this entity (customer or any subject), or the party id itself. */
export function resolveCorpusParty(root: string, subject: string): { id: string; case: CaseBootstrap } {
  for (const entry of readManifest(root).parties) {
    const dossier = readParty(root, entry.id);
    if (dossier.id === subject || dossier.case.subjects.some((s) => s.entity_id === subject)) return { id: dossier.id, case: dossier.case };
  }
  throw new Error("adapter.corpus_subject_unknown");
}

/**
 * Replay a corpus party's provider-form payloads through the real normalizers. The records carry
 * the gateway invocation as a source ref and are marked synthetic; nothing is read from the answer key.
 */
export function replayCorpus(root: string, bindingName: string, input: unknown, ctx: { tenantId: string; invocationId?: string }): { output: Record<string, unknown>; dataset: string } {
  const body = (input && typeof input === "object" ? input : {}) as Input;
  if (typeof body.subject !== "string" || !body.subject) throw new Error("adapter.corpus_subject_missing");
  const accounts = Array.isArray(body.accounts) ? body.accounts.filter((a): a is string => typeof a === "string") : undefined;
  const { id, case: bootstrap } = resolveCorpusParty(root, body.subject);
  const manifest = readManifest(root);
  const context = {
    connectorId: `corpus:${bindingName}`, capabilityId: bindingName, tenantId: ctx.tenantId, subjectId: bootstrap.customer_entity_id,
    ...(ctx.invocationId ? { invocationId: ctx.invocationId } : {}),
  };
  if (bindingName === "transaction.monitor.v1") {
    const payload = JSON.parse(readSourceFile(root, id, "provider/transaction.monitor.v1/alerts.json")) as MonitorInput;
    return { output: { ...normalizeTransactionMonitoring({ ...payload, synthetic: true }, context), party: id }, dataset: manifest.corpus_digest };
  }
  if (bindingName === "screening.sanctions.v1" || bindingName === "screening.pep.v1") {
    const type = bindingName === "screening.pep.v1" ? "pep" : "sanctions";
    const slug = body.subject.includes(".entity.") ? body.subject.split(".entity.")[1]! : undefined;
    if (!slug) throw new Error("adapter.corpus_screening_subject_must_be_an_entity");
    let host: unknown;
    try {
      host = JSON.parse(readSourceFile(root, id, `provider/screening.${type}.v1/${slug}.json`));
    } catch (error) {
      if ((error as Error).message.startsWith("corpus.source_file_unknown")) throw new Error("adapter.corpus_subject_not_screened");
      throw error;
    }
    const out = normalizeWiringResult({
      operationId: `corpus:screening.${type}`, outcome: "passed", error: null, providerCheckId: `corpus-${id.toLowerCase()}-${slug}-${type}`,
      executionMode: "simulation", warnings: ["DEMO_ONLY: test context corpus replay"], host,
    }, { ...context, subjectId: body.subject });
    return { output: { ...out, party: id }, dataset: manifest.corpus_digest };
  }
  if (bindingName === "business.ownership.discover.v1") {
    const host = JSON.parse(readSourceFile(root, id, "provider/business.ownership.discover.v1/host.json")) as unknown;
    // The same normalizer a real wiring connector's result goes through; `simulation` marks the records synthetic.
    const out = normalizeWiringResult({
      operationId: "corpus:business.ownership.discover", outcome: "passed", error: null, providerCheckId: `corpus-${id.toLowerCase()}`,
      executionMode: "simulation", warnings: ["DEMO_ONLY: test context corpus replay"], host,
    }, context);
    return { output: { ...out, party: id }, dataset: manifest.corpus_digest };
  }
  if (bindingName !== "financial.transactions.v1") throw new Error(`adapter.corpus_operation_unknown:${bindingName}`);
  const records = readParty(root, id).records;
  const scope = records.find((r: CorpusRecord) => r.object_type === "DatasetScope")?.data as TransactionScope | undefined;
  const accountEntities: Record<string, string> = {};
  for (const r of records) if (r.object_type === "Account") accountEntities[r.id] = r.data.entity_id as string;
  const out = normalizeTransactionStatements({
    statements: [readSourceFile(root, id, "iso20022/camt.053.xml")], accountEntities, synthetic: true,
    ...(scope ? { scope } : {}), ...(accounts?.length ? { accounts } : {}),
  }, context);
  return { output: { ...out, party: id }, dataset: manifest.corpus_digest };
}

/**
 * Serves the test context corpus (docs/implementation/test-context-corpus.md §8.2). Synthetic by
 * construction, so it is never enabled by default: add it with GATEWAY_ADAPTERS=default,corpus and
 * point CORPUS_ROOT at fixtures/context-corpus. Bind connectors as `corpus:<capability id>`.
 */
export const corpusModule: CapabilityAdapterModule = {
  id: "corpus",
  sourcePolicyClass: "synthetic",
  cloud: "local",
  label: "Test context corpus (replay)",
  supportedKinds: ["tool"],
  enabledByDefault: false,
  create: ({ env }) => ({
    descriptor: async () => ({
      id: "corpus", label: "Test context corpus (replay)", supportedKinds: ["tool"],
      credentialState: env[CORPUS_ROOT_ENV]?.trim() ? "Configured" : "Missing", bindingOptions: corpusOperations,
    }),
    assertCapability: (capability, bindingName) => {
      if (capability.id !== bindingName) throw new Error(`gateway.corpus_binding_capability_mismatch:${bindingName}`);
    },
    invoke: async (bindingName, _capability, input, context) => {
      const root = env[CORPUS_ROOT_ENV]?.trim();
      if (!root) throw new Error("gateway.corpus_not_configured");
      if (!corpusOperations.some((o) => o.value === bindingName)) throw new Error(`adapter.corpus_operation_unknown:${bindingName}`);
      const { output, dataset } = replayCorpus(join(root), bindingName, input, { tenantId: context.tenantId, ...(context.invocationId ? { invocationId: context.invocationId } : {}) });
      return { output, provider: "corpus", model: dataset.slice(0, 16), providerRequestId: null, inputTokens: null, outputTokens: null, costUsd: 0 };
    },
  }),
};
