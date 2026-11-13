import { ApiError } from "@ehf/ui-client";
import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, Disclosure, Field, Icon, InlineMessage, Select, Sheet, Skeleton, TextArea, TextInput } from "@ehf/ui-kit";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "../../app/api";
import { ApiErrorView, useCommand } from "../common";
import {
  CUSTOMER_TYPE_LABEL, DUE_DILIGENCE_LABEL, dueDiligenceIneligibility, EVENT_LABEL, initialForm, missing, PRODUCT_LABEL, processTitle, refusalCopy, scopeOf,
  selectionSummary, TRIGGER_LABEL, updateForm, type CasePlanSelection, type CaseScope, type CaseScopeForm, type ScopeOptions,
} from "./case-scope-model";
import {
  applicantMissing, applicantStarted, applicationOf, blankActivity, DOCUMENT_MAX_BYTES, DOCUMENT_MAX_COUNT, emptyApplicant, EXPOSURE_LABEL, IDENTIFIER_TYPES, intakeSummary,
  LABEL, LEGAL_FORMS, newDocument, newParty, PARTY_ROLES, readBase64, RELATIONS,
  type ActivityRow, type ApplicantForm, type ApplicationIntake, type DocumentRow, type Exposure, type PartyRow,
} from "./applicant-model";
import styles from "./operations/operations.module.css";
import scopeStyles from "./create-case.module.css";

const CLASSIFICATIONS = ["confidential", "restricted", "internal"];
export const SELECT_DEBOUNCE_MS = 300;

type Selection =
  | { status: "incomplete" } | { status: "loading" } | { status: "ready"; key: string; selection: CasePlanSelection }
  | { status: "refused"; error: ApiError } | { status: "failed"; error: unknown };
/** A selection refusal the creator can act on (422 case.plan_*, 409 case.plan_selection_changed). */
const refusalOf = (error: unknown): ApiError | null => error instanceof ApiError && (error.status === 422 || error.reason === "case.plan_selection_changed") ? error : null;

/**
 * PLT-09 · New case, opened by its scope: the creator says who the case is about, why it is opened,
 * how much due diligence, the policy jurisdiction and the products; the catalogue names the one
 * released process and policy pack the case falls under (or why there is none) before it is created.
 * With the applicant filled in, the case is opened from the application (POST /v1/applications) and
 * comes populated with its subjects and records.
 */
