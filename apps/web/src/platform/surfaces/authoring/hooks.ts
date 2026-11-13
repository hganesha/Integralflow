import type { OperationId } from "@ehf/ui-contracts";
import type { CallArgs, ResultOf } from "@ehf/ui-client";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useCommand } from "../../common";
import { DRAFT_READS, useWorkspace } from "./context";
import { authoringCopy } from "./copy";
import { isConflict } from "./model";

/**
 * A draft mutation with the workspace's standard handling: the draft is refetched before
 * success is reported (N6), a 409 opens the conflict view without touching local buffers,
 * and any other failure shows its reason-code copy in the banner (unless `quiet`, when the
 * caller renders the error itself). Never optimistic.
 */
export function useDraftMutation<K extends OperationId>(operationId: K, label: string, options: { invalidate?: readonly QueryKey[]; quiet?: boolean } = {}) {
  const { say, setConflict, draft } = useWorkspace();
  const queryClient = useQueryClient();
  const command = useCommand(operationId, { invalidate: options.invalidate ?? DRAFT_READS });
  const mine = useRef(draft.revision);
  const quiet = options.quiet ?? false;

  useEffect(() => {
    if (command.state !== "failed" || !command.error) return;
    if (isConflict(command.error)) {
      // Show the revision that won: refetch the draft, keep every local buffer.
      setConflict({ mine: mine.current, label, error: command.error });
      for (const queryKey of DRAFT_READS) void queryClient.invalidateQueries({ queryKey });
    }
    else if (!quiet) say({ tone: "error", text: `${label}: ${authoringCopy(command.error)} (${command.error.reason})` });
  }, [command.state, command.error, label, quiet, say, setConflict, queryClient]);

  const { run: runCommand } = command;
  const run = useCallback(async (args: CallArgs<K>, success?: (result: ResultOf<K>) => string | null): Promise<ResultOf<K> | null> => {
    const body = (args as { body?: { expectedRevision?: unknown } }).body;
    mine.current = typeof body?.expectedRevision === "number" ? body.expectedRevision : draft.revision;
    say(null);
    const result = await runCommand(args);
    if (result) {
      setConflict(null);
      const text = success?.(result);
      if (text) say({ tone: "ok", text });
    }
    return result;
  }, [draft.revision, runCommand, say, setConflict]);

  return { ...command, run };
}
