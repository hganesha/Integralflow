type Row = Record<string, unknown>;

const LIST_KEYS: Readonly<Record<string, string>> = {
  getAuthoringDrafts: 'drafts',
  getAuthoringTemplates: 'templates',
  getAdminProviders: 'providers',
  getAdminModelProfiles: 'profiles',
  getAdminSettings: 'sections',
  getAdminChangeLog: 'changes',
};

function withoutCreationFlag(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { created: _created, ...record } = value as Row;
  return record;
}

/** The legacy browser contract calls an agent instruction a skill. Keep this
 * compatibility translation at the BFF; canonical business skills stay separate. */
function instructionView(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { instruction, created: _created, ...record } = value as Row;
  return { ...record, skill: instruction };
}

function page(body: Row, items: unknown[]) {
  return { items, nextCursor: body.nextCursor ?? null, generatedAt: body.generatedAt ?? new Date().toISOString() };
}

function releaseRecordView(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return (value as Row).record ?? value;
}

/** Adapt only reviewed service envelopes. Unknown fields and malformed rows remain
 * visible to response validation rather than being silently replaced with empty data. */
export function platformRelayView(operation: string, body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const value = body as Row;
  if (operation === 'getGatewayDecisions' && Array.isArray(value.receipts)) {
    return page(value, value.receipts.map(receipt => {
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return receipt;
      const row = receipt as Row;
      const result = row.result && typeof row.result === 'object' && !Array.isArray(row.result) ? row.result as Row : null;
      const usage = result?.usage && typeof result.usage === 'object' && !Array.isArray(result.usage) ? result.usage as Row : null;
      return {
        receiptId: row.invocationId, occurredAt: row.createdAt,
        runId: row.runId, nodeId: row.nodeId, attempt: row.attempt, fencingEpoch: row.fencingEpoch,
        capabilityId: row.capabilityId, effect: row.effect, decision: row.decision, reasonCode: row.reasonCode,
        // These values are not retained by receipt persistence. Never infer them from mutable configuration.
        adapterBindingId: null, envelopeDigest: null, idempotencyKey: null,
        latencyMs: result?.latencyMs ?? null, resultStatus: result?.status ?? null,
        provider: result?.provider ?? null, model: result?.model ?? null, errorCode: result?.errorCode ?? null,
        usage: usage ? {
          inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null,
          costUsd: usage.costUsd ?? null,
        } : null,
        requestDigest: row.requestDigest, resultDigest: row.receiptDigest ?? null,
        traceId: row.traceId ?? null, spanId: row.spanId ?? null,
      };
    }));
  }
  const listKey = LIST_KEYS[operation];
  if (listKey && Array.isArray(value[listKey])) return page(value, value[listKey]);
  if (operation === 'getAuthoringSkills' && Array.isArray(value.instructions)) {
    return page(value, value.instructions.map(instructionView));
  }
  if (operation === 'getReleases' && Array.isArray(value.releases)) {
    return {
      releases: value.releases.map(releaseRecordView),
      generatedAt: value.generatedAt ?? new Date().toISOString(),
    };
  }
  if (operation === 'postReleases' || operation === 'postReleasesReleaseIdTransition' || operation === 'postReleasesReleaseIdRollback') {
    return releaseRecordView(value);
  }
  if (operation === 'postAuthoringAgents' || operation === 'putAdminModelProfilesProfileId') {
    return withoutCreationFlag(value);
  }
  if (operation === 'postAuthoringSkills') return instructionView(value);
  if (operation === 'postAuthoringImportGithub' && Array.isArray(value.instructions) && value.agent) {
    const { instructions, ...result } = value;
    return { ...result, agent: withoutCreationFlag(value.agent), skills: instructions.map(instructionView) };
  }
  return body;
}
