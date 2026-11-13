import { ApiError } from "@ehf/ui-client";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "./query-client";

vi.mock("./session-events", () => ({ markSessionEnded: vi.fn() }));
const { markSessionEnded } = await import("./session-events");

const error = (status: number, reason: string) => new ApiError(status, { error: reason, message: reason } as never);

describe("global error policy", () => {
  it("AC6: a 403 role_missing from a mutation refetches the session", async () => {
    const client = createQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await client.getMutationCache().build(client, { mutationFn: () => Promise.reject(error(403, "authorization.role_missing")) }).execute(undefined).catch(() => undefined);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["session"] });
  });

  it("AC5: a 401 from any query ends the session", async () => {
    const client = createQueryClient();
    await client.fetchQuery({ queryKey: ["anything"], queryFn: () => Promise.reject(error(401, "session.expired")) }).catch(() => undefined);
    expect(markSessionEnded).toHaveBeenCalledWith(true);
  });

  it("does not touch the session for ordinary failures", async () => {
    const client = createQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await client.fetchQuery({ queryKey: ["other"], queryFn: () => Promise.reject(error(409, "authoring.revision_conflict_or_published")) }).catch(() => undefined);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
