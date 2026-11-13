// Freeze the view models of the Next.js control-ui BFF that this UI replaces.
// They are TypeScript-only (apps/control-ui/src/lib/types.ts), so the parity
// matrix needs a JSON Schema snapshot to say "the new BFF returns this shape".
//
//   npm i -D ts-json-schema-generator@2 typescript@5.9
//   node docs/ui/contracts/tools/export_control_ui_views.mjs <path-to-ehfconcept> [out]
//
// Output: docs/ui/contracts/upstream/control-ui-views.schema.json (deterministic).
// After cutover (BUILD-SPEC M7) this file is reference history, not a live contract.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";

const here = dirname(fileURLToPath(import.meta.url));
const ehfRoot = resolve(process.argv[2] ?? join(here, "../../../../../ehfconcept"));
const out = resolve(process.argv[3] ?? join(here, "../upstream/control-ui-views.schema.json"));
const source = join(ehfRoot, "apps/control-ui/src/lib/types.ts");

const raw = createGenerator({ path: source, type: "*", expose: "all", skipTypeCheck: true, topRef: true }).createSchema("*");
// Generated names for anonymous Record<> types embed file offsets; give them stable names.
const rename = new Map();
let anon = 0;
for (const name of Object.keys(raw.definitions).sort()) {
  rename.set(name, /^Record<string,(string|number|unknown|NodeAttemptView)>$/.test(name)
    ? `Record_${name.slice(14, -1)}` : name.startsWith("Record<") ? `Record_Anonymous${++anon}` : name);
}
const fix = (v) => Array.isArray(v) ? v.map(fix) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((k) => {
      const x = v[k];
      if (k === "$ref" && typeof x === "string" && x.startsWith("#/definitions/")) {
        const n = decodeURIComponent(x.slice(14));
        return [k, `#/$defs/${rename.get(n) ?? n}`];
      }
      return [k, fix(x)];
    })) : v;
const defs = Object.fromEntries([...rename].map(([from, to]) => [to, fix(raw.definitions[from])]).sort(([a], [b]) => a.localeCompare(b)));
const bundle = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:ehf:control-ui:views",
  title: "Frozen view models of the replaced control-ui BFF (generated from types.ts; do not edit)",
  "x-source": { repository: "ehfconcept", file: "apps/control-ui/src/lib/types.ts", sha256: createHash("sha256").update(readFileSync(source)).digest("hex") },
  $defs: defs,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(bundle, null, 1) + "\n");
console.log(`exported ${Object.keys(defs).length} control-ui view models -> ${out}`);
