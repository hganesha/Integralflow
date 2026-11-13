import { STUDIO_SANDBOX } from "../navigation";

export type SandboxTestKind = "rehearsal" | "probe" | "document";

export const sandboxPath = (runId: string) => `${STUDIO_SANDBOX}/${encodeURIComponent(runId)}`;

export function sandboxTestSearch(kind: SandboxTestKind, target?: string) {
  return { kind, target };
}
