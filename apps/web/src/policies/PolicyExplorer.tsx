import type { EffectiveControl, EffectivePolicy, InstitutionOffering, ProductTaxonomy } from "@ehf/contracts/products";
import { usePolled } from "@ehf/ui-client/react";
import { Button, EmptyState, Field, InlineMessage, SegmentedControl, Select, Switch, ToneBadge } from "@ehf/ui-kit";
import { useMemo, useState, type ReactNode } from "react";
import { api } from "../app/api";
import { useSearchParam } from "../platform/common";
import type { PolicyCompilation } from "../platform/surfaces/authoring/policy";
import { LevelChip, OverlaySheet } from "./Diligence";
import { addMatrixColumn, cleanScope, draftFromOverlay, overlaySource, setMatrixCell, setOverlayEnabled, upsertOverlay, type OverlayDraft } from "./edit";
import {
  explorerProduct, overrideCount, ownTarget, packLayers, productPolicy, productTree, STATUS_LABEL, trailText, workingDiligence, type ExplorerNode,
} from "./explorer";
import { humanize, type Rulebook } from "./rulebook";
import styles from "./studio.module.css";
import { WhatIf } from "./WhatIf";

type Editor = { source: string; onEdit: (next: string) => void } | null;
type Status = EffectiveControl["status"];
const STATUS_LOOK: Record<Status, { tone: "info" | "neutral" | "attention" | "draft"; icon: "lock" | "arrowd" | "branch" | "flag" | "minus" }> = {
  PROTECTED: { tone: "info", icon: "lock" }, INHERITED: { tone: "neutral", icon: "arrowd" }, MODIFIED: { tone: "attention", icon: "branch" },
  CONDITIONAL: { tone: "draft", icon: "flag" }, NOT_APPLICABLE: { tone: "neutral", icon: "minus" },
};
export function StatusChip({ status }: { status: Status }) {
  const look = STATUS_LOOK[status];
  return <ToneBadge tone={look.tone} icon={look.icon}>{STATUS_LABEL[status]}</ToneBadge>;
}
const REASONS: Record<string, string> = {
  outside_products: "Scoped to other products", outside_party_types: "Scoped to other party types", outside_jurisdictions: "Scoped to other jurisdictions",
  switched_off: "Switched off", product_not_in_matrix: "The matrix has no column for this product",
};

/** A control's value in words. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map(valueText).join(", ") : "None";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length ? entries.map(([key, item]) => `${humanize(key)}: ${valueText(item)}`).join("; ") : "None";
  }
  return String(value);
}

/**
 * The Product Policy Explorer (Product Policy Studio phase E): the set's products on the taxonomy,
 * one product's controls with where each comes from, and an inspector with the inheritance trail.
 * Edits change the working copy's diligence block, as every other policy-owner view does.
 */
