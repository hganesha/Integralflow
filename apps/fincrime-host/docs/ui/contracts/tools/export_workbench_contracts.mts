import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "../../../../../../packages/contracts/node_modules/zod/index.js";
import {
  createWorkspaceSchema,
  saveWorkspaceSchema,
  evaluateWorkspaceSchema,
  workbenchConfigSchema,
  datasetSchema,
} from "../../../../../../packages/contracts/src/workbench.ts";
const root = z
  .object({
    create: createWorkspaceSchema,
    save: saveWorkspaceSchema,
    evaluate: evaluateWorkspaceSchema,
    config: workbenchConfigSchema,
    dataset: datasetSchema,
  })
  .strict();
const text =
  JSON.stringify(
    z.toJSONSchema(root, {
      target: "draft-2020-12",
      unrepresentable: "any",
      io: "input",
    }),
    null,
    2,
  ) + "\n";
const output = fileURLToPath(
  new URL("../upstream/workbench.schema.json", import.meta.url),
);
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== text)
    throw new Error("Workbench schemas are stale.");
} else writeFileSync(output, text);
