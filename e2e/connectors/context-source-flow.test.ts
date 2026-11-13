import {
  assembleContextPack,
  verifyContextPackDigest,
} from "../../packages/context-plane/src/index.js";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contextConnectionSchema,
  contextBindingSchema,
  stableDigest,
  type HarnessPlanV2,
} from "@ehf/contracts";
import { mintExecutionEnvelope } from "@ehf/execution-auth";
import {
  createDatabase,
  contextConnectorId,
  getCapabilityConnector,
  admitPlan,
  createRun,
  registerSourceArtifact,
  approveSourceArtifact,
  revokeArtifactEntry,
} from "@ehf/persistence";
import { buildControlApi } from "../../apps/control-api/src/app.js";
import { buildApp } from "../../apps/experience-bff/src/app.js";
import { buildGateway } from "../../apps/capability-gateway/src/app.js";
import sourceFixture from "../../packages/contracts/test-fixtures/context-source.json" with { type: "json" };
import policyFixture from "../../packages/contracts/test-fixtures/source-policy.json" with { type: "json" };
import planFixture from "../../packages/contracts/test-fixtures/skill-bound.plan.json" with { type: "json" };

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)(
  "real context source flow",
  () => {
    it("connects through the BFF, qualifies HTTPS data and enforces source policy at runtime", async () => {
      const db = createDatabase(process.env.EHF_TEST_DATABASE_URL),
        directory = await mkdtemp(join(tmpdir(), "context-source-tls-"));
      const tenantId = `source_flow_${randomUUID()}`,
        edgeToken = randomBytes(32).toString("hex"),
        runtimeToken = randomBytes(32).toString("hex"),
        secret = randomBytes(32).toString("hex"),
        sourceToken = randomBytes(32).toString("hex");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(directory, "key.pem"),
          "-out",
          join(directory, "cert.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=IP:127.0.0.1,DNS:localhost",
        ],
        { stdio: "ignore" },
      );
      const cert = await readFile(join(directory, "cert.pem"));
      let requests = 0;
      let changed = false;
      const source = createServer(
        { key: await readFile(join(directory, "key.pem")), cert },
        (request, response) => {
          requests++;
          if (request.headers.authorization !== `Bearer ${sourceToken}`) {
            response.writeHead(401).end();
            return;
          }
          const properties = {
            id: { type: "string" },
            name: { type: "string" },
            entity_type: { type: "string" },
            identifiers: { type: "array" },
            observed_at: { type: "string" },
            ...(changed ? { new_column: { type: "string" } } : {}),
          };
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify(
              request.url === "/openapi.json"
                ? {
                    openapi: "3.0.3",
                    paths: {
                      "/customers/{customer_id}": {
                        get: {
                          responses: {
                            "200": {
                              content: {
                                "application/json": {
                                  schema: {
                                    type: "object",
                                    properties: {
                                      rows: {
                                        type: "array",
                                        items: {
                                          type: "object",
                                          properties,
                                          required: [
                                            "id",
                                            "name",
                                            "observed_at",
                                          ],
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  }
                : {
                    rows: [
                      {
                        id: "c1",
                        name: "Synthetic customer",
                        entity_type: "company",
                        identifiers: [],
                        observed_at: new Date(Date.now() - 1000).toISOString(),
                      },
                    ],
                  },
            ),
          );
        },
      );
      await new Promise<void>((resolve) =>
        source.listen(0, "127.0.0.1", resolve),
      );
      const address = source.address();
      if (!address || typeof address === "string")
        throw new Error("source.listen_failed");
      const endpoint = `https://127.0.0.1:${address.port}`;
      const connection = contextConnectionSchema.parse({
        ...sourceFixture.connection,
        provider: "openapi",
        endpoint,
        credentialRef: "env:SMOKE_SOURCE",
      });
      const binding = contextBindingSchema.parse(sourceFixture.binding);
      const secureFetch: typeof globalThis.fetch = async (input, init) =>
        new Promise((resolve, reject) => {
          const url =
            input instanceof Request
              ? new URL(input.url)
              : new URL(String(input));
          if (url.origin !== endpoint) {
            reject(new Error("context_source.endpoint_denied"));
            return;
          }
          const request = httpsRequest(
            url,
            {
              ca: cert,
              rejectUnauthorized: true,
              method: init?.method ?? "GET",
              headers: Object.fromEntries(new Headers(init?.headers)),
              ...(init?.signal ? { signal: init.signal } : {}),
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              response.on("error", reject);
              response.on("end", () =>
                resolve(
                  new Response(Buffer.concat(chunks), {
                    status: response.statusCode ?? 500,
                    headers: { "content-type": "application/json" },
                  }),
                ),
              );
            },
          );
          request.on("error", reject);
          if (init?.body) request.write(String(init.body));
          request.end();
        });
      const grants = [
        {
          token: edgeToken,
          tenantId,
          subjectId: "smoke-edge",
          roles: ["Edge.Delegate"],
        },
      ];
      const control = buildControlApi({
        db,
        contextStore: null,
        env: {},
        serviceGrants: grants,
      });
      control.log.level = "silent";
      const gateway = buildGateway({
        db,
        executionSecret: secret,
        env: {
          RELEASE_ENVIRONMENT: "production",
          GATEWAY_ADAPTERS: "context-source",
          SMOKE_SOURCE: sourceToken,
          CONTEXT_SOURCE_TARGETS_JSON: JSON.stringify({
            [tenantId]: [
              {
                provider: "openapi",
                endpoint,
                credentialRef: "env:SMOKE_SOURCE",
              },
            ],
          }),
        },
        serviceGrants: [
          ...grants,
          {
            token: runtimeToken,
            tenantId,
            subjectId: "smoke-runtime",
            roles: ["Capability.Invoke"],
          },
        ],
        fetch: secureFetch,
      });
      gateway.log.level = "silent";
      const controlUrl = await control.listen({ port: 0, host: "127.0.0.1" }),
        gatewayUrl = await gateway.listen({ port: 0, host: "127.0.0.1" });
      const bff = buildApp({
        env: { BFF_PUBLIC_ORIGIN: "http://smoke.test" },
        principalResolver: {
          source: "local",
          resolve: async () => ({
            subjectId: "source-admin",
            tenantId,
            actorType: "human",
            roles: ["Platform.Admin"],
            source: "local",
          }),
        },
        upstream: async (service, method, path, principal, body) => {
          const result = await fetch(
            `${service === "control-api" ? controlUrl : gatewayUrl}${path}`,
            {
              method,
              headers: {
                authorization: `Bearer ${edgeToken}`,
                "x-actor-id": principal.subjectId,
                "x-actor-roles": principal.roles.join(","),
                "x-tenant-id": principal.tenantId,
                ...(body ? { "content-type": "application/json" } : {}),
              },
              ...(body ? { body: JSON.stringify(body) } : {}),
            },
          );
          return { status: result.status, body: await result.json() };
        },
      });
      const bffUrl = await bff.listen({ port: 0, host: "127.0.0.1" });
      try {
        const session = await fetch(`${bffUrl}/api/v1/session`),
          sessionBody = (await session.json()) as { csrfToken: string };
        const headers = {
          origin: "http://smoke.test",
          cookie: session.headers.get("set-cookie")!.split(";")[0]!,
          "x-csrf-token": sessionBody.csrfToken,
          "content-type": "application/json",
        };
        const post = async (path: string, body: unknown) => {
          const response = await fetch(`${bffUrl}/api/v1${path}`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });
          const payload = await response.json();
          expect(response.status, JSON.stringify(payload)).toBeLessThan(300);
          return payload;
        };
        await post("/context-sources/connections", {
          definition: connection,
          expectedRevision: null,
        });
        await post("/context-sources/bindings", {
          definition: binding,
          expectedRevision: null,
        });
        const report = await post(
          `/context-sources/bindings/${binding.id}/checks`,
          {
            expectedRevision: 1,
            kind: "qualify",
            parameters: { customer_id: "c1" },
          },
        );
        expect(report.status).toBe("passed");
        expect(report.rowCount).toBe(1);
        await post(`/context-sources/bindings/${binding.id}/activation`, {
          expectedRevision: 1,
          revision: 1,
          action: "activate",
          reason: "Synthetic end-to-end qualification",
        });
        const connectorId = contextConnectorId(tenantId, binding.id, 1),
          connector = (await getCapabilityConnector(db, connectorId))!;
        const approved = {
          ...policyFixture.binding,
          id: "customer-source",
          capabilityId: "context.source.read.v1",
          connectorId,
          connectorDigest: connector.digest,
          providerId: "openapi",
          datasetIds: [binding.datasetId],
          evidenceRoles: ["supplemental"],
          fields: binding.mapping.map((mapping) => mapping.target),
          approvedEndpoints: [endpoint],
        };
        const access = {
          ...policyFixture.access,
          bindingDigest: stableDigest(approved),
          approvedEndpoints: [endpoint],
          datasetIds: [binding.datasetId],
        };
        const policy = {
          ...policyFixture.policy,
          rules: [
            {
              ...policyFixture.policy.rules[0]!,
              capabilityIds: ["context.source.read.v1"],
              datasetIds: [binding.datasetId],
              evidenceRoles: ["supplemental"],
              requiredFields: ["name"],
              recipientIds: [tenantId],
            },
          ],
        };
        const register = async (artifact: unknown) => {
          const record = await registerSourceArtifact(db, {
            tenantId,
            actor: "source-author",
            artifact,
            expectedDigest: stableDigest(artifact),
          });
          await approveSourceArtifact(db, {
            tenantId,
            actor: "source-reviewer",
            kind: record.artifact.kind,
            digest: record.digest,
          });
          return record.digest;
        };
        const bindingDigest = await register(approved),
          accessDigest = await register(access),
          policyDigest = await register(policy);
        const plan = JSON.parse(
          JSON.stringify(planFixture).replaceAll(
            "screening.sanctions.v1",
            "context.source.read.v1",
          ),
        ) as HarnessPlanV2;
        delete plan.skillBindings;
        for (const node of plan.graph.nodes) {
          delete node.config.skillId;
          delete node.config.skillVersion;
        }
        plan.capabilities.find(
          (c) => c.id === "context.source.read.v1",
        )!.adapterBindingId = connectorId;
        plan.sourceAuthorization = {
          policyDigests: [policyDigest],
          bindings: [
            {
              capabilityId: "context.source.read.v1",
              connectorId,
              bindingDigest,
              accessDigest,
            },
          ],
        };
        const { planId: _id, planDigest: _digest, ...content } = plan;
        plan.planDigest = stableDigest(content);
        await admitPlan(db, plan, tenantId);
        const contextDigest = await register({
          ...policyFixture.context,
          tenantId,
          planDigest: plan.planDigest,
        });
        const { run } = await createRun(db, {
          tenantId,
          planDigest: plan.planDigest,
          sourceContextDigest: contextDigest,
          runInput: { tenantId, caseId: "case-1" },
          idempotencyKey: randomUUID(),
        });
        await db.query(
          "update harness_runtime.runs set status='running',started_at=now() where run_id=$1",
          [run.runId],
        );
        const permission = plan.permissionEnvelopes.find(
          (p) => p.nodeId === "sanctions-screen",
        )!;
        const invoke = async (suffix: string) => {
          const invocationId = `${run.runId}:sanctions-screen:${suffix}`;
          const envelope = await mintExecutionEnvelope({
            secret,
            tenantId,
            caseId: "case-1",
            runId: run.runId,
            nodeId: "sanctions-screen",
            attempt: 1,
            planDigest: plan.planDigest,
            permissionDigest: permission.digest,
            capabilities: permission.capabilities,
            effects: permission.effects,
            fencingEpoch: run.fencingEpoch,
            invocationId,
          });
          const response = await fetch(`${gatewayUrl}/v1/invoke`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtimeToken}`,
              "x-execution-envelope": envelope,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              invocationId,
              capabilityId: "context.source.read.v1",
              effect: "read",
              input: { customer_id: "c1" },
            }),
          });
          return { status: response.status, body: await response.json() };
        };
        const first = await invoke("read");
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        expect(first.body.output.records[0]).toMatchObject({
          data: { name: "Synthetic customer" },
          provenance: {
            connector_id: connectorId,
            provider_check_id: report.id,
          },
        });
        expect(first.body.evidenceUseDecisionId).toBeTruthy();
        const contextPlan = structuredClone(plan);
        contextPlan.contextSelectors = [
          {
            id: "source-records",
            source: "case",
            path: "records.Entity",
            purpose: "CDD",
            classification: "CONFIDENTIAL",
            required: true,
            record: {
              objectType: "Entity",
              fields: ["name"],
              minCount: 1,
              maxAgeSeconds: 86400,
            },
          },
        ];
        contextPlan.graph.nodes.find(
          (node) => node.id === "sanctions-screen",
        )!.contextSelectorIds = ["source-records"];
        const pack = assembleContextPack({
          plan: contextPlan,
          nodeId: "sanctions-screen",
          runId: run.runId,
          selection: { "source-records": first.body.output.records },
          envelope: {
            tenantId,
            caseId: "case-1",
            subjectRefs: ["customer:c1"],
            jurisdiction: "US",
            actor: "source-smoke",
            policySnapshotRef: policyDigest,
            asOfTime: new Date().toISOString(),
          },
        });
        expect(
          pack.sections.find((section) => section.id === "source-records"),
        ).toMatchObject({ trust: "UNTRUSTED_EXTERNAL" });
        expect(verifyContextPackDigest(pack)).toBe(true);

        changed = true;
        const drift = await invoke("drift");
        expect(
          String(drift.body.errorCode ?? drift.body.error),
          JSON.stringify(drift.body),
        ).toContain("schema_drift");
        expect(drift.body.output ?? null).toBeNull();
        const before = requests;
        await revokeArtifactEntry(db, {
          tenantId,
          actor: "source-reviewer",
          kind: "source-policy",
          digest: policyDigest,
          reasonCode: "source_revoked",
        });
        expect((await invoke("revoked")).status).toBe(403);
        expect(requests).toBe(before);
      } finally {
        await Promise.all([bff.close(), gateway.close(), control.close()]);
        await new Promise<void>((resolve) => source.close(() => resolve()));
        await db.end();
        await rm(directory, { recursive: true, force: true });
      }
    }, 30000);
  },
);
