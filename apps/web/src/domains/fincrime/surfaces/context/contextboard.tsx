import type { ContextDefinitionRevision } from "@ehf/contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, Id, Tabs } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { api } from "../../../../app/api";
import { Freshness, Region, useSearchParam } from "../../../../platform/common";
import { StudioFrame, useStudioNav } from "../../../../shell/studio-frame";
import { EngineerBoard } from "../../context/Engineer";
import { PlayBoard, ProductInspector } from "../../context/Play";
import { TuneBoard } from "../../context/Tune";
import { CONTEXT_PREVIEW_PATH, CONTEXT_SETUP_PATH, CASE_TRAVERSAL_PATH } from "../../context/links";
import styles from "../../context/context.module.css";

import { OntologyBoard } from "../../context/ontology/OntologyBoard";
import { OntologyInspector } from "../../context/ontology/OntologyInspector";
import { useOntologySelection } from "../../context/ontology/selection";
import ontologyStyles from "../../context/ontology/ontology.module.css";
import { layoutFor } from "../../context/model";

type Mode = "play" | "tune" | "engineer";
const MODES: { value: Mode; label: string }[] = [
  { value: "play", label: "Play" },
  { value: "tune", label: "Tune" },
  { value: "engineer", label: "Engineer" },
];

/**
 * Contextboard (CXT-01 Play · CXT-02 Tune · CXT-03 Engineer) at
 * `/context?agent=&mode=&product=`. Orientation is the consumer perspective: "All agents" or
 * one agent, whose subscriptions restrict the banks.
 */
