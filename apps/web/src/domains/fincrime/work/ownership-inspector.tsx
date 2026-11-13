import { Id, ToneBadge } from "@ehf/ui-kit";
import { useSearch } from "@tanstack/react-router";
import { useCaseRead, type CaseRoom } from "./case-reads";
import { EvidenceRefs } from "./evidence";
import { interestText, nodeStanding, percent, type Ownership } from "./ownership-graph";
import { pathInterest, pathsToRoot } from "./ownership-model";
import styles from "./work.module.css";

type Node = Ownership["nodes"][number];
type Edge = Ownership["edges"][number];

const STATUS: Record<Edge["status"], { text: string; tone: "positive" | "blocking" | "attention" | "neutral"; icon: "checkcircle" | "split" | "help" | "eye" }> = {
  verified: { text: "Verified interest", tone: "positive", icon: "checkcircle" },
  conflict: { text: "Conflicting sources", tone: "blocking", icon: "split" },
  unresolved: { text: "Unresolved path", tone: "attention", icon: "help" },
  candidate: { text: "Candidate / asserted", tone: "neutral", icon: "eye" },
};

function Relationship({ edge, other }: { edge: Edge; other: string }) {
  const status = STATUS[edge.status];
  return (
    <li className={styles.row}>
      <span><strong className="num">{edge.kind === "control" ? "Control" : interestText(edge)}</strong> {other}</span>
      <ToneBadge tone={status.tone} icon={status.icon}>{status.text}</ToneBadge>
    </li>
  );
}

function NodeDetail({ view, node, onClear }: { view: Ownership; node: Node; onClear: () => void }) {
  const name = new Map(view.nodes.map((entry) => [entry.id, entry.label]));
  const standing = nodeStanding(node);
  const holds = view.edges.filter((edge) => edge.source === node.id);
  const heldBy = view.edges.filter((edge) => edge.target === node.id);
  const root = view.nodes.find((entry) => entry.isRoot);
  const { paths, circular, truncated } = pathsToRoot(view, node.id);
  const gap = view.gaps.find((entry) => entry.node === node.id);
  return (
    <section aria-labelledby="selected-party" className={styles.humanStep}>
      <div>
        <div className={styles.eyebrow}>Selected party</div>
        <h3 id="selected-party" className={styles.subTitle}>{node.label}</h3>
      </div>
      <dl className={styles.kv}>
        <dt>Type</dt><dd>{node.kind === "person" ? "Person" : "Entity"}{node.isRoot ? " · the customer" : ""}</dd>
        <dt>Standing</dt><dd>{standing.glyph} {standing.text}</dd>
        {node.sublabel ? (<><dt>Detail</dt><dd>{node.sublabel}</dd></>) : null}
      </dl>
      {gap ? <p className={styles.small}><ToneBadge tone="attention" icon="help">Unresolved path</ToneBadge> {gap.reason}</p> : null}
      {holds.length ? (
        <div>
          <div className={styles.eyebrow}>Holds directly</div>
          <ul className={styles.plainList}>{holds.map((edge) => <Relationship key={edge.id} edge={edge} other={`of ${name.get(edge.target) ?? edge.target}`} />)}</ul>
        </div>
      ) : null}
      {heldBy.length ? (
        <div>
          <div className={styles.eyebrow}>Held by</div>
          <ul className={styles.plainList}>{heldBy.map((edge) => <Relationship key={edge.id} edge={edge} other={`by ${name.get(edge.source) ?? edge.source}`} />)}</ul>
        </div>
      ) : null}
      {!node.isRoot && root ? (
        <div>
          <div className={styles.eyebrow}>Interest in {root.label}</div>
          <dl className={styles.kv}>
            <dt>Reported effective interest</dt>
            <dd><strong className="num">{node.effectiveInterest === null || node.effectiveInterest === undefined ? "Unknown" : percent(node.effectiveInterest)}</strong> <span className={styles.muted}>from the ownership projection</span></dd>
          </dl>
          {paths.length ? (
            <ol className={styles.plainList} aria-label="Paths to the customer">
              {paths.map((path) => {
                const result = pathInterest(path);
                const route = [node.label, ...path.map((edge) => name.get(edge.target) ?? edge.target)].join(" → ");
                return (
                  <li key={path.map((edge) => edge.id).join(">")}>
                    <span>{route}</span><br />
                    {result.state === "calculated" ? (
                      path.length === 1
                        ? <span>Direct interest: <strong className="num">{percent(result.value)}</strong></span>
                        : <span>Calculated indirect economic interest: <span className="num">{result.terms.map(percent).join(" × ")} = <strong>{percent(result.value)}</strong></span></span>
                    ) : <span><strong>Unable to determine.</strong> {result.reason}</span>}
                  </li>
                );
              })}
            </ol>
          ) : <p className={styles.muted}>No recorded path connects this party to the customer.</p>}
          {circular ? <p className={styles.muted}>A circular holding was found; paths stop where they would repeat a party, and no total is calculated across it.</p> : null}
          {truncated ? <p className={styles.muted}>More paths exist than are listed here.</p> : null}
          <p className={styles.muted}>
            Threshold {view.threshold === null ? "not reported" : percent(view.threshold)}. A percentage alone does not establish a beneficial owner; control and the applicable policy decide that.
          </p>
        </div>
      ) : null}
      <div className={styles.actions}><button type="button" className={styles.textButton} onClick={onClear}>Clear selection</button></div>
    </section>
  );
}

