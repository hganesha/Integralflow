// Export the EHF zod contracts (@ehf/contracts) to one JSON Schema bundle the
// Experience API can $ref. EHF owns these shapes; this file never edits them.
//
//   npx tsx docs/ui/contracts/tools/export_ehf_contracts.mts <path-to-ehfconcept> [out]
//   node --experimental-strip-types docs/ui/contracts/tools/export_ehf_contracts.mts <path>   (Node >= 22.6, no tsx)
//
// out defaults to docs/ui/contracts/upstream/ehf-contracts.schema.json.
// The output is deterministic (sorted keys) so drift shows up as a diff.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const ehfRoot = resolve(process.argv[2] ?? join(here, "../../../../../ehfconcept"));
const out = resolve(process.argv[3] ?? join(here, "../upstream/ehf-contracts.schema.json"));
const pkgDir = join(ehfRoot, "packages/contracts");
const entry = join(pkgDir, "src/index.ts");

// Resolve zod from the contracts package itself so the exporter uses EHF's pinned version.
const req = createRequire(join(pkgDir, "package.json"));
const zodPath = req.resolve("zod");
const zodVersion = JSON.parse(readFileSync(join(dirname(req.resolve("zod/package.json")), "package.json"), "utf8")).version;
const { z } = await import(pathToFileURL(zodPath).href);
const C = await import(pathToFileURL(entry).href);

let commit = process.env.EHF_COMMIT ?? "unknown";
try { commit = execFileSync("git", ["-C", ehfRoot, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* not a checkout: keep EHF_COMMIT */ }

const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;

const defs: Record<string, unknown> = {};
const failed: string[] = [];
for (const [name, value] of Object.entries(C).sort(([a], [b]) => a.localeCompare(b))) {
  if (!name.endsWith("Schema") || !(value instanceof z.ZodType)) continue;
  try {
    const schema = z.toJSONSchema(value, { target: "draft-2020-12", unrepresentable: "any", io: "output" }) as Record<string, unknown>;
    delete schema.$schema;
    const key = name.replace(/Schema$/, "");
    // Recursive JSON values keep their local definitions under the exported root.
    // Relocate local references to that root in the enclosing contract bundle.
    const relocate = (v: unknown): unknown => Array.isArray(v) ? v.map(relocate) : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).map(([k,value])=>[k,k==="$ref" && typeof value==="string" && value.startsWith("#")
        ? `#/$defs/${key}${value.slice(1)}` : relocate(value)])) : v;
    defs[key] = relocate(schema);
  } catch (error) { failed.push(`${name}: ${String(error).slice(0, 160)}`); }
}
if (failed.length) { console.error(failed.join("\n")); process.exit(1); }

const sourceDigest = createHash("sha256").update(readFileSync(entry)).digest("hex");
const bundle = sortKeys({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:ehf:contracts:bundle",
  title: "EHF platform contracts (exported from @ehf/contracts; do not edit)",
  "x-source": { repository: "ehfconcept", commit, file: "packages/contracts/src/index.ts", sha256: sourceDigest, zod: zodVersion,
    options: { target: "draft-2020-12", unrepresentable: "any", io: "output" } },
  $defs: defs,
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(bundle, null, 1) + "\n");
console.log(`exported ${Object.keys(defs).length} schemas from ${commit.slice(0, 7)} (zod ${zodVersion}) -> ${out}`);
