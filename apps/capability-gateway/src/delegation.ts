import { issueDelegatedEnvelope, type JwtSigner } from "@ehf/execution-auth";
import {
  currentFencingEpoch,
  getBusinessSkill,
  getExecutionWorkItem,
  getPlan,
  getRun,
  requireExecutableRelease,
  type Database,
} from "@ehf/persistence";
import type { DelegateEnvelope } from "./adapters/types.js";

/**
 * The gateway's in-process delegation (skill.execution.v1 §6.1).
 *
 * A delegated envelope is presented only by a skill host and accepted only by this gateway,
 * so issuing it here instead of at the control plane removes a network hop and the gateway's
 * need for any identity at the control plane, without widening anyone's authority: the same
 * durable-state checks run (run, fence, release, work lease, node permission, the skill's
 * pinned manifest and declared dependencies), and under `ENVELOPE_SIGNER=private_key` the
 * envelope is signed with a key only the gateway holds and only the gateway verifies.
 */
export function createInProcessDelegation(input: {
  db: Database;
  /** Verifies the parent node envelope: the shared secret, or the control plane's public key. */
  parentVerifier: string;
  /** Signs the delegated envelope: the gateway's own key, or (development) the shared secret. */
  signer?: JwtSigner;
  secret?: string;
  environment: string;
}): DelegateEnvelope {
  return async (callerTenantId, parentEnvelope, request) => {
    const issued = await issueDelegatedEnvelope({
      db: input.db,
      reads: { getRun, currentFencingEpoch, getPlan, requireExecutableRelease, getExecutionWorkItem, getBusinessSkill },
      envelopeVerifier: input.parentVerifier,
      ...(input.signer ? { envelopeSigner: input.signer } : { envelopeSecret: input.secret! }),
      environment: input.environment,
    }, callerTenantId, parentEnvelope, request);
    return { envelope: issued.envelope, expiresAt: issued.expiresAt, capabilities: issued.capabilities };
  };
}
