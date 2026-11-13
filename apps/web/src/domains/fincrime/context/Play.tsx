import type { ContextDefinitionRevision } from "@ehf/contracts";
import { CONTEXT_SETUP_PATH } from "./links";
import { usePolled } from "@ehf/ui-client/react";
import { Disclosure, EmptyState, Id, InspectorSection, StatusBadge } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { api } from "../../../app/api";
import { Region } from "../../../platform/common";
import { InstrumentBanks, ReadinessLegend } from "./InstrumentBanks";
import { CONTEXT_PATH } from "./links";
import { DefinitionLabel, DefinitionReferences } from '../../../presentation/components';
import { bankName, layoutFor, readBank, STATUS_WORDS, type BankReading, type ContextProduct, type Matrix } from "./model";
import styles from "./context.module.css";

/**
 * CXT-01 Play: what governed intelligence each consumer can see. Readiness is the context
 * product against the agent ceiling (BFF §5.6); with "All agents" the banks roll up the
 * subscribed agents. Tune edits never change these readings.
 */
export function PlayBoard({ products, matrix, agentId, selected, onSelect }: {
  products: readonly ContextProduct[];
  matrix: Matrix;
  agentId: string | null;
  selected: string | undefined;
  onSelect: (productId: string) => void;
}) {
  const byId = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const bays = useMemo(() => layoutFor(products.map((product) => product.id)), [products]);
  const readings = useMemo(() => new Map<string, BankReading>(
    products.map((product) => [product.id, readBank(matrix, product.id, byId.get(product.id), agentId)]),
  ), [products, matrix, agentId, byId]);
  return (
    <div className={styles.stack}>
      <p className={styles.hint}>
        <b>What field access is covered{agentId ? <> to <Id>{agentId}</Id></> : " to each agent"}?</b>{" "}
        Banks keep fixed positions. Access coverage compares each context product with the agent&apos;s field ceiling; it is a state, not a score.
      </p>
      <InstrumentBanks bays={bays} readings={readings} selected={selected} onSelect={onSelect} />
      <ReadinessLegend />
    </div>
  );
}

/** Inspector for the selected bank: objects and fields, consumers, the selected agent's ceiling. */
export function ProductInspector({ productId, agentId, matrix, product, draftId }: {
  productId: string | undefined;
  agentId: string | null;
  matrix: Matrix | undefined;
  product: ContextProduct | undefined;
  draftId?: string | undefined;
}) {
  const view = usePolled(api, "getFincrimeContextProductsProductId", { path: { productId: productId ?? "" } }, { enabled: Boolean(productId) });
  const setup = usePolled(api, "getContextDefinitions", undefined, { enabled: Boolean(productId) });
  const mappings = ((setup.data?.items ?? []) as unknown as ContextDefinitionRevision[]).filter(r => r.definition.kind === "mapping" && r.definition.productId === productId);
  if (!productId) {
    return <EmptyState icon="grid" title="Select a bank" headingLevel={2}>Its objects, fields, consumers and the agent ceiling appear here.</EmptyState>;
  }
  const reading = matrix ? readBank(matrix, productId, product, agentId) : undefined;
  return (
    <div className={styles.inspector}>
      <header>
        <div className="t-engraved">Intelligence bank</div>
        <h2 className={styles.inspectorTitle}>{bankName(productId)} intelligence</h2>
        <Id>{productId}</Id>
      </header>
      {reading ? (
        <div className={styles.tight}>
          <StatusBadge dimension="ContextReadiness" value={reading.status} label={STATUS_WORDS[reading.status]} />
          <span className={styles.small}>{reading.summary}</span>
          {reading.gaps.length ? (
            <Disclosure tone="attention" title="Required fields outside the ceiling" code="context.ceiling_gap">
              <ul className={styles.objectList}>{reading.gaps.map((gap) => <li key={gap}><Id>{gap}</Id></li>)}</ul>
            </Disclosure>
          ) : null}
        </div>
      ) : null}
      <Region polled={view} label="context product" skeletonHeight={180}>
        {(data) => {
          const ceilings = agentId ? data.ceilings.filter((entry) => entry.agentId === agentId) : data.ceilings;
          return (
            <>
              <InspectorSection title="Source and sample evidence" defaultOpen>
                <p>{setup.data ? `${mappings.length} mapping${mappings.length === 1 ? "" : "s"} configured for this product.` : "Source inventory unavailable."} Open a mapping to inspect its sample qualification. Freshness and task context require a case assessment.</p>
                <Link to={CONTEXT_SETUP_PATH} search={{ product: productId, ...(agentId ? { agent: agentId } : {}), ...(draftId ? {draft:draftId} : {}) }}>Connect source / View mappings / Test context</Link>
              </InspectorSection>
              <InspectorSection title="Objects and fields" count={Object.keys(data.product.objects).length} defaultOpen>
                <ul className={styles.objectList}>
                  {Object.entries(data.product.objects).map(([object, fields]) => (
                    <li key={object}>
                      <span><Id>{object}</Id> <span className={styles.muted}>· {fields.length} field{fields.length === 1 ? "" : "s"}</span></span>
                      <span className={styles.mono}>{fields.join(" · ")}</span>
                    </li>
                  ))}
                </ul>
              </InspectorSection>
              <InspectorSection title="Consumers" count={data.consumers.agents.length + data.consumers.skills.length} defaultOpen>
                <div className={styles.tight}>
                  <span className="t-engraved">Agents</span>
                  <div className={styles.chips}>
                    {data.consumers.agents.length ? data.consumers.agents.map((agent) => <Link key={agent} to={CONTEXT_PATH} search={{ agent, product: productId }}><DefinitionLabel kind="agents" id={agent}/></Link>) : <span className={styles.muted}>None</span>}
                  </div>
                  <span className="t-engraved">Skills</span>
                  <DefinitionReferences kind="skills" ids={data.consumers.skills} label="Consuming skills"/>
                </div>
              </InspectorSection>
              <InspectorSection title={agentId ? "Ceiling for this agent" : "Agent ceilings"} count={ceilings.length} defaultOpen={Boolean(agentId)}>
                {ceilings.length ? (
                  <ul className={styles.objectList}>
                    {ceilings.map((ceiling) => (
                      <li key={ceiling.agentId}>
                        <Id>{ceiling.agentId}</Id>
                        {Object.entries(ceiling.fields).map(([object, fields]) => (
                          <span key={object} className={styles.mono}>{object}: {fields.join(" · ")}</span>
                        ))}
                      </li>
                    ))}
                  </ul>
                ) : <p className={styles.muted}>{agentId ? "This agent has no ceiling for this product: it does not subscribe to it." : "No agent subscribes to this product."}</p>}
              </InspectorSection>
              <Link to={CONTEXT_PATH} search={{ mode: "engineer", product: productId, ...(agentId ? { agent: agentId } : {}) }}>Field requirements in Engineer</Link>
            </>
          );
        }}
      </Region>
    </div>
  );
}
