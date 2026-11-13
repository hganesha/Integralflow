import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Schemas } from "@ehf/ui-contracts";
import { Button, Tabs } from "@ehf/ui-kit";
import { useState, type ReactNode } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { lensPath } from "../../domains/fincrime/work/paths";
import { ApiErrorView } from "../../platform/common";
import type { RuntimeEvent } from "../../platform/surfaces/runs/use-run-events";
import { humanLabel, policyLabel, profileLabel, readable, stringValues, type StepScope } from "./inspection-model";
import { AdvancedData, InspectorChoice } from "./InspectorControls";
import styles from "./sandbox.module.css";

type Observation = Schemas["SandboxObservation"];
type CaptureScope = { runId: string; scope: (Omit<StepScope, "attempt"> & { attempt?: number }) | null; settled: boolean };
type InspectCall = (nodeId: string, attempt: number, epoch: number, callId: string) => void;

function useObservations({ runId, scope, settled }: CaptureScope, kind: Observation["kind"], enabled = true) {
  const { actions } = useSession();
  const allowed = actions.includes("evidence.read") && actions.includes("case.read");
  const query = useInfiniteQuery({
    queryKey: ["sandbox-observations", runId, kind, scope],
    enabled: allowed && enabled,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ signal, pageParam }) => api.getAuthoringSandboxRunsRunIdObservations({
      path: { runId }, query: { kind, nodeId: scope?.nodeId, attempt: scope?.attempt, fencingEpoch: scope?.epoch, before: pageParam }, signal,
    }),
    getNextPageParam: page => page.nextBefore ?? undefined,
    refetchInterval: settled ? false : 7000,
  });
  return { query, allowed, items: query.data?.pages.flatMap(page => page.items) ?? [] };
}
type Feed = ReturnType<typeof useObservations>;

function ObservationFeed({ feed, empty, children }: { feed: Feed; empty: string; children: ReactNode }) {
  if (!feed.allowed) return <p>Restricted. Recorded evidence requires case and evidence access.</p>;
  const { query, items } = feed;
  if (query.isPending) return <p>Loading recorded evidence…</p>;
  return <div className={styles.inspectorStack}>
    {query.error ? <ApiErrorView error={query.error} /> : null}
    {items.length ? children : !query.isError ? <p>{empty}</p> : null}
    {query.hasNextPage ? <Button size="sm" onClick={() => void query.fetchNextPage()} busy={query.isFetchingNextPage}>Load older observations</Button> : null}
    {items.length && query.data ? <small>Redacted captures are retained for {query.data.pages[0]?.retentionDays} days.</small> : null}
  </div>;
}

type ContextProps = CaptureScope & {
  packDigest?: string; event?: RuntimeEvent; profile?: string; policy: string; step: string;
};

