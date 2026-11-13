import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { usePolled } from "@ehf/ui-client/react";
import type { ContextDefinitionRevision } from "@ehf/contracts";
import { Button, Field, Select, Sheet, TextInput } from "@ehf/ui-kit";
import { canUse } from "@ehf/ui-shell";
import { api } from "../../../../app/api";
import { useSession } from "../../../../app/session";
import {
  CONNECTOR_CATALOG,
  connectorSetupSearch,
  latestDefinitions,
  recordProvider,
  type ConnectorDescriptor,
} from "./catalog";
import styles from "./connectors.module.css";

function VendorMark({ connector }: { connector: ConnectorDescriptor }) {
  return (
    <span className={styles.mark} aria-hidden="true" data-vendor={connector.id}>
      {connector.icon ? (
        <img
          src={`/connectors/${connector.icon}.svg`}
          alt=""
          width={32}
          height={32}
        />
      ) : (
        connector.mark
      )}
    </span>
  );
}

export function ConnectorCatalog() {
  const session = useSession();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const canReadProducts = canUse(session, ["capability.read"]);
  const definitions = usePolled(api, "getContextDefinitions", undefined, {
    enabled: canUse(session, ["draft.read"]),
  });
  const products = usePolled(api, "getContextSources", undefined, {
    enabled: canReadProducts,
  });
  const adapters = usePolled(api, "getGatewayAdapters", undefined, {
    enabled: canReadProducts,
  });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All connectors");
  const [view, setView] = useState("cards");
  const [selected, setSelected] = useState<ConnectorDescriptor | null>(null);
  const records = definitions.data
    ? latestDefinitions(
        definitions.data.items as unknown as ContextDefinitionRevision[],
      )
    : undefined;
  const productHeads = new Map<
    string,
    NonNullable<typeof products.data>["connections"][number]
  >();
  for (const c of products.data?.connections ?? [])
    if ((productHeads.get(c.definition.id)?.revision ?? 0) < c.revision)
      productHeads.set(c.definition.id, c);
  const saved = (
    connector: ConnectorDescriptor,
  ):
    | {
        id: string;
        name: string;
        revision: number;
        path: "records" | "product";
      }[]
    | undefined => {
    if (!connector.setup) return undefined;
    const recordConnections = records
      ?.filter((r) => recordProvider(r.definition) === connector.id)
      .map((r) => ({
        id: r.definition.id,
        name: "name" in r.definition ? r.definition.name : r.definition.id,
        revision: r.revision,
        path: "records" as const,
      }));
    const productConnections =
      canReadProducts && products.data
        ? [...productHeads.values()]
            .filter((c) => c.definition.provider === connector.id)
            .map((c) => ({
              id: c.definition.id,
              name: c.definition.name,
              revision: c.revision,
              path: "product" as const,
            }))
        : undefined;
    // PostgreSQL has both legacy product bindings and record mappings. Keep their
    // namespaces visible instead of hiding one inventory behind the default setup path.
    if (connector.id === "postgresql")
      return recordConnections || productConnections
        ? [...(recordConnections ?? []), ...(productConnections ?? [])]
        : undefined;
    return connector.setup.kind === "records"
      ? recordConnections
      : productConnections;
  };
  const countLabel = (connector: ConnectorDescriptor) => {
    if (!connector.setup) return "Not available yet";
    const connections = saved(connector);
    if (!connections) return "Connection inventory unavailable";
    const stale =
      connector.setup.kind === "records"
        ? definitions.state === "stale" ||
          (connector.id === "postgresql" && products.state === "stale")
        : products.state === "stale";
    const partial =
      connector.id === "postgresql" && (!records || !products.data);
    return `${connections.length} saved connection${connections.length === 1 ? "" : "s"}${partial ? " · partial inventory" : stale ? " · cached inventory" : ""}`;
  };
  const openSetup = (connector: ConnectorDescriptor, resourceId?: string) => {
    if (!connector.setup) return;
    const next = connectorSetupSearch(search, connector.setup, resourceId);
    setSelected(null);
    void navigate({
      to: "/platform/data-sources" as string,
      search: next as never,
    });
  };
  const matches = CONNECTOR_CATALOG.filter(
    (c) =>
      (category === "All connectors" ||
        (category === "My connections"
          ? Boolean(saved(c)?.length)
          : c.category === category)) &&
      `${c.name} ${c.category} ${c.summary} ${c.capabilities.join(" ")}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const setupAllowed = (connector: ConnectorDescriptor) =>
    connector.setup?.kind === "product"
      ? canReadProducts && canUse(session, ["admin.write"])
      : canUse(session, ["draft.write"]) &&
        canUse(session, ["integration.connector.write"]);
  const setupVisible = (connector: ConnectorDescriptor) =>
    connector.setup?.kind === "product"
      ? canReadProducts
      : canUse(session, ["draft.read"]);
  const selectedConnections = selected ? saved(selected) : undefined;
  const selectedResources =
    selected?.setup?.kind === "records"
      ? records?.filter((r) => {
          const resource = r.definition;
          return (
            resource.kind === "resource" &&
            selectedConnections?.some(
              (c) => c.path === "records" && c.id === resource.connectionId,
            )
          );
        })
      : undefined;
  return (
    <section
      className={styles.workspace}
      aria-labelledby="connector-catalog-title"
    >
      <header className={styles.header}>
        <div>
          <p className="t-engraved">Connection catalog</p>
          <h2 id="connector-catalog-title">Choose a source connector</h2>
          <p>
            Connect once, reuse across context. Choose a source to see supported
            reads, requirements and saved connections.
          </p>
        </div>
        <span className={styles.count}>
          {CONNECTOR_CATALOG.length} connector types
        </span>
      </header>
      {typeof search.object === "string" ? (
        <p className={styles.scope}>
          Mapping for{" "}
          <strong>
            {search.object}
            {typeof search.field === "string" ? `.${search.field}` : ""}
          </strong>
          {typeof search.product === "string" ? ` · ${search.product}` : ""}
        </p>
      ) : null}
      <div className={styles.toolbar}>
        <Field label="Find a connector">
          <TextInput
            type="search"
            placeholder="Search vendor, technology or capability…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>
        <Field label="Connector category">
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {[
              "All connectors",
              "My connections",
              "CRM & CLM",
              "Databases & warehouses",
              "APIs & events",
            ].map((name) => (
              <option key={name}>{name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Catalog layout">
          <Select value={view} onChange={(e) => setView(e.target.value)}>
            <option value="cards">Cards</option>
            <option value="list">List</option>
          </Select>
        </Field>
      </div>
      <p className={styles.muted} role="status">
        {matches.length} connector{matches.length === 1 ? "" : "s"} shown ·
        Saved configuration does not establish live health or qualification.
      </p>
      <div className={styles.grid} data-layout={view}>
        {matches.map((connector) => (
          <article className={styles.card} key={connector.id}>
            <div className={styles.cardHeading}>
              <VendorMark connector={connector} />
              <div>
                <h3>{connector.name}</h3>
                <span className={styles.muted}>{connector.category}</span>
              </div>
            </div>
            <p>{connector.summary}</p>
            <ul
              className={styles.badges}
              aria-label={`${connector.name} capabilities`}
            >
              {connector.capabilities.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className={styles.cardFooter}>
              <span className={styles.muted}>{countLabel(connector)}</span>
              <Button
                size="sm"
                aria-label={`Explore ${connector.name}`}
                onClick={() => setSelected(connector)}
              >
                View details
              </Button>
            </div>
          </article>
        ))}
      </div>
      {!matches.length ? (
        <div className={styles.empty}>
          <h3>No matching connectors</h3>
          <p>
            Try another vendor or category. My connections includes only
            connections visible in the loaded inventory.
          </p>
          <Button
            onClick={() => {
              setQuery("");
              setCategory("All connectors");
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : null}
      {selected ? (
        <Sheet
          open
          onClose={() => setSelected(null)}
          title={selected.name}
          description={selected.summary}
          footer={
            selected.setup ? (
              <Button
                variant="primary"
                disabled={!setupVisible(selected)}
                onClick={() => openSetup(selected)}
              >
                {setupAllowed(selected) ? "Configure" : "View setup for"}{" "}
                {selected.name}
              </Button>
            ) : (
              <span>Planned · Connection setup is not available yet</span>
            )
          }
        >
          <div className={styles.workspace}>
            <VendorMark connector={selected} />
            <section>
              <h3>Supported experience</h3>
              <ul>
                {selected.capabilities.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <p>
                {selected.setup?.kind === "records"
                  ? "Maps source fields to canonical records for authorized case subjects."
                  : selected.setup
                    ? "Uses versioned product source bindings. This is separate from the complete-record mapping compiler."
                    : "A dedicated adapter and qualification path are required before setup can be enabled."}
              </p>
              {selected.setup?.kind === "records" ? (
                <p>
                  Runtime adapter:{" "}
                  {adapters.data
                    ? adapters.data.items.some(
                        (a) =>
                          a.id ===
                          (selected.setup?.kind === "records"
                            ? selected.setup.adapterId
                            : ""),
                      )
                      ? "enabled in this deployment; qualification still required"
                      : "not enabled in this deployment"
                    : "not checked"}
                  .
                </p>
              ) : selected.setup ? (
                <p>
                  Source access is checked against tenant deployment allowlists
                  during discovery and qualification.
                </p>
              ) : null}
            </section>
            <section>
              <h3>Requirements</h3>
              <ul>
                {selected.prerequisites.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </section>
            <section>
              <h3>Refresh</h3>
              <p>{selected.refresh}</p>
            </section>
            {selected.setup ? (
              <section>
                <h3>Saved connections</h3>
                <p>
                  {countLabel(selected)}. Access checks, qualification and
                  release remain separate.
                </p>
                {selectedConnections?.map((c) => (
                  <div className={styles.saved} key={c.id}>
                    <strong>{c.name}</strong>
                    <span>
                      Revision {c.revision} · {c.id} ·{" "}
                      {c.path === "records"
                        ? "Record mapping connection"
                        : "Product source connection"}
                    </span>
                  </div>
                ))}
                {selectedResources?.length ? (
                  <>
                    <h4>Reuse a saved resource</h4>
                    {selectedResources.map((r) => (
                      <div className={styles.saved} key={r.definition.id}>
                        <span>
                          {r.definition.id} · revision {r.revision}
                        </span>
                        <Button
                          size="sm"
                          onClick={() => openSetup(selected, r.definition.id)}
                        >
                          Use resource {r.definition.id}
                        </Button>
                      </div>
                    ))}
                  </>
                ) : null}
                {selectedConnections?.some((c) => c.path === "product") ? (
                  <Button
                    onClick={() => {
                      setSelected(null);
                      void navigate({
                        to: "/platform/data-sources" as string,
                        search: {
                          ...search,
                          tab: "connections",
                          connectionMode: "enterprise",
                          provider: undefined,
                        } as never,
                      });
                    }}
                  >
                    Manage saved connections
                  </Button>
                ) : null}
                {!setupAllowed(selected) ? (
                  <p>
                    Your role can inspect this connector. Connection changes
                    require the appropriate source administration permissions.
                  </p>
                ) : null}
              </section>
            ) : null}
          </div>
        </Sheet>
      ) : null}
    </section>
  );
}
