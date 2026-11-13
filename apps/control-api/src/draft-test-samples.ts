import { draftTestSampleSchema, type DraftTestSample } from "@ehf/contracts";
import type { AuthoringDraftRecord } from "@ehf/persistence";
import records from "../../fincrime-host/examples/records.json" with { type: "json" };

/** Schema-shaped placeholders are explicitly labelled; they are never claims of observed data. */
export function sampleValue(raw: unknown, depth = 0): unknown {
  if (!raw || typeof raw !== "object" || depth > 8) return null;
  const s = raw as Record<string, any>;
  if (s.default !== undefined) return s.default;
  if (s.examples?.length) return s.examples[0];
  if (s.const !== undefined) return s.const;
  if (s.enum?.length) return s.enum[0];
  if (s.anyOf?.length || s.oneOf?.length) return sampleValue((s.anyOf ?? s.oneOf)[0], depth + 1);
  if (s.type === "object" || s.properties) return Object.fromEntries(Object.entries(s.properties ?? {}).map(([key, value]) => [key, sampleValue(value, depth + 1)]));
  if (s.type === "array") return Array.from({ length: Math.min(s.minItems ?? 0, 5) }, () => sampleValue(s.items, depth + 1));
  if (s.type === "boolean") return false;
  if (s.type === "number" || s.type === "integer") return s.minimum ?? 0;
  if (s.type === "string") return s.format === "date-time" ? "2026-11-07T12:00:00.000Z" : s.format === "date" ? "2026-11-07" : "sample".padEnd(Math.min(s.minLength ?? 0, 100), "_");
  return {};
}

export function draftTestSamples(draft: Pick<AuthoringDraftRecord, "parsedWorkflow" | "parsedPackage" | "sourceFiles">): DraftTestSample[] {
  const workflow = draft.parsedWorkflow as { spec?: { inputs?: unknown } };
  const pkg = draft.parsedPackage as { capabilities?: Array<{ id: string; kind: string; outputSchema?: unknown }> };
  const input = sampleValue(workflow.spec?.inputs ?? { type: "object" }) as Record<string, unknown>;
  const capabilityOutputs = Object.fromEntries((pkg.capabilities ?? []).filter(c => c.kind !== "model").map(c => [c.id, sampleValue(c.outputSchema)]));
  const groupedRecords: Record<string, unknown[]> = {};
  for (const record of records) (groupedRecords[record.object_type] ??= []).push({ ...record, object_id: record.id });
  const context = { asOfTime: "2026-01-01T00:00:00.000Z", recordsAsOf: { asOf: "2026-01-01T00:00:00.000Z", knowledgeCutoff: "2026-01-01T00:00:00.000Z" }, case: { caseId: "sample-case" }, subjects: [{ subject_id: "alice", display_name: "Alice Example", attributes: { country: "US", customerType: "individual" } }], facts: [], records: groupedRecords };
  const samples: DraftTestSample[] = [
    { id: "synthetic-individual", name: "Synthetic individual", description: "Alice Example and the bundled synthetic financial-crime records. Tool outputs are editable schema placeholders.", input, context, capabilityOutputs },
    { id: "synthetic-company", name: "Synthetic company", description: "Acme and the bundled synthetic financial-crime records. Tool outputs are editable schema placeholders.", input: { ...input }, context: { ...context, subjects: [{ subject_id: "acme", display_name: "Acme", attributes: { country: "US", customerType: "company" } }] }, capabilityOutputs },
    { id: "schema-template", name: "Input schema template", description: "Defaults, examples and required field types from the saved workflow. Fill in values before running.", input: { ...input }, context: {}, capabilityOutputs },
  ];
  for (const [path, source] of Object.entries(draft.sourceFiles ?? {})) {
    if (!/^samples\/[a-z0-9._-]+\.json$/i.test(path)) continue;
    try {
      const parsed = draftTestSampleSchema.safeParse({ ...JSON.parse(source), id: path });
      if (parsed.success) samples.push(parsed.data);
    } catch { /* Invalid sample documents do not prevent the author editing the draft. */ }
  }
  return samples;
}
