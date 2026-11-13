import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { EmptyState, Field, Id, LocalTimestamp, StatusBadge, Table, TextInput } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../app/api";
import { useDecisionOptions } from "../../shell/modules-context";
import { HumanDecisionSheet } from "../../shell/trusted/HumanDecisionSheet";
import { Freshness, Region, useSearchParam } from "../common";
import { HumanWorkCard, inConflict, QueueFlags } from "./operations/HumanWorkCard";
import styles from "./operations/operations.module.css";

type QueueItem = Schemas["HumanQueueItem"];
type SheetState = { mode: "decide" | "resolve"; item: QueueItem } | null;

/**
 * PLT-10 · Human work: the domain-neutral queue over the human-work API. Decisions use the
 * labels of the domain module that owns the item, else the platform's neutral options
 * (Approve · Reject · Return) (§8.5).
 */
export default function HumanWork() {
  const [selected, setSelected] = useSearchParam("item");
  const [caseId, setCaseId] = useSearchParam("case");
  const [sheet, setSheet] = useState<SheetState>(null);
  const decisionOptions = useDecisionOptions();
  const queue = usePolled(api, "getOperationsHumanWork", { query: caseId ? { caseId } : {} });

  return (
    <>
      <ConsoleHeader
        breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "Human work" }]}
        title="Human work"
        meta={<Freshness polled={queue} />}
      />
      <div className={styles.stack}>
        <form className={styles.toolbar} role="search" aria-label="Filter human work" onSubmit={(event) => event.preventDefault()}>
          <div className={styles.grow}>
            <Field label="Case">
              <TextInput mono type="search" value={caseId ?? ""} placeholder="Case id, e.g. KYB-1042" onChange={(event) => setCaseId(event.target.value)} />
            </Field>
          </div>
        </form>
        <Region polled={queue} label="human work">
          {(page) => {
            const current = page.items.find((entry) => entry.workItem.workItemId === selected) ?? page.items[0];
            return (
              <div className={styles.split}>
                <Table<QueueItem>
                  caption="Human work queue"
                  captionHidden
                  rows={page.items}
                  rowKey={(row) => row.workItem.workItemId}
                  stickyFirstColumn
                  empty={<EmptyState icon="hand" title={caseId ? `Nothing is waiting on a person for ${caseId}` : "Nothing is waiting on a person"} headingLevel={2} />}
                  columns={[
                    {
                      key: "objective", header: "Objective", render: (row) => (
                        <button
                          type="button"
                          className={styles.rowButton}
                          aria-current={row === current ? "true" : undefined}
                          onClick={() => setSelected(row.workItem.workItemId)}
                        >
                          {row.workItem.objective}
                        </button>
                      ),
                    },
                    { key: "case", header: "Case", render: (row) => <Link className={styles.nowrap} to={`/platform/cases/${encodeURIComponent(row.workItem.caseId)}` as string}>{row.workItem.caseId}</Link> },
                    { key: "gate", header: "Gate", render: (row) => <Id>{row.workItem.workType}</Id> },
                    { key: "status", header: "Status", render: (row) => inConflict(row)
                      ? <StatusBadge dimension="WorkItemStatus" value={row.workItem.status} label="Conflict" />
                      : <StatusBadge dimension="WorkItemStatus" value={row.workItem.status} humanize /> },
                    { key: "assignees", header: "Claimed by", render: (row) => (row.assignedTo.length ? row.assignedTo.join(", ") : <span className={styles.muted}>Unclaimed</span>) },
                    { key: "approvals", header: "Decisions", align: "end", render: (row) => <span className="num">{row.decisions.length}/{row.requiredApprovals}</span> },
                    { key: "deadline", header: "Deadline", render: (row) => (row.workItem.deadlineAt ? <LocalTimestamp iso={row.workItem.deadlineAt} compact /> : <span className={styles.muted}>None</span>) },
                    { key: "flags", header: "Flags", render: (row) => <QueueFlags item={row} /> },
                  ]}
                />
                {current ? (
                  <HumanWorkCard
                    item={current}
                    onDecide={() => setSheet({ mode: "decide", item: current })}
                    onResolve={() => setSheet({ mode: "resolve", item: current })}
                  />
                ) : (
                  <aside className={styles.inspector} aria-label="Human work item">
                    <p className={styles.muted}>Select an item to see its details.</p>
                  </aside>
                )}
              </div>
            );
          }}
        </Region>
      </div>
      {sheet ? (
        <HumanDecisionSheet
          open
          onClose={() => setSheet(null)}
          mode={sheet.mode}
          item={sheet.item}
          options={sheet.mode === "decide" ? decisionOptions(sheet.item) : null}
          liveItem={queue.data?.items.find((entry) => entry.workItem.workItemId === sheet.item.workItem.workItemId)}
        />
      ) : null}
    </>
  );
}
