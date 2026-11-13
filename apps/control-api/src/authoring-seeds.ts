import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@ehf/persistence";
import { loadAuthoringTemplates } from "./authoring-templates.js";
import { analyzeAuthoringSources } from "./authoring.js";
import { validateSourceFiles } from "./harnessc.js";

/** Deployment-owned starter drafts. Never overwrite an author's work or advance its lifecycle. */
export async function seedAuthoringDrafts(db: Database, tenantId: string, domainsPath: string) {
  if (!tenantId.trim()) throw new Error("authoring.seed_tenant_required");
  // The released starter processes: standard KYC and KYB, and the escalation targets (enhanced due
  // diligence for both, simplified for an eligible entity). Each still compiles, is approved and is released.
  const STARTERS = ["kyc-agentic", "kyb-agentic", "kyc-edd-agentic", "kyb-edd-agentic", "kyb-sdd-agentic"];
  const templates = (await loadAuthoringTemplates(domainsPath)).filter(template => STARTERS.includes(template.id));
  // Resolve every dependency and analyze both packages before any database write.
  const seeds = templates.map(template => {
    const analysis = analyzeAuthoringSources(template.packageSource, template.workflowSource);
    if (analysis.diagnostics.some(item => item.severity === "error")) throw new Error(`authoring.seed_invalid:${template.id}`);
    return { template, analysis, sourceFiles: validateSourceFiles(template.sourceFiles) };
  });
  const created: string[] = [];
  const client = await db.connect();
  try {
    await client.query("begin");
    for (const { template, analysis, sourceFiles } of seeds) {
      // Stable per tenant/template, independent of source revisions. ON CONFLICT also
      // protects archived, edited, approved and published drafts on a later deployment.
      const draftId = `draft_${createHash("sha256").update(JSON.stringify([tenantId, template.id])).digest("hex").slice(0, 32)}`;
      const result = await client.query(`
        with seeded as (
          insert into harness_control.authoring_drafts(
            draft_id, tenant_id, name, domain, version, status, package_source, workflow_source,
            parsed_package, parsed_workflow, diagnostics, source_files
          ) values ($1, $2, $3, $4, $5, 'DRAFT', $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)
          on conflict (draft_id) do nothing returning draft_id
        )
        insert into harness_control.authoring_events(event_id, draft_id, revision, event_type, actor, details)
        select $12, draft_id, 1, 'draft.created', 'system:deployment', $13::jsonb from seeded
        returning draft_id
      `, [draftId, tenantId, analysis.metadata.name, analysis.metadata.domain, analysis.metadata.version,
        template.packageSource, template.workflowSource, JSON.stringify(analysis.parsedPackage),
        JSON.stringify(analysis.parsedWorkflow), JSON.stringify(analysis.diagnostics), JSON.stringify(sourceFiles),
        `evt_${randomUUID()}`, JSON.stringify({ source: "deployment-template", templateId: template.id })]);
      if (result.rowCount) created.push(template.id);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
  return { created, templates: templates.map(template => template.id) };
}
