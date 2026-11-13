import { HUMAN_ROLES, type Principal } from "@ehf/identity";
import { UpstreamError, type Upstream } from "./upstream.js";

/** Resolve managed roles on every request, including requests using an existing session. */
export function directoryAccess(upstream: Upstream): (principal: Principal) => Promise<Principal> {
  return async principal => {
    if (principal.actorType !== "human") return principal;
    const result = await upstream("control-api", "GET", "/v1/identity/access", principal);
    if (result.status !== 200 || !result.body || !("user" in result.body)) throw new UpstreamError(503, "users.directory_unavailable");
    const user = result.body.user;
    // Existing provider-managed assignments remain valid until explicitly managed here.
    if (user === null) return principal;
    if (![principal.subjectId, principal.directorySubjectId].includes(user.subjectId) || !Array.isArray(user.roles) || !user.roles.length || user.roles.some((id: unknown) => !HUMAN_ROLES.some(role => role.id === id))) throw new UpstreamError(503, "users.directory_invalid");
    return { ...principal, roles: user.roles, displayName: user.displayName, email: user.email };
  };
}
