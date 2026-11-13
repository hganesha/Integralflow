import { CONTEXT_SETUP_PATH } from "./links";
import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { canUse } from "@ehf/ui-shell";
import { Disclosure, EmptyState, Field, Id, Select, Table, ToneBadge, type Column } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { api } from "../../../app/api";
import { useSession } from "../../../app/session";
import { Region } from "../../../platform/common";
import { skillPath } from "./links";
import { bankName, type ContextProduct } from "./model";
import styles from "./context.module.css";
import { DefinitionLabel, GroupedItems } from '../../../presentation/components';

type Requirement = Schemas["FieldRequirement"];
type Capability = Schemas["CapabilityRegistryItemView"];
type Adapter = Schemas["AdapterDescriptorView"];

const REQUIREMENT_COLUMNS: Column<Requirement>[] = [
  { key: "object", header: "Object", render: (row) => <Id>{row.object_type}</Id> },
  { key: "field", header: "Field", render: (row) => <Id>{row.field}</Id> },
  { key: "required", header: "Required", render: (row) => (row.required ? "Yes" : "No") },
  { key: "min", header: "Min count", align: "end", render: (row) => row.min_count },
  { key: "missing", header: "On missing", render: (row) => <Id>{row.on_missing}</Id> },
  { key: "freshness", header: "Freshness", render: (row) => (row.freshness_policy ? <Id>{row.freshness_policy}</Id> : <span className={styles.muted}>Not set</span>) },
  { key: "skill", header: "Skill", render: (row) => <Link to={skillPath(row.skill_id)}><DefinitionLabel kind="skills" id={row.skill_id}/></Link> },
];

const CAPABILITY_COLUMNS: Column<Capability>[] = [
  { key: "id", header: "Capability", render: (row) => <DefinitionLabel kind="external-capabilities" id={row.capability.id} showId/> },
  { key: "kind", header: "Kind", render: (row) => row.capability.kind },
  { key: "effect", header: "Effect", render: (row) => row.capability.effect },
  { key: "binding", header: "Adapter binding", render: (row) => <Id>{row.capability.adapterBindingId}</Id> },
  { key: "status", header: "Status", render: (row) => row.capability.status },
];

/** Credentials are referenced by state only; no secret value exists in the contract or the UI (AC3). */
function CredentialState({ state }: { state: Adapter["credentialState"] }) {
  if (state === "Configured") return <ToneBadge tone="positive" icon="lock">Credential configured</ToneBadge>;
  if (state === "Missing") return <ToneBadge tone="attention" icon="alert">Credential missing</ToneBadge>;
  return <ToneBadge tone="neutral" icon="minus">No credential needed</ToneBadge>;
}

const ADAPTER_COLUMNS: Column<Adapter>[] = [
  { key: "label", header: "Adapter", render: (row) => <span>{row.label} <Id>{row.id}</Id></span> },
  { key: "kinds", header: "Supports", render: (row) => row.supportedKinds.join(", ") },
  { key: "credential", header: "Credential", render: (row) => <CredentialState state={row.credentialState} /> },
  { key: "bindings", header: "Binding options", align: "end", render: (row) => row.bindingOptions.length },
];

/**
 * CXT-03 Engineer: the field requirements behind one context product, and the provider side
 * read-only. Provider binding readiness waits for the canonical external capability model,
 * shown as a neutral disclosure (G5) rather than a guess.
 */
