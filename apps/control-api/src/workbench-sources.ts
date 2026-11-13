import { readdir, readFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { parse } from "yaml";
import {
  listAuthoringAgents,
  listAuthoringSkills,
  type Database,
} from "@ehf/persistence";
import { workspaceConfig, type WorkbenchConfig } from "@ehf/contracts";

const defaults = {
  version: "0.1.0",
  description: "",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  modelProfileId: null,
  skillRefs: [],
};
export function workspaceTemplate(
  kind: "skill" | "agent",
  name: string,
): Record<string, string> {
  const config: WorkbenchConfig = {
    ...defaults,
    kind,
    name,
    engine: kind === "agent" ? "agent" : "python",
    entrypoint: kind === "agent" ? "AGENT.md" : "main:run",
  };
  return {
    "workbench.json": JSON.stringify(config, null, 2),
    [kind === "agent" ? "AGENT.md" : "SKILL.md"]:
      `# ${name}\n\nDescribe the purpose, inputs and expected behavior here.\n`,
    ...(kind === "skill"
      ? { "main.py": "def run(data):\n    return data\n" }
      : {}),
    "tests/dataset.json": JSON.stringify(
      {
        name: "Example dataset",
        version: "1",
        cases: [
          {
            id: "echo",
            input: { message: "hello" },
            expected: { message: "hello" },
          },
        ],
      },
      null,
      2,
    ),
  };
}

/** Reads only regular files inside the configured, reviewed source library. No symlinks. */
async function textTree(
  root: string,
  directory: string,
  prefix: string,
  files: Record<string, string>,
) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await textTree(root, path, prefix, files);
    else if (
      entry.isFile() &&
      /\.(?:py|md|json|ya?ml|toml|txt|csv|svg|rego)$/.test(entry.name)
    ) {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || stat.size > 1_000_000) continue;
      files[prefix + relative(root, path).replaceAll("\\", "/")] =
        await readFile(path, "utf8");
    }
  }
}
export function workbenchLibraryRoot(env: NodeJS.ProcessEnv) {
  return (
    env.WORKBENCH_LIBRARY_ROOT ??
    fileURLToPath(new URL("../../fincrime-host/", import.meta.url))
  );
}
export async function listWorkspaceSources(
  db: Database,
  env: NodeJS.ProcessEnv,
) {
  const root = workbenchLibraryRoot(env);
  const catalog = JSON.parse(
    await readFile(join(root, "catalog/catalog.json"), "utf8"),
  );
  const skills = (catalog.skills ?? []).map((skill: any) => ({
    id: skill.id,
    kind: "skill" as const,
    name: skill.id,
    description: skill.description ?? skill.business_outcome ?? "",
    version: skill.version ?? skill.semver ?? "0.3.0",
    category: skill.domain ?? skill.id.split(".")[0],
  }));
  const agents = (await listAuthoringAgents(db)).map(({ agent }) => ({
    id: agent.id,
    kind: "agent" as const,
    name: agent.name,
    description: agent.description,
    version: agent.version,
    category: "Runtime agents",
  }));
  const profiles = (await readdir(join(root, "profiles"))).filter(
    (name) => name.startsWith("agent.") && name.endsWith(".json"),
  );
  for (const file of profiles) {
    const profile = JSON.parse(
      await readFile(join(root, "profiles", file), "utf8"),
    );
    const id = profile.id ?? file.slice(0, -5);
    if (!agents.some((agent) => agent.id === id))
      agents.push({
        id,
        kind: "agent",
        name: profile.name ?? id,
        description: profile.role ?? profile.execution?.instructions ?? "",
        version: profile.version ?? "0.1.0",
        category: "Business agents",
      });
  }
  return [...skills, ...agents];
}

export async function importWorkspaceSource(
  db: Database,
  env: NodeJS.ProcessEnv,
  kind: "skill" | "agent",
  id: string,
) {
  const root = workbenchLibraryRoot(env);
  const files: Record<string, string> = {};
  if (kind === "skill") {
    let manifest: any = null;
    for (const category of await readdir(join(root, "skills"), {
      withFileTypes: true,
    })) {
      if (!category.isDirectory()) continue;
      for (const entry of await readdir(join(root, "skills", category.name), {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        const directory = join(root, "skills", category.name, entry.name);
        const candidate = parse(
          await readFile(join(directory, "skill.yaml"), "utf8"),
        );
        if (candidate.id === id) {
          manifest = candidate;
          await textTree(directory, directory, "", files);
          break;
        }
      }
      if (manifest) break;
    }
    if (!manifest) throw new Error("workbench.source_not_found");
    await textTree(join(root, "src"), join(root, "src"), "src/", files);
    await textTree(
      join(root, "tests"),
      join(root, "tests"),
      "tests/library/",
      files,
    );
    files["pyproject.toml"] = await readFile(
      join(root, "pyproject.toml"),
      "utf8",
    );
    const config = {
      ...defaults,
      kind,
      name: id,
      version: manifest.version ?? manifest.semver ?? "0.3.0",
      description: manifest.description ?? "",
      engine: "library-skill",
      entrypoint: manifest.entrypoint,
      inputSchema: JSON.parse(files["input.schema.json"] ?? "{}"),
      outputSchema: JSON.parse(files["output.schema.json"] ?? "{}"),
    };
    files["workbench.json"] = JSON.stringify(config, null, 2);
  } else {
    const registered = (await listAuthoringAgents(db)).find(
      (row) => row.agent.id === id,
    );
    if (registered) {
      const { agent } = registered;
      Object.assign(files, workspaceTemplate("agent", agent.name));
      files["AGENT.md"] = agent.prompt;
      for (const { skill } of await listAuthoringSkills(db)) {
        if (agent.skillIds.includes(skill.id))
          files["instructions/" + skill.id + ".md"] = skill.instructions;
      }
      files["agent.json"] = JSON.stringify(agent, null, 2);
      files["workbench.json"] = JSON.stringify(
        {
          ...workspaceConfig(files),
          description: agent.description,
          version: agent.version,
          inputSchema: agent.inputSchema,
          outputSchema: agent.outputSchema,
          modelProfileId: agent.modelProfileId,
        },
        null,
        2,
      );
    } else {
      if (!/^agent\.[a-z0-9_.-]+$/.test(id))
        throw new Error("workbench.source_not_found");
      const raw = await readFile(join(root, "profiles", id + ".json"), "utf8");
      const agent = JSON.parse(raw);
      Object.assign(files, workspaceTemplate("agent", agent.name ?? id));
      files["agent.json"] = raw;
      files["AGENT.md"] = agent.execution?.instructions ?? agent.role ?? id;
      const allowed = agent.execution?.allowed_skills ?? {};
      files["skills/versions.json"] = JSON.stringify(allowed, null, 2);
    }
  }
  workspaceConfig(files);
  return files;
}
