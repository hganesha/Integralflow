import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { boundedJson } from "./network.js";
import { RUNTIME_SERVICES } from "@ehf/contracts/deployment-plan";

const LAUNCHABLE = new Set<string>([...RUNTIME_SERVICES.map(service => service.entrypoint), "runtime-verify", "migrate", "discovery-worker"]);

export async function projectWorkloadToken(env: NodeJS.ProcessEnv, fetcher = fetch) {
  const required = (name: string) => { if (!env[name]) throw new Error(`runtime_launch.required:${name}`); return env[name]!; };
  const endpoint = new URL(required("WORKLOAD_OAUTH_TOKEN_ENDPOINT"));
  const jwks = new URL(required("WORKLOAD_IDENTITY_JWKS_URI"));
  if (endpoint.protocol !== "https:" || jwks.protocol !== "https:" || endpoint.username || endpoint.password || jwks.username || jwks.password) throw new Error("runtime_launch.https_required");
  const form = new URLSearchParams({ grant_type: "client_credentials" });
  if (env.WORKLOAD_OAUTH_SCOPE) form.set("scope", env.WORKLOAD_OAUTH_SCOPE);
  const basic = Buffer.from(`${encodeURIComponent(required("WORKLOAD_OAUTH_CLIENT_ID"))}:${encodeURIComponent(required("WORKLOAD_OAUTH_CLIENT_SECRET"))}`).toString("base64");
  const body = await boundedJson(await fetcher(endpoint, { method: "POST", headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "error", signal: AbortSignal.timeout(10_000) }));
  if (typeof body.access_token !== "string" || body.access_token.length > 20_000 || String(body.token_type).toLowerCase() !== "bearer") throw new Error("runtime_launch.token_response_invalid");
  const { payload } = await jwtVerify(body.access_token, createRemoteJWKSet(jwks, { [customFetch]: fetcher }), { issuer: required("WORKLOAD_IDENTITY_ISSUER"), audience: required("WORKLOAD_IDENTITY_AUDIENCE"), subject: required("WORKLOAD_OAUTH_SUBJECT"), algorithms: ["RS256", "PS256", "ES256"], requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5 });
  const now = Date.now() / 1000;
  if (!payload.exp || !payload.iat || payload.iat > now + 5 || payload.exp < now + 90 || payload.exp > now + 3650 || payload.exp - payload.iat > 3650) throw new Error("runtime_launch.token_lifetime_invalid");
  return { token: body.access_token as string, expires: payload.exp * 1000 };
}

/**
 * Token projection alone (SERVICE_NAME=workload-token), as a sidecar of a service built from
 * another image: it keeps a verified workload token at WORKLOAD_TOKEN_OUTPUT, which the
 * service reads as its WORKLOAD_TOKEN_FILE. The client credential stays in this container.
 * The file is world-readable because the service runs as another user; the directory is a
 * volume shared only by this replica's containers.
 */
export async function projectTokenToFile(env: NodeJS.ProcessEnv, options: { fetcher?: typeof fetch; once?: boolean; intervalMs?: number; root?: string } = {}) {
  const output = env.WORKLOAD_TOKEN_OUTPUT ?? "";
  if (!isAbsolute(output) || output.includes("..") || !output.startsWith(options.root ?? "/var/run/")) throw new Error("runtime_launch.token_output_invalid");
  await mkdir(dirname(output), { recursive: true });
  let expires = 0;
  const refresh = async () => {
    const value = await projectWorkloadToken(env, options.fetcher);
    await writeFile(`${output}.next`, value.token, { mode: 0o644 });
    await chmod(`${output}.next`, 0o644);
    await rename(`${output}.next`, output);
    expires = value.expires;
  };
  await refresh();
  if (options.once) return;
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, options.intervalMs ?? 30_000));
    try { await refresh(); } catch { if (Date.now() > expires - 60_000) throw new Error("runtime_launch.token_refresh_failed"); }
  }
}

async function main() {
  if (process.env.SERVICE_NAME === "workload-token" && process.argv[2] !== "--prepare-files") return projectTokenToFile(process.env);
  process.umask(0o077);
  const directory = "/tmp/integralflow-secrets";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = JSON.parse(process.env.INTEGRALFLOW_PRIVATE_FILES ?? "{}");
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("runtime_launch.files_invalid");
  for (const [name, value] of Object.entries(files)) {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(name) || name.includes("..") || typeof value !== "string" || value.length > 90000) throw new Error("runtime_launch.files_invalid");
    await writeFile(join(directory, name), Buffer.from(value, "base64"), { mode: 0o600 });
  }
  if (process.argv[2] === "--prepare-files") return;
  const service = process.env.SERVICE_NAME;
  if (!service || !LAUNCHABLE.has(service)) throw new Error("runtime_launch.service_invalid");
  let expires = 0;
  const tokenFile = join(directory, "workload.jwt");
  const refresh = async () => {
    const value = await projectWorkloadToken(process.env);
    await writeFile(`${tokenFile}.next`, value.token, { mode: 0o600 });
    await rename(`${tokenFile}.next`, tokenFile); expires = value.expires;
  };
  const requiresToken = service !== "migrate" && service !== "discovery-worker";
  if (requiresToken) await refresh();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, WORKLOAD_TOKEN_FILE: tokenFile };
  // The service receives its projected token, not the issuer's client credential.
  delete childEnv.WORKLOAD_OAUTH_CLIENT_SECRET;
  delete childEnv.INTEGRALFLOW_PRIVATE_FILES;
  delete childEnv.INTEGRALFLOW_RUNTIME_LAUNCH;
  const child = spawn(process.execPath, [`/app/services/${service}/server.mjs`, ...process.argv.slice(2)], { stdio: "inherit", env: childEnv });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { if (stopped) return; stopped = true; if (timer) clearTimeout(timer); child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 10000); killTimer.unref(); };
  const rotate = async () => {
    try { await refresh(); } catch { if (Date.now() > expires - 60_000) { process.stderr.write("runtime_launch.token_refresh_failed\n"); stop(); return; } }
    if (!stopped) timer = setTimeout(() => { void rotate(); }, 30_000);
  };
  if (requiresToken) timer = setTimeout(() => { void rotate(); }, 30_000);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
  child.once("error", () => { stop(); process.exitCode = 1; });
  child.once("exit", code => { stopped = true; if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer); process.exitCode = code ?? 1; });
}
if (process.env.INTEGRALFLOW_RUNTIME_LAUNCH === "true") {
  try { await main(); } catch { process.stderr.write("runtime_launch.configuration_or_identity_failed\n"); process.exitCode = 1; }
}