export function CreateCaseSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const options = usePolled(api, "getAuthoringScopeOptions", undefined, { enabled: open });
  const [form, setForm] = useState<CaseScopeForm | null>(null);
  const [externalRef, setExternalRef] = useState("");
  const [classification, setClassification] = useState("confidential");
  const [result, setResult] = useState<Selection>({ status: "incomplete" });
  const [attempt, setAttempt] = useState(0);
  const intent = useRef<{ signature: string; key: string } | null>(null);
  const create = useCommand("postCases", { invalidate: [["getCases"]] });
  const apply = useCommand("postApplications", { invalidate: [["getCases"]] });
  const [applicant, setApplicant] = useState<ApplicantForm>(emptyApplicant);
  const [intake, setIntake] = useState<ApplicationIntake | null>(null);
  useEffect(() => { if (options.data && !form) setForm(initialForm(options.data)); }, [options.data, form]);

  const scope = form ? scopeOf(form) : null;
  const requestKey = scope ? JSON.stringify(scope) : "";
  // Ask the catalogue for each settled scope (debounced); a newer scope cancels the request in flight.
  useEffect(() => {
    if (!open || !requestKey) { setResult({ status: "incomplete" }); return; }
    setResult({ status: "loading" });
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.call("postCasePlansSelect", { body: JSON.parse(requestKey) as CaseScope, signal: controller.signal });
        if (!controller.signal.aborted && response.data) setResult({ status: "ready", key: requestKey, selection: response.data });
      } catch (error) {
        if (controller.signal.aborted) return;
        const refusal = refusalOf(error);
        setResult(refusal ? { status: "refused", error: refusal } : { status: "failed", error });
      }
    }, SELECT_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, requestKey, attempt]);

  const selection = result.status === "ready" && result.key === requestKey ? result.selection : null;
  const applying = applicantStarted(applicant);
  const applicantGap = form && applying ? applicantMissing(applicant, form.customerType, scope?.products ?? form.products) : null;
  const valid = Boolean(selection && scope && classification) && !applicantGap;
  const busy = create.busy || apply.busy;
  const close = () => { create.reset(); apply.reset(); setIntake(null); setApplicant(emptyApplicant()); onClose(); };
  const openCase = (caseId: string) => { close(); void navigate({ to: `/platform/cases/${encodeURIComponent(caseId)}` }); };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || !selection || !scope || busy) return;
    if (applying) {
      const body = applicationOf(applicant, scope, { externalRef, classification, harnessPlanDigest: selection.planDigest });
      const signature = JSON.stringify(body);
      if (intent.current?.signature !== signature) intent.current = { signature, key: crypto.randomUUID() };
      const opened = await apply.run({ body, idempotencyKey: intent.current.key });
      if (opened) { intent.current = null; setIntake(opened); } else setAttempt((value) => value + 1);
      return;
    }
    // The BFF derives the case type from the scope too: KYB for a business or trust.
    const body = { caseType: scope.customerType === "individual" ? "kyc_onboarding" : "kyb_onboarding", externalRef: externalRef.trim() || null, harnessPlanDigest: selection.planDigest, classification, scope };
    const signature = JSON.stringify(body);
    if (intent.current?.signature !== signature) intent.current = { signature, key: crypto.randomUUID() };
    const created = await create.run({ body, idempotencyKey: intent.current.key });
    if (created) {
      intent.current = null;
      onClose();
      void navigate({ to: `/platform/cases/${encodeURIComponent(created.caseId)}` });
    } else {
      // The catalogue changed under the reviewed selection: show the new one.
      setAttempt((value) => value + 1);
    }
  }

  const failure = apply.error ?? create.error;
  const createRefusal = refusalOf(failure);
  return (
    <Sheet
      open={open}
      onClose={close}
      title="New case"
      description="Choose the case's scope; the released process and policy pack it falls under are shown before the case is created."
      footer={(
        <>
          {intake ? (
            <>
              <Button onClick={close}>Close</Button>
              <Button variant="primary" onClick={() => openCase(intake.caseId)}>Open case</Button>
            </>
          ) : (
            <>
              <Button onClick={close} disabled={busy}>Cancel</Button>
              <Button variant="primary" type="submit" form="create-case" busy={busy} disabled={!valid || busy}>{applying ? "Create case from application" : "Create case"}</Button>
            </>
          )}
        </>
      )}
    >
      {intake ? <IntakeDone intake={intake} /> : !options.data || !form ? (
        options.error ? <ApiErrorView error={options.error} title="The case scope options could not be loaded" /> : <Skeleton height="16rem" label="Loading case scope options" />
      ) : (
        <form id="create-case" className={styles.form} onSubmit={(event) => void submit(event)}>
          <ScopeFields form={form} options={options.data} disabled={busy} onChange={(patch) => setForm((value) => value && updateForm(value, patch, options.data!))} />
          <SelectionView result={result} incomplete={missing(form)} />
          <div className={styles.formGrid}>
            <Field label="Case type">
              <TextInput value={form.customerType === "individual" ? "Customer onboarding (KYC)" : "Business onboarding (KYB)"} readOnly />
            </Field>
            <Field label="External reference" hint="Optional.">
              <TextInput value={externalRef} onChange={(event) => setExternalRef(event.target.value)} />
            </Field>
            <Field label="Classification">
              <Select value={classification} onChange={(event) => setClassification(event.target.value)}>
                {CLASSIFICATIONS.map((value) => <option key={value} value={value}>{value}</option>)}
              </Select>
            </Field>
          </div>
          <ApplicantFields form={applicant} customerType={form.customerType} products={scope?.products ?? form.products} disabled={busy}
            onChange={(patch) => setApplicant((value) => ({ ...value, ...patch }))} />
          {applicantGap ? <p className={styles.muted} role="status">{applicantGap}</p> : null}
          {failure ? (createRefusal ? <Refusal error={createRefusal} heading="The case was not created" /> : <ApiErrorView error={failure} />) : null}
          {create.state === "confirmed" ? <InlineMessage tone="ok">Case created.</InlineMessage> : null}
        </form>
      )}
    </Sheet>
  );
}

