import { actionsForRoles } from '@ehf/identity';
import { validateResponse } from '@ehf/ui-contracts/validate';
import type { FastifyInstance } from 'fastify';
import type { sessionAccess } from './session.js';
import { delegatedHeaders, errorResponse } from './relay.js';
import { experienceReader, type Row } from './experience-read.js';
import { runSummary } from './platform-experience.js';
import { UpstreamError, type Upstream } from './upstream.js';

export function registerOperationsExperience(app: FastifyInstance, access: ReturnType<typeof sessionAccess>, upstream: Upstream, env: NodeJS.ProcessEnv) {
  for (const [operation, path] of [
    ['getOverview', '/api/v1/overview'],
    ['getFincrimeAssuranceMissionControl', '/api/v1/fincrime/assurance/mission-control'],
  ] as const) app.get(path, async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-correlation-id', request.id);
    try {
      const principal = await access.resolver.resolve(request);
      const actions = actionsForRoles(principal.roles);
      if (principal.actorType !== 'human' || ![...actions].some(action => action.endsWith('.read'))) throw new UpstreamError(403, 'authorization.role_missing');
      const reader = experienceReader(upstream, principal, delegatedHeaders(request, access, env));
      const generatedAt = new Date().toISOString();
      let body: Row;
      {
        const runs = actions.has('run.read') ? await reader.pages('control-api', '/v1/runs', 'runs') : null;
        if (operation === 'getFincrimeAssuranceMissionControl') {
          const queue = actions.has('human_work.read') ? (await reader.call('control-api', '/v1/operations/human-work?limit=500')).items as Row[] : null;
          const runCounts: Record<string, number> = {};
          for (const run of runs ?? []) runCounts[run.status] = (runCounts[run.status] ?? 0) + 1;
          const agents = new Map<string, { agentId: string; running: null; waitingHuman: number; failed: null }>();
          for (const item of queue ?? []) {
            const agentId = item.workItem.constraints?.agentId;
            if (!agentId) continue;
            const current = agents.get(agentId) ?? { agentId, running: null, waitingHuman: 0, failed: null };
            current.waitingHuman++;
            agents.set(agentId, current);
          }
          body = { generatedAt, kpis: runs ? [{ key: 'runs', label: 'Recorded runs', value: runs.length, unit: null, definition: 'All run pages visible to your tenant and role; this is an all-time count.' }] : [],
            humanWork: { open: queue?.length ?? null, overdue: queue?.filter(item => item.overdue).length ?? null,
              escalated: queue?.filter(item => item.escalated).length ?? null,
              awaitingSecondApprover: queue?.filter(item => item.requiredApprovals > item.decisions.length && item.decisions.length > 0).length ?? null },
            runs: runCounts, agents: [...agents.values()], exceptions: queue?.some(item => item.overdue) ? [{ kind: 'overdue', label: 'Overdue human work', count: queue.filter(item => item.overdue).length, route: '/platform/human-work' }] : [],
            limitations: [...(!runs ? ['Run totals are unavailable to your role.'] : []), ...(!queue ? ['Human-work totals are unavailable to your role.'] : []),
              ...(queue && queue.length >= 500 ? ['Human-work counts cover the first 500 queue items.'] : []), 'Agent counts describe the human queue only; runtime activity is not inferred from catalog definitions.'] };
        } else {
          const plans = actions.has('plan.read') ? await reader.pages('control-api', '/v1/plan-records', 'records') : null;
          const planById = new Map<string, Row>((plans ?? []).map(record => [record.plan.planDigest, record.plan]));
          const active = (runs ?? []).filter(run => ['queued', 'running', 'retrying', 'manual_review', 'cancelling'].includes(run.status));
          const activeRuns: Row[] = [];
          for (const run of active.slice(0, 20)) {
            let plan = planById.get(run.planDigest);
            if (!plan) plan = (await reader.call('control-api', `/v1/runs/${encodeURIComponent(run.runId)}/execution`)).plan;
            activeRuns.push(runSummary(run, plan!));
          }
          const recent = (runs ?? []).filter(run => Date.parse(run.createdAt) >= Date.parse(generatedAt) - 86400000);
          const count = (status: string) => runs ? runs.filter(run => run.status === status).length : null;
          body = { window: 'Run counts: all recorded runs; cost: runs created in the past 24 hours', admittedHarnessesCount: plans?.length ?? null,
            activeRunsCount: runs ? active.length : null, queuedCount: count('queued'), runningCount: count('running'), retryingCount: count('retrying'),
            needsAttentionCount: runs ? runs.filter(run => ['manual_review', 'failed', 'denied'].includes(run.status)).length : null,
            failedCount: count('failed'), deniedCount: count('denied'), staleLeaseCount: null,
            reportedCost24h: { reportedUsd: recent.reduce((sum, run) => sum + run.costUsd, 0), complete: runs !== null && recent.every(run => run.costComplete) },
            activeRuns, recentIssues: [], issuesReported: false, serviceStatus: [], modelTiers: [], modelTiersReported: false, runtimeMode: ['OpenRouter', 'Recorded'].includes(env.RUNTIME_MODE ?? '') ? env.RUNTIME_MODE : null, fixture: false,
            globalReadiness: 'Degraded', generatedAt, telemetryFreshThrough: null,
            limitations: ['Counts come from tenant-scoped records. Active-run details show at most 20 runs. Lease health, issue telemetry and model-tier health are not inferred.', ...(!runs ? ['Run totals are unavailable to your role.'] : []), ...(!plans ? ['Plan totals are unavailable to your role.'] : [])] };
        }
      }
      if (!validateResponse(operation, 200, body).valid) throw new UpstreamError(502, 'bff.upstream_contract_invalid');
      return body;
    } catch (error) { const failure = errorResponse(error, request); return reply.code(failure.status).send(failure.body); }
  });
}
