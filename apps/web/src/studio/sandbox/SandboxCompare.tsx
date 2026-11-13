import { Table } from "@ehf/ui-kit";
import { AdvancedData } from "./InspectorControls";
import styles from "./sandbox.module.css";

export type CompareStep = { id: string; name: string; status: string; input?: unknown; output?: unknown };
export type CompareRun = {
  label: string;
  status: string;
  outcome?: string | null;
  calls: number | null;
  duration: number | null;
  cost: number | null;
  steps: CompareStep[];
};

const missing = "Unavailable";
const elapsed = (value: number | null) => value === null ? missing : `${(value / 1000).toFixed(2)} s`;
const currency = (value: number | null) => value === null ? missing : `$${value.toFixed(4)}`;

export function duration(start: string | null, end: string | null) {
  if (!start || !end) return null;
  const milliseconds = Date.parse(end) - Date.parse(start);
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : null;
}

export function reportedCost(calls: ReadonlyArray<{ costUsd: number | null }>) {
  return calls.some(call => call.costUsd === null) ? null : calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0);
}

function isContainer(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Compare paths without including payload values in the diff. */
export function changedPaths(before: unknown, after: unknown, limit = 40): string[] {
  const changes: string[] = [];
  function visit(left: unknown, right: unknown, path: string) {
    if (changes.length >= limit || Object.is(left, right)) return;
    if (!isContainer(left) || !isContainer(right) || Array.isArray(left) !== Array.isArray(right)) {
      changes.push(path || "/");
      return;
    }
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const child = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      visit(Object.hasOwn(left, key) ? left[key] : undefined, Object.hasOwn(right, key) ? right[key] : undefined, child);
      if (changes.length >= limit) break;
    }
  }
  visit(before, after, "");
  return changes;
}

export function RunComparison({ baseline, candidate }: { baseline: CompareRun; candidate: CompareRun }) {
  const metrics = [
    { metric: "Runtime status", a: baseline.status, b: candidate.status },
    { metric: "Outcome", a: baseline.outcome ?? missing, b: candidate.outcome ?? missing },
    { metric: "Calls", a: baseline.calls ?? missing, b: candidate.calls ?? missing },
    { metric: "Duration", a: elapsed(baseline.duration), b: elapsed(candidate.duration) },
    { metric: "Reported cost", a: currency(baseline.cost), b: currency(candidate.cost) },
  ];
  const prior = new Map(baseline.steps.map(step => [step.id, step]));
  const next = new Map(candidate.steps.map(step => [step.id, step]));
  const changes = [...new Set([...prior.keys(), ...next.keys()])].flatMap(id => {
    const before = prior.get(id), after = next.get(id);
    const paths = before && after ? changedPaths({ input: before.input, output: before.output }, { input: after.input, output: after.output }) : [];
    return !before || !after || before.status !== after.status || paths.length ? [{
      id, name: (after ?? before)!.name, before: before?.status ?? "Absent", after: after?.status ?? "Absent", paths,
    }] : [];
  });
  return <div className={styles.inspectorStack}>
    <Table caption="Run comparison" rows={metrics} rowKey={row => row.metric} columns={[
      { key: "metric", header: "Metric", render: row => row.metric },
      { key: "baseline", header: baseline.label, render: row => row.a },
      { key: "candidate", header: candidate.label, render: row => row.b },
    ]} />
    {changes.length ? <Table caption="Changed steps" rows={changes} rowKey={row => row.id} columns={[
      { key: "step", header: "Step", render: row => row.name },
      { key: "baseline", header: "Baseline", render: row => row.before },
      { key: "candidate", header: "Candidate", render: row => row.after },
      { key: "paths", header: "Payload changes", render: row => row.paths.length ? <AdvancedData label="Changed paths" data={row.paths} /> : "—" },
    ]} /> : <p>No changes in the recorded steps.</p>}
  </div>;
}