export function EngineerBoard({ productId, products, onProduct, agentId, draftId }: { productId: string | undefined; products: readonly ContextProduct[]; onProduct: (productId: string) => void; agentId?: string | undefined; draftId?: string | undefined }) {
  const session = useSession();
  const canReadCapabilities = canUse(session, ["capability.read"]);
  const view = usePolled(api, "getFincrimeContextProductsProductId", { path: { productId: productId ?? "" } }, { enabled: Boolean(productId) });
  const registry = usePolled(api, "getGatewayRegistry", undefined, { enabled: canReadCapabilities });
  const sources = usePolled(api, "getContextSources", undefined, { enabled: canReadCapabilities });
  const adapters = usePolled(api, "getGatewayAdapters", undefined, { enabled: canReadCapabilities });
  return (
    <div className={styles.stack}>
      <p className={styles.hint}><b>Requirements and provider workbench.</b> Secrets are referenced by state, never displayed.</p>
      <Link to={CONTEXT_SETUP_PATH} search={{ ...(productId ? { product: productId } : {}), ...(agentId ? {agent:agentId} : {}), ...(draftId ? {draft:draftId} : {}) }}>Connect source · View mappings · Test context</Link>
      <div className={styles.rowEnd}>
        <Field label="Context product">
          <Select value={productId ?? ""} onChange={(event) => event.target.value && onProduct(event.target.value)}>
            <option value="">Choose a product…</option>
            {products.map((product) => <option key={product.id} value={product.id}>{bankName(product.id)} · {product.id}</option>)}
          </Select>
        </Field>
      </div>
      {!productId ? (
        <EmptyState icon="table" title="Choose a context product" headingLevel={2}>Select a bank in Play or a product above to see its field requirements.</EmptyState>
      ) : (
        <Region polled={view} label="context product" skeletonHeight={200}>
          {(data) => (
            <>
              <section className={styles.panel} aria-labelledby="eng-requirements">
                <div className={styles.row}>
                  <h2 id="eng-requirements" className={styles.panelTitle}>Field requirements · {bankName(data.product.id)}</h2>
                  <span className={styles.mono}>{data.product.id} v{data.product.version}</span>
                </div>
                {data.fieldRequirements.length ? <GroupedItems items={data.fieldRequirements} kind="skills" idOf={row => row.skill_id}>
                  {rows => <Table
                  caption={`Field requirements for ${data.product.id}`}
                  captionHidden
                  columns={REQUIREMENT_COLUMNS}
                  rows={rows}
                  rowKey={(row) => `${row.skill_id}:${row.object_type}.${row.field}`}
                  stickyFirstColumn
                  empty="No skill requires a field of this product."
                />}
                </GroupedItems> : <p className={styles.muted}>No skill requires a field of this product.</p>}
              </section>
              <section className={styles.panel} aria-labelledby="eng-binding">
                <h2 id="eng-binding" className={styles.panelTitle}>Provider binding</h2>
                <Link to={"/platform/data-sources" as string} search={{productId,tab:"bindings"}}>Configure enterprise context sources</Link>
                {canReadCapabilities ? <Region polled={sources} label="enterprise context bindings" skeletonHeight={80}>{inventory => <Table
                  caption="Enterprise source bindings" rows={inventory.bindings.filter(binding => binding.definition.productId === data.product.id)} rowKey={binding => binding.definition.id}
                  columns={[
                    { key: "name", header: "Source", render: binding => <Link to={"/platform/data-sources" as string} search={{productId:data.product.id,tab:"bindings"}}>{binding.definition.name}</Link> },
                    { key: "revision", header: "Saved revision", render: binding => `r${binding.revision}` },
                    { key: "active", header: "Execution", render: binding => binding.disabled ? "Disabled" : binding.activeRevision ? `Active r${binding.activeRevision}` : "Not activated" },
                  ]} empty="No enterprise source binding is configured for this product."
                />}</Region> : null}
                {data.capabilityReadiness ? (
                  <Disclosure tone="neutral" title="Provider binding readiness is pending upstream" code={data.capabilityReadiness.status}>
                    {data.capabilityReadiness.note}
                  </Disclosure>
                ) : <p className={styles.muted}>No provider binding readiness is reported for this product.</p>}
              </section>
            </>
          )}
        </Region>
      )}
      <section className={styles.panel} aria-labelledby="eng-gateway">
        <h2 id="eng-gateway" className={styles.panelTitle}>Gateway capabilities and adapters</h2>
        {!canReadCapabilities ? (
          <Disclosure tone="neutral" title="Not visible to your role" code="authorization.role_missing">Listing gateway capabilities needs capability.read.</Disclosure>
        ) : (
          <>
            <Region polled={registry} label="capability registry" skeletonHeight={120}>
              {(page) => <GroupedItems items={page.items} kind="external-capabilities" idOf={row=>row.capability.id}>{rows=><Table caption="Gateway capabilities" columns={CAPABILITY_COLUMNS} rows={rows} rowKey={(row) => row.capability.id}/>}</GroupedItems>}
            </Region>
            <Region polled={adapters} label="adapters" skeletonHeight={120}>
              {(page) => <Table caption="Adapters" columns={ADAPTER_COLUMNS} rows={page.items} rowKey={(row) => row.id} empty="No adapters are installed." />}
            </Region>
          </>
        )}
      </section>
    </div>
  );
}
