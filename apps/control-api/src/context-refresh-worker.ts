import { setTimeout as delay } from "node:timers/promises";
import { createWorkloadAuthorization } from "@ehf/identity";
// This process has no source, case or control database credentials. The service scopes each tick.
const authorization = createWorkloadAuthorization({
  staticTokenEnv: "CONTEXT_REFRESH_SERVICE_TOKEN",
});
const base = process.env.CONTROL_API_URL ?? "http://control-api:4100";
const stopping = new AbortController();
process.once("SIGTERM", () => stopping.abort());
process.once("SIGINT", () => stopping.abort());
while (!stopping.signal.aborted) {
  try {
    const response = await fetch(`${base}/internal/context/refresh:tick`, {
      method: "POST",
      headers: { authorization: await authorization() },
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok)
      process.stderr.write(`context.refresh_tick_http_${response.status}\n`);
  } catch {
    process.stderr.write("context.refresh_tick_unavailable\n");
  }
  if (!stopping.signal.aborted)
    await delay(30000, undefined, { signal: stopping.signal }).catch(
      () => undefined,
    );
}
