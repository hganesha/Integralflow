import { verifyContextPackDigest, type ContextPack } from "@ehf/context-plane";
import { casePackPrefix, withContextTenant, type ContextStore } from "@ehf/context-store";
import type { Database } from "@ehf/persistence";
import { z } from "zod";
import { withSandboxTenant } from "./sandbox-history.js";

const digits = z.string().regex(/^\d{1,15}$/).transform(Number);
export const sandboxContextResultsQuery = z.object({
  nodeId: z.string().min(1).max(220), attempt: digits.pipe(z.number().int().max(2_147_483_647)),
  fencingEpoch: digits, packDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

type Scope = z.infer<typeof sandboxContextResultsQuery> & { tenantId: string; runId: string; caseId: string; actor: string };
type Row = Record<string, unknown>;
type Field = { label: string; value: string | number };
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const allowedText = new Set("individual corporate company private_company public_company listed_company business organization organisation person natural_person legal_entity customer beneficial_owner director officer shareholder signatory settlor trustee protector beneficiary controlling_person completed partial failed blocked needs_evidence needs_review needs_human decided pending approved rejected verified unverified unknown confirmed clear potential_match high medium low enhanced standard simplified sanctions pep adverse_media current expired not_yet_valid not_extracted".split(" "));
const labels = {
  subject_type: "Subject type", customer_type: "Customer type", entity_type: "Entity type", role: "Role",
  employees: "Employees", legal_name: "Legal name", status: "Status", decision: "Decision",
  tier: "Risk tier", screening_type: "Screening type", jurisdiction: "Jurisdiction",
  review_required: "Review required", promotion_allowed: "Promotion allowed", required: "Required",
  truncated: "Truncated", verified: "Verified", page_count: "Pages", confidence: "Confidence",
} as const;
const collections = {
  profiles: "Profiles", classifications: "Classifications", findings: "Findings", requirements: "Requirements",
  matches: "Matches", candidates: "Candidates", extractions: "Extractions", records: "Records",
  events: "Events", assessments: "Assessments", triggers: "Triggers", gaps: "Gaps", relationships: "Relationships",
  subjects: "Subjects", conflicts: "Conflicts", hits: "Hits", decisions: "Decisions", observations: "Observations",
} as const;
const knownStatus = (value: unknown) => typeof value === "string" && allowedText.has(value.toLowerCase()) ? value.toUpperCase() : null;

function previewFields(row: Row, syntheticNames: ReadonlySet<string>): Field[] {
  return Object.entries(labels).flatMap(([key, label]): Field[] => {
    const value = row[key];
    if (key === "legal_name") return typeof value === "string" && syntheticNames.has(value) ? [{ label, value }] : [];
    if (key === "jurisdiction") return typeof value === "string" && /^[A-Z]{2}$/.test(value) ? [{ label, value }] : [];
    if (["review_required", "promotion_allowed", "required", "truncated", "verified"].includes(key)) {
      return typeof value === "boolean" ? [{ label, value: value ? "Yes" : "No" }] : [];
    }
    if (["employees", "page_count", "confidence"].includes(key)) {
      return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= (key === "confidence" ? 1 : 1_000_000_000)
        ? [{ label, value }] : [];
    }
    return typeof value === "string" && allowedText.has(value.toLowerCase()) ? [{ label, value: value.toLowerCase().replaceAll("_", " ") }] : [];
  });
}

export function projectContextResults(pack: ContextPack | null, output: unknown, workStatus: unknown) {
  const admitted = (pack?.sections ?? []).filter(section => !section.quarantined && !pack?.budget.droppedSectionIds.includes(section.id));
  const syntheticNames = new Set<string>();
  for (const section of admitted) {
    if (section.kind !== "case" || !Array.isArray(section.value)) continue;
    for (const record of section.value) {
      const row = object(record);
      const data = object(row.data);
      const name = object(data.profile).legal_name;
      if (row.synthetic === true && row.object_type === "Party" && ["company", "corporate", "business", "private_company", "public_company", "listed_company"].includes(String(data.customer_type).toLowerCase())
        && typeof name === "string" && /^[\p{L}\p{N}][\p{L}\p{N} .,&'()-]{1,119}$/u.test(name)) syntheticNames.add(name);
    }
  }
  const context = admitted.slice(0, 20).map(section => {
    const rows = Array.isArray(section.value) ? section.value : section.value == null ? [] : [section.value];
    const fields = rows.slice(0, 2).flatMap(row => {
      const selected = object(row);
      const data = object(selected.data);
      return previewFields({ ...selected, ...data, ...object(data.profile) }, syntheticNames);
    });
    const distinct = [...new Map(fields.map(field => [`${field.label}:${field.value}`, field])).values()].slice(0, 5);
    return { id: section.id, count: rows.length, fields: distinct };
  });
  const result = object(output);
  const computation = object(result.computation);
  const payload = object(computation.payload ?? result.payload ?? result);
  const status = knownStatus(computation.business_status ?? result.status ?? workStatus);
  return {
    context,
    outcome: output == null ? null : {
      status,
      fields: previewFields(payload, syntheticNames).slice(0, 6),
      groups: Object.entries(collections).flatMap(([key, label]) => {
        const rows = payload[key];
        if (!Array.isArray(rows)) return [];
        return [{ label, count: rows.length, fields: previewFields(object(rows[0]), syntheticNames).slice(0, 5) }];
      }).slice(0, 8),
    },
  };
}

async function readContextPack(store: ContextStore | null, scope: Scope, started: Date, next: Date | null) {
  if (!store) return null;
  const row = await withContextTenant(store, scope.tenantId, async client => {
    const result = await client.query<{ pack: ContextPack | null; pack_digest: string; pack_blob_name: string | null }>(`
      select pack,pack_digest,pack_blob_name from context.packs
      where tenant_id=$1 and case_id=$2 and run_id=$3 and node_id=$4 and attempt=$5
        and ($6::text is null or pack_digest=$6)
        and recorded_at >= $7 and ($8::timestamptz is null or recorded_at < $8)
      order by recorded_at desc limit 1
    `, [scope.tenantId, scope.caseId, scope.runId, scope.nodeId, scope.attempt, scope.packDigest ?? null, started, next]);
    return result.rows[0];
  }, { readOnly: true });
  if (!row) return null;
  if (row.pack) return row.pack;
  const expected = `${casePackPrefix(scope.tenantId, scope.caseId)}${row.pack_digest}.json`;
  if (!store.packBlobs || row.pack_blob_name !== expected) return null;
  const pack = JSON.parse((await store.packBlobs.get(expected)).toString()) as ContextPack;
  return pack.packDigest === row.pack_digest && verifyContextPackDigest(pack) ? pack : null;
}

export async function readSandboxContextResults(db: Database, store: ContextStore | null, scope: Scope) {
  const attempt = await withSandboxTenant(db, scope, async client => {
    const result = await client.query<{ started_at: Date; next_start: Date | null }>(`
      select a.started_at, (
        select min(n.started_at) from harness_runtime.node_attempts n
        where n.run_id=a.run_id and n.node_id=a.node_id and n.attempt>a.attempt
      ) as next_start
      from harness_runtime.node_attempts a join harness_runtime.runs r on r.run_id=a.run_id
      where r.tenant_id=$1 and a.run_id=$2 and a.node_id=$3 and a.attempt=$4 and a.fencing_epoch=$5
    `, [scope.tenantId, scope.runId, scope.nodeId, scope.attempt, scope.fencingEpoch]);
    return result.rows[0];
  });
  if (!attempt) return projectContextResults(null, null, null);
  const [pack, stored] = await Promise.all([
    readContextPack(store, scope, attempt.started_at, attempt.next_start),
    withSandboxTenant(db, scope, async client => {
      const { rows } = await client.query<{ output: unknown; status: string }>(`
        select n.output,w.status from workflow.work_items w
        join workflow.node_outputs n using (tenant_id, work_item_id)
        where w.tenant_id=$1 and w.case_id=$2 and w.document->'constraints'->>'runId'=$3
          and w.document->'constraints'->>'nodeId'=$4 and n.created_at >= $5
          and ($6::timestamptz is null or n.created_at < $6)
        order by n.created_at desc limit 1
      `, [scope.tenantId, scope.caseId, scope.runId, scope.nodeId, attempt.started_at, attempt.next_start]);
      return rows[0];
    }),
  ]);
  if (pack || stored) await withSandboxTenant(db, scope, async client => {
    await client.query(`
      insert into harness_control.sandbox_observation_reads (tenant_id,run_id,kind,node_id,attempt,fencing_epoch,actor)
      values ($1,$2,'context-results',$3,$4,$5,$6)
    `, [scope.tenantId, scope.runId, scope.nodeId, scope.attempt, scope.fencingEpoch, scope.actor]);
  });
  return projectContextResults(pack, stored?.output, stored?.status);
}