function EdgeDetail({ view, edge, onClear }: { view: Ownership; edge: Edge; onClear: () => void }) {
  const name = new Map(view.nodes.map((entry) => [entry.id, entry.label]));
  const status = STATUS[edge.status];
  return (
    <section aria-labelledby="selected-relationship" className={styles.humanStep}>
      <div>
        <div className={styles.eyebrow}>Selected relationship</div>
        <h3 id="selected-relationship" className={styles.subTitle}>{name.get(edge.source) ?? edge.source} → {name.get(edge.target) ?? edge.target}</h3>
      </div>
      <dl className={styles.kv}>
        <dt>Kind</dt><dd>{edge.kind === "control" ? "Control (carries no percentage)" : "Equity ownership"}</dd>
        <dt>Direct interest</dt>
        <dd className="num">{edge.kind === "control" ? "—" : edge.interest === null ? "Unknown" : interestText(edge)}{edge.status === "conflict" && edge.interestAlternative !== null ? <span className={styles.muted}> (two sources)</span> : null}</dd>
        <dt>Status</dt><dd><ToneBadge tone={status.tone} icon={status.icon}>{status.text}</ToneBadge></dd>
        <dt>Evidence</dt><dd><EvidenceRefs ids={edge.evidenceIds} empty="None cited" /></dd>
        {edge.contradictionId ? (<><dt>Contradiction</dt><dd><Id>{edge.contradictionId}</Id> <span className={styles.muted}>compared below the canvas</span></dd></>) : null}
      </dl>
      <div className={styles.actions}><button type="button" className={styles.textButton} onClick={onClear}>Clear selection</button></div>
    </section>
  );
}

/** The inspector for the ownership workspace: whatever party or relationship is selected. */
export function OwnershipInspector({ caseId, room, onClear }: { caseId: string; room: CaseRoom; onClear: () => void }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const text = (value: unknown) => (value === undefined || value === null || value === "" ? undefined : String(value));
  const nodeId = text(search.node);
  const edgeId = text(search.edge);
  const ownership = useCaseRead("getFincrimeCasesCaseIdOwnership", { path: { caseId }, query: {} }, room.caseSequence, { enabled: Boolean(nodeId || edgeId) });
  const view = ownership.data;
  if (!view) return null;
  const node = nodeId ? view.nodes.find((entry) => entry.id === nodeId) : undefined;
  const edge = edgeId ? view.edges.find((entry) => entry.id === edgeId) : undefined;
  if (node) return <NodeDetail view={view} node={node} onClear={onClear} />;
  if (edge) return <EdgeDetail view={view} edge={edge} onClear={onClear} />;
  return null;
}