/** The applicant's declaration: optional; naming the customer makes the case an application. */
function ApplicantFields({ form, customerType, products, disabled, onChange }: {
  form: ApplicantForm; customerType: CaseScopeForm["customerType"]; products: readonly string[]; disabled: boolean; onChange: (patch: Partial<ApplicantForm>) => void;
}) {
  const hint = useId();
  const individual = customerType === "individual";
  const text = (field: keyof ApplicantForm, upper = false) => ({
    value: form[field] as string, disabled,
    onChange: (event: { target: { value: string } }) => onChange({ [field]: upper ? event.target.value.toUpperCase() : event.target.value } as Partial<ApplicantForm>),
  });
  return (
    <fieldset className={scopeStyles.applicant} aria-describedby={hint} data-testid="applicant">
      <legend className={scopeStyles.applicantLegend}>Applicant</legend>
      <span id={hint} className={styles.muted}>Optional. Name the customer to open the case from the application, with its subjects, records and documents; leave it empty for an empty case.</span>
      <div className={styles.formGrid}>
        <Field label="Customer name"><TextInput {...text("name")} autoComplete="off" /></Field>
        {individual ? (
          <>
            <Field label="Date of birth"><TextInput type="date" {...text("dateOfBirth")} /></Field>
            <Field label="Nationality" hint="Two-letter country code, e.g. GB."><TextInput {...text("nationality", true)} maxLength={2} /></Field>
            <ExposureFields label="Customer" value={form.politicallyExposed} position={form.pepPosition} disabled={disabled}
              onChange={(politicallyExposed, pepPosition) => onChange({ politicallyExposed, pepPosition })} />
          </>
        ) : (
          <>
            <Field label="Legal form">
              <Select {...text("legalForm")}>
                <option value="">{customerType === "trust" ? "Ordinary trust (default)" : "Choose a legal form"}</option>
                {LEGAL_FORMS[customerType].map((value) => <option key={value} value={value}>{LABEL(value)}</option>)}
              </Select>
            </Field>
            <Field label="Registration number" hint={customerType === "trust" ? "Optional for a trust." : undefined}><TextInput {...text("registrationNumber")} /></Field>
            <Field label="Registration jurisdiction" hint="Two-letter country code, e.g. GB."><TextInput {...text("registrationJurisdiction", true)} maxLength={2} /></Field>
            <Field label="Registry" hint="Optional: the registry that issued the number."><TextInput {...text("registrationAuthority")} /></Field>
          </>
        )}
        <Field label="Identifier type">
          <Select {...text("identifierType")}>
            <option value="">None</option>
            {IDENTIFIER_TYPES[customerType].map((value) => <option key={value} value={value}>{LABEL(value)}</option>)}
          </Select>
        </Field>
        <Field label="Identifier issuer" hint="The issuing country or authority."><TextInput {...text("identifierIssuer")} /></Field>
        <Field label="Identifier value"><TextInput {...text("identifierValue")} autoComplete="off" /></Field>
        <Field label="Address line"><TextInput {...text("addressLine")} /></Field>
        <Field label="Town or city"><TextInput {...text("locality")} /></Field>
        <Field label="Postal code"><TextInput {...text("postalCode")} /></Field>
        <Field label="Address country" hint="Two-letter country code."><TextInput {...text("addressCountry", true)} maxLength={2} /></Field>
      </div>
      <RelatedParties parties={form.parties} customerType={customerType} disabled={disabled}
        onChange={(parties) => onChange({ parties, documents: form.documents.map((document) => parties.some((party) => party.key === document.about) ? document : { ...document, about: "" }) })} />
      <fieldset className={scopeStyles.parties}>
        <legend className={scopeStyles.legend}>Expected monthly activity</legend>
        {products.length ? null : <span className={styles.muted}>Choose the products first.</span>}
        {products.map((product) => {
          const row = form.activity[product] ?? blankActivity();
          const name = LABEL(product);
          const set = (patch: Partial<ActivityRow>) => onChange({ activity: { ...form.activity, [product]: { ...row, ...patch } } });
          return (
            <fieldset key={product} className={scopeStyles.party}>
              <legend className={scopeStyles.legend}>{name}</legend>
              <Field label={`${name} currency`} hint="Three-letter code, e.g. GBP."><TextInput value={row.currency} maxLength={3} disabled={disabled} onChange={(event) => set({ currency: event.target.value.toUpperCase() })} /></Field>
              <Field label={`${name} monthly inflow`}><TextInput value={row.monthlyInflow} inputMode="decimal" disabled={disabled} onChange={(event) => set({ monthlyInflow: event.target.value })} /></Field>
              <Field label={`${name} monthly outflow`}><TextInput value={row.monthlyOutflow} inputMode="decimal" disabled={disabled} onChange={(event) => set({ monthlyOutflow: event.target.value })} /></Field>
              <Field label={`${name} counterparty countries`} hint="Two-letter codes, comma separated."><TextInput value={row.counterpartyCountries} disabled={disabled} onChange={(event) => set({ counterpartyCountries: event.target.value.toUpperCase() })} /></Field>
            </fieldset>
          );
        })}
      </fieldset>
      <Field label="Declared source of funds" hint="Recorded as the applicant's declaration, unverified."><TextArea {...text("sourceOfFunds")} rows={2} maxLength={2000} /></Field>
      <Documents documents={form.documents} parties={form.parties} disabled={disabled} onChange={(documents) => onChange({ documents })} />
    </fieldset>
  );
}

