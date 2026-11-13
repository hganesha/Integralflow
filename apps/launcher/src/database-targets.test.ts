import { describe, expect, it } from "vitest";
import { defaultDeploymentProfile } from "@ehf/contracts/deployment";
import { databaseTargets } from "./database-targets.js";
const profile = defaultDeploymentProfile({ provider: "container", scopeId: "local", region: "local", recipe: "test" });
profile.foundation.database.host = "database.example.com";
const env = { SECURITY_PROFILE: "production", DATABASE_AUTH: "url", DATABASE_URL: "postgresql://migrator@database.example.com/control?sslmode=verify-full", CASE_DATABASE_URL: "postgresql://migrator@database.example.com/case?sslmode=verify-full", CONTEXT_DATABASE_URL: "postgresql://migrator@database.example.com/context?sslmode=verify-full" };
describe("operator migration boundaries", () => {
  it("requires three distinct databases on the reviewed server with passwordless verified-TLS URLs", () => {
    expect(databaseTargets(profile, env).map(target => target.database)).toEqual(["control", "case", "context"]);
    for (const patch of [
      { CASE_DATABASE_URL: env.DATABASE_URL },
      { DATABASE_URL: env.DATABASE_URL.replace("database.example.com", "unreviewed.example.com") },
      { DATABASE_URL: env.DATABASE_URL.replace("migrator@", "migrator:secret@") },
      { DATABASE_URL: env.DATABASE_URL.replace("verify-full", "require") },
      { DATABASE_URL: env.DATABASE_URL + "&host=unreviewed.example.com" },
      { DATABASE_BOOTSTRAP_URL: env.DATABASE_URL },
      { DATABASE_DEV_LOGIN_PASSWORD: "shared-login-password" },
    ]) expect(() => databaseTargets(profile, { ...env, ...patch })).toThrow();
  });
});
