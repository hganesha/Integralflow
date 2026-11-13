import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { join } from "node:path";
import type { SetupDocument } from "@ehf/contracts/deployment";
import type { DeploymentJob } from "./deployment-jobs.js";

export type StoredSession = { hash: string; csrf: string; expires: number; subject: string; method: "bootstrap" | "oidc" };
export type SetupState = { executorSeenAt?: number; provisioning?: { configuration: import("@ehf/contracts/resource-provisioning").ResourceConfiguration; inventory?: Partial<Record<import("@ehf/contracts/resource-provisioning").ResourceKind, import("@ehf/contracts/resource-provisioning").ResourceOutput>>; run?: import("./resource-provisioning.js").ResourceRun }; document: SetupDocument; deployment?: DeploymentJob; claimed: boolean; sessions: StoredSession[]; identityVerified: boolean; events: Array<{ at: string; action: string; revision: number; subject: string }> };

/** Single writer per volume. The Azure recipe deliberately pins min/max replicas to one. */
export class SetupStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, private initial: () => SetupState) {}
  async read(): Promise<SetupState> {
    await this.queue;
    return this.readFile();
  }
  private async readFile(): Promise<SetupState> {
    try { return JSON.parse(await readFile(join(this.directory, "setup.json"), "utf8")) as SetupState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.initial(); throw error; }
  }
  update<T>(change: (state: SetupState) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      // Cross-process exclusion also covers the overlap between Azure revisions during
      // a rollout. A crashed writer leaves a lock for explicit operator recovery; never
      // steal a possibly active writer's lock based on a local clock or process ID.
      const lock = join(this.directory, ".writer-lock");
      const deadline = Date.now() + 5000;
      while (true) {
        try { await mkdir(lock); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
          await setTimeout(50);
        }
      }
      try {
        const state = await this.readFile();
        const result = await change(state);
        const temporary = join(this.directory, `.setup-${randomUUID()}.json`);
        await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
        await rename(temporary, join(this.directory, "setup.json"));
        return result;
      } finally { await rmdir(lock); }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
