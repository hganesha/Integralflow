import type { Schemas } from "@ehf/ui-contracts";
import { EpistemicMarker, Id, Table, ToneBadge, type EpistemicKind } from "@ehf/ui-kit";
import { EvidenceRefs } from "./evidence";
import styles from "./work.module.css";

type Fact = Schemas["CaseFact"];
type Actor = Fact["recordedBy"];

const KIND_LABEL: Record<Fact["kind"], string> = {
  claim: "Claim",
  fact: "Fact",
  assumption: "Assumption",
  contradiction: "Contradiction",
  screening_finding: "Screening finding",
  evidence_link: "Evidence link",
};

export function actorText(actor: Actor): string {
  return `${actor.principalId} (${actor.type.toLowerCase()})`;
}

/**
 * The epistemic status of a case statement (BIZ-02-AC3). A contradiction is a kind, not an
 * epistemic status, so it carries its own badge next to the marker.
 */
export function FactStatus({ fact }: { fact: Fact }) {
  return (
    <span className={styles.row}>
      <EpistemicMarker kind={fact.epistemic as EpistemicKind} />
      {fact.kind === "contradiction" ? (
        <ToneBadge tone={fact.status === "open" ? "blocking" : "neutral"} icon="split">Contradiction · {fact.status}</ToneBadge>
      ) : null}
    </span>
  );
}

/** Claims, facts, assumptions and contradictions with who recorded and who accepted them. */
export function ClaimsTable({ items, caption = "Claims and facts" }: { items: readonly Fact[]; caption?: string }) {
  return (
    <Table<Fact>
      caption={caption}
      rows={items}
      rowKey={(row) => row.id}
      empty="No claims recorded yet."
      columns={[
        { key: "kind", header: "Kind", render: (row) => KIND_LABEL[row.kind] },
        { key: "statement", header: "Statement", render: (row) => <span><Id>{row.subjectRef ?? "case"}</Id> · {row.field ?? "—"}: <strong>{row.value ?? "—"}</strong></span> },
        { key: "status", header: "Status", render: (row) => <FactStatus fact={row} /> },
        { key: "evidence", header: "Evidence", render: (row) => <EvidenceRefs ids={row.evidenceIds} /> },
        { key: "recorded", header: "Recorded by", render: (row) => <span>{actorText(row.recordedBy)} <span className={styles.muted}>· seq <span className="num">{row.caseSequence ?? "Not reported"}</span></span></span> },
        { key: "accepted", header: "Accepted by", render: (row) => (row.acceptedBy ? actorText(row.acceptedBy) : <span className={styles.muted}>not accepted</span>) },
      ]}
    />
  );
}
