import {
  effectiveEligibility, institutionCatalogProblems, institutionCatalogSchema, PRODUCT_PARTY_TYPES, REGULATORY_REGIMES,
  type InstitutionCatalog, type InstitutionOffering, type ProductAttributeDefinition, type ProductTaxonomy,
} from "@ehf/contracts/products";
import { usePolled } from "@ehf/ui-client/react";
import { Button, Disclosure, EmptyState, Field, InlineMessage, Select, Sheet, Switch, Table, TextArea, TextInput, ToneBadge } from "@ehf/ui-kit";
import { useId, useMemo, useState, type ReactNode } from "react";
import { api } from "../app/api";
import { useSession } from "../app/session";
import { ApiErrorView, useCommand, useSearchParam } from "../platform/common";
import { humanize, sentenceCase } from "./rulebook";
import styles from "./studio.module.css";

const DEFAULT_INSTITUTION = "bank.synthetic";
const READS = [["getAuthoringInstitutionsInstitutionIdCatalog"], ["getAuthoringInstitutions"]] as const;
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const label = (value: string) => sentenceCase(humanize(value.toLowerCase()));

/** Plain-language versions of the catalog problem codes (`institution.<kind>:<subject>:<detail>`). */
export function describeCatalogProblem(problem: string): string {
  const [code = "", subject = "", detail = ""] = problem.split(":");
  const text: Record<string, string> = {
    "institution.taxonomy_outdated": `The catalog was written against taxonomy ${subject}; save it again to check it against the current taxonomy`,
    "institution.offering_product_unknown": `${subject} names ${detail}, which is not in the product taxonomy`,
    "institution.offering_outside_business_line": `${subject} is outside the products business line ${detail} may offer`,
    "institution.offering_business_line_unknown": `${subject} names business line ${detail}, which does not exist`,
    "institution.offering_legal_entity_unknown": `${subject} names legal entity ${detail}, which does not exist`,
    "institution.offering_jurisdiction_outside": `${subject} is offered in ${detail}, where the institution does not operate`,
    "institution.offering_eligibility_wider": `${subject} admits ${label(detail)}, which its canonical product does not`,
    "institution.attribute_unknown": `${subject} sets ${detail}, which is not a product attribute`,
    "institution.attribute_not_offering_level": `${subject} sets ${detail}, which is set per product or per relationship, not per offering`,
    "institution.attribute_value_invalid": `${subject} has an invalid value for ${detail}`,
    "institution.offering_bundle_invalid": `${subject} bundles ${detail}, which is not another offering`,
    "institution.legacy_ambiguous": `Case product type ${subject} is claimed by several offerings (${detail})`,
    "institution.legal_entity_jurisdiction_outside": `Legal entity ${subject} is in a jurisdiction the institution does not list`,
    "institution.business_line_scope_unknown": `Business line ${subject} names ${detail}, which is not in the product taxonomy`,
    "institution.offering_duplicate": `Offering id ${subject} is used twice`,
    "institution.legal_entity_duplicate": `Legal entity id ${subject} is used twice`,
    "institution.business_line_duplicate": `Business line id ${subject} is used twice`,
  };
  return text[code] ?? problem;
}

export type InstitutionWorkspace = ReturnType<typeof useInstitutionWorkspace>;

/**
 * An institution's catalog as the studio's Business and Products steps edit it: the working copy
 * (latest revision, else the repository seed) with local edits, the problems an approver would
 * see, and the revision lifecycle. Lives in the studio so both steps share one working copy.
 */
export function useInstitutionWorkspace(enabled: boolean) {
  const session = useSession();
  const [param, setInstitution] = useSearchParam("institution");
  const institutionId = param ?? DEFAULT_INSTITUTION;
  const list = usePolled(api, "getAuthoringInstitutions", undefined, { enabled });
  const view = usePolled(api, "getAuthoringInstitutionsInstitutionIdCatalog", { path: { institutionId } }, { enabled });
  const taxonomyPolled = usePolled(api, "getAuthoringProductsTaxonomy", undefined, { enabled });
  const taxonomy = taxonomyPolled.data as ProductTaxonomy | undefined;
  const [edits, setEdits] = useState<Record<string, InstitutionCatalog>>({});
  const stored = (view.data?.latest?.catalog ?? view.data?.seed ?? null) as InstitutionCatalog | null;
  const working = edits[institutionId] ?? stored;
  const dirty = Boolean(edits[institutionId]);
  // An institution created here and not yet saved: the server has no catalog for it (404) yet.
  const isNew = !stored && Boolean(edits[institutionId]);
  const problems = useMemo(() => working && taxonomy ? institutionCatalogProblems(working, taxonomy) : view.data?.problems ?? [], [working, taxonomy, view.data?.problems]);
  const save = useCommand("postAuthoringInstitutionsInstitutionIdCatalogRevisions", { invalidate: READS });
  const approve = useCommand("postAuthoringInstitutionsInstitutionIdCatalogRevisionsRevisionApprove", { invalidate: READS });
  const publish = useCommand("postAuthoringInstitutionsInstitutionIdCatalogRevisionsRevisionPublish", { invalidate: READS });
  const latest = view.data?.latest ?? null;
  const edit = (change: (catalog: InstitutionCatalog) => InstitutionCatalog) => {
    if (!working) return;
    setEdits((previous) => ({ ...previous, [institutionId]: change(structuredClone(working)) }));
  };
  const discard = () => setEdits(({ [institutionId]: _dropped, ...rest }) => rest);
  return {
    institutionId, setInstitution, list, view, taxonomy, taxonomyPolled, working, dirty, isNew, problems, latest, edit, discard, save, approve, publish,
    /** Start a new institution's working copy (saved as its first revision, like any other draft). */
    create: (catalog: InstitutionCatalog) => {
      setEdits((previous) => ({ ...previous, [catalog.institution.id]: catalog }));
      setInstitution(catalog.institution.id);
    },
    can: (action: string) => session.actions.includes(action), subjectId: session.subject.subjectId,
    /** Save the working copy as a new draft, checked against the taxonomy the server holds now. */
    saveDraft: async (reason: string) => {
      const reference = view.data?.taxonomy ?? (taxonomy ? { version: taxonomy.version, digest: taxonomy.digest } : null);
      if (!working || !reference) return;
      const catalog = { ...working, taxonomy: reference };
      // The generated body type carries the exported schema's $defs; the zod contract is the real shape.
      const saved = await save.run({ path: { institutionId }, body: { catalog, expectedRevision: latest?.revision ?? 0, reason } as never });
      if (saved) discard();
    },
  };
}

