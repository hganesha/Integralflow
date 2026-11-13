import { randomUUID } from "node:crypto";
import { mintIntegrationEnvelope, type JwtSigner } from "@ehf/execution-auth";
import {
  claimContextRefresh,
  contextRefreshRunStatus,
  finishContextRefresh,
  type Database,
} from "@ehf/persistence";

export async function processContextRefresh(
  db: Database,
  options: {
    tenantId: string;
    onClaim?: () => () => void;
    signer?: JwtSigner;
    secret?: string;
    start: (
      body: unknown,
      headers: Record<string, string>,
    ) => Promise<{ run: { runId: string } }>;
  },
): Promise<boolean> {
  const job = await claimContextRefresh(db, options.tenantId);
  if (!job) return false;
  const finish = options.onClaim?.();
  try {
    if (job.run_id) {
      const status = await contextRefreshRunStatus(db, job);
      if (!status) throw new Error("context_source.refresh_run_missing");
      await finishContextRefresh(db, job, { status });
      return true;
    }
    const nonce = `context-refresh:${job.tenant_id}:${job.binding_id}:${job.revision}:${job.scheduled_for.toISOString()}`;
    const signing = options.signer
      ? { signer: options.signer }
      : options.secret
        ? { secret: options.secret }
        : {};
    const token = await mintIntegrationEnvelope({
      ...signing,
      envelopeId: `context_refresh_${randomUUID()}`,
      tenantId: job.tenant_id,
      deploymentId: "context-refresh",
      bindingId: job.binding_id,
      bindingRevision: job.revision,
      planDigest: job.plan_digest,
      caseId: String(job.run_input.caseId),
      intent: "start_run",
      commandType: null,
      nonce,
      ttlSeconds: 60,
    });
    const result = await options.start(
      {
        planDigest: job.plan_digest,
        input: { ...job.run_input, tenantId: job.tenant_id },
        sourceContextDigest: job.source_context_digest,
      },
      { "x-integration-envelope": token, "idempotency-key": nonce },
    );
    if (!result.run?.runId)
      throw new Error("context_source.refresh_response_invalid");
    await finishContextRefresh(db, job, { runId: result.run.runId });
  } catch {
    await finishContextRefresh(db, job, {
      error: "context_source.refresh_dispatch_failed",
    });
  } finally {
    finish?.();
  }
  return true;
}
