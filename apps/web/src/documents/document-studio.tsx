import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { Schemas } from "@ehf/ui-contracts";
import { Button, Field, JsonViewer, SegmentedControl, Select, TextArea, TextInput, ToneBadge } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { useState } from "react";
import { api } from "../app/api";
import { useSession } from "../app/session";
import { SourceViewer } from "./SourceViewer";
import { ExtractionPanel, type DataTab } from "./ExtractionPanel";
import { RouteComparison } from "./RouteComparison";
import { downloadFile, extractionExport } from "./export";
import documentStyles from "./documents.module.css";
import { sandboxPath, sandboxTestSearch } from "../studio/sandbox/test-run-path";
import styles from "./studio.module.css";

type Content = Schemas["DocumentContent"];
type Test = Schemas["DocumentStudioTest"];

async function documentTypes() {
  const items: Schemas["CatalogIndex"]["items"] = [];
  let cursor: string | undefined;
  do {
    const page = await api.getCatalogs({ query: { kind: "documents", entryType: "definition", limit: 100, ...(cursor ? { cursor } : {}) } });
    items.push(...page.items); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

export default function DocumentStudio() {
  const session = useSession();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const types = useQuery({ queryKey: ["studio-document-types"], queryFn: documentTypes });
  const configuration = useQuery({ queryKey: ["document-studio-configuration"], queryFn: () => api.getDocumentStudioConfiguration(), retry: false });
  const documentType = typeof search.documentType === "string" ? search.documentType : types.data?.[0]?.id ?? "";
  const catalog = useQuery({ queryKey: ["document-contract", documentType], enabled: Boolean(documentType), queryFn: () => api.getCatalogsKindEntryId({ path: { kind: "documents", entryId: documentType } }) });
  const [typeQuery, setTypeQuery] = useState("");
  const [mode, setMode] = useState<"upload" | "text">("upload");
  const [sample, setSample] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [testId, setTestId] = useState<string | null>(null);
  const [original, setOriginal] = useState<Omit<Content, "documentVersion" | "documentId"> | null>(null);
  const [inputError, setInputError] = useState("");
  const test = useQuery({ queryKey: ["document-studio-test", testId], enabled: Boolean(testId), queryFn: () => api.getDocumentStudioTestsTestId({ path: { testId: testId! } }), refetchInterval: query => query.state.data?.status === "running" ? 1000 : false, retry: false });
  const start = useMutation({ mutationFn: async () => {
    const source = mode === "text" ? new File([sample], `${documentType}.txt`, { type: "text/plain" }) : file;
    if (!source || !source.size) throw new Error("Choose a sample file or enter document text.");
    if (source.size > 8 * 1024 * 1024) throw new Error("Choose a file smaller than 8 MB.");
    const bytes = new Uint8Array(await source.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    const content = { filename: source.name, mediaType: source.type || "application/octet-stream", contentBase64: btoa(binary) };
    const result = await api.postDocumentStudioTests({ body: { documentType, ...content }, idempotencyKey: crypto.randomUUID() });
    return { result, content };
  }, onSuccess: ({ result, content }) => { setOriginal(content); setTestId(result.testId); } });
  const run = test.data;
  const classifiedType = (run?.skillOutputs.classification as { classifications?: Array<{ document_type: string }> } | undefined)?.classifications?.[0]?.document_type;
  const busy = start.isPending || run?.status === "running";
  const model = configuration.data?.model;
  const matching = types.data?.filter(type => `${type.title} ${type.id} ${type.group}`.toLowerCase().includes(typeQuery.toLowerCase())) ?? [];
  const availableTypes = types.data?.filter(type => type.id === documentType || matching.includes(type)) ?? [];
  const canTest = session.actions.includes("draft.evaluate") && session.actions.includes("evidence.read");
  return <div className={styles.page}>
    <ConsoleHeader breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "Document Studio" }]} title="Document Studio" actions={<Link to={"/catalogs/documents" as string}>Browse document contracts</Link>} />
    <p className={styles.intro}>Test a built-in document contract against a sample, then inspect extracted fields on their source pages.</p>
    <div className={styles.setup}>
      <section className={styles.card} aria-label="Document test setup">
        <h2>1. Choose a document type</h2>
        {types.isPending ? <p>Loading document types…</p> : null}
        {types.isError ? <p role="alert">Document types could not load. <Button size="sm" onClick={() => void types.refetch()}>Retry</Button></p> : null}
        <TextInput aria-label="Search document types" placeholder="Find a type or family…" value={typeQuery} disabled={busy} onChange={event => setTypeQuery(event.target.value)} />
        <Field label={`Document type${types.data ? ` · ${types.data.length} built in` : ""}`}><Select value={documentType} disabled={busy || !types.data} onChange={event => { void navigate({ search: (previous: Record<string, unknown>) => ({ ...previous, documentType: event.target.value }) } as never); }}>
          {!types.data ? <option value="">Loading…</option> : null}
          {availableTypes.map(type => <option key={type.id} value={type.id}>{type.title} · {type.group}</option>)}
        </Select></Field>
        {!matching.length && types.data ? <p>No document types match your search.</p> : null}
        {catalog.data ? <><p>{catalog.data.description}</p><p className={styles.meta}>{catalog.data.fields.length} fields · {catalog.data.fields.filter(field => field.key).length} key fields</p><Link to={"/catalogs/documents" as string} search={{ selected: documentType }}>Inspect field contract</Link></> : null}
        {catalog.isError ? <p role="alert">This document contract is unavailable. Choose another type or retry.</p> : null}
      </section>
      <section className={styles.card} aria-label="Sample document">
        <h2>2. Add a sample</h2>
        <SegmentedControl label="Sample source" value={mode} onChange={value => { if (!busy) setMode(value); }} options={[{ value: "upload", label: "Upload file" }, { value: "text", label: "Document text" }]} />
        {mode === "upload" ? <Field label="Sample file" hint="Up to 8 MB. Text PDFs, TXT, Markdown, CSV, JSON and DOCX use the configured parser. Scanned files require OCR support."><input type="file" disabled={busy} onChange={event => { setInputError(""); const chosen = event.target.files?.[0] ?? null; setFile(chosen); if (chosen && chosen.size > 8 * 1024 * 1024) setInputError("Choose a file smaller than 8 MB."); }} /></Field> : <Field label="Sample document text" hint="Use the document’s actual title and contents to test classification and extraction."><TextArea rows={7} value={sample} disabled={busy} maxLength={100000} onChange={event => setSample(event.target.value)} /></Field>}
        {file && mode === "upload" ? <p className={styles.meta}>{file.name} · {Math.ceil(file.size / 1024)} KB</p> : null}
        {inputError ? <p role="alert">{inputError}</p> : null}
      </section>
      <section className={styles.card} aria-label="Document intelligence configuration">
        <h2>3. Run document skills</h2>
        <ol className={styles.skills}><li>Catalog classification</li><li>Contract field extraction</li><li>Source citation validation</li><li>Document validity assessment</li></ol>
        <p className={styles.meta}>Where an extraction model is configured for the type, it runs in shadow beside the LLM and the routes are compared field by field.</p>
        {model ? <p className={styles.model}><strong>{model.model}</strong><span>{model.provider} · {model.profileId}</span><small>Profile {model.profileDigest.slice(0, 12)}</small></p> : <p role={configuration.isError ? "alert" : "status"}>{configuration.isPending ? "Checking configured model…" : "Live document extraction is unavailable. Configure the extraction model, parser and document skill host."}</p>}
        {!model && !configuration.isPending ? <><code className={styles.meta}>{configuration.data?.unavailableReason ?? configuration.error?.message}</code><Button size="sm" onClick={() => void configuration.refetch()}>Check configuration again</Button></> : null}
        <Link to={"/platform/intelligence" as string}>Intelligence configuration</Link>
        <Button variant="primary" icon="play" busy={busy} disabled={!canTest || !model || !catalog.data || Boolean(mode === "upload" && inputError) || (mode === "upload" ? !file : !sample.trim())} onClick={() => start.mutate()}>Run document test</Button>
        {!canTest ? <p className={styles.meta}>Document testing requires draft evaluation and evidence read access.</p> : null}
        <p className={styles.meta}>Uses live inference. Results are held in memory for 30 minutes after completion. No case evidence or accepted facts are created.</p>
      </section>
    </div>
    {start.isError ? <p role="alert">Could not start the test: {start.error.message}</p> : null}
    {test.isError ? <p role="alert">Could not refresh this test: {test.error.message}. <Button size="sm" onClick={() => void test.refetch()}>Retry result</Button></p> : null}
    {run ? <section className={styles.results} aria-label="Document test results">
      <div className={styles.resultHeader}><div><h2>{run.filename}</h2><p>{run.documentType.replaceAll("_", " ")} · {run.model.model}</p></div><ToneBadge icon={run.status === "failed" ? "alert" : run.status === "running" ? "clock" : "check"} tone={run.status === "failed" ? "blocking" : run.status === "running" ? "attention" : "neutral"}>{run.stage}</ToneBadge></div>
      <p role="status">{run.status === "running" ? `${run.stage}…` : run.status === "completed" ? `${run.detail?.assertions.length ?? 0} extracted assertions. Review source citations before using any value.` : `Test failed: ${run.error}`}</p>
      {classifiedType ? <p className={styles.meta}>Automatic classification: {classifiedType.replaceAll("_", " ")}.{classifiedType !== run.documentType ? " This differs from the selected test contract; inspect whether the sample is appropriate." : " Matches the selected test contract."}</p> : null}
      {run.costUsd !== null ? <p className={styles.meta}>Reported inference cost: ${run.costUsd.toFixed(4)}</p> : null}
      <Link to={sandboxPath(run.testId)} search={sandboxTestSearch("document")}>Inspect in Sandbox Studio</Link>
      {run.detail ? <StudioResult key={run.testId} run={run} original={original} /> : null}
      {run.validation ? <details open={run.status === "failed"}><summary>Validation issues and field coverage</summary><JsonViewer label="Document contract validation" data={run.validation} /></details> : null}
      <details><summary>Document skill outputs</summary><JsonViewer label="Classification, extraction and validity" data={run.skillOutputs} /></details>
    </section> : <div className={styles.empty}><h2>Your sample, annotated</h2><p>Run a test to see source pages and extracted fields side by side. Select a field to find its exact citation; inspect the result as fields, JSON or schema.</p></div>}
  </div>;
}