/** Declared political exposure, and the position when exposed. */
function ExposureFields({ label, value, position, disabled, onChange }: { label: string; value: Exposure; position: string; disabled: boolean; onChange: (value: Exposure, position: string) => void }) {
  return (
    <>
      <Field label={`${label} politically exposed`} hint="As declared; screening checks it.">
        <Select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as Exposure, event.target.value === "yes" ? position : "")}>
          {(Object.keys(EXPOSURE_LABEL) as Exposure[]).map((option) => <option key={option} value={option}>{EXPOSURE_LABEL[option]}</option>)}
        </Select>
      </Field>
      {value === "yes" ? <Field label={`${label} political position`}><TextInput value={position} maxLength={200} disabled={disabled} onChange={(event) => onChange(value, event.target.value)} /></Field> : null}
    </>
  );
}

/** A business's or trust's parties (people or companies, several roles each), or a person's relatives and close associates. */
function RelatedParties({ parties, customerType, disabled, onChange }: { parties: PartyRow[]; customerType: CaseScopeForm["customerType"]; disabled: boolean; onChange: (parties: PartyRow[]) => void }) {
  const individual = customerType === "individual";
  const set = (index: number, patch: Partial<PartyRow>) => onChange(parties.map((party, at) => (at === index ? { ...party, ...patch } : party)));
  return (
    <fieldset className={scopeStyles.parties}>
      <legend className={scopeStyles.legend}>{individual ? "Relatives and close associates" : "Related parties"}</legend>
      {parties.length ? null : <span className={styles.muted}>{individual ? "Declared relatives and close associates are screened too." : customerType === "trust" ? "A trust needs its trustee." : "Directors and owners of the business."}</span>}
      {parties.map((party, index) => {
        const n = index + 1;
        const person = individual || party.kind === "individual";
        return (
          <fieldset key={party.key} className={scopeStyles.party}>
            <legend className={scopeStyles.legend}>Party {n}</legend>
            <Field label={`Party ${n} name`}><TextInput value={party.name} disabled={disabled} onChange={(event) => set(index, { name: event.target.value })} /></Field>
            {individual ? (
              <Field label={`Party ${n} relationship`}>
                <Select value={party.relationToCustomer} disabled={disabled} onChange={(event) => set(index, { relationToCustomer: event.target.value })}>
                  <option value="">Choose a relationship</option>
                  {RELATIONS.map((value) => <option key={value} value={value}>{LABEL(value)}</option>)}
                </Select>
              </Field>
            ) : (
              <>
                <Field label={`Party ${n} kind`}>
                  <Select value={party.kind} disabled={disabled} onChange={(event) => set(index, { kind: event.target.value as PartyRow["kind"], ...(event.target.value === "company" ? { politicallyExposed: "", pepPosition: "" } : {}) })}>
                    <option value="individual">Person</option>
                    <option value="company">Company</option>
                  </Select>
                </Field>
                <fieldset className={scopeStyles.roles}>
                  <legend className={scopeStyles.legend}>Party {n} roles</legend>
                  <div className={scopeStyles.checks}>
                    {PARTY_ROLES[customerType].map((role) => (
                      <label key={role} className={scopeStyles.check}>
                        <input type="checkbox" checked={party.roles.includes(role)} disabled={disabled}
                          onChange={(event) => set(index, { roles: event.target.checked ? [...party.roles, role] : party.roles.filter((value) => value !== role) })} />
                        <span>{LABEL(role)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <Field label={`Party ${n} ownership %`} hint="Optional.">
                  <TextInput value={party.ownershipPercent} inputMode="decimal" disabled={disabled} onChange={(event) => set(index, { ownershipPercent: event.target.value })} />
                </Field>
              </>
            )}
            {person ? <ExposureFields label={`Party ${n}`} value={party.politicallyExposed} position={party.pepPosition} disabled={disabled}
              onChange={(politicallyExposed, pepPosition) => set(index, { politicallyExposed, pepPosition })} /> : null}
            <Button onClick={() => onChange(parties.filter((_, at) => at !== index))} disabled={disabled} aria-label={`Remove party ${n}`}>Remove</Button>
          </fieldset>
        );
      })}
      <div><Button onClick={() => onChange([...parties, newParty(customerType)])} disabled={disabled}>{individual ? "Add relative or associate" : "Add related party"}</Button></div>
    </fieldset>
  );
}

/** Documents the applicant supplied: each needs a document field catalog type. */
function Documents({ documents, parties, disabled, onChange }: { documents: DocumentRow[]; parties: PartyRow[]; disabled: boolean; onChange: (documents: DocumentRow[]) => void }) {
  const inputId = useId();
  const hintId = useId();
  const [reading, setReading] = useState<string | null>(null);
  const set = (index: number, patch: Partial<DocumentRow>) => onChange(documents.map((document, at) => (at === index ? { ...document, ...patch } : document)));
  async function attach(files: FileList | null) {
    if (!files?.length) return;
    setReading(null);
    const added: DocumentRow[] = [];
    for (const file of Array.from(files)) {
      if (file.size > DOCUMENT_MAX_BYTES) { setReading(`${file.name} is larger than 4 MB.`); continue; }
      added.push(newDocument(file, await readBase64(file)));
    }
    onChange([...documents, ...added].slice(0, DOCUMENT_MAX_COUNT));
  }
  return (
    <fieldset className={scopeStyles.parties}>
      <legend className={scopeStyles.legend}>Documents</legend>
      <div className={styles.formGrid}>
        <div>
          <label htmlFor={inputId} className={scopeStyles.legend}>Attach documents</label>
          <input id={inputId} type="file" multiple aria-describedby={hintId} disabled={disabled || documents.length >= DOCUMENT_MAX_COUNT}
            onChange={(event) => { void attach(event.target.files); event.target.value = ""; }} />
          <span id={hintId} className={styles.muted}> Up to {DOCUMENT_MAX_COUNT} files of at most 4 MB. They are stored as case evidence, untrusted until parsed and reviewed.</span>
        </div>
      </div>
      {reading ? <p role="alert" className={styles.muted}>{reading}</p> : null}
      {documents.map((document, index) => (
        <fieldset key={document.key} className={scopeStyles.party}>
          <legend className={scopeStyles.legend}>{document.filename}</legend>
          <DocumentTypeField label={`${document.filename} document type`} value={document.documentType} disabled={disabled} onChange={(documentType) => set(index, { documentType })} />
          <Field label={`${document.filename} is about`}>
            <Select value={document.about} disabled={disabled} onChange={(event) => set(index, { about: event.target.value })}>
              <option value="">The customer</option>
              {parties.map((party, at) => <option key={party.key} value={party.key}>{party.name.trim() || `Party ${at + 1}`}</option>)}
            </Select>
          </Field>
          <Button onClick={() => onChange(documents.filter((_, at) => at !== index))} disabled={disabled} aria-label={`Remove ${document.filename}`}>Remove</Button>
        </fieldset>
      ))}
    </fieldset>
  );
}

/** A document field catalog type, suggested from the catalog as it is typed. */
function DocumentTypeField({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const listId = useId();
  const query = value.trim();
  const types = usePolled(api, "getCatalogs", { query: { kind: "documents", entryType: "definition", limit: 100, ...(query ? { q: query } : {}) } });
  const options = (types.data?.items ?? []).map((entry) => entry.id);
  return (
    <>
      <Field label={label} hint="A document field catalog type, e.g. certificate_of_incorporation.">
        <TextInput value={value} list={listId} disabled={disabled} autoComplete="off" onChange={(event) => onChange(event.target.value.toLowerCase())} />
      </Field>
      <datalist id={listId}>{options.map((id) => <option key={id} value={id} />)}</datalist>
    </>
  );
}

/** Whether each upload's extraction run started; one that did not is named with its reason, never hidden. */
function documentRunSummary(intake: ApplicationIntake): string {
  if (!intake.documentRuns.length) return "";
  const started = intake.documentRuns.filter((run) => run.status === "STARTED").length;
  const reasons = [...new Set(intake.documentRuns.flatMap((run) => run.status === "NOT_STARTED" && run.reason ? [run.reason] : []))];
  return ` · ${started} extraction run${started === 1 ? "" : "s"} started` + (reasons.length ? ` · not started: ${reasons.join(", ")}` : "");
}

function IntakeDone({ intake }: { intake: ApplicationIntake }) {
  return (
    <div role="status" className={scopeStyles.selected} data-testid="application-intake">
      <InlineMessage tone="ok">Case created from the application.</InlineMessage>
      <dl className={styles.kv}>
        <dt>Case</dt><dd><code>{intake.caseId}</code> · {intake.caseType === "kyb_onboarding" ? "Business onboarding (KYB)" : "Customer onboarding (KYC)"}</dd>
        <dt>Subjects</dt><dd>{intake.subjectsAdded}</dd>
        <dt>Documents</dt><dd data-testid="application-documents">{intake.documentsUploaded} uploaded{documentRunSummary(intake)}</dd>
        <dt>Records</dt><dd data-testid="application-records">{intake.recordsRecorded} records recorded</dd>
        <dt>Policy pack</dt><dd><code>{intake.pack.id}</code></dd>
      </dl>
      <p className={styles.muted}>{intakeSummary(intake)}</p>
    </div>
  );
}

function ScopeFields({ form, options, disabled, onChange }: { form: CaseScopeForm; options: ScopeOptions; disabled: boolean; onChange: (patch: Partial<CaseScopeForm>) => void }) {
  const productsHint = useId();
  const events = options.events.filter((item) => item.customerTypes.includes(form.customerType));
  const level = options.dueDiligence.find((item) => item.value === form.dueDiligence);
  return (
    <>
      <div className={styles.formGrid}>
        <Field label="Customer type">
          <Select value={form.customerType} disabled={disabled} onChange={(event) => onChange({ customerType: event.target.value as CaseScopeForm["customerType"] })}>
            {options.customerTypes.map((item) => <option key={item.value} value={item.value} disabled={!item.available}>{CUSTOMER_TYPE_LABEL[item.value] ?? item.value}{item.available ? "" : " · not available yet"}</option>)}
          </Select>
        </Field>
        <Field label="Trigger" hint="Why the case is opened.">
          <Select value={form.trigger} disabled={disabled} onChange={(event) => onChange({ trigger: event.target.value as CaseScopeForm["trigger"] })}>
            {options.triggers.map((item) => <option key={item.value} value={item.value} disabled={!item.available}>{TRIGGER_LABEL[item.value] ?? item.value}{item.available ? "" : " · not available yet"}</option>)}
          </Select>
        </Field>
        {form.trigger === "event_review" ? (
          <Field label="Review event" hint={`Events that occur for ${(CUSTOMER_TYPE_LABEL[form.customerType] ?? form.customerType).toLowerCase()} customers.`}>
            <Select value={form.event} disabled={disabled} onChange={(event) => onChange({ event: event.target.value })}>
              <option value="">Choose an event</option>
              {events.map((item) => <option key={item.value} value={item.value}>{EVENT_LABEL(item.value)}</option>)}
            </Select>
          </Field>
        ) : null}
        <Field label="Due diligence" hint={level?.description}>
          <Select value={form.dueDiligence} disabled={disabled} onChange={(event) => onChange({ dueDiligence: event.target.value as CaseScopeForm["dueDiligence"] })}>
            {options.dueDiligence.map((item) => {
              const ineligible = dueDiligenceIneligibility(item, form.customerType);
              return <option key={item.value} value={item.value} disabled={Boolean(ineligible)}>{DUE_DILIGENCE_LABEL[item.value] ?? item.value}{ineligible ? ` · ${ineligible}` : ""}</option>;
            })}
          </Select>
        </Field>
        <Field label="Policy jurisdiction" hint="The jurisdiction whose policy pack governs this case.">
          <Select value={form.jurisdiction} disabled={disabled} onChange={(event) => onChange({ jurisdiction: event.target.value })}>
            <option value="">Choose a jurisdiction</option>
            {options.jurisdictions.map((item) => <option key={item.code} value={item.code} disabled={!item.available}>{item.code}{item.available ? "" : " · no policy pack layer"}</option>)}
          </Select>
        </Field>
      </div>
      <fieldset className={scopeStyles.products} aria-describedby={productsHint}>
        <legend className={scopeStyles.legend}>Products</legend>
        <div className={scopeStyles.checks}>
          {options.products.map((product) => (
            <label key={product} className={scopeStyles.check}>
              <input type="checkbox" checked={form.products.includes(product)} disabled={disabled}
                onChange={(event) => onChange({ products: event.target.checked ? [...form.products, product] : form.products.filter((item) => item !== product) })} />
              <span>{PRODUCT_LABEL(product)}</span>
            </label>
          ))}
        </div>
        <span id={productsHint} className={styles.muted}>The relationship's products. The case's policy pack must cover every one.</span>
      </fieldset>
    </>
  );
}

function SelectionView({ result, incomplete }: { result: Selection; incomplete: string | null }) {
  return (
    <section className={scopeStyles.selection} aria-labelledby="case-selection-title" aria-busy={result.status === "loading"}>
      <h3 id="case-selection-title" className={scopeStyles.selectionTitle}>Process and policy pack</h3>
      <div aria-live="polite">
        {incomplete ? <p className={styles.muted}>{incomplete}</p>
          : result.status === "loading" || result.status === "incomplete" ? <p className={styles.muted} role="status"><Icon name="refresh" size="sm" /> Finding the released process for this scope…</p>
          : result.status === "refused" ? <Refusal error={result.error} />
          : result.status === "failed" ? <ApiErrorView error={result.error} title="The process could not be selected" />
          : <Selected selection={result.selection} />}
      </div>
    </section>
  );
}

function Selected({ selection }: { selection: CasePlanSelection }) {
  const pack = selection.pack.scope;
  return (
    <div className={scopeStyles.selected} data-testid="case-plan-selection">
      <p className={scopeStyles.summary}><Icon name="check" size="sm" /> <strong>{selectionSummary(selection)}</strong></p>
      <dl className={styles.kv}>
        <dt>Process</dt><dd>{processTitle(selection.scope)}</dd>
        <dt>Policy pack</dt><dd><code>{selection.pack.id}</code> · version {selection.policyAuthority.policyVersion}</dd>
        <dt>Pack covers</dt><dd>{pack.jurisdiction} · {pack.products.map(PRODUCT_LABEL).join(", ")}</dd>
        <dt>Plan</dt><dd><DigestValue value={selection.planDigest} label="plan digest" /></dd>
      </dl>
    </div>
  );
}

function Refusal({ error, heading }: { error: ApiError; heading?: string }) {
  const copy = refusalCopy(error.reason);
  return (
    <div role="alert" data-testid="case-plan-refusal">
      <Disclosure tone="blocking" icon="block" title={heading ? `${heading}: ${copy.title.toLowerCase()}` : copy.title} code={error.reason}>
        {error.body.message ? <p className={scopeStyles.reason}>{error.body.message}</p> : null}
        <p className={scopeStyles.remedy}><strong>What to do:</strong> {error.body.remedy ?? copy.remedy}</p>
      </Disclosure>
    </div>
  );
}
