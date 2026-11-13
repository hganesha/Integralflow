import { Field, Select, TextArea, TextInput } from "@ehf/ui-kit";
import type { Definition } from "./model";
import styles from "./intelligence.module.css";

type DocumentConfig = Extract<Definition, { serviceClass: "document" }>["configuration"];
type DecisionConfig = Extract<Definition, { serviceClass: "decision" }>["configuration"];
function Text({ label, value, onChange, hint }: { label: string; value: string; onChange: (value: string) => void; hint?: string }) {
  return <Field label={label} hint={hint}><TextInput value={value} maxLength={400} onChange={event => onChange(event.target.value)} /></Field>;
}
function NumberField({ label, value, onChange, min = 1, max, step = 1 }: { label: string; value: number; onChange: (value: number) => void; min?: number; max: number; step?: number }) {
  return <Field label={label}><TextInput type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : ""} onChange={event => onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))} /></Field>;
}
const DOCUMENT_HINTS: Record<string, string> = {
  private_document: "Bind the private document service endpoint and pin its processor and API versions. Declare the approved result boundary for asynchronous jobs.",
  aws_textract: "Select the Textract operation and feature set. Multipage documents require asynchronous processing and approved storage/IAM permissions.",
  databricks_document: "Bind the deployed document-parsing function or endpoint and its immutable version; declare the approved Unity Catalog result boundary.",
  llamaparse: "LlamaParse is the hosted parser from LlamaIndex. Pin the parse configuration and output contract; a LlamaIndex workflow can use a private adapter.",
};
export function DocumentParameters({ configuration: config, adapterId, onChange }: { configuration: DocumentConfig; adapterId: string; onChange: (value: DocumentConfig) => void }) {
  const patch = (value: Partial<DocumentConfig>) => onChange({ ...config, ...value });
  return <>
    <p className={`${styles.notice} ${styles.wide}`}>{DOCUMENT_HINTS[adapterId] ?? "Declare the processor, supported features and approved document/result boundary."}</p>
    <Text label="Versioned capability ID" value={config.capabilityId} onChange={capabilityId => patch({ capabilityId })} />
    <Field label="Document operation"><Select value={config.operation} onChange={event => patch({ operation: event.target.value as DocumentConfig["operation"] })}>{["ocr", "layout", "extract", "classify", "split"].map(value => <option key={value} value={value}>{value}</option>)}</Select></Field>
    <Text label="Processor / model / function" value={config.model} onChange={model => patch({ model })} />
    <Text label="Model / processor version" value={config.modelVersion} onChange={modelVersion => patch({ modelVersion })} />
    <Text label="Provider API version" value={config.apiVersion} onChange={apiVersion => patch({ apiVersion })} />
    <Text label="Canonical output schema reference" value={config.outputSchemaRef} onChange={outputSchemaRef => patch({ outputSchemaRef })} />
    <Text label="Locale / language hint" value={config.locale} onChange={locale => patch({ locale })} />
    <Field label="Processing mode"><Select value={config.executionMode} onChange={event => patch({ executionMode: event.target.value as DocumentConfig["executionMode"] })}><option value="asynchronous">Asynchronous job</option><option value="synchronous">Synchronous request</option></Select></Field>
    <fieldset className={`${styles.featureSet} ${styles.wide}`}><legend>Requested features · subject to provider qualification</legend>{(["tables", "key_values", "selection_marks", "barcodes", "languages"] as const).map(feature => <label key={feature}><input type="checkbox" checked={config.features.includes(feature)} onChange={event => patch({ features: event.target.checked ? [...config.features, feature] : config.features.filter(value => value !== feature) })} />{feature.replaceAll("_", " ")}</label>)}</fieldset>
    <NumberField label="Maximum pages per document" value={config.maxPages} max={10000} onChange={maxPages => patch({ maxPages })} />
    <NumberField label="Maximum document size (bytes)" value={config.maxBytes} max={536870912} onChange={maxBytes => patch({ maxBytes })} />
    <NumberField label="Job / request timeout (ms)" value={config.timeoutMs} max={600000} onChange={timeoutMs => patch({ timeoutMs })} />
    {config.executionMode === "asynchronous" ? <><NumberField label="Poll interval (ms)" value={config.pollIntervalMs} min={100} max={60000} onChange={pollIntervalMs => patch({ pollIntervalMs })} /><Text label="Approved result-store reference" value={config.resultStoreRef} onChange={resultStoreRef => patch({ resultStoreRef })} hint="A logical storage reference, never a signed URL or document content." /></> : null}
    <NumberField label="Minimum field confidence" value={config.minConfidence} min={0} max={1} step={0.01} onChange={minConfidence => patch({ minConfidence })} />
    <Text label="Extraction evaluation reference" value={config.evaluationRef} onChange={evaluationRef => patch({ evaluationRef })} />
    <p className={`${styles.notice} ${styles.wide}`}>Page and source provenance are required. Unsupported features, missing confidence, incomplete jobs and low-confidence fields route to review. Provider limits must be verified before activation.</p>
  </>;
}
export function DecisionParameters({ configuration: config, adapterId, onChange }: { configuration: DecisionConfig; adapterId: string; onChange: (value: DecisionConfig) => void }) {
  const patch = (value: Partial<DecisionConfig>) => onChange({ ...config, ...value });
  return <>
    <p className={`${styles.notice} ${styles.wide}`}>{adapterId === "jev" ? "Jev evaluates typed questions against state. Choice selects a label; score uses ordered rubric levels; Noul returns a truth probability; box locates an image region. Confidence availability depends on the primitive." : "Schema-constrained model output can implement a bounded decision contract. It does not establish calibrated confidence or native System One behavior."}</p>
    <Text label="Versioned capability ID" value={config.capabilityId} onChange={capabilityId => patch({ capabilityId })} />
    <Field label="Decision primitive"><Select value={config.primitive} onChange={event => patch({ primitive: event.target.value as DecisionConfig["primitive"] })}><option value="choice">Choice · bounded labels</option><option value="score">Score · ordered rubric levels</option><option value="noul">Noul · truth probability</option><option value="box">Box · image coordinates</option></Select></Field>
    <Text label="Model / deployment" value={config.model} onChange={model => patch({ model })} />
    <Text label="Immutable model version" value={config.modelVersion} onChange={modelVersion => patch({ modelVersion })} />
    <Text label="State schema reference" value={config.stateSchemaRef} onChange={stateSchemaRef => patch({ stateSchemaRef })} />
    <Text label="Versioned questions / rubric reference" value={config.questionSetRef} onChange={questionSetRef => patch({ questionSetRef })} hint="Atomic questions and instructions live in this reviewed artifact." />
    <Text label="Typed output schema reference" value={config.outputSchemaRef} onChange={outputSchemaRef => patch({ outputSchemaRef })} />
    {config.primitive === "choice" || config.primitive === "score" ? <div className={styles.wide}><Field label={config.primitive === "choice" ? "Allowed choice labels · one per line" : "Ordered rubric levels · one per line"} hint="Use 2–100 unique labels. Score order follows this list; descriptions belong in the versioned rubric."><TextArea value={config.options.join("\n")} onChange={event => patch({ options: event.target.value.split("\n") })} /></Field></div> : null}
    <Field label="Confidence source"><Select value={config.confidenceMode} onChange={event => { const confidenceMode = event.target.value as DecisionConfig["confidenceMode"]; patch({ confidenceMode, ...(confidenceMode === "none" ? { minConfidence: 0 } : {}) }); }}><option value="none">No confidence signal</option><option value="provider">Provider confidence · requires qualification</option><option value="validated">Independently validated confidence</option></Select></Field>
    {config.confidenceMode !== "none" ? <NumberField label="Minimum decision confidence" value={config.minConfidence} min={0} max={1} step={0.01} onChange={minConfidence => patch({ minConfidence })} /> : null}
    <Text label="Confidence / calibration evidence reference" value={config.calibrationRef} onChange={calibrationRef => patch({ calibrationRef })} hint="Probability, confidence and rubric score have different meanings." />
    <Text label="Decision use policy reference" value={config.policyRef} onChange={policyRef => patch({ policyRef })} />
    <Text label="Decision evaluation reference" value={config.evaluationRef} onChange={evaluationRef => patch({ evaluationRef })} />
    <NumberField label="Maximum questions per request" value={config.maxQuestions} max={100} onChange={maxQuestions => patch({ maxQuestions })} />
    <NumberField label="Decision latency budget (ms)" value={config.timeoutMs} max={600000} onChange={timeoutMs => patch({ timeoutMs })} />
    <p className={`${styles.notice} ${styles.wide}`}>Timeouts, invalid typed answers and unmet confidence thresholds abstain. There is no automatic fallback to a reasoning model. Application policy decides review or escalation; a model answer does not authorize a business action.</p>
  </>;
}