export function PolicyExplorer({ files, book, setId, editor, compilation, ensureCompiled, workingOfferings }: {
  files: Record<string, string>; book: Rulebook; setId: string; editor: Editor;
  compilation: PolicyCompilation | null; ensureCompiled: () => Promise<PolicyCompilation | null>;
  /** The Products step's working copy of the set's institution catalog, including unsaved offerings. */
  workingOfferings?: InstitutionOffering[] | undefined;
}) {
  const set = book.policySets.find((entry) => entry.id === setId) ?? book.policySets[0];
  const packs = usePolled(api, "getAuthoringPoliciesPacks", undefined);
  const taxonomyPolled = usePolled(api, "getAuthoringProductsTaxonomy", undefined);
  const catalog = usePolled(api, "getAuthoringInstitutionsInstitutionIdCatalog", { path: { institutionId: set?.institution ?? "" } }, { enabled: Boolean(set) && !workingOfferings });
  const [productParam, setProduct] = useSearchParam("product");
  const [viewParam, setView] = useSearchParam("explore");
  const view = viewParam === "coverage" ? "coverage" : "explorer";
  const diligence = useMemo(() => workingDiligence(files["policy.yaml"]), [files]);
  const parties = (diligence?.partyTypes ?? []).filter((party) => set?.customerTypes.includes(party.customerType));
  const [partyChoice, setPartyChoice] = useState<string | null>(null);
  const partyType = parties.find((party) => party.id === partyChoice)?.id ?? parties[0]?.id ?? null;
  const [controlId, setControlId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ overlayId: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taxonomy = taxonomyPolled.data as ProductTaxonomy | undefined;
  const layers = useMemo(() => packLayers((packs.data?.layers ?? []) as unknown[]), [packs.data]);

  if (!set || !book.diligence || !diligence) {
    return <EmptyState icon="package" title="The explorer needs an installation policy with a diligence design" headingLevel={3}>Choose the KYC or KYB onboarding policy.</EmptyState>;
  }
  if (packs.error || taxonomyPolled.error) return <InlineMessage tone="error">The pack layers or the product taxonomy could not be read, so effective policies cannot be shown.</InlineMessage>;
  if (!taxonomy || !packs.data) return <p className={styles.hint}>Loading the product taxonomy and pack layers…</p>;

  const legacy = taxonomy.legacy;
  const names = new Map(taxonomy.nodes.map((node) => [node.id, node.name]));
  const offerings = workingOfferings ?? ((catalog.data?.latest?.catalog ?? catalog.data?.seed)?.offerings ?? []) as InstitutionOffering[];
  const tree = productTree(set.products, taxonomy, offerings);
  const { product, offering } = explorerProduct(productParam, set.products, tree);
  const nameOf = (id: string) => names.get(legacy[id] ?? id) ?? humanize(id);
  const policyFor = (id: string, party = partyType) => productPolicy({ layers, legacy, diligence, set, product: id, partyType: party });
  const selected = policyFor(product);
  const apply = (change: (source: string) => string) => {
    if (!editor) return;
    try { editor.onEdit(change(editor.source)); setError(null); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  return (
    <div className={styles.sections}>
      <div className={styles.toolbar}>
        <p className={styles.hint}>Every product inherits from the regulator, the institution and its product family; it may only tighten what it inherits.</p>
        <span className={styles.row}>
          {parties.length > 1 ? (
            <Field label="Party type">
              <Select value={partyType ?? ""} onChange={(event) => setPartyChoice(event.target.value)}>
                {parties.map((party) => <option key={party.id} value={party.id}>{party.label}</option>)}
              </Select>
            </Field>
          ) : null}
          <SegmentedControl label="Explorer view" value={view} onChange={(next: "explorer" | "coverage") => setView(next === "explorer" ? undefined : next)}
            options={[{ value: "explorer", label: "Product" }, { value: "coverage", label: "Coverage" }]} />
        </span>
      </div>
      {error ? <div role="alert"><InlineMessage tone="error">{error}</InlineMessage></div> : null}
      {view === "coverage"
        ? <CoverageMatrix products={set.products} nameOf={nameOf} policyFor={(id) => policyFor(id)} book={book} editor={editor} legacy={legacy}
            onOpen={(id) => { setProduct(id); setView(undefined); }} onScope={(overlayId, products) => apply((source) => {
              const raw = overlaySource(source, overlayId)!;
              const draft = draftFromOverlay(raw);
              return upsertOverlay(source, { ...draft, appliesTo: { ...draft.appliesTo, products } } as OverlayDraft, overlayId);
            })} />
        : (
          <div className={styles.explorer}>
            <nav className={`${styles.pane} ${styles.paneSticky}`} aria-label="Products">
              <h3 className={styles.paneTitle}>Products</h3>
              <ProductTreeList nodes={tree} selected={product} onSelect={(id) => { setProduct(id); setControlId(null); }}
                countOf={(id) => { const result = policyFor(id); return result.policy ? overrideCount(result.policy, diligence, legacy) : null; }} />
            </nav>
            <section className={styles.pane} aria-labelledby="explorer-product">
              {offering ? <p className={styles.hint}>The offering {offering}, evaluated as its canonical product {nameOf(product)} (<code>{product}</code>).</p> : null}
              {selected.policy ? (
                <ProductRules policy={selected.policy} book={book} diligence={diligence} legacy={legacy} nameOf={nameOf} editor={editor} selected={controlId}
                  onSelect={setControlId} onAddRule={() => setSheet({ overlayId: null })} onEditRule={(id) => setSheet({ overlayId: id })} apply={apply} />
              ) : <InlineMessage tone="error">{nameOf(product)} has no effective policy: {selected.error}</InlineMessage>}
            </section>
            <aside className={`${styles.pane} ${styles.paneSticky}`} aria-label="Effective policy inspector">
              {selected.policy ? <Inspector policy={selected.policy} names={names} legacy={legacy} controlId={controlId} book={book} /> : null}
            </aside>
          </div>
        )}
      {view === "explorer" ? (
        <WhatIf key={`${set.id}:${product}`} files={files} book={book} setId={set.id} compilation={compilation} ensureCompiled={ensureCompiled}
          focusProducts={[product]} title={`Simulate ${offering ?? nameOf(product)}`} />
      ) : null}
      {editor && sheet ? (
        <OverlaySheet diligence={book.diligence} source={editor.source} overlayId={sheet.overlayId} initialScope={cleanScope({ products: [product] })}
          onSave={(draft) => { try { editor.onEdit(upsertOverlay(editor.source, draft, sheet.overlayId ?? undefined)); setError(null); return true; } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return false; } }}
          onClose={() => setSheet(null)} />
      ) : null}
    </div>
  );
}

function ProductTreeList({ nodes, selected, onSelect, countOf }: { nodes: ExplorerNode[]; selected: string; onSelect: (product: string) => void; countOf: (product: string) => number | null }) {
  return (
    <ul className={styles.tree}>
      {nodes.map((node) => (
        <li key={node.id}>
          {node.products.length ? node.products.map((product) => {
            const count = countOf(product);
            return (
              <button key={product} type="button" className={styles.treeItem} aria-current={product === selected ? "true" : undefined} onClick={() => onSelect(product)}>
                <span>{node.name} <code className={styles.ruleId}>{product}</code></span>
                <span className={styles.hint}>{count === null ? "Not composable" : count === 0 ? "Inherited" : `${count} override${count === 1 ? "" : "s"}`}</span>
              </button>
            );
          }) : <span className={styles.treeGroup}>{node.name}</span>}
          {node.offerings.length ? (
            <ul className={styles.tree} aria-label={`${node.name} offerings`}>
              {node.offerings.map((offering) => (
                <li key={offering.offeringId}>
                  {offering.served ? (
                    <button type="button" className={styles.treeItem} aria-current={offering.canonicalProductId === selected ? "true" : undefined}
                      onClick={() => onSelect(offering.canonicalProductId)}>
                      <span>Offered as {offering.name} <code className={styles.ruleId}>{offering.canonicalProductId}</code></span>
                    </button>
                  ) : <span className={styles.hint}>Offered as {offering.name}: not served by this policy set</span>}
                </li>
              ))}
            </ul>
          ) : null}
          {node.children.length ? <ProductTreeList nodes={node.children} selected={selected} onSelect={onSelect} countOf={countOf} /> : null}
        </li>
      ))}
    </ul>
  );
}

function ProductRules({ policy, book, diligence, legacy, nameOf, editor, selected, onSelect, onAddRule, onEditRule, apply }: {
  policy: EffectivePolicy; book: Rulebook; diligence: NonNullable<ReturnType<typeof workingDiligence>>; legacy: Readonly<Record<string, string>>;
  nameOf: (id: string) => string; editor: Editor; selected: string | null; onSelect: (id: string) => void;
  onAddRule: () => void; onEditRule: (id: string) => void; apply: (change: (source: string) => string) => void;
}) {
  const product = policy.scope.product;
  const levels = book.diligence!.levels;
  const cell = policy.controls.find((control) => control.kind === "diligence_cell");
  const floors = policy.controls.filter((control) => control.kind === "diligence_floor");
  const rules = policy.controls.filter((control) => control.kind === "diligence_overlay");
  const values = policy.controls.filter((control) => control.kind === "pack_value");
  const party = book.diligence!.partyTypes.find((entry) => entry.id === policy.scope.partyType);
  const column = cell?.source?.target ?? null;
  const own = ownTarget(product, column, legacy);
  const row = (control: EffectiveControl, body: ReactNode) => (
    <li key={control.controlId} className={styles.control} data-selected={control.controlId === selected || undefined}>
      <button type="button" className={styles.controlSelect} onClick={() => onSelect(control.controlId)} aria-label={`Inspect ${control.label}`}>
        <strong>{control.label}</strong><StatusChip status={control.status} />
      </button>
      {body}
    </li>
  );
  return (
    <div className={styles.stack}>
      <div className={styles.sectionHead}>
        <h3 id="explorer-product">{nameOf(product)}</h3>
        <span className={styles.hint}>{[...new Set(policy.scope.lineage.map(nameOf).reverse())].join(" › ")}</span>
      </div>

      <section aria-label="Base level" className={styles.stack}>
        <h4 className={styles.paneTitle}>Base level{party ? ` for ${party.label}` : ""}</h4>
        <ul className={styles.controls}>
          {cell ? row(cell, (
            <span className={styles.row}>
              {typeof cell.value !== "string" ? <span>{REASONS[cell.reason ?? ""] ?? "—"}</span>
                : !(editor && party && column && own) ? <LevelChip levels={levels} level={cell.value} /> : null}
              {cell.status === "INHERITED" ? <span className={styles.hint}>From the {nameOf(column ?? "")} column</span> : null}
              {editor && party && column && own ? (
                <Select aria-label={`${party.label} base level for ${nameOf(product)}`} value={String(cell.value)}
                  onChange={(event) => apply((source) => setMatrixCell(source, party.id, column, event.target.value))}>
                  {levels.map((level) => <option key={level} value={level}>{level}</option>)}
                </Select>
              ) : null}
              {editor && column && !own ? <Button size="sm" icon="branch" onClick={() => apply((source) => addMatrixColumn(source, product, column))}>Override for {nameOf(product)}</Button> : null}
            </span>
          )) : null}
          {floors.map((floor) => row(floor, <span className={styles.row}><LevelChip levels={levels} level={String(floor.value)} /><span className={styles.hint}>Set by {floor.source?.id}</span></span>))}
        </ul>
      </section>

      <section aria-label="Rules" className={styles.stack}>
        <div className={styles.sectionHead}>
          <h4 className={styles.paneTitle}>Rules</h4>
          {editor ? <Button size="sm" icon="plus" onClick={onAddRule}>Add a rule for {nameOf(product)}</Button> : null}
        </div>
        <ul className={styles.controls}>
          {rules.map((rule) => {
            const summary = book.diligence!.overlays.find((overlay) => overlay.id === rule.controlId);
            const authored = diligence.overlays.find((overlay) => overlay.id === rule.controlId);
            const scopedHere = (authored?.appliesTo?.products ?? []).some((target) => ownTarget(product, target, legacy));
            return row(rule, (
              <>
                <span className={styles.hint}>{summary?.sentence ?? ""}</span>
                <span className={styles.row}>
                  {rule.reason ? <span className={styles.hint}>{REASONS[rule.reason] ?? rule.reason}</span> : null}
                  {rule.enforced ? <span className={styles.hint}>Required by {rule.source?.id}</span> : null}
                  {scopedHere ? <ToneBadge tone="attention" icon="branch">For this product</ToneBadge> : null}
                  {editor && authored && !rule.enforced ? <Switch label={`${rule.label} enabled`} checked={authored.enabled} onChange={(checked) => apply((source) => setOverlayEnabled(source, rule.controlId, checked))} /> : null}
                  {editor ? <Button size="sm" variant="quiet" icon="file" aria-label={`Edit ${rule.label}`} onClick={() => onEditRule(rule.controlId)}>Edit</Button> : null}
                </span>
              </>
            ));
          })}
        </ul>
      </section>

      <section aria-label="Controls from policy packs" className={styles.stack}>
        <h4 className={styles.paneTitle}>Controls from policy packs</h4>
        <ul className={styles.controls}>
          {values.map((value) => row(value, <span className={styles.hint}>{valueText(value.value)}</span>))}
        </ul>
      </section>
    </div>
  );
}

function Inspector({ policy, names, legacy, controlId, book }: { policy: EffectivePolicy; names: ReadonlyMap<string, string>; legacy: Readonly<Record<string, string>>; controlId: string | null; book: Rulebook }) {
  const control = policy.controls.find((entry) => entry.controlId === controlId);
  const overlay = control?.kind === "diligence_overlay" ? book.diligence?.overlays.find((entry) => entry.id === control.controlId) : undefined;
  return (
    <div className={styles.stack}>
      <h3 className={styles.paneTitle}>Effective policy</h3>
      <ol className={styles.trail} aria-label="Inheritance trail">
        {trailText(policy, names, legacy).map((step) => <li key={step}>{step}</li>)}
      </ol>
      {control ? (
        <section className={styles.stack} aria-label={`About ${control.label}`}>
          <span className={styles.row}><strong>{control.label}</strong><StatusChip status={control.status} /></span>
          <dl className={styles.settings}>
            <dt>Value</dt><dd>{valueText(control.value)}</dd>
            {control.source ? <><dt>Set by</dt><dd>{control.source.id}{control.source.target ? ` (${names.get(legacy[control.source.target] ?? control.source.target) ?? control.source.target})` : ""} · {control.source.status}</dd></> : null}
            {control.regulatoryValue !== null ? <><dt>Regulatory value</dt><dd>{valueText(control.regulatoryValue)}: no layer may loosen past it</dd></> : null}
            {control.reason ? <><dt>Why not here</dt><dd>{REASONS[control.reason] ?? control.reason}</dd></> : null}
            {control.evidence.length ? <><dt>Requires</dt><dd>{control.evidence.join(", ")}</dd></> : null}
            {overlay ? <><dt>Reads</dt><dd>{overlay.sentence}</dd></> : null}
          </dl>
          {control.basis ? <p className={styles.hint}>{control.basis.text}</p> : null}
          {control.history.length > 1 ? (
            <ol className={styles.contributors} aria-label="How it got its value">
              {control.history.map((step, index) => <li key={`${step.id}:${index}`}>{step.id}: {valueText(step.value)}</li>)}
            </ol>
          ) : null}
        </section>
      ) : <p className={styles.hint}>Select a control to see where its value comes from.</p>}
    </div>
  );
}

/** Controls × products: what each product gets and from where. Rule rows toggle where a rule applies. */
function CoverageMatrix({ products, nameOf, policyFor, book, editor, legacy, onOpen, onScope }: {
  products: string[]; nameOf: (id: string) => string; policyFor: (product: string) => ReturnType<typeof productPolicy>; book: Rulebook; editor: Editor;
  legacy: Readonly<Record<string, string>>; onOpen: (product: string) => void; onScope: (overlayId: string, products: string[]) => void;
}) {
  const policies = products.map((product) => ({ product, result: policyFor(product) }));
  const first = policies.find((entry) => entry.result.policy)?.result.policy;
  if (!first) return <InlineMessage tone="error">No product of this set has an effective policy.</InlineMessage>;
  const rows = first.controls.filter((control) => control.kind !== "diligence_floor");
  const cellOf = (product: string, controlId: string) => policies.find((entry) => entry.product === product)?.result.policy?.controls.find((control) => control.controlId === controlId);
  return (
    <div className={styles.matrixWrap}>
      <table className={styles.coverage}>
        <caption>Controls by product</caption>
        <thead>
          <tr><th scope="col">Control</th>{products.map((product) => <th key={product} scope="col"><button type="button" className={styles.linkish} onClick={() => onOpen(product)}>{nameOf(product)}</button></th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cells = products.map((product) => cellOf(product, row.controlId));
            const varies = new Set(cells.map((cell) => JSON.stringify(cell?.value ?? null))).size > 1;
            const authored = row.kind === "diligence_overlay" ? workingOverlay(book, row.controlId) : null;
            return (
              <tr key={row.controlId}>
                <th scope="row">{row.label}{varies && row.kind === "pack_value" ? <span className={styles.hint}> · differs by product</span> : null}</th>
                {products.map((product, index) => {
                  const cell = cells[index];
                  if (!cell) return <td key={product}>—</td>;
                  if (row.kind === "diligence_overlay" && editor && authored !== null) {
                    const scope = authored;
                    const applies = cell.reason !== "outside_products";
                    const named = scope === undefined ? null : scope.filter((target) => products.includes(target));
                    // A rule scoped through a taxonomy node (PAY) is changed in its sheet, not per product.
                    const throughNode = scope !== undefined && applies && !scope.includes(product);
                    const next = applies ? (named ?? products).filter((entry) => entry !== product) : [...(named ?? []), product];
                    return (
                      <td key={product}>
                        <label className={styles.check}>
                          <input type="checkbox" checked={applies} disabled={throughNode || next.length === 0}
                            title={throughNode ? "Applies through a product family; edit the rule to change it" : undefined}
                            onChange={() => onScope(row.controlId, next.length === products.length ? [] : next)} />
                          <StatusChip status={cell.status} />
                        </label>
                      </td>
                    );
                  }
                  return <td key={product}><span className={styles.cellValue}>{valueText(cell.value)}</span> <StatusChip status={cell.status} /></td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className={styles.hint}>Protected values come from the regulator; an override only ever tightens what a product inherits.</p>
    </div>
  );
}

/** A rule's product scope as authored: undefined when it applies to every product. */
function workingOverlay(book: Rulebook, overlayId: string): string[] | undefined | null {
  const overlay = book.diligence?.overlays.find((entry) => entry.id === overlayId);
  if (!overlay) return null;
  return overlay.scopeProducts.length ? overlay.scopeProducts : undefined;
}
