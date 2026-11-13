import { usePolled } from "@ehf/ui-client/react";
import { Disclosure } from "@ehf/ui-kit";
import { api } from "../../../../app/api";
import { Freshness, Region } from "../../../../platform/common";
import { StudioFrame } from "../../../../shell/studio-frame";
import styles from "../../agents/agents.module.css";
import { AgentCardTile, CatalogProvenance, StudioHeader } from "../../agents/components";

/** AGT-01 · Workforce Atlas — `/agents`. The admitted catalog's agents as cards (15 s poll). */
export default function WorkforceAtlas() {
  const atlas = usePolled(api, "getFincrimeAgents");
  return (
    <StudioFrame>
      <div className={styles.stack}>
        <StudioHeader
          eyebrow="Process Studio"
          title="Workforce Atlas"
          actions={<Freshness polled={atlas} />}
        >
          {atlas.data ? (
            <CatalogProvenance
              catalogDigest={atlas.data.catalogDigest}
              sourceRelease={atlas.data.sourceRelease}
              extra={(
                <div>
                  <dt>Catalog holds</dt>
                  <dd>
                    {atlas.data.counts.agents} agents · {atlas.data.counts.tasks} tasks · {atlas.data.counts.skills} skills · {atlas.data.counts.contextProducts} context products
                  </dd>
                </div>
              )}
            />
          ) : null}
        </StudioHeader>
        <Region polled={atlas} label="agents">
          {(data) => (
            <section className={styles.section} aria-labelledby="atlas-agents">
              <h2 id="atlas-agents" className="sr-only">Agents</h2>
              {data.agents.length ? (
                <ul className={styles.cards} aria-label="Agents in the admitted catalog">
                  {data.agents.map((card) => <li key={card.agent.id}><AgentCardTile card={card} /></li>)}
                </ul>
              ) : (
                <Disclosure tone="attention" title="The admitted catalog has no agents">
                  Import and release a FinCrime catalog to see its agents here.
                </Disclosure>
              )}
              <p className={styles.note}>
                Readiness is the agent's context subscriptions checked against its ceiling in this catalog; it is not run-time data quality.
                Each card's release chip is the release that admitted this catalog.
              </p>
            </section>
          )}
        </Region>
      </div>
    </StudioFrame>
  );
}