function SheetForm({ title, description, onClose, onSave, children, error, saveLabel = "Apply to working copy" }: {
  title: string; description: string; onClose: () => void; onSave: () => void; children: ReactNode; error: string | null; saveLabel?: string;
}) {
  return (
    <Sheet open title={title} description={description} onClose={onClose}
      footer={<span className={styles.row}><Button variant="primary" onClick={onSave}>{saveLabel}</Button><Button onClick={onClose}>Cancel</Button></span>}>
      <div className={styles.stack}>
        {children}
        {error ? <div role="alert"><InlineMessage tone="error">{error}</InlineMessage></div> : null}
      </div>
    </Sheet>
  );
}

function Checks<T extends string>({ legend, options, value, onChange, describe = label }: { legend: string; options: readonly T[]; value: T[]; onChange: (next: T[]) => void; describe?: (option: T) => string }) {
  return (
    <div className={styles.checkGroup} role="group" aria-label={legend}>
      {options.map((option) => (
        <label key={option} className={styles.check}>
          <input type="checkbox" checked={value.includes(option)} onChange={(event) => onChange(event.target.checked ? [...value, option] : value.filter((entry) => entry !== option))} />
          {describe(option)}
        </label>
      ))}
    </div>
  );
}

/** Institution picker, revision state, problems and the save → approve → publish lifecycle. */
export function InstitutionBar({ workspace }: { workspace: InstitutionWorkspace }) {
  const { list, view, latest, problems, dirty, working, can, subjectId } = workspace;
  const [reason, setReason] = useState("");
  const [creating, setCreating] = useState(false);
  const listed = list.data?.items ?? [{ institutionId: workspace.institutionId, name: workspace.institutionId }];
  const choices = workspace.isNew && working && !listed.some((item) => item.institutionId === workspace.institutionId)
    ? [...listed, { institutionId: workspace.institutionId, name: `${working.institution.name} (new)` }] : listed;
  const reasonId = useId();
  const published = view.data?.published ?? null;
  const busy = [workspace.save, workspace.approve, workspace.publish].some((command) => command.busy);
  const error = [workspace.save, workspace.approve, workspace.publish].find((command) => command.state === "failed")?.error ?? null;
  const shortReason = reason.trim().length < 3 ? "Give a reason of at least three characters." : null;
  const saveReason = !can("draft.write") ? "Your role cannot save catalogs (needs draft.write)."
    : !dirty && latest ? "Nothing to save: the working copy matches the latest revision." : shortReason;
  const approveReason = !latest ? "Save a draft first." : latest.status !== "DRAFT" ? `Needs DRAFT (now ${latest.status}).` : dirty ? "Save or discard your edits first."
    : latest.authoredBy === subjectId ? `Separation of duties: you authored revision ${latest.revision}.` : !can("draft.approve") ? "Your role cannot approve (needs draft.approve)."
    : problems.length ? "Resolve every problem first." : shortReason;
  const publishReason = !latest ? "Save a draft first." : latest.status !== "APPROVED" ? `Needs APPROVED (now ${latest.status}).`
    : latest.authoredBy === subjectId ? `Separation of duties: you authored revision ${latest.revision}.` : !can("draft.publish") ? "Your role cannot publish (needs draft.publish)." : shortReason;
  const act = async (run: () => Promise<unknown>) => { await run(); setReason(""); };
  return (
    <section className={styles.section} aria-labelledby="institution-title">
      <div className={styles.toolbar}>
        <Field label="Institution" hint={dirty ? "Save or discard your edits before switching institutions." : undefined}>
          <Select value={workspace.institutionId} disabled={dirty || busy} onChange={(event) => workspace.setInstitution(event.target.value)}>
            {choices.map((item) => <option key={item.institutionId} value={item.institutionId}>{item.name}</option>)}
          </Select>
        </Field>
        {can("draft.write") ? <Button size="sm" icon="plus" disabled={dirty || busy} title={dirty ? "Save or discard your edits first." : undefined} onClick={() => setCreating(true)}>New institution</Button> : null}
        <span className={styles.row} id="institution-title">
          {working?.institution.synthetic ? <ToneBadge tone="neutral" icon="info">Synthetic</ToneBadge> : null}
          {latest ? <ToneBadge tone={latest.status === "PUBLISHED" ? "positive" : "draft"} icon="file">Revision {latest.revision} · {latest.status}</ToneBadge>
            : workspace.isNew ? <ToneBadge tone="draft" icon="file">New institution (never saved)</ToneBadge> : <ToneBadge tone="draft" icon="file">Repository seed (never saved)</ToneBadge>}
          {published && published.revision !== latest?.revision ? <ToneBadge tone="positive" icon="checkcircle">Published: revision {published.revision}</ToneBadge> : null}
          {dirty ? <span className={styles.hint}>Modified</span> : null}
        </span>
      </div>
      {problems.length ? (
        <Disclosure tone="attention" title={`${problems.length} problem${problems.length === 1 ? "" : "s"} to resolve before approval`}>
          <ul className={styles.problemList}>{problems.map((problem) => <li key={problem}>{describeCatalogProblem(problem)}</li>)}</ul>
        </Disclosure>
      ) : <span className={styles.hint}>No problems: every offering maps onto the taxonomy within its business line, entity and jurisdictions.</span>}
      <div className={styles.toolbar}>
        <Field label="Reason" hint="Recorded with the revision, approval or publication.">
          <TextInput id={reasonId} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="What changed and why" />
        </Field>
        <span className={styles.row}>
          {dirty ? <Button onClick={workspace.discard} disabled={busy}>Discard edits</Button> : null}
          <Button icon="file" busy={workspace.save.busy} disabled={busy || Boolean(saveReason)} title={saveReason ?? undefined} onClick={() => void act(() => workspace.saveDraft(reason.trim()))}>Save draft</Button>
          <Button icon="checkcircle" busy={workspace.approve.busy} disabled={busy || Boolean(approveReason)} title={approveReason ?? undefined}
            onClick={() => latest && void act(() => workspace.approve.run({ path: { institutionId: workspace.institutionId, revision: latest.revision }, body: { reason: reason.trim() } }))}>Approve</Button>
          <Button variant="primary" icon="send" busy={workspace.publish.busy} disabled={busy || Boolean(publishReason)} title={publishReason ?? undefined}
            onClick={() => latest && void act(() => workspace.publish.run({ path: { institutionId: workspace.institutionId, revision: latest.revision }, body: { reason: reason.trim() } }))}>Publish</Button>
        </span>
      </div>
      <p className={styles.hint} aria-live="polite">{saveReason && dirty ? saveReason : approveReason && latest?.status === "DRAFT" && !dirty ? approveReason : publishReason && latest?.status === "APPROVED" ? publishReason : ""}</p>
      {error ? <ApiErrorView error={error} title="The catalog change was refused" /> : null}
      {creating && workspace.taxonomy ? <InstitutionSheet taxonomy={workspace.taxonomy} existing={listed.map((item) => item.institutionId)}
        onClose={() => setCreating(false)} onSave={(catalog) => workspace.create(catalog)} /> : null}
    </section>
  );
}

