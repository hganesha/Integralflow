import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { diligenceReaders, policyGateOptions } from "./policy-gates";

const read = (path: string) => readFileSync(new URL(`../../../../../../${path}`, import.meta.url), "utf8");

it("offers the business policy's gates, with its diligence gate, and nothing for another policy", () => {
  const files = { "policy.yaml": read("domains/kyb-agentic/policy.yaml") };
  expect(policyGateOptions(files, "policy.kyb-agentic.business.v2")).toEqual([
    { gateId: "intake-ready", label: "Intake ready", diligence: false },
    { gateId: "decision-ready", label: "Decision ready", diligence: false },
    { gateId: "disposition", label: "Disposition", diligence: false },
    { gateId: "diligence-level", label: "Diligence level (SDD, CDD or EDD)", diligence: true },
  ]);
  expect(policyGateOptions(files, "policy.other")).toBeNull();
  expect(policyGateOptions({ "policy.yaml": "kind: Policy\nmetadata: { id: x }" }, "x")).toBeNull();
});

it("lists the skill steps that read a diligence gate's level", () => {
  const workflow = parse(read("domains/kyb-agentic/workflow.yaml")) as Record<string, unknown>;
  expect(diligenceReaders(workflow, "diligence-level")).toEqual([
    { nodeId: "edd-trigger-evaluate", name: "edd.trigger.evaluate", target: "facts.diligence_level" },
    { nodeId: "decision-requirements-compile", name: "decision.requirements.compile", target: "facts.diligence_level" },
  ]);
  expect(diligenceReaders(workflow, "pack-disposition")).toEqual([]);
});
