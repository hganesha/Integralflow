import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, EmptyState, Field, Id, LocalTimestamp, Select, StatusBadge, Table, TextInput } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { Freshness, Region, useSearchParam } from "../common";
import { CreateCaseSheet } from "./create-case";
import styles from "./operations/operations.module.css";

type CaseSummary = Schemas["CaseSummaryView"];

type CaseStatus = NonNullable<NonNullable<Parameters<typeof api.getCases>[0]>["query"]>["status"];
const STATUSES: ReadonlyArray<NonNullable<CaseStatus>> = ["INTAKE", "VALIDATING", "INVESTIGATING", "SCREENING", "HUMAN_REVIEW", "READY_FOR_DECISION", "QA_REVIEW", "NEEDS_INFORMATION", "SUSPENDED", "APPROVED", "DECLINED", "CLOSED"];

/** PLT-09 · Cases (platform view): every case, domain-neutral. */
export default function Cases() {
  const session = useSession();
  const [query, setQuery] = useSearchParam("query");
  const [status, setStatus] = useSearchParam("status");
  const [creating, setCreating] = useState(false);
  const cases = usePolled(api, "getCases", { query: { ...(query ? { query } : {}), ...(status ? { status: status as NonNullable<CaseStatus> } : {}) } });
  const canCreate = session.actions.includes("case.write");

  return (
    <>
      <ConsoleHeader
        breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "Cases" }]}
        title="Cases"
        meta={<Freshness polled={cases} />}
        actions={canCreate
          ? <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New case</Button>
          : <span className={styles.muted}>Creating cases needs case.write.</span>}
      />
      <div className={styles.stack}>
        <form className={styles.toolbar} role="search" aria-label="Filter cases" onSubmit={(event) => event.preventDefault()}>
          <div className={styles.grow}>
            <Field label="Search">
              <TextInput type="search" value={query ?? ""} placeholder="Case id or external reference" onChange={(event) => setQuery(event.target.value)} />
            </Field>
          </div>
          <Field label="Status">
            <Select value={status ?? ""} onChange={(event) => setStatus(event.target.value)}>
              <option value="">Any status</option>
              {STATUSES.map((value) => <option key={value} value={value}>{value.replace(/_/g, " ").toLowerCase()}</option>)}
            </Select>
          </Field>
        </form>
        <Region polled={cases} label="cases">
          {(page) => (
            <Table<CaseSummary>
              caption="Cases"
              captionHidden
              rows={page.items}
              rowKey={(row) => row.caseId}
              stickyFirstColumn
              empty={<EmptyState title={query || status ? "No cases match these filters" : "No cases yet"} headingLevel={2} />}
              columns={[
                { key: "case", header: "Case", render: (row) => <Link to={`/platform/cases/${encodeURIComponent(row.caseId)}` as string}>{row.caseId}</Link> },
                { key: "ref", header: "External reference", render: (row) => row.externalRef },
                { key: "type", header: "Type", render: (row) => <Id>{row.caseType}</Id> },
                { key: "status", header: "Status", render: (row) => <StatusBadge dimension="KycCaseStatus" value={row.status} humanize /> },
                { key: "jurisdiction", header: "Jurisdiction", render: (row) => row.jurisdiction },
                { key: "seq", header: "Sequence", align: "end", render: (row) => <span className="num">{row.caseSequence}</span> },
                { key: "plan", header: "Plan", render: (row) => <DigestValue value={row.harnessPlanDigest} label="plan digest" /> },
                { key: "updated", header: "Updated", render: (row) => <LocalTimestamp iso={row.updatedAt} compact /> },
              ]}
            />
          )}
        </Region>
      </div>
      {canCreate ? <CreateCaseSheet open={creating} onClose={() => setCreating(false)} /> : null}
    </>
  );
}