function StudioResult({ run, original }: { run: Test; original: Omit<Content, "documentVersion" | "documentId"> | null }) {
  const detail = run.detail!;
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [tab, setTab] = useState<DataTab>("form");
  const [mobile, setMobile] = useState<"document" | "data">("document");
  const catalog = useQuery({ queryKey: ["document-contract", run.documentType], queryFn: () => api.getCatalogsKindEntryId({ path: { kind: "documents", entryId: run.documentType } }) });
  const select = (id: string | null) => { setSelected(id); setTab("form"); const assertion = detail.assertions.find(row => row.objectId === id); if (assertion?.spans[0]) setPage(assertion.spans[0].page); };
  const exportJson = () => downloadFile(`${run.filename}.studio.json`, JSON.stringify({ testId: run.testId, model: run.model, extraction: extractionExport(detail), routes: run.routes, validation: run.validation, skillOutputs: run.skillOutputs }, null, 2));
  return <>
    <div className={styles.resultHeader}><p className={styles.meta}>The selected type is the test contract. Automatic classification is reported in skill outputs.</p><Button size="sm" icon="download" onClick={exportJson}>Export test JSON</Button></div>
    <div className={documentStyles.mobileSwitch}><SegmentedControl label="Studio workspace" value={mobile} onChange={setMobile} options={[{ value: "document", label: "Document" }, { value: "data", label: "Extracted fields" }]} /></div>
    <div className={`${documentStyles.reviewWorkspace} ${styles.workspace}`} data-mobile={mobile}>
      <SourceViewer detail={detail} content={original ? { ...original, documentVersion: run.documentVersion } : undefined} page={page} onPage={setPage} selected={selected} hovered={hovered} onSelect={select} onHover={setHovered} />
      <ExtractionPanel detail={detail} selected={selected} hovered={hovered} onSelect={select} onHover={setHovered} tab={tab} onTab={setTab} catalog={catalog.data} canReview={false} onReview={() => {}} onExport={exportJson} preview />
    </div>
    {run.routes ? <RouteComparison comparison={run.routes} selected={selected} onSelect={id => { select(id); setMobile("document"); }} /> : null}
  </>;
}
