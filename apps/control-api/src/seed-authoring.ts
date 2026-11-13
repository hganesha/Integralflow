import { resolve } from "node:path";
import { createDatabase } from "@ehf/persistence";
import { seedAuthoringDrafts } from "./authoring-seeds.js";

const tenantId = process.env.PLATFORM_TENANT_ID;
if (!tenantId) throw new Error("authoring.seed_tenant_required");
const database = createDatabase();
try {
  const result = await seedAuthoringDrafts(database, tenantId, process.env.DOMAINS_PATH ?? resolve("domains"));
  process.stdout.write(JSON.stringify({ action: "seed-authoring", tenantId, ...result }) + "\n");
} catch {
  process.stderr.write("authoring.seed_failed\n");
  process.exitCode = 1;
} finally { await database.end(); }
