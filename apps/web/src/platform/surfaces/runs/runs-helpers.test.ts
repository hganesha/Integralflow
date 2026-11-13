import { describe, expect, it } from "vitest";
import { visibleAttributes } from "./trace-attributes";
import { lastSequence, mergeEvents, type RuntimeEvent } from "./use-run-events";

const event = (sequence: number, code = "node.started"): RuntimeEvent => ({ runId: "r", sequence, code, nodeId: null, status: "observed", values: {}, occurredAt: "2026-11-07T09:00:00Z" });

describe("mergeEvents", () => {
  it("appends without duplicates and orders by sequence", () => {
    const held = [event(1), event(2), event(3)];
    const merged = mergeEvents(held, [event(5), event(3, "replayed"), event(4)]);
    expect(merged.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(merged[2]!.code).toBe("node.started");
    expect(lastSequence(merged)).toBe(5);
    expect(lastSequence([])).toBe(0);
  });
});

describe("visibleAttributes", () => {
  it("renders only allow-listed attributes and never credentials or bodies", () => {
    const { shown, hidden } = visibleAttributes({
      "http.route": "/v1/runs",
      "span.kind": "server",
      "http.request.header.cookie": "c",
      "http.request.header.authorization": "a",
      "http.request.body": "b",
      "custom.thing": 1,
    });
    expect(shown).toEqual([["http.route", "/v1/runs"], ["span.kind", "server"]]);
    expect(hidden).toBe(4);
  });
  it("shows safe GenAI counters and omits payload-like values", () => {
    const result = visibleAttributes({
      "gen_ai.provider.name": "azure.ai.foundry",
      "gen_ai.usage.input_tokens": 20,
      "gen_ai.usage.output_tokens": "unexpected secret",
      "gen_ai.input.messages": "sensitive prompt",
    });
    expect(result.shown).toEqual([["gen_ai.provider.name", "azure.ai.foundry"], ["gen_ai.usage.input_tokens", "20"]]);
    expect(result.hidden).toBe(2);
  });
});
