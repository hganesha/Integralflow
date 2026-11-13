import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { stableDigest, type WorkspaceRevision } from "@ehf/contracts";
import { workspaceTemplate } from "../src/workbench-sources.js";
import { workspaceConfig } from "@ehf/contracts/workbench";
import { executeAzureSourceCase } from "../src/workbench-azure.js";

const endpoint = process.env.WORKBENCH_AZURITE_URL;
const run = endpoint ? it : it.skip;
run(
  "round trips signed, blob-bound Azure job input/output through Azurite and the real restricted source container",
  async () => {
    const key = Buffer.alloc(64, 1).toString("base64");
    const storage = new BlobServiceClient(
      endpoint!,
      new StorageSharedKeyCredential("workbench", key),
    );
    const container = storage.getContainerClient("workbench-evaluations");
    await container.createIfNotExists();
    const files = workspaceTemplate("skill", "Azure job example");
    files["main.py"] =
      'def run(data):\n    return {"answer": data["value"] * 2}\n';
    const source: WorkspaceRevision = {
      workspaceId: "WS-test",
      revision: 1,
      digest: stableDigest(files),
      files,
      config: workspaceConfig(files),
      message: "test",
      actor: "test",
      createdAt: new Date().toISOString(),
    };
    let started = 0;
    const result = await executeAzureSourceCase(
      source,
      { value: 21 },
      {
        SECURITY_PROFILE: "development",
        WORKBENCH_AZURE_JOB_ID:
          "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.App/jobs/test",
        WORKBENCH_AZURE_STORAGE_ACCOUNT: "workbench",
        WORKBENCH_AZURE_STORAGE_KEY: key,
        WORKBENCH_AZURE_STORAGE_ENDPOINT: endpoint!,
        WORKBENCH_EVALUATOR_IMAGE: "ehf-workbench-evaluator:local",
      },
      {
        credential: {
          getToken: async () => ({
            token: "test-arm-token",
            expiresOnTimestamp: Date.now() + 60_000,
          }),
        },
        fetch: (async (url, init) => {
          expect(String(url)).toContain(
            "https://management.azure.com/subscriptions/",
          );
          const template = JSON.parse(init!.body as string);
          expect(template.containers).toHaveLength(1);
          const env = Object.fromEntries(
            template.containers[0].env.map(
              (item: { name: string; value: string }) => [
                item.name,
                item.value,
              ],
            ),
          );
          expect(Object.keys(env).sort()).toEqual([
            "WORKBENCH_INPUT_URL",
            "WORKBENCH_OUTPUT_URL",
          ]);
          expect(
            new URL(env.WORKBENCH_INPUT_URL as string).searchParams.get("sp"),
          ).toBe("r");
          expect(
            new URL(env.WORKBENCH_OUTPUT_URL as string).searchParams.get("sp"),
          ).toBe("cw");
          // Docker reaches the host's Azurite listener through this development-only alias.
          const publicUrl = (raw: string) => {
            const parsed = new URL(raw);
            parsed.hostname = "host.docker.internal";
            return parsed.toString();
          };
          await promisify(execFile)(
            "docker",
            [
              "run",
              "--rm",
              "--entrypoint",
              "python",
              "-e",
              "WORKBENCH_INPUT_URL=" +
                publicUrl(env.WORKBENCH_INPUT_URL as string),
              "-e",
              "WORKBENCH_OUTPUT_URL=" +
                publicUrl(env.WORKBENCH_OUTPUT_URL as string),
              "ehf-workbench-evaluator:local",
              "/opt/azure_job.py",
            ],
            { timeout: 30_000, maxBuffer: 512_000 },
          );
          started++;
          return new Response("{}", { status: 202 });
        }) as typeof fetch,
      },
    );
    expect(started).toBe(1);
    expect(result).toMatchObject({
      actual: { answer: 42 },
      costUsd: null,
      traceId: null,
    });
    const remaining = [];
    for await (const blob of container.listBlobsFlat())
      remaining.push(blob.name);
    expect(remaining).toEqual([]);
  },
  45_000,
);
