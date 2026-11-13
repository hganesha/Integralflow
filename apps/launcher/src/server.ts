import { buildLauncher } from "./app.js";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

const directory = process.env.ONBOARDING_STATE_DIR ?? ".integralflow/setup";
await mkdir(directory, { recursive: true, mode: 0o700 });
const probe = join(directory, `.startup-write-probe-${process.pid}`);
await writeFile(probe, "", { mode: 0o600, flag: "wx" });
await unlink(probe);
const app = buildLauncher({ logger: true });
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 4300) });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close(); });