const JURISDICTION = /^[A-Z]{2}$/;
/**
 * A new institution: its profile, its first legal entity and its first business line, the least a
 * catalog needs. It becomes the working copy and is saved as revision 1 like any other draft; a
 * second person approves and publishes it.
 */
function InstitutionSheet({ taxonomy, existing, onSave, onClose }: {
  taxonomy: ProductTaxonomy; existing: string[]; onSave: (catalog: InstitutionCatalog) => void; onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [synthetic, setSynthetic] = useState(true);
  const [jurisdictions, setJurisdictions] = useState("US");
  const [entity, setEntity] = useState("");
  const [regimes, setRegimes] = useState<Array<(typeof REGULATORY_REGIMES)[number]>>(["BANKING"]);
  const [line, setLine] = useState("");
  const [scope, setScope] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const domains = taxonomy.nodes.filter((node) => node.level === "domain");
  const codes = [...new Set(jurisdictions.split(/[\s,]+/).map((code) => code.trim().toUpperCase()).filter(Boolean))];
  const institutionId = id.trim() || (name.trim() ? `${slug(name)}` : "");
  const save = () => {
    if (!name.trim()) return setError("Name the institution.");
    if (!/^[a-z0-9][a-z0-9.-]{0,79}$/.test(institutionId)) return setError("The id is lower-case letters, digits, dots and hyphens (for example credit-union.synthetic).");
    if (existing.includes(institutionId)) return setError(`An institution with id ${institutionId} already exists.`);
    if (!codes.length || codes.some((code) => !JURISDICTION.test(code))) return setError("List the jurisdictions as two-letter country codes, such as US, GB.");
    if (!slug(entity)) return setError("Name the first legal entity.");
    if (!regimes.length) return setError("Choose at least one regulatory regime for the legal entity.");
    if (!slug(line)) return setError("Name the first business line.");
    if (!scope.length) return setError("Choose at least one product domain for the business line.");
    const catalog = {
      apiVersion: "harness.factory/institution-catalog-v1" as const, kind: "InstitutionCatalog" as const,
      institution: { id: institutionId, name: name.trim(), description: description.trim(), synthetic, jurisdictions: codes,
        legalEntities: [{ id: slug(entity), name: entity.trim(), jurisdiction: codes[0]!, regulatoryRegimes: regimes, bookingEntity: true }],
        businessLines: [{ id: slug(line), name: line.trim(), productScope: scope }] },
      offerings: [], taxonomy: { version: taxonomy.version, digest: taxonomy.digest },
    };
    const parsed = institutionCatalogSchema.safeParse(catalog);
    if (!parsed.success) return setError(`The institution does not fit the catalog contract: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    onSave(parsed.data);
    onClose();
  };
  return (
    <SheetForm title="New institution" saveLabel="Create working copy" onClose={onClose} onSave={save} error={error}
      description="An institution with no repository seed. It starts as a working copy with one legal entity and one business line; save it as a draft, then a second person approves and publishes it.">
      <Field label="Name"><TextInput value={name} onChange={(event) => setName(event.target.value)} data-autofocus /></Field>
      <Field label="Institution id" hint={`Used by cases (BankingRelationship.institutionId). Default: ${slug(name) || "derived from the name"}.`}>
        <TextInput mono value={id} placeholder={slug(name)} onChange={(event) => setId(event.target.value)} />
      </Field>
      <Field label="Description"><TextArea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
      <Field label="Jurisdictions" hint="Two-letter country codes, separated by commas."><TextInput mono value={jurisdictions} onChange={(event) => setJurisdictions(event.target.value)} /></Field>
      <span className={styles.row}><Switch label="Synthetic" checked={synthetic} onChange={setSynthetic} /><span>Synthetic (not a real institution)</span></span>
      <Field label="First legal entity" hint={`Books business in ${codes[0] ?? "the first jurisdiction"}.`}><TextInput value={entity} onChange={(event) => setEntity(event.target.value)} /></Field>
      <Checks legend="Regulated as" options={REGULATORY_REGIMES} value={regimes} onChange={setRegimes} />
      <Field label="First business line"><TextInput value={line} onChange={(event) => setLine(event.target.value)} /></Field>
      <Checks legend="Product domains the business line may offer" options={domains.map((node) => node.id)} value={scope} onChange={setScope}
        describe={(nodeId) => `${domains.find((node) => node.id === nodeId)?.name ?? nodeId} (${nodeId})`} />
    </SheetForm>
  );
}

function Loading({ workspace, children }: { workspace: InstitutionWorkspace; children: (catalog: InstitutionCatalog, taxonomy: ProductTaxonomy) => ReactNode }) {
  // A new institution has no catalog on the server until its first save.
  const failure = (workspace.isNew ? null : workspace.view.error) ?? workspace.taxonomyPolled.error;
  if (failure) return <ApiErrorView error={failure} title="The institution catalog is unavailable" />;
  if (!workspace.working || !workspace.taxonomy) return <p className={styles.hint}>Loading the institution catalog…</p>;
  return <>{children(workspace.working, workspace.taxonomy)}</>;
}

/** Step 1, Business: the institution's profile, legal entities and business lines. */
export function BusinessStep({ workspace }: { workspace: InstitutionWorkspace }) {
  const [sheet, setSheet] = useState<"entity" | "line" | null>(null);
  const editable = workspace.can("draft.write");
  return (
    <div className={styles.sections}>
      <InstitutionBar workspace={workspace} />
      <Loading workspace={workspace}>{(catalog, taxonomy) => {
        const names = new Map(taxonomy.nodes.map((node) => [node.id, node.name]));
        return (
          <>
            <section className={styles.section} aria-labelledby="business-profile">
              <div className={styles.sectionHead}><h3 id="business-profile">Profile</h3><span className={styles.hint}>Operates in {catalog.institution.jurisdictions.join(", ")}</span></div>
              <Field label="Name"><TextInput value={catalog.institution.name} readOnly={!editable} onChange={(event) => workspace.edit((next) => { next.institution.name = event.target.value; return next; })} /></Field>
              <Field label="Description"><TextArea rows={2} value={catalog.institution.description} readOnly={!editable} onChange={(event) => workspace.edit((next) => { next.institution.description = event.target.value; return next; })} /></Field>
            </section>
            <section className={styles.section} aria-labelledby="business-entities">
              <div className={styles.sectionHead}>
                <h3 id="business-entities">Legal entities</h3>
                {editable ? <Button size="sm" icon="plus" onClick={() => setSheet("entity")}>Add legal entity</Button> : null}
              </div>
              <Table
                caption="Legal entities and the regimes that regulate them"
                columns={[
                  { key: "name", header: "Legal entity", render: (row) => <span>{row.name} <code className={styles.ruleId}>{row.id}</code></span> },
                  { key: "jurisdiction", header: "Jurisdiction", render: (row) => row.jurisdiction },
                  { key: "regimes", header: "Regulated as", render: (row) => row.regulatoryRegimes.map(label).join(", ") },
                  { key: "booking", header: "Books business", render: (row) => row.bookingEntity ? "Yes" : "No" },
                  { key: "offerings", header: "Offerings", render: (row) => catalog.offerings.filter((offering) => offering.legalEntity === row.id).length },
                  ...(editable ? [{ key: "remove", header: "", render: (row: InstitutionCatalog["institution"]["legalEntities"][number]) => (
                    <Button size="sm" variant="quiet" icon="x" aria-label={`Remove ${row.name}`} onClick={() => workspace.edit((next) => { next.institution.legalEntities = next.institution.legalEntities.filter((entity) => entity.id !== row.id); return next; })} />
                  ) }] : []),
                ]}
                rows={catalog.institution.legalEntities}
                rowKey={(row) => row.id}
              />
            </section>
            <section className={styles.section} aria-labelledby="business-lines">
              <div className={styles.sectionHead}>
                <h3 id="business-lines">Business lines</h3>
                {editable ? <Button size="sm" icon="plus" onClick={() => setSheet("line")}>Add business line</Button> : null}
              </div>
              <span className={styles.hint}>A business line may only offer products within its scope. A scope is any node of the product taxonomy: a domain, a class or a type.</span>
              <Table
                caption="Business lines and the products they may offer"
                columns={[
                  { key: "name", header: "Business line", render: (row) => <span>{row.name} <code className={styles.ruleId}>{row.id}</code></span> },
                  { key: "scope", header: "Product scope", render: (row) => row.productScope.map((id) => `${names.get(id) ?? id} (${id})`).join(", ") },
                  { key: "offerings", header: "Offerings", render: (row) => catalog.offerings.filter((offering) => offering.businessLine === row.id).length },
                  ...(editable ? [{ key: "remove", header: "", render: (row: InstitutionCatalog["institution"]["businessLines"][number]) => (
                    <Button size="sm" variant="quiet" icon="x" aria-label={`Remove ${row.name}`} onClick={() => workspace.edit((next) => { next.institution.businessLines = next.institution.businessLines.filter((line) => line.id !== row.id); return next; })} />
                  ) }] : []),
                ]}
                rows={catalog.institution.businessLines}
                rowKey={(row) => row.id}
              />
            </section>
            {sheet === "entity" ? <EntitySheet catalog={catalog} onClose={() => setSheet(null)} onSave={(entity) => workspace.edit((next) => { next.institution.legalEntities.push(entity); return next; })} /> : null}
            {sheet === "line" ? <LineSheet catalog={catalog} taxonomy={taxonomy} onClose={() => setSheet(null)} onSave={(line) => workspace.edit((next) => { next.institution.businessLines.push(line); return next; })} /> : null}
          </>
        );
      }}</Loading>
    </div>
  );
}

function EntitySheet({ catalog, onSave, onClose }: { catalog: InstitutionCatalog; onSave: (entity: InstitutionCatalog["institution"]["legalEntities"][number]) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [jurisdiction, setJurisdiction] = useState(catalog.institution.jurisdictions[0] ?? "");
  const [regimes, setRegimes] = useState<Array<(typeof REGULATORY_REGIMES)[number]>>(["BANKING"]);
  const [booking, setBooking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const id = slug(name);
    if (!id) return setError("Name the legal entity.");
    if (catalog.institution.legalEntities.some((entity) => entity.id === id)) return setError(`A legal entity with id ${id} already exists.`);
    if (!regimes.length) return setError("Choose at least one regulatory regime.");
    onSave({ id, name: name.trim(), jurisdiction, regulatoryRegimes: regimes, bookingEntity: booking });
    onClose();
  };
  return (
    <SheetForm title="Add legal entity" description="An entity that holds licences and books business. Offerings name the entity that provides them." onClose={onClose} onSave={save} error={error}>
      <Field label="Name"><TextInput value={name} onChange={(event) => setName(event.target.value)} data-autofocus /></Field>
      <Field label="Jurisdiction" hint="One of the jurisdictions the institution operates in.">
        <Select value={jurisdiction} onChange={(event) => setJurisdiction(event.target.value)}>{catalog.institution.jurisdictions.map((code) => <option key={code} value={code}>{code}</option>)}</Select>
      </Field>
      <Checks legend="Regulated as" options={REGULATORY_REGIMES} value={regimes} onChange={setRegimes} />
      <span className={styles.row}><Switch label="Books business" checked={booking} onChange={setBooking} /><span>Books business</span></span>
    </SheetForm>
  );
}

function LineSheet({ catalog, taxonomy, onSave, onClose }: { catalog: InstitutionCatalog; taxonomy: ProductTaxonomy; onSave: (line: InstitutionCatalog["institution"]["businessLines"][number]) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<string[]>([]);
  const [pending, setPending] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const known = new Set(taxonomy.nodes.map((node) => node.id));
  const add = () => {
    const id = pending.trim().toUpperCase();
    if (!known.has(id)) return setError(`${id || "That"} is not a node of the product taxonomy.`);
    setScope([...new Set([...scope, id])]); setPending(""); setError(null);
  };
  const save = () => {
    const id = slug(name);
    if (!id) return setError("Name the business line.");
    if (catalog.institution.businessLines.some((line) => line.id === id)) return setError(`A business line with id ${id} already exists.`);
    if (!scope.length) return setError("Add at least one product to the scope.");
    onSave({ id, name: name.trim(), productScope: scope });
    onClose();
  };
  return (
    <SheetForm title="Add business line" description="A business line offers products within its scope. Offerings outside the scope are reported as problems." onClose={onClose} onSave={save} error={error}>
      <Field label="Name"><TextInput value={name} onChange={(event) => setName(event.target.value)} data-autofocus /></Field>
      <datalist id={listId}>{taxonomy.nodes.filter((node) => node.level !== "type").map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</datalist>
      <span className={styles.row}>
        <Field label="Product scope" hint="A domain, class or type id, such as BRK.PRIME.">
          <TextInput mono list={listId} value={pending} onChange={(event) => setPending(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
        </Field>
        <Button size="sm" icon="plus" onClick={add}>Add to scope</Button>
      </span>
      <ul className={styles.chipList} aria-label="Products in scope">
        {scope.map((id) => <li key={id}><code className={styles.obligation}>{id}</code><Button size="sm" variant="quiet" icon="x" aria-label={`Remove ${id} from the scope`} onClick={() => setScope(scope.filter((entry) => entry !== id))} /></li>)}
      </ul>
    </SheetForm>
  );
}

/** Step 2, Products: the institution's offerings mapped onto canonical products, and how cases resolve. */
export function ProductsStep({ workspace }: { workspace: InstitutionWorkspace }) {
  const [adding, setAdding] = useState(false);
  const [details, setDetails] = useState<string | null>(null);
  const editable = workspace.can("draft.write");
  const resolution = workspace.view.data?.legacyResolution ?? [];
  return (
    <div className={styles.sections}>
      <InstitutionBar workspace={workspace} />
      <Loading workspace={workspace}>{(catalog, taxonomy) => {
        const nodes = new Map(taxonomy.nodes.map((node) => [node.id, node]));
        const lines = new Map(catalog.institution.businessLines.map((line) => [line.id, line.name]));
        const entities = new Map(catalog.institution.legalEntities.map((entity) => [entity.id, entity.name]));
        const path = (id: string) => [...(nodes.get(id)?.ancestors ?? []), id].map((step) => nodes.get(step)?.name ?? step).join(" › ");
        const setOffering = (offeringId: string, change: Partial<InstitutionOffering>) => workspace.edit((next) => {
          next.offerings = next.offerings.map((offering) => offering.offeringId === offeringId ? { ...offering, ...change } : offering); return next;
        });
        return (
          <>
            <section className={styles.section} aria-labelledby="products-offerings">
              <div className={styles.sectionHead}>
                <h3 id="products-offerings">Offerings</h3>
                {editable ? <Button size="sm" icon="plus" onClick={() => setAdding(true)}>Add offering</Button> : null}
              </div>
              <span className={styles.hint}>Each offering is the institution's own product, mapped to one canonical product. Policy is set on canonical products; an offering may only narrow who is eligible.</span>
              {catalog.offerings.length ? (
                <Table
                  caption="Offerings and their canonical products"
                  columns={[
                    { key: "name", header: "Offering", render: (row) => <span>{row.name} <code className={styles.ruleId}>{row.offeringId}</code></span> },
                    { key: "canonical", header: "Canonical product", render: (row) => <span>{path(row.canonicalProductId)} <code className={styles.ruleId}>{row.canonicalProductId}</code></span> },
                    { key: "line", header: "Business line · entity", render: (row) => `${lines.get(row.businessLine) ?? row.businessLine} · ${entities.get(row.legalEntity) ?? row.legalEntity}` },
                    { key: "where", header: "Jurisdictions", render: (row) => row.jurisdictions.join(", ") },
                    { key: "who", header: "Eligible", render: (row) => {
                      const own = row.eligiblePartyTypes; const allowed = nodes.has(row.canonicalProductId) ? effectiveEligibility(taxonomy, row.canonicalProductId) : [];
                      return own.length ? own.map(label).join(", ") : allowed.length ? `As the product: ${allowed.map(label).join(", ")}` : "Any party type";
                    } },
                    { key: "variant", header: "Variant · bundle", render: (row) => {
                      const attributes = Object.entries(row.variantAttributes).map(([key, value]) => `${taxonomy.attributes.find((entry) => entry.id === key)?.name ?? key}: ${attributeText(value)}`);
                      const bundle = row.bundle.map((member) => catalog.offerings.find((entry) => entry.offeringId === member)?.name ?? member);
                      return [attributes.length ? attributes.join("; ") : null, bundle.length ? `With ${bundle.join(", ")}` : null].filter(Boolean).join(" · ") || "—";
                    } },
                    { key: "status", header: "Status", render: (row) => editable
                      ? <Select aria-label={`${row.name} status`} value={row.status} onChange={(event) => setOffering(row.offeringId, { status: event.target.value as InstitutionOffering["status"] })}>
                          <option value="ACTIVE">Active</option><option value="CLOSED_TO_NEW">Closed to new</option><option value="RETIRED">Retired</option>
                        </Select>
                      : label(row.status) },
                    ...(editable ? [{ key: "remove", header: "", render: (row: InstitutionOffering) => (
                      <span className={styles.row}>
                        <Button size="sm" variant="quiet" icon="sliders" aria-label={`Edit ${row.name} details`} onClick={() => setDetails(row.offeringId)} />
                        <Button size="sm" variant="quiet" icon="x" aria-label={`Remove ${row.name}`} onClick={() => workspace.edit((next) => { next.offerings = next.offerings.filter((offering) => offering.offeringId !== row.offeringId); return next; })} />
                      </span>
                    ) }] : []),
                  ]}
                  rows={catalog.offerings}
                  rowKey={(row) => row.offeringId}
                />
              ) : <EmptyState icon="package" title="No offerings yet" headingLevel={3}>Add the institution's first offering and map it to a canonical product.</EmptyState>}
            </section>
            <section className={styles.section} aria-labelledby="products-resolution">
              <div className={styles.sectionHead}>
                <h3 id="products-resolution">How today's case products resolve</h3>
                <span className={styles.hint}>Using the {workspace.view.data?.published ? "published" : "latest saved"} catalog: an offering the institution declared first, then the taxonomy's own mapping.</span>
              </div>
              <Table
                caption="Case product types and the canonical products they resolve to"
                columns={[
                  { key: "type", header: "Case product type", render: (row) => <code>{row.productType}</code> },
                  { key: "product", header: "Canonical product", render: (row) => row.resolved ? <span>{path(row.resolved.canonicalProductId)} <code className={styles.ruleId}>{row.resolved.canonicalProductId}</code></span> : "Unresolved" },
                  { key: "offering", header: "Offering", render: (row) => row.resolved?.offeringId ?? "—" },
                  { key: "source", header: "Resolved by", render: (row) => !row.resolved ? "Nothing: the case stops for a person" : row.resolved.source === "taxonomy_legacy" ? "Taxonomy mapping" : "The institution's offering" },
                ]}
                rows={resolution}
                rowKey={(row) => row.productType}
              />
            </section>
            {adding ? <OfferingSheet catalog={catalog} taxonomy={taxonomy} onClose={() => setAdding(false)} onSave={(offering) => workspace.edit((next) => { next.offerings.push(offering); return next; })} /> : null}
            {details && catalog.offerings.some((offering) => offering.offeringId === details) ? (
              <OfferingDetailsSheet catalog={catalog} taxonomy={taxonomy} offeringId={details} onClose={() => setDetails(null)}
                onSave={(change) => setOffering(details, change)} />
            ) : null}
          </>
        );
      }}</Loading>
    </div>
  );
}

function OfferingSheet({ catalog, taxonomy, onSave, onClose }: { catalog: InstitutionCatalog; taxonomy: ProductTaxonomy; onSave: (offering: InstitutionOffering) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [line, setLine] = useState(catalog.institution.businessLines[0]?.id ?? "");
  const [entity, setEntity] = useState(catalog.institution.legalEntities[0]?.id ?? "");
  const [product, setProduct] = useState("");
  const [jurisdictions, setJurisdictions] = useState<string[]>(catalog.institution.jurisdictions.slice(0, 1));
  const [parties, setParties] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scope = catalog.institution.businessLines.find((entry) => entry.id === line)?.productScope ?? [];
  // Products this business line may offer: the scope nodes and everything below them.
  const candidates = taxonomy.nodes.filter((node) => scope.some((root) => node.id === root || node.id.startsWith(`${root}.`)));
  const allowed = product && taxonomy.nodes.some((node) => node.id === product) ? effectiveEligibility(taxonomy, product) : [];
  const save = () => {
    const offeringId = slug(name);
    if (!offeringId) return setError("Name the offering.");
    if (catalog.offerings.some((offering) => offering.offeringId === offeringId)) return setError(`An offering with id ${offeringId} already exists.`);
    if (!candidates.some((node) => node.id === product)) return setError("Choose a canonical product within the business line's scope.");
    if (!jurisdictions.length) return setError("Choose at least one jurisdiction.");
    onSave({ offeringId, name: name.trim(), description: "", canonicalProductId: product, businessLine: line, legalEntity: entity, jurisdictions,
      eligiblePartyTypes: parties as InstitutionOffering["eligiblePartyTypes"], variantAttributes: {}, bundle: [], legacyProductTypes: [], status: "ACTIVE" });
    onClose();
  };
  return (
    <SheetForm title="Add offering" description="The institution's own product, mapped to the canonical product whose policy it follows." onClose={onClose} onSave={save} error={error}>
      <Field label="Name"><TextInput value={name} onChange={(event) => setName(event.target.value)} data-autofocus /></Field>
      <Field label="Business line">
        <Select value={line} onChange={(event) => { setLine(event.target.value); setProduct(""); }}>{catalog.institution.businessLines.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</Select>
      </Field>
      <Field label="Canonical product" hint="Products within the business line's scope.">
        <Select value={product} onChange={(event) => { setProduct(event.target.value); setParties([]); }}>
          <option value="">Choose a product</option>
          {candidates.map((node) => <option key={node.id} value={node.id}>{`${"  ".repeat(node.ancestors.length)}${node.name} (${node.id})`}</option>)}
        </Select>
      </Field>
      <Field label="Legal entity">
        <Select value={entity} onChange={(event) => setEntity(event.target.value)}>{catalog.institution.legalEntities.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</Select>
      </Field>
      <Checks legend="Jurisdictions" options={catalog.institution.jurisdictions} value={jurisdictions} onChange={setJurisdictions} describe={(code) => code} />
      <fieldset className={styles.fieldset}>
        <legend>Eligible party types</legend>
        <span className={styles.hint}>{allowed.length ? `Leave empty for the product's own: ${allowed.map(label).join(", ")}. You may only narrow it.` : "Leave empty for any party type."}</span>
        <Checks legend="Eligible party types" options={allowed.length ? allowed : PRODUCT_PARTY_TYPES} value={parties} onChange={setParties} />
      </fieldset>
    </SheetForm>
  );
}

const attributeText = (value: unknown) => Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? (value ? "yes" : "no") : String(value);

/** A value of the attribute's type, from what the author entered; strings stay strings. */
function attributeDefault(attribute: ProductAttributeDefinition): unknown {
  switch (attribute.type) {
    case "boolean": return false;
    case "number": return 0;
    case "enum": return attribute.values?.[0] ?? "";
    case "enum_list": case "string_list": return [];
    default: return "";
  }
}

function AttributeValue({ attribute, value, onChange }: { attribute: ProductAttributeDefinition; value: unknown; onChange: (value: unknown) => void }) {
  const name = attribute.name;
  switch (attribute.type) {
    case "boolean":
      return <span className={styles.row}><Switch label={name} checked={value === true} onChange={onChange} /><span>{value === true ? "Yes" : "No"}</span></span>;
    case "number":
      return <TextInput aria-label={name} type="number" value={typeof value === "number" ? String(value) : ""} onChange={(event) => onChange(event.target.value === "" ? 0 : Number(event.target.value))} />;
    case "enum":
      return <Select aria-label={name} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)}>{(attribute.values ?? []).map((option) => <option key={option} value={option}>{label(option)}</option>)}</Select>;
    case "enum_list":
      return <Checks legend={name} options={attribute.values ?? []} value={Array.isArray(value) ? value as string[] : []} onChange={onChange} />;
    case "string_list":
      return <TextInput aria-label={name} value={Array.isArray(value) ? value.join(", ") : ""} onChange={(event) => onChange(event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} />;
    default:
      return <TextInput aria-label={name} type={attribute.type === "date" ? "date" : "text"} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} />;
  }
}

