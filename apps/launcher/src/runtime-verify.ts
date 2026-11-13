import { readFile } from "node:fs/promises";
import { projectWorkloadToken } from "./runtime-launch.js";
import { verifyRuntime } from "./runtime-verification.js";

try {
  const result = await verifyRuntime(process.env, async () => process.env.WORKLOAD_TOKEN_FILE
    ? (await readFile(process.env.WORKLOAD_TOKEN_FILE, "utf8")).trim()
    : (await projectWorkloadToken(process.env)).token);
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  const code = error instanceof Error && /^(verification|endpoint|runtime_launch)\.[a-z_]+$/.test(error.message)
    ? error.message : "verification.runtime_connectivity_or_contract_failed";
  process.stderr.write(code + "\n");
  process.exitCode = 1;
}