export function ContextObservations({ packDigest, event, profile, policy, step, ...scope }: ContextProps) {
  const feed = useObservations(scope, "context");
  const [selection, setSelection] = useState("");
  const captures = feed.items.filter(item => item.kind === "context");
  const capture = captures.find(item => String(item.sequence) === selection)
    ?? captures.find(item => item.data.packDigest === packDigest) ?? captures[0];
  const metadata = event?.values;
  const { nodeId, attempt, epoch } = scope.scope ?? {};
  const selectedDigest = capture?.data.packDigest ?? packDigest;
  const results = useQuery({
    queryKey: ["sandbox-context-results", scope.runId, nodeId, attempt, epoch, selectedDigest],
    enabled: feed.allowed && !!nodeId && attempt !== undefined && epoch !== undefined,
    refetchInterval: scope.settled ? false : 7000,
    queryFn: ({ signal }) => api.getAuthoringSandboxRunsRunIdContextResults({
      path: { runId: scope.runId },
      query: { nodeId: nodeId!, attempt: attempt!, fencingEpoch: epoch!, packDigest: selectedDigest }, signal,
    }),
  });
  const recordedProfile = typeof metadata?.agentId === "string" ? metadata.agentId : profile;
  const dropped = new Set(stringValues(metadata?.droppedSectionIds));
  const quarantined = new Set(stringValues(metadata?.quarantinedSectionIds));
  const sections = capture?.data.sections ?? stringValues(metadata?.sectionIds).map(id => ({
    id, items: null, state: quarantined.has(id) ? "Quarantined" : dropped.has(id) ? "Dropped by budget" : "Included",
  }));
  const gaps = capture?.data.gaps ?? (Array.isArray(metadata?.recordGaps) ? metadata.recordGaps.flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const gap = value as Record<string, unknown>;
    return typeof gap.objectType === "string" && typeof gap.code === "string"
      ? [{ objectType: gap.objectType, code: gap.code, required: gap.required === true }] : [];
  }) : []);
  const status = gaps.some(gap => gap.required) ? "Missing required evidence"
    : sections.some(section => section.state === "Quarantined") ? "Some context quarantined" : "Context resolved";
  const selectedSections = <ul className={styles.compactList}>{sections.map(section => <li key={section.id}>
    {humanLabel(section.id.replace(/^rec(?=[A-Z])/, "").replace(/-.+$/, ""))}
    {section.items === null ? "" : ` · ${section.items} items`}
    {section.state === "Included" ? "" : ` · ${section.state}`}
  </li>)}</ul>;

  return <div className={styles.inspectorStack}>
    {feed.query.error ? <ApiErrorView error={feed.query.error} /> : null}
    <dl className={styles.facts}>
      <dt>Step</dt><dd>{step}</dd>
      <dt>Agent profile</dt><dd>{recordedProfile ? profileLabel(recordedProfile) : "Not recorded"}</dd>
      <dt>Run policy pack</dt><dd>{policyLabel(policy)}</dd>
      <dt>Context</dt><dd>{capture || metadata ? status : feed.query.isFetching ? "Loading…" : "Not recorded"}</dd>
      {capture?.data.caseSequence != null ? <><dt>Case snapshot</dt><dd>Revision {capture.data.caseSequence}</dd></> : null}
    </dl>
    {captures.length > 1 ? <InspectorChoice label="Context snapshot" value={String(capture?.sequence)} onChange={setSelection}
      items={captures.map((item, index) => ({ value: String(item.sequence), label: index === 0 ? "Latest snapshot" :
        `Snapshot ${captures.length - index}${item.data.caseSequence != null ? ` · Case revision ${item.data.caseSequence}` : ""}` }))} /> : null}
    {results.error ? <ApiErrorView error={results.error} /> : null}
    {results.data ? <ContextResults data={results.data} /> : null}
    {sections.length && !results.data?.context.length ? <div className={styles.inspectorStack}>
      <strong>{sections.length} context sections</strong>
      {sections.length > 4 ? <details><summary>View sections</summary><div className={styles.boundedList}>{selectedSections}</div></details> : selectedSections}
    </div> : null}
    {gaps.length ? <details className={styles.advanced}><summary>{gaps.length} evidence {gaps.length === 1 ? "gap" : "gaps"}</summary>
      <ul className={`${styles.compactList} ${styles.boundedList}`}>{gaps.map((gap, index) => <li key={index}>
        {humanLabel(gap.objectType)} · {humanLabel(gap.code.toLowerCase())}{gap.required ? " · Required" : ""}
      </li>)}</ul>
    </details> : null}
    {!capture && metadata ? <small>{feed.allowed ? results.data?.context.length ? "Collected context from the recorded snapshot." : "Summary from the recorded context event." : "Snapshot details require evidence access."}</small> : null}
    {capture || metadata ? <AdvancedData key={capture?.sequence ?? event?.sequence} label="Context data"
      data={capture ? { policy, profile: recordedProfile, ...capture } : { policy, profile: recordedProfile, ...metadata }} /> : null}
    {feed.query.hasNextPage ? <Button size="sm" onClick={() => void feed.query.fetchNextPage()} busy={feed.query.isFetchingNextPage}>Load older snapshots</Button> : null}
  </div>;
}