export default function Contextboard() {
  const [agent, setAgent] = useSearchParam("agent");
  const [modeParam, setMode] = useSearchParam("mode");
  const [product, setProduct] = useSearchParam("product");
  const [draft, setDraft] = useSearchParam("draft");
  const [viewParam, setView] = useSearchParam("view");
  const presentation = viewParam === "banks" || viewParam === "list" ? viewParam : "graph";
  const { selection, select } = useOntologySelection();
  const mode: Mode = MODES.some((entry) => entry.value === modeParam) ? (modeParam as Mode) : "play";
  const agentId = agent ?? null;
  const studioNav = useStudioNav();

  const catalog = usePolled(api, "getFincrimeCatalog");
  const ontology = usePolled(api, "getFincrimeContextOntology", undefined, { enabled: presentation !== "banks" });
  const definitions = usePolled(api, "getContextDefinitions", undefined, { enabled: presentation !== "banks" });
  const products = usePolled(api, "getFincrimeContextProducts");
  const readiness = usePolled(api, "getFincrimeContextReadiness", agentId ? { query: { agentId } } : undefined);
  const productList = products.data ?? [];
  const focusedProduct = product === "all" ? undefined : product ?? "party360";
  const selectedProduct = productList.find((entry) => entry.id === focusedProduct);

  const orient = (
    <div className={styles.orient}>
      {studioNav}
      {presentation !== "banks" && <nav aria-label="Context products">
        <div className="t-engraved">Context products</div>
        <button type="button" className={styles.agentLink} aria-current={product === "all"} onClick={() => setProduct("all")}>Complete ontology<span className={styles.agentMeta}>All canonical object types</span></button>
        {layoutFor(productList.map(p => p.id)).map(bay => <section key={bay.id}>
          <h2 className={styles.bayLabel}>{bay.name}</h2>
          <ul className={styles.agentList}>{bay.banks.map(bank => <li key={bank.productId}><button type="button" className={styles.agentLink} aria-current={focusedProduct === bank.productId} onClick={() => setProduct(bank.productId)}>{bank.name}<span className={styles.agentMeta}>{Object.keys(productList.find(p => p.id === bank.productId)?.objects ?? {}).length} object types</span></button></li>)}</ul>
        </section>)}
      </nav>}
      <nav aria-label="Consumer perspective">
        <div className="t-engraved">Consumers</div>
        <ul className={styles.agentList}>
          <li>
            <button type="button" className={styles.agentLink} aria-current={agentId === null} onClick={() => setAgent(undefined)}>
              All agents
              <span className={styles.agentMeta}>Every subscription</span>
            </button>
          </li>
          {(catalog.data?.agents ?? []).map((entry) => (
            <li key={entry.id}>
              <button type="button" className={styles.agentLink} aria-current={agentId === entry.id} onClick={() => setAgent(entry.id)}>
                <span className={styles.mono}>{entry.id}</span>
                <span className={styles.agentMeta}>{entry.context_products.length} product{entry.context_products.length === 1 ? "" : "s"} subscribed</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );

  return (
    <StudioFrame
      orient={orient}
      labels={{ orient: "Contextboard navigation", inspector: presentation === "banks" ? "Context product inspector" : "Context inspector" }}
      inspector={presentation !== "banks" && ontology.data ? <OntologyInspector view={ontology.data} selection={selection} onSelect={select} agentId={agentId} definitions={definitions.data?.items as unknown as ContextDefinitionRevision[] | undefined} /> : product?<ProductInspector productId={product} agentId={agentId} matrix={readiness.data} product={selectedProduct} draftId={draft} />:undefined}
    >
      <div className={`${styles.page} ${ontologyStyles.boardPage}`}>
        <header className={styles.header}>
          <div>
            <div className="t-engraved">FinCrime context · CXT-01</div>
            <h1 className={styles.title}>Contextboard</h1>
            <Region polled={catalog} label="catalog" skeletonHeight={24}>
              {(data) => (
                <details><summary className={styles.small}>Catalog provenance · {agentId ?? "All agents"}</summary><dl className={styles.meta}>
                  <div><dt>Catalog</dt><dd><DigestValue value={data.catalogDigest} label="catalog digest" /></dd></div>
                  <div><dt>Source release</dt><dd><Id>{data.sourceRelease}</Id></dd></div>
                  <div><dt>Context schema</dt><dd><Id>{data.contextSchemaVersion}</Id></dd></div>
                  <div><dt>Perspective</dt><dd>{agentId ? <Id>{agentId}</Id> : "All agents"}</dd></div>
                </dl></details>
              )}
            </Region>
          </div>
          <div className={styles.row}>
            <Freshness polled={readiness} />
            <Link to={CASE_TRAVERSAL_PATH}>Explore case relationships</Link>
            <Link to={CONTEXT_SETUP_PATH} search={{ ...(focusedProduct ? { product: focusedProduct } : {}), ...(agent ? { agent } : {}), ...(draft ? { draft } : {}) }}>Edit context</Link>
            <Link to={CONTEXT_PREVIEW_PATH} search={agentId ? { agent: agentId } : {}}>Preview context</Link>
          </div>
        </header>
        {mode === "play" && <div className={styles.row} role="group" aria-label="Context presentation">
          <div className={styles.row}>{(["graph", "list", "banks"] as const).map(v => <Button key={v} size="sm" variant={presentation === v ? "primary" : "secondary"} aria-pressed={presentation === v} onClick={() => setView(v === "graph" ? undefined : v)}>{v === "graph" ? "Ontology" : v === "list" ? "Object list" : "Access banks"}</Button>)}</div>
          {presentation !== "banks" && ontology.data ? <span className={styles.small}>Schema {ontology.data.schemaVersion} · {ontology.data.nodes.length} canonical types</span> : null}
        </div>}
        <Tabs
          label="Disclosure level"
          items={MODES}
          value={mode}
          onChange={(next) => setMode(next === "play" ? undefined : next)}
          renderPanel={(current) => {
            if (current === "tune") return <TuneBoard draftId={draft} onDraft={setDraft} product={selectedProduct} />;
            if (current === "engineer") return <EngineerBoard productId={focusedProduct} products={productList} onProduct={setProduct} agentId={agent} draftId={draft} />;
            if (presentation !== "banks") return <Region polled={ontology} label="canonical ontology">{data => <OntologyBoard view={data} productId={focusedProduct} agentId={agentId} presentation={presentation} selection={selection} onSelect={select} />}</Region>;
            return (
              <Region polled={products} label="context products">
                {(list) => (
                  <Region polled={readiness} label="context readiness">
                    {(matrix) => <PlayBoard products={list} matrix={matrix} agentId={agentId} selected={product} onSelect={setProduct} />}
                  </Region>
                )}
              </Region>
            );
          }}
        />
      </div>
    </StudioFrame>
  );
}
