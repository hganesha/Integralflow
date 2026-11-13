import { randomUUID } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobServiceClient,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import type { WorkspaceRevision } from "@ehf/contracts";
import type { SourceExecution } from "./workbench-evaluator.js";

export function azureEvaluationTemplate(
  image: string,
  inputUrl: string,
  outputUrl: string,
) {
  return {
    containers: [
      {
        name: "evaluator",
        image,
        command: ["python", "/opt/azure_job.py"],
        resources: { cpu: 0.5, memory: "1Gi" },
        env: [
          { name: "WORKBENCH_INPUT_URL", value: inputUrl },
          { name: "WORKBENCH_OUTPUT_URL", value: outputUrl },
        ],
      },
    ],
  };
}

/** Azure runs the same source interpreter in a fresh job. Blob permissions are restricted
 * to one input and one output; the untrusted child receives neither URL nor an identity. */
export async function executeAzureSourceCase(
  source: WorkspaceRevision,
  input: unknown,
  env: NodeJS.ProcessEnv,
  dependencies: {
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    credential?: Pick<DefaultAzureCredential, "getToken">;
  } = {},
): Promise<SourceExecution> {
  const job = env.WORKBENCH_AZURE_JOB_ID;
  const account = env.WORKBENCH_AZURE_STORAGE_ACCOUNT;
  const image = env.WORKBENCH_EVALUATOR_IMAGE;
  if (
    !job ||
    !/^\/subscriptions\/[a-f0-9-]+\/resourceGroups\/[a-zA-Z0-9_.()-]+\/providers\/Microsoft.App\/jobs\/[a-zA-Z0-9_.()-]+$/.test(
      job,
    ) ||
    !account ||
    !image ||
    (env.SECURITY_PROFILE !== "development" &&
      !/@sha256:[a-f0-9]{64}$/.test(image))
  )
    throw new Error("workbench.azure_configuration_required");
  const credential =
    dependencies.credential ??
    new DefaultAzureCredential({
      ...(env.WORKBENCH_AZURE_MANAGED_IDENTITY_CLIENT_ID
        ? {
            managedIdentityClientId:
              env.WORKBENCH_AZURE_MANAGED_IDENTITY_CLIENT_ID,
          }
        : {}),
    });
  const shared = env.WORKBENCH_AZURE_STORAGE_KEY
    ? new StorageSharedKeyCredential(account, env.WORKBENCH_AZURE_STORAGE_KEY)
    : null;
  const endpoint =
    env.WORKBENCH_AZURE_STORAGE_ENDPOINT ??
    `https://${account}.blob.core.windows.net`;
  const url = new URL(endpoint);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && env.SECURITY_PROFILE !== "development")
  )
    throw new Error("workbench.azure_storage_https_required");
  const service = new BlobServiceClient(endpoint, shared ?? credential);
  const container = service.getContainerClient(
    env.WORKBENCH_AZURE_STORAGE_CONTAINER ?? "workbench-evaluations",
  );
  const id = randomUUID();
  const inputBlob = container.getBlockBlobClient(`${id}/input.json`);
  const outputBlob = container.getBlockBlobClient(`${id}/output.json`);
  const expiresOn = new Date(Date.now() + 10 * 60_000);
  const startsOn = new Date(Date.now() - 60_000);
  const key = shared
    ? null
    : await service.getUserDelegationKey(startsOn, expiresOn);
  const sas = (blobName: string, permissions: string) => {
    const values = {
      containerName: container.containerName,
      blobName,
      permissions: BlobSASPermissions.parse(permissions),
      startsOn,
      expiresOn,
      protocol:
        url.protocol === "https:"
          ? SASProtocol.Https
          : SASProtocol.HttpsAndHttp,
    };
    return shared
      ? generateBlobSASQueryParameters(values, shared).toString()
      : generateBlobSASQueryParameters(values, key!, account).toString();
  };
  const fetcher = dependencies.fetch ?? fetch;
  try {
    await inputBlob.uploadData(
      Buffer.from(
        JSON.stringify({
          requestId: id,
          sourceDigest: source.digest,
          config: source.config,
          files: source.files,
          input,
        }),
      ),
      {
        abortSignal: AbortSignal.timeout(30_000),
        conditions: { ifNoneMatch: "*" },
      },
    );
    const access = await credential.getToken(
      "https://management.azure.com/.default",
    );
    if (!access) throw new Error("workbench.azure_identity_unavailable");
    const started = await fetcher(
      `https://management.azure.com${job}/start?api-version=2025-07-01`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${access.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          azureEvaluationTemplate(
            image,
            inputBlob.url + "?" + sas(inputBlob.name, "r"),
            outputBlob.url + "?" + sas(outputBlob.name, "cw"),
          ),
        ),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!started.ok) throw new Error("workbench.azure_job_start_failed");
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (
        await outputBlob.exists({ abortSignal: AbortSignal.timeout(10_000) })
      ) {
        const properties = await outputBlob.getProperties({
          abortSignal: AbortSignal.timeout(10_000),
        });
        if (!properties.contentLength || properties.contentLength > 600_000)
          throw new Error("workbench.azure_output_limit");
        const output = await outputBlob.downloadToBuffer(
          0,
          properties.contentLength,
          { abortSignal: AbortSignal.timeout(10_000) },
        );
        const result = JSON.parse(output.toString("utf8")) as {
          requestId: string;
          sourceDigest: string;
          actual?: unknown;
          error?: string;
        };
        if (result.requestId !== id || result.sourceDigest !== source.digest)
          throw new Error("workbench.azure_result_binding_invalid");
        if (result.error) throw new Error("workbench.source_test_failed");
        return {
          actual: result.actual,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          traceId: null,
        };
      }
      await (
        dependencies.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      )(1500);
    }
    throw new Error("workbench.azure_job_timeout");
  } finally {
    await Promise.allSettled([
      inputBlob.deleteIfExists(),
      outputBlob.deleteIfExists(),
    ]);
  }
}