function ContextResults({ data }: { data: Schemas["SandboxContextResults"] }) {
  const groups = data.context.filter(section => section.count > 0);
  const [selection, setSelection] = useState("");
  const section = groups.find(item => item.id === selection) ?? groups.find(item => item.fields.length > 0) ?? groups[0];
  const fields = (values: ReadonlyArray<{ label: string; value: string | number }>) => values.length
    ? <dl className={styles.facts}>{values.map(({ label, value }, index) => <div className={styles.factPair} key={`${label}:${index}`}>
      <dt>{label}</dt><dd>{typeof value === "number" ? value.toLocaleString() : value}</dd>
    </div>)}</dl> : null;
  const outcome = data.outcome;
  const group = outcome?.groups.find(item => item.fields.length) ?? outcome?.groups[0];

  return <div className={styles.inspectorStack}>
    <section className={styles.detailCard} aria-label="Step result">
      <h3>Step result</h3>
      {outcome?.status ? <p>{humanLabel(readable(outcome.status))}</p> : null}
      {outcome ? <>
        {fields(outcome.fields)}
        {group ? <><p>{group.label} · {group.count}</p>{fields(group.fields)}</> : null}
        {outcome.groups.length > 1 ? <details className={styles.advanced}><summary>Other result groups</summary>
          <ul className={styles.compactList}>{outcome.groups.filter(item => item !== group).map(item => <li key={item.label}>{item.label} · {item.count}</li>)}</ul>
        </details> : null}
        {!outcome.fields.length && !group ? <p>No summary fields were recorded.</p> : null}
      </> : <p>No step output recorded for this attempt.</p>}
    </section>
    {section ? <section className={styles.detailCard} aria-label="Collected context">
      <h3>Collected context</h3>
      {groups.length > 1 ? <InspectorChoice label="Context section" value={section.id} onChange={setSelection}
        items={groups.map(item => ({ value: item.id, label: `${humanLabel(item.id.replace(/^rec(?=[A-Z])/, "").replace(/-.+$/, ""))} · ${item.count}` }))} /> : null}
      {groups.length === 1 ? <p>{humanLabel(section.id.replace(/^rec(?=[A-Z])/, "").replace(/-.+$/, ""))} · {section.count}</p> : null}
      {fields(section.fields) ?? <p>No summary fields for this section.</p>}
    </section> : null}
  </div>;
}

type SkillObservation = Extract<Observation, { kind: "skill" }>;
type Payload = NonNullable<SkillObservation["data"]["input"]>;
const skillTabs = [{ value: "input", label: "Input" }, { value: "output", label: "Output" }, { value: "diff", label: "Diff" }] as const;