/**
 * An offering's variant attributes (offering-level attributes of the taxonomy, each a value of its
 * type) and its bundle (other offerings sold or serviced with it). The catalog's own checks run on
 * the change as it is made; nothing is saved until the working copy is.
 */
function OfferingDetailsSheet({ catalog, taxonomy, offeringId, onSave, onClose }: {
  catalog: InstitutionCatalog; taxonomy: ProductTaxonomy; offeringId: string; onSave: (change: Pick<InstitutionOffering, "variantAttributes" | "bundle">) => void; onClose: () => void;
}) {
  const offering = catalog.offerings.find((entry) => entry.offeringId === offeringId)!;
  const [variant, setVariant] = useState<Record<string, unknown>>(structuredClone(offering.variantAttributes));
  const [bundle, setBundle] = useState<string[]>([...offering.bundle]);
  const [adding, setAdding] = useState("");
  const offeringLevel = taxonomy.attributes.filter((attribute) => attribute.setAt === "offering");
  const definition = (id: string) => taxonomy.attributes.find((attribute) => attribute.id === id);
  const available = offeringLevel.filter((attribute) => !(attribute.id in variant));
  const candidate = { ...catalog, offerings: catalog.offerings.map((entry) => entry.offeringId === offeringId ? { ...entry, variantAttributes: variant as InstitutionOffering["variantAttributes"], bundle } : entry) };
  const problems = institutionCatalogProblems(candidate, taxonomy).filter((problem) => problem.split(":")[1] === offeringId && /attribute|bundle/.test(problem));
  const others = catalog.offerings.filter((entry) => entry.offeringId !== offeringId && entry.status !== "RETIRED");
  const save = () => { onSave({ variantAttributes: variant as InstitutionOffering["variantAttributes"], bundle }); onClose(); };
  return (
    <SheetForm title={`${offering.name} details`} description="What makes this offering a variant of its canonical product, and what is sold with it." onClose={onClose} onSave={save}
      error={problems.length ? problems.map(describeCatalogProblem).join(". ") : null}>
      <section className={styles.stack} aria-label="Variant attributes">
        <h4 className={styles.paneTitle}>Variant attributes</h4>
        <span className={styles.hint}>Offering-level attributes only; product and relationship attributes are set elsewhere.</span>
        {Object.keys(variant).length ? (
          <dl className={styles.settings}>
            {Object.entries(variant).map(([key, value]) => {
              const attribute = definition(key);
              return (
                <div key={key} className={styles.row}>
                  <dt>{attribute?.name ?? key}</dt>
                  <dd className={styles.row}>
                    {attribute ? <AttributeValue attribute={attribute} value={value} onChange={(next) => setVariant({ ...variant, [key]: next })} /> : <code>{attributeText(value)}</code>}
                    <Button size="sm" variant="quiet" icon="x" aria-label={`Remove ${attribute?.name ?? key}`} onClick={() => { const { [key]: _removed, ...rest } = variant; setVariant(rest); }} />
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : <p className={styles.hint}>No variant attributes: the offering is the canonical product as it is.</p>}
        <span className={styles.row}>
          <Field label="Add attribute">
            <Select value={adding} onChange={(event) => setAdding(event.target.value)}>
              <option value="">Choose an attribute</option>
              {available.map((attribute) => <option key={attribute.id} value={attribute.id}>{attribute.name} ({label(attribute.group)})</option>)}
            </Select>
          </Field>
          <Button size="sm" icon="plus" disabled={!adding} onClick={() => { const attribute = definition(adding); if (attribute) setVariant({ ...variant, [adding]: attributeDefault(attribute) }); setAdding(""); }}>Add</Button>
        </span>
      </section>
      <section className={styles.stack} aria-label="Bundle">
        <h4 className={styles.paneTitle}>Bundle</h4>
        {others.length ? <Checks legend="Sold or serviced with" options={others.map((entry) => entry.offeringId)} value={bundle} onChange={setBundle}
          describe={(id) => others.find((entry) => entry.offeringId === id)?.name ?? id} /> : <p className={styles.hint}>The institution has no other offering to bundle with.</p>}
      </section>
    </SheetForm>
  );
}
