import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase } from "@ehf/persistence";
import {
  saveModelProfileRevision,
  upsertProvider,
} from "@ehf/persistence/admin";
import { workspaceConfig } from "@ehf/contracts/workbench";
import { buildControlApi } from "../src/app.js";
import { buildGateway } from "../../capability-gateway/src/app.js";
import { workspaceTemplate } from "../src/workbench-sources.js";

const database = process.env.WORKBENCH_TEST_DATABASE_URL;
(database ? it : it.skip)(
  "runs an agent through the real gateway and pinned skill code while newer source and model revisions exist",
  async () => {
    const db = createDatabase(database!);
    const controlUrl = new URL(database!);
    controlUrl.searchParams.set("options", "-c role=ehf_svc_control_api");
    const controlDb = createDatabase(controlUrl.toString());
    const gatewayUrl = new URL(database!);
    gatewayUrl.searchParams.set(
      "options",
      "-c role=ehf_svc_capability_gateway",
    );
    const gatewayDb = createDatabase(gatewayUrl.toString());
    const tenant = "agent-" + randomUUID();
    const edgeToken = "workbench-agent-edge-token-000000001";
    const controlToken = "workbench-agent-control-token-000001";
    const actor = { subjectId: "test-admin", roles: ["Platform.Admin"] };
    await upsertProvider(db, {
      tenantId: tenant,
      actor,
      provider: {
        id: "test-provider",
        kind: "openai_compatible",
        displayName: "Provider transport fixture",
        baseUrl: "https://models.invalid/v1",
        credentialRef: "WB_TEST_API_KEY",
        siteUrl: null,
        appName: null,
        status: "active",
      },
    });
    const profile = {
      id: "model.workbench.test",
      provider: "test-provider",
      model: "fixture-model-v1",
      maxOutputTokens: 100,
      timeoutMs: 10000,
      maxConcurrency: 1,
    };
    const pinned = await saveModelProfileRevision(db, {
      tenantId: tenant,
      actor,
      profile,
    });
    let skillId = "";
    const requests: any[] = [];
    const gateway = buildGateway({
      db: gatewayDb,
      executionSecret: "workbench-test-execution-secret",
      env: { PLATFORM_TENANT_ID: tenant, WB_TEST_API_KEY: "fixture-only-key" },
      serviceGrants: [
        {
          token: controlToken,
          subjectId: "control-api",
          roles: ["Workbench.Evaluate"],
          tenantId: tenant,
        },
      ],
      fetch: (async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        requests.push(body);
        const action =
          requests.length === 1
            ? { action: "skill", skillId, input: { name: " ALICE " } }
            : { action: "final", output: { normalized: "alice" } };
        return new Response(
          JSON.stringify({
            id: "chatcmpl-fixture",
            object: "chat.completion",
            created: 1700000000,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: JSON.stringify(action) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    gateway.log.level = "silent";
    const gatewayOrigin = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const control = buildControlApi({
      db: controlDb,
      contextStore: null,
      env: {
        PLATFORM_TENANT_ID: tenant,
        WORKBENCH_EVALUATOR_BACKEND: "docker",
        CAPABILITY_GATEWAY_URL: gatewayOrigin,
        CONTROL_API_SERVICE_TOKEN: controlToken,
      },
      serviceGrants: [
        {
          token: edgeToken,
          subjectId: "edge",
          roles: ["Edge.Delegate"],
          tenantId: tenant,
        },
      ],
    });
    control.log.level = "silent";
    const origin = await control.listen({ host: "127.0.0.1", port: 0 });
    const call = async (path: string, body: unknown, method = "POST") => {
      const response = await fetch(origin + "/v1" + path, {
        method,
        headers: {
          authorization: `Bearer ${edgeToken}`,
          "x-actor-id": "author",
          "x-actor-roles": "Harness.Author",
          "x-tenant-id": tenant,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as any;
      expect(response.status, JSON.stringify(result)).toBeLessThan(300);
      return result;
    };
    try {
      const files = workspaceTemplate("skill", "Name tool");
      files["main.py"] =
        'def run(data):\n    return {"normalized": data["name"].strip().lower()}\n';
      const skill = await call("/workbench/workspaces", {
        kind: "skill",
        name: "Name tool",
        files,
      });
      skillId = skill.workspace.workspaceId;
      const agentFiles = workspaceTemplate("agent", "Reviewer");
      agentFiles["AGENT.md"] =
        "Use the attached name tool, then return its output.";
      agentFiles["workbench.json"] = JSON.stringify({
        ...workspaceConfig(agentFiles),
        modelProfileId: profile.id,
        skillRefs: [
          { id: skillId, version: "0.1.0", digest: skill.source.digest },
        ],
      });
      const agent = await call("/workbench/workspaces", {
        kind: "agent",
        name: "Reviewer",
        files: agentFiles,
      });
      const queued = await call(
        "/workbench/workspaces/" + agent.workspace.workspaceId + "/evaluations",
        {
          revision: 1,
          dataset: {
            name: "Agent dataset",
            version: "1",
            cases: [
              {
                id: "name-tool",
                input: { name: " ALICE " },
                expected: { normalized: "alice" },
              },
            ],
          },
          maxCostUsd: 1,
        },
      );
      // A newer default must not change a queued evaluation's source or model pins.
      await saveModelProfileRevision(db, {
        tenantId: tenant,
        actor,
        profile: { ...profile, model: "fixture-model-v2" },
      });
      await call(
        "/workbench/workspaces/" + skillId,
        {
          expectedRevision: 1,
          message: "Change the default source",
          files: {
            ...files,
            "main.py": 'def run(data):\n    return {"normalized": "changed"}\n',
          },
        },
        "PUT",
      );
      let report: any;
      for (let tries = 0; tries < 90; tries++) {
        const response = await fetch(
          origin + "/v1/workbench/workspaces/" + agent.workspace.workspaceId,
          {
            headers: {
              authorization: `Bearer ${edgeToken}`,
              "x-actor-id": "author",
              "x-actor-roles": "Harness.Reader",
              "x-tenant-id": tenant,
            },
          },
        );
        const view = (await response.json()) as any;
        report = view.evaluations.find(
          (item: any) => item.evaluationId === queued.evaluationId,
        );
        if (report && !["queued", "running"].includes(report.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(report.status, JSON.stringify(report)).toBe("passed");
      expect(requests).toHaveLength(2);
      expect(
        requests.every((request) => request.model === "fixture-model-v1"),
      ).toBe(true);
      expect(report.modelProfileDigest).toBe(pinned.digest);
      expect(report.modelProfileRevision).toBe(1);
      expect(report.cases[0].receipts).toMatchObject([
        {
          skillId,
          sourceDigest: skill.source.digest,
          output: { normalized: "alice" },
        },
      ]);
      expect(report.cases[0].inputTokens).toBe(6);
      expect(report.cases[0].outputTokens).toBe(4);
      const denied = await gateway.inject({
        method: "POST",
        url: `/v1/workbench/evaluations/${queued.evaluationId}/model/0/0`,
        headers: { authorization: `Bearer ${controlToken}` },
      });
      expect(denied.statusCode).toBe(409);
      expect(requests).toHaveLength(2);
    } finally {
      await control.close();
      await gateway.close();
      await Promise.all([controlDb.end(), gatewayDb.end(), db.end()]);
    }
  },
  45_000,
);
