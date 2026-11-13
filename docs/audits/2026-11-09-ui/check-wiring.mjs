// Bundle the diagnostic with the same ESM strategy used by scripts/build-service.mjs.
// This avoids the current checkout's tsx/Ajv runtime-loader failure.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
const target = '/tmp/ehf-ui-audit-wiring.mjs';
await build({ entryPoints:['docs/audits/2026-11-09-ui/check-wiring.mts'], outfile:target, bundle:true,
  platform:'node', format:'esm', target:'node24', banner:{js:'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'} });
const result = spawnSync(process.execPath,[target],{stdio:'inherit'});
process.exitCode = result.status ?? 1;