function payloadDiff(input: Payload, output: Payload) {
  const before = new Map(input.fields.map(field => [field.path, field]));
  const after = new Map(output.fields.map(field => [field.path, field]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(path => {
    const left = before.get(path);
    const right = after.get(path);
    if (left?.type === right?.type && left?.count === right?.count) return [];
    return [{ path, change: !left ? "added" : !right ? "removed" : "changed",
      input: left ? { type: left.type, count: left.count } : null, output: right ? { type: right.type, count: right.count } : null }];
  });
}

function PayloadView({ data }: { data: SkillObservation["data"] }) {
  const [tab, setTab] = useState<(typeof skillTabs)[number]["value"]>(data.input ? "input" : "output");
  const { input, output } = data;
  return <Tabs label="Skill payload" items={skillTabs} value={tab} onChange={setTab} renderPanel={active => {
    if (active === "diff") {
      if (!input || !output) return <p>Both input and output are needed for a comparison.</p>;
      const changes = payloadDiff(input, output);
      return <div className={styles.inspectorStack}>
        <p>{changes.length ? `${changes.length} structural changes in this attempt` : "No structural changes in the captured fields."}</p>
        <ul className={styles.compactList}>{changes.slice(0, 4).map(change => <li key={change.path}>
          {humanLabel(change.path.split("/").at(-1) || "Payload")} · {change.change}
        </li>)}</ul>
        <AdvancedData key="diff" label="Redacted structure diff" data={changes} />
      </div>;
    }
    const payload = data[active];
    if (!payload) return <p>{active === "input" && data.status === "NEEDS_EVIDENCE"
      ? "No input was sent for this observation." : "Payload details were not captured for this selection."}</p>;
    const fields = payload.fields.filter(field => field.path.split("/").length === 2 && field.type !== "omitted");
    return <div className={styles.inspectorStack}>
      <p>{fields.length ? "Recorded fields. Values are masked." : "Payload recorded. Values are masked."}</p>
      {fields.length ? <ul className={styles.compactList}>{fields.slice(0, 5).map(field => <li key={field.path}>
        {humanLabel(field.path.slice(2))} · {field.count == null ? field.type : `${field.count} ${field.type === "array" ? "items" : "fields"}`}
      </li>)}</ul> : null}
      <AdvancedData key={active} label={`Redacted skill ${active}`} data={payload} />
    </div>;
  }} />;
}

export function SkillObservations({ inspectCall, openContext, ...scope }: CaptureScope & { inspectCall: InspectCall; openContext: InspectCall }) {
  const feed = useObservations(scope, "skill");
  const [selection, setSelection] = useState("");
  const records = feed.items.filter(item => item.kind === "skill");
  const item = records.find(item => String(item.sequence) === selection) ?? records[0];
  return <ObservationFeed feed={feed} empty="Skill payload details were not captured for this selection.">
    {records.length > 1 && item ? <InspectorChoice label="Skill observation" value={String(item.sequence)} onChange={setSelection}
      items={records.map(record => ({ value: String(record.sequence), label: `${humanLabel(record.data.skillId)} · ${humanLabel(readable(record.data.status))}` }))} /> : null}
    {item ? <section className={styles.detailCard}>
      <strong>{humanLabel(item.data.skillId)}</strong>
      <p>{humanLabel(readable(item.data.status))}{item.data.skillVersion ? ` · Version ${item.data.skillVersion}` : ""}</p>
      <div className={styles.row}>
        {item.data.contextHash ? <Button size="sm" onClick={() => openContext(item.nodeId, item.attempt, item.fencingEpoch, item.data.contextHash!)}>Inspect context snapshot</Button> : null}
        {item.invocationId ? <Button size="sm" onClick={() => inspectCall(item.nodeId, item.attempt, item.fencingEpoch, item.invocationId!)}>Inspect recorded invocation</Button> : null}
      </div>
      <PayloadView key={item.sequence} data={item.data} />
    </section> : null}
  </ObservationFeed>;
}

type Selection = { id: string; version: string };
type DocumentProps = CaptureScope & {
  caseId: string; documents: number; skipped: number; selection: Selection | null; extractionNodeId?: string;
  select: (selection: Selection | null) => void; inspectCall: InspectCall;
};
const sameVersion = (left: string, right: string) => left.replace(/^sha256:/, "") === right.replace(/^sha256:/, "");

export function SandboxDocuments({ caseId, documents, skipped, selection, select, inspectCall, extractionNodeId, ...scope }: DocumentProps) {
  const source = useObservations({ ...scope, scope: null }, "documents");
  const extractionScope = extractionNodeId ? { nodeId: extractionNodeId, attempt: scope.scope?.attempt, epoch: scope.scope?.epoch } : null;
  const extractions = useObservations({ ...scope, scope: extractionScope }, "skill", Boolean(extractionScope));
  const list = useQuery({
    queryKey: ["sandbox-case-documents", caseId],
    enabled: source.allowed, retry: false, refetchInterval: scope.settled ? false : 7000,
    queryFn: ({ signal }) => api.getFincrimeCasesCaseIdDocuments({ path: { caseId }, signal }),
  });
  const current = list.data?.documents ?? [];
  const document = selection ? current.find(item => item.documentId === selection.id && sameVersion(item.documentVersion, selection.version)) : current[0];
  const detail = useQuery({
    queryKey: ["sandbox-case-document", caseId, document?.documentId, document?.documentVersion],
    enabled: source.allowed && !!document, retry: false,
    queryFn: ({ signal }) => api.getFincrimeCasesCaseIdDocumentsDocumentIdCitations({
      path: { caseId, documentId: document!.documentId }, query: { version: document!.documentVersion }, signal,
    }),
  });
  if (!source.allowed) return <p>Restricted. Document evidence requires case and evidence access.</p>;
  const acquired = document && source.items.find(item => item.kind === "documents" && item.data.documents.some(ref =>
    ref.documentId === document.documentId && sameVersion(ref.version, document.documentVersion)));
  const extraction = document && extractions.items.find((item): item is SkillObservation => item.kind === "skill" && item.data.documents.some(ref =>
    sameVersion(ref.version, document.documentVersion)));
  const state = document && ((extraction ? extraction.data.documents.find(ref => sameVersion(ref.version, document.documentVersion))?.status : undefined) ?? document.extractionStatus);
  const options = current.map(item => ({ value: JSON.stringify([item.documentId, item.documentVersion]), label: item.filename ?? item.documentId }));
  if (!document && current.length) options.unshift({ value: "", label: "Choose a document version" });
  return <div className={styles.inspectorStack}>
    <p>{documents} source documents loaded{skipped ? ` · ${skipped} skipped` : ""}.</p>
    {list.error ? <ApiErrorView error={list.error} /> : null}
    {list.isPending ? <p>Loading case document evidence…</p> : !current.length && !list.isError ? <p>No document versions are available in the case store.</p> : null}
    {options.length > 1 ? <InspectorChoice label="Document version" value={document ? JSON.stringify([document.documentId, document.documentVersion]) : ""}
      items={options} onChange={value => {
        const item = current.find(item => JSON.stringify([item.documentId, item.documentVersion]) === value);
        if (item) select({ id: item.documentId, version: item.documentVersion });
      }} /> : null}
    {document && state ? <section className={styles.detailCard} key={document.documentVersion}>
      <strong>{document.filename ?? document.documentId}</strong>
      <dl className={styles.facts}>
        <dt>Pages</dt><dd>{document.pageCount}</dd>
        <dt>Extraction</dt><dd>{humanLabel(readable(state))}</dd>
        <dt>Extracted fields</dt><dd>{document.assertionCount}</dd>
      </dl>
      {detail.error ? <ApiErrorView error={detail.error} /> : null}
      <Link to={lensPath(caseId, "documents")} search={{ document: document.documentId, version: document.documentVersion } as never}>Open document viewer</Link>
      {detail.data && sameVersion(detail.data.documentVersion, document.documentVersion) ? <CitationList detail={detail.data} caseId={caseId} /> : null}
      {acquired && acquired.invocationId ? <button type="button" className={styles.textButton} onClick={() => inspectCall(acquired.nodeId, acquired.attempt, acquired.fencingEpoch, acquired.invocationId!)}>Inspect acquisition call</button> : null}
      {extraction && extraction.invocationId ? <button type="button" className={styles.textButton} onClick={() => inspectCall(extraction.nodeId, extraction.attempt, extraction.fencingEpoch, extraction.invocationId!)}>Inspect extraction call</button> : null}
      <AdvancedData label="Document data" data={document} />
    </section> : null}
    {selection && list.data && !document ? <p>The selected document version is unavailable.</p> : null}
    {source.query.error ? <ApiErrorView error={source.query.error} /> : null}
    {extractions.query.error ? <ApiErrorView error={extractions.query.error} /> : null}
    {source.query.hasNextPage ? <Button size="sm" onClick={() => void source.query.fetchNextPage()}>Load earlier acquisition records</Button> : null}
  </div>;
}

function CitationList({ detail, caseId }: { detail: Schemas["CaseDocumentCitationPreview"]; caseId: string }) {
  const { evidence, assertions, documentId, documentVersion } = detail;
  const spanLink = (span: (typeof evidence)[number]) => <Link to={lensPath(caseId, "documents")} search={{
    document: documentId, version: documentVersion, field: span.ref, page: span.page, citationStart: span.start, citationEnd: span.end,
  } as never}>Page {span.page} · offsets {span.start}–{span.end}</Link>;
  return <>
    {evidence.length ? <details className={styles.advanced}>
      <summary>{evidence.length} source {evidence.length === 1 ? "citation" : "citations"}</summary>
      <ul className={`${styles.compactList} ${styles.boundedList}`}>{evidence.map((span, index) => <li key={index}>{spanLink(span)}</li>)}</ul>
    </details> : null}
    {assertions.length ? <details className={styles.advanced}><summary>Field citations</summary><ul className={`${styles.compactList} ${styles.boundedList}`}>
      {assertions.map((assertion, index) => <li key={index}>
        <strong>{assertion.field}</strong> · {readable(assertion.verification)}
        {assertion.spans.length ? <ul className={styles.evidenceList}>{assertion.spans.map((span, index) =>
          <li key={index}>{spanLink(span)}</li>)}</ul> : <p>No source citation recorded.</p>}
      </li>)}
    </ul></details> : <p>No extracted fields or field citations were recorded for this version.</p>}
    {detail.truncated ? <p>Open the document viewer for all citations.</p> : null}
  </>;
}
