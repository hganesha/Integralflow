import { randomUUID } from "node:crypto";
import type { MemorySaver } from "@langchain/langgraph";
import type { DraftTestControl, DraftTestDebug, DraftTestRun } from "@ehf/contracts";

type Checkpoint = NonNullable<Awaited<ReturnType<MemorySaver["getTuple"]>>>;
type RetainedCheckpoint = Checkpoint & { metadata: NonNullable<Checkpoint["metadata"]> };
export type FixtureCheckpoint = { id: string; nodeId: string; tuple: RetainedCheckpoint };
type Boundary = { nodeId: string; nodeKind: string; capabilityId: string | null };

export const fixtureDebugRetentionMs = 15 * 60_000;
export const fixtureDebugTimeoutMs = 8 * 60_000;

export class FixtureDebugger {
  readonly checkpoints = new Map<string, FixtureCheckpoint>();
  readonly expiresAt = new Date(Date.now() + fixtureDebugRetentionMs).toISOString();
  private pauseRequested: boolean;
  private step: "boundary" | "call" | "node" | null = null;
  private release: (() => void) | null = null;
  private sequence = 0;
  private checkpointBytes = 0;

  constructor(private readonly run: DraftTestRun, private readonly config: DraftTestDebug) {
    this.pauseRequested = config.pauseAtStart;
    this.run.debug = { state: "running", boundary: null, checkpoints: [], expiresAt: this.expiresAt };
  }

  retain(nodeId: string, tuple: Checkpoint | undefined) {
    if (!tuple?.metadata || this.checkpoints.size >= 24) return;
    const bytes = Buffer.byteLength(JSON.stringify(tuple.checkpoint));
    if (bytes > 256 * 1024 || this.checkpointBytes + bytes > 2 * 1024 * 1024) return;
    const id = randomUUID();
    this.checkpoints.set(id, { id, nodeId, tuple: structuredClone({ ...tuple, metadata: tuple.metadata }) });
    this.checkpointBytes += bytes;
    this.run.debug!.checkpoints.push({ id, nodeId });
  }

  async visit(boundary: Boundary, signal: AbortSignal, persist: () => Promise<void>) {
    signal.throwIfAborted();
    const nodeBoundary = boundary.capabilityId === null;
    const breakpoint = this.config.breakpoints.find(item => item.nodeId === boundary.nodeId && (
      item.when?.field === "capabilityId" ? boundary.capabilityId === item.when.equals
        : nodeBoundary && (!item.when || boundary.nodeKind === item.when.equals)
    ));
    const requested = this.pauseRequested && nodeBoundary;
    const stepped = this.step === "boundary" || this.step === "call" || this.step === "node" && nodeBoundary;
    if (!breakpoint && !requested && !stepped) return;
    this.pauseRequested = false;
    this.step = null;
    this.run.debug!.state = "paused";
    this.run.debug!.boundary = {
      sequence: ++this.sequence, nodeId: boundary.nodeId, capabilityId: boundary.capabilityId,
      reason: breakpoint?.when ? `Breakpoint matched ${breakpoint.when.field} = ${breakpoint.when.equals}`
        : breakpoint ? "Step breakpoint" : requested ? "Pause requested" : "Step completed",
    };
    let unblock!: () => void;
    const waiting = new Promise<void>(resolve => { unblock = resolve; });
    this.release = unblock;
    signal.addEventListener("abort", unblock, { once: true });
    try {
      await persist();
      if (!signal.aborted) await waiting;
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", unblock);
      this.release = null;
      this.run.debug!.state = "running";
      this.run.debug!.boundary = null;
    }
  }

  command(input: DraftTestControl): boolean {
    if (this.run.status !== "running" || !this.run.debug) return false;
    const boundary = this.run.debug.boundary;
    if (input.action === "pause") {
      if (boundary) return false;
      this.pauseRequested = true;
      return true;
    }
    if (!this.release || !boundary || input.boundary !== boundary.sequence) return false;
    if (input.action === "step_into") this.step = "boundary";
    if (input.action === "step_over") this.step = boundary.capabilityId ? "call" : "node";
    if (input.action === "step_out") this.step = "node";
    const release = this.release;
    this.release = null;
    release();
    return true;
  }

  finish() {
    this.run.debug!.state = "finished";
    this.run.debug!.boundary = null;
  }
}
