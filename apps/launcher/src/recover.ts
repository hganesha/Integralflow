import { readFile, writeFile, rmdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { SetupStore, type SetupState } from "./store.js";

const args = process.argv.slice(2);
if (![3, 4].includes(args.length) || args[0] !== "--state" || !args[1] || args[2] !== "--acknowledge-stopped" || (args[3] && args[3] !== "--acknowledge-executor-stopped")) throw new Error("Stop all writers, then use: --state DIRECTORY --acknowledge-stopped [--acknowledge-executor-stopped]. Recovery re-enables the original bootstrap token and revokes all sessions.");
const directory = resolve(args[1]);
const source = await readFile(join(directory, "setup.json"), "utf8");
const previous = JSON.parse(source) as SetupState;
const active = previous.deployment?.phase === "queued" || previous.deployment?.phase === "running";
if (active && args[3] !== "--acknowledge-executor-stopped") throw new Error("Stop the executor and cancel in-flight Azure deployments/jobs, then add --acknowledge-executor-stopped. No state was changed.");
const backup = join(directory, `setup-backup-${Date.now()}.json`);
await writeFile(backup, source, { mode: 0o600, flag: "wx" });
await rmdir(join(directory, ".writer-lock")).catch(error => { if (error.code !== "ENOENT") throw error; });
const store = new SetupStore(directory, () => { throw new Error("setup.existing_state_required"); });
await store.update(state => {
  state.sessions = []; state.claimed = false; state.identityVerified = false;
  if (active && state.deployment) { state.deployment.phase = "failed"; delete state.deployment.leaseHash; state.deployment.message = "Operator recovery acknowledged a stopped executor. Review existing resources before retrying."; }
  state.events.push({ at: new Date().toISOString(), action: "administrator.recovery", revision: state.document.revision, subject: "deployment-operator" });
});
process.stdout.write(`Recovery completed. Backup: ${backup}\nRestart the console and use the original private claim-token file.\n`);
