import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectTokenToFile, projectWorkloadToken } from "./runtime-launch.js";
describe("projected OAuth workload identity", () => {
  it("verifies issuer, audience, distinct subject and lifetime before projecting an access token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "key", alg: "RS256" };
    const env = { WORKLOAD_OAUTH_TOKEN_ENDPOINT: "https://id.example.com/token", WORKLOAD_IDENTITY_JWKS_URI: "https://id.example.com/jwks", WORKLOAD_IDENTITY_ISSUER: "https://id.example.com", WORKLOAD_IDENTITY_AUDIENCE: "platform", WORKLOAD_OAUTH_CLIENT_ID: "control-api", WORKLOAD_OAUTH_CLIENT_SECRET: "private-client-secret", WORKLOAD_OAUTH_SUBJECT: "service:control-api" };
    let subject = env.WORKLOAD_OAUTH_SUBJECT; let authorization = "";
    const transport: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/jwks")) return Response.json({ keys: [jwk] });
      authorization = (init!.headers as Record<string, string>).authorization!;
      const token = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "key" }).setSubject(subject).setIssuer(env.WORKLOAD_IDENTITY_ISSUER).setAudience(env.WORKLOAD_IDENTITY_AUDIENCE).setIssuedAt().setExpirationTime("5m").sign(privateKey);
      return Response.json({ token_type: "Bearer", access_token: token });
    };
    expect((await projectWorkloadToken(env, transport)).expires).toBeGreaterThan(Date.now());
    expect(authorization).toBe(`Basic ${Buffer.from("control-api:private-client-secret").toString("base64")}`);
    subject = "service:case-api";
    await expect(projectWorkloadToken(env, transport)).rejects.toThrow();
  });
  it("projects a verified token into a shared file for a service built from another image", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "key", alg: "RS256" };
    const root = await mkdtemp(join(tmpdir(), "integralflow-token-"));
    const env = { WORKLOAD_OAUTH_TOKEN_ENDPOINT: "https://id.example.com/token", WORKLOAD_IDENTITY_JWKS_URI: "https://id.example.com/jwks", WORKLOAD_IDENTITY_ISSUER: "https://id.example.com", WORKLOAD_IDENTITY_AUDIENCE: "platform", WORKLOAD_OAUTH_CLIENT_ID: "skill-host", WORKLOAD_OAUTH_CLIENT_SECRET: "private-client-secret", WORKLOAD_OAUTH_SUBJECT: "service:skill-host", WORKLOAD_TOKEN_OUTPUT: join(root, "token", "workload.jwt") };
    let issued = "";
    const transport: typeof fetch = async (url) => {
      if (String(url).endsWith("/jwks")) return Response.json({ keys: [jwk] });
      issued = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "key" }).setSubject(env.WORKLOAD_OAUTH_SUBJECT).setIssuer(env.WORKLOAD_IDENTITY_ISSUER).setAudience(env.WORKLOAD_IDENTITY_AUDIENCE).setIssuedAt().setExpirationTime("5m").sign(privateKey);
      return Response.json({ token_type: "Bearer", access_token: issued });
    };
    try {
      await projectTokenToFile(env, { fetcher: transport, once: true, root });
      expect(await readFile(env.WORKLOAD_TOKEN_OUTPUT, "utf8")).toBe(issued);
      expect((await stat(env.WORKLOAD_TOKEN_OUTPUT)).mode & 0o777).toBe(0o644);
      expect(await readFile(env.WORKLOAD_TOKEN_OUTPUT, "utf8")).not.toContain("private-client-secret");
      await expect(projectTokenToFile({ ...env, WORKLOAD_TOKEN_OUTPUT: "/etc/workload.jwt" }, { fetcher: transport, once: true, root })).rejects.toThrow("runtime_launch.token_output_invalid");
      await expect(projectTokenToFile({ ...env, WORKLOAD_TOKEN_OUTPUT: join(root, "..", "escape.jwt") }, { fetcher: transport, once: true, root })).rejects.toThrow("runtime_launch.token_output_invalid");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
