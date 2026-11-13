import { randomUUID } from "node:crypto";
import { businessDecisionSchema } from "@ehf/contracts";
import type { Database } from "@ehf/persistence";
import type { PoolClient } from "pg";
import type { SandboxRunResult } from "./sandbox-run.js";

type Scope = { tenantId: string; environment: string };
type Launch = Scope & { draftId: string; key: string; actor: string; revision: number; party: string };
type Row = { actor: string; revision: number; party: string; result: SandboxRunResult | null; created_at: Date };

export async function withSandboxTenant<T>(db: Database, scope: { tenantId: string }, read: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const result = await read(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const view = (row: Row & { draft_id: string; process_name?: string; status?: string; terminal_outcome?: string | null }) => ({
  ...row.result!, draftId: row.draft_id, revision: row.revision, createdAt: row.created_at.toISOString(),
  processName: row.process_name ?? row.draft_id, status: row.status ?? "queued", outcome: row.terminal_outcome ?? null,
});

export async function readSandboxHistory(db: Database, scope: Scope, runId?: string) {
  return withSandboxTenant(db, scope, async client => {
    const { rows } = await client.query<Row & { draft_id: string; process_name: string; status: string; terminal_outcome: string | null }>(`
      select l.*, r.status, r.terminal_outcome, p.plan->'metadata'->>'name' as process_name
      from harness_control.sandbox_launches l
      join harness_runtime.runs r on r.run_id = l.run_id and r.tenant_id = l.tenant_id
      join harness_control.plans p on p.tenant_id = r.tenant_id and p.plan_digest = r.plan_digest
      where l.tenant_id = $1 and l.environment = $2 and l.run_id is not null
        and ($3::text is null or l.run_id = $3)
      order by l.created_at desc, l.run_id desc limit 50
    `, [scope.tenantId, scope.environment, runId ?? null]);
    return rows.map(view);
  });
}

/** Gate receipts from work items belonging to this run, projected without case facts or action payloads. */
export async function readSandboxPolicy(db: Database, scope: Scope, run: SandboxRunResult) {
  return withSandboxTenant(db, scope, async client => {
    const { rows } = await client.query<{ node_id: string; output: unknown }>(`
      select w.document->'constraints'->>'nodeId' as node_id, n.output
      from workflow.work_items w
      join workflow.node_outputs n using (tenant_id, work_item_id)
      where w.tenant_id = $1 and w.case_id = $2 and w.plan_digest = $3
        and w.document->'constraints'->>'runId' = $4
        and n.output->>'apiVersion' = 'harness.factory/business-decision-v2'
      order by n.created_at, n.work_item_id
    `, [scope.tenantId, run.caseId, run.planDigest, run.runId]);
    return rows.flatMap(row => {
      const parsed = businessDecisionSchema.safeParse(row.output);
      if (!parsed.success || !row.node_id) return [];
      const { caseId, planDigest, tenantId, decisionId, gateId, evaluatedAt, result } = parsed.data;
      if (caseId !== run.caseId || planDigest !== run.planDigest || tenantId !== scope.tenantId) return [];
      return [{
        nodeId: row.node_id, decisionId, gateId, evaluatedAt, state: result.state,
        reasonCodes: result.reasonCodes, gaps: result.gaps.map(({ code, path }) => ({ code, path })),
        actions: result.actions.map(action => action.kind === "case_command" ? action.commandType : action.kind),
      }];
    });
  });
}

function matches(row: Row, launch: Launch) {
  if (row.actor !== launch.actor || row.revision !== launch.revision || row.party !== launch.party) {
    throw new Error("sandbox.idempotency_conflict");
  }
}

export async function findSandboxReplay(db: Database, launch: Launch) {
  return withSandboxTenant(db, launch, async client => {
    const { rows } = await client.query<Row>(`
      select actor, revision, party, result from harness_control.sandbox_launches
      where tenant_id=$1 and environment=$2 and draft_id=$3 and request_key=$4
    `, [launch.tenantId, launch.environment, launch.draftId, launch.key]);
    if (!rows[0]) return null;
    matches(rows[0], launch);
    return rows[0].result;
  });
}

/** Claim the launch before case writes. A retried launch reuses the corpus seed's stable copy ID. */
export async function recordSandboxLaunch(
  db: Database, launch: Launch, planDigest: string, execute: (copyId: string) => Promise<SandboxRunResult>,
) {
  const key = [launch.tenantId, launch.environment, launch.draftId, launch.key];
  const leaseId = randomUUID();
  const copyId = `sandbox-${randomUUID()}`;
  const claim = await withSandboxTenant(db, launch, async client => {
    await client.query(`
      insert into harness_control.sandbox_launches
        (tenant_id, environment, draft_id, request_key, revision, party, actor, copy_id, plan_digest)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing
    `, [...key, launch.revision, launch.party, launch.actor, copyId, planDigest]);
    const { rows: [row] } = await client.query<Row & { copy_id: string; plan_digest: string }>(`
      select * from harness_control.sandbox_launches
      where tenant_id=$1 and environment=$2 and draft_id=$3 and request_key=$4 for update
    `, key);
    if (!row) throw new Error("sandbox.launch_missing");
    matches(row, launch);
    if (row.result) return row;
    if (row.plan_digest !== planDigest) throw new Error("sandbox.idempotency_conflict");
    const claimed = await client.query(`
      update harness_control.sandbox_launches set lease_id=$5, lease_until=now() + interval '30 minutes'
      where tenant_id=$1 and environment=$2 and draft_id=$3 and request_key=$4
        and (lease_until is null or lease_until < now())
    `, [...key, leaseId]);
    if (!claimed.rowCount) throw new Error("sandbox.launch_in_progress");
    return row;
  });
  if (claim.result) return claim.result;
  try {
    const result = await execute(claim.copy_id);
    await withSandboxTenant(db, launch, async client => {
      const updated = await client.query(`
        update harness_control.sandbox_launches set run_id=$6, result=$7, lease_id=null, lease_until=null
        where tenant_id=$1 and environment=$2 and draft_id=$3 and request_key=$4 and lease_id=$5
      `, [...key, leaseId, result.runId, result]);
      if (!updated.rowCount) throw new Error("sandbox.launch_in_progress");
    });
    return result;
  } catch (error) {
    await withSandboxTenant(db, launch, client => client.query(`
      update harness_control.sandbox_launches set lease_id=null, lease_until=null
      where tenant_id=$1 and environment=$2 and draft_id=$3 and request_key=$4 and lease_id=$5
    `, [...key, leaseId])).catch(() => undefined);
    throw error;
  }
}
