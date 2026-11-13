import { ArtifactRevocation } from "./operations/artifact-revocation";
import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, EmptyState, Field, Id, InlineMessage, LocalTimestamp, Sheet, StatusBadge, Table, TextArea } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { useState, type FormEvent } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { offeredTransitions, ReleaseTransitionSheet, transitionVerb, type ReleaseStatus } from "../../shell/trusted/ReleaseTransitionSheet";
import { ApiErrorView, Freshness, Region, useCommand } from "../common";
import styles from "./operations/operations.module.css";

type Release = Schemas["releaseRecord"];
type Target = Exclude<ReleaseStatus, "candidate">;

/** PLT-11 · Releases: the release lifecycle, with every transition in the trusted sheet. */
export default function Releases() {
  const session = useSession();
  const releases = usePolled(api, "getReleases");
  const [sheet, setSheet] = useState<{ release: Release; to: Target } | null>(null);
  const [registering, setRegistering] = useState(false);
  const canRegister = session.actions.includes("release.create");

  return (
    <>
      <ConsoleHeader
        breadcrumb={[{ label: "Process Studio", href: "/studio" }, { label: "Published processes" }]}
        title="Published processes"
        meta={<Freshness polled={releases} />}
        actions={canRegister ? <Button icon="plus" onClick={() => setRegistering(true)}>Register manifest</Button> : null}
      />
      <Region polled={releases} label="releases">
        {(data) => (
          <Table<Release>
            caption="Process releases"
            captionHidden
            rows={data.releases}
            rowKey={(row) => row.releaseId}
            stickyFirstColumn
            empty={<EmptyState icon="send" title="No releases registered" headingLevel={2} />}
            columns={[
              { key: "release", header: "Release", render: (row) => <Id>{row.releaseId}</Id> },
              { key: "status", header: "Status", render: (row) => <StatusBadge dimension="ReleaseStatus" value={row.status} humanize /> },
              { key: "revision", header: "Revision", align: "end", render: (row) => <span className="num">{row.revision}</span> },
              { key: "manifest", header: "Manifest", render: (row) => <DigestValue value={row.manifestDigest} label="manifest digest" /> },
              { key: "reason", header: "Last reason", render: (row) => (row.reasonCode ? <code>{row.reasonCode}</code> : <span className={styles.muted}>—</span>) },
              { key: "updated", header: "Updated", render: (row) => <LocalTimestamp iso={row.updatedAt} compact /> },
              {
                key: "actions", header: "Transitions", render: (row) => {
                  const offered = offeredTransitions(row.status, session.actions);
                  if (!offered.length) return <span className={styles.muted}>{row.status === "revoked" ? "Final" : "None for your role"}</span>;
                  return (
                    <span className={styles.actions}>
                      {offered.map((to) => (
                        <Button key={to} size="sm" onClick={() => setSheet({ release: row, to })} aria-label={`${transitionVerb(to)} ${row.releaseId}`}>
                          {transitionVerb(to)}
                        </Button>
                      ))}
                    </span>
                  );
                },
              },
            ]}
          />
        )}
      </Region>
      <ReleaseActivation releases={releases.data?.releases ?? []} />
      <ArtifactRevocation />
      {sheet ? (
        <ReleaseTransitionSheet
          open
          onClose={() => setSheet(null)}
          release={sheet.release}
          to={sheet.to}
          liveRelease={releases.data?.releases.find((entry) => entry.releaseId === sheet.release.releaseId)}
        />
      ) : null}
      {canRegister ? <RegisterSheet open={registering} onClose={() => setRegistering(false)} /> : null}
    </>
  );
}

function RegisterSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [source, setSource] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const register = useCommand("postReleases", { invalidate: [["getReleases"]] });

  function close() {
    register.reset();
    setParseError(null);
    onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    let manifest: Schemas["releaseManifest"];
    try {
      manifest = JSON.parse(source) as Schemas["releaseManifest"];
    } catch (caught) {
      setParseError(`The manifest isn't valid JSON: ${(caught as Error).message}`);
      return;
    }
    setParseError(null);
    await register.run({ body: { manifest } });
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Register a release manifest"
      description="The platform verifies the manifest signature before it records a candidate release."
      footer={(
        <>
          <Button onClick={close} disabled={register.busy}>{register.state === "confirmed" ? "Close" : "Cancel"}</Button>
          {register.state !== "confirmed"
            ? <Button variant="primary" type="submit" form="register-release" busy={register.busy} disabled={!source.trim() || register.busy}>Register</Button>
            : null}
        </>
      )}
    >
      <form id="register-release" className={styles.form} onSubmit={(event) => void submit(event)}>
        <Field label="Manifest (JSON)" hint="A signed release manifest document." {...(parseError ? { error: parseError } : {})}>
          <TextArea rows={14} value={source} spellCheck={false} onChange={(event) => setSource(event.target.value)} />
        </Field>
        {register.error ? <ApiErrorView error={register.error} title={register.error.message || register.error.reason} /> : null}
        {register.state === "confirmed" && register.result
          ? <InlineMessage tone="ok">Registered {register.result.releaseId} as a candidate at revision {register.result.revision}.</InlineMessage>
          : null}
      </form>
    </Sheet>
  );
}

type Activation = Schemas["ReleaseActivation"];
const KIND: Record<Activation["kind"], string> = { ACTIVATE: "Activated", SCHEDULE: "Scheduled", ROLLBACK: "Rolled back to" };

/**
 * Release activation (phase H): which release is in effect for each process, what is scheduled, the
 * history, and rollback to an earlier release. The server decides; a scheduled release decides nothing
 * before its date, and a superseded or rolled-back one nothing after.
 */
function ReleaseActivation({ releases }: { releases: Release[] }) {
  const session = useSession();
  const activations = usePolled(api, "getReleasesActivations");
  const rollback = useCommand("postReleasesReleaseIdRollback", { invalidate: [["getReleases"], ["getReleasesActivations"]] });
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const canRollBack = session.actions.includes("release.activate");
  const inEffect = new Set(activations.data?.inEffect ?? []);
  // Releases that were in effect once and are not now: active but superseded, or deprecated. A
  // release whose only activations are still to come (scheduled) was never in effect.
  const history = activations.data?.activations ?? [];
  const onlyScheduled = (id: string) => history.some((entry) => entry.releaseId === id) && history.filter((entry) => entry.releaseId === id).every((entry) => Date.parse(entry.effectiveFrom) > Date.now());
  const earlier = releases.filter((release) => !inEffect.has(release.releaseId) && (release.status === "active" || release.status === "deprecated") && !onlyScheduled(release.releaseId));
  const chosen = target || earlier[0]?.releaseId || "";
  const blocked = !canRollBack ? "Your role cannot roll back (needs release.activate)." : !earlier.length ? "No earlier release to return to." : reason.trim().length < 3 ? "Say why you are rolling back." : null;
  return (
    <section aria-labelledby="release-activation-title">
      <h2 id="release-activation-title">Activation</h2>
      <Region polled={activations} label="release activation">
        {(data) => (
          <>
            <dl className={styles.form}>
              <dt>In effect</dt><dd>{data.inEffect.length ? data.inEffect.map((id) => <Id key={id}>{id}</Id>) : "No release is in effect"}</dd>
              <dt>Scheduled</dt><dd>{data.scheduled.length ? data.scheduled.map((entry) => <span key={entry.activationId}><Id>{entry.releaseId}</Id> from <LocalTimestamp iso={entry.effectiveFrom} /></span>) : "Nothing scheduled"}</dd>
            </dl>
            <Table<Activation>
              caption="Release activation history"
              rows={data.activations}
              rowKey={(row) => row.activationId}
              empty={<EmptyState icon="history" title="No release has been activated" headingLevel={3} />}
              columns={[
                { key: "when", header: "Takes effect", render: (row) => <LocalTimestamp iso={row.effectiveFrom} compact /> },
                { key: "what", header: "Change", render: (row) => <span>{KIND[row.kind]} <Id>{row.releaseId}</Id></span> },
                { key: "line", header: "Process", render: (row) => `${row.line} · ${row.environment}` },
                { key: "who", header: "By", render: (row) => row.actor },
                { key: "why", header: "Reason", render: (row) => row.reason || "—" },
              ]}
            />
          </>
        )}
      </Region>
      <form className={styles.form} onSubmit={(event) => { event.preventDefault(); if (!blocked) void rollback.run({ path: { releaseId: chosen }, body: { reason: reason.trim() } }).then((done) => { if (done) setReason(""); }); }}>
        <Field label="Roll back to">
          <select value={chosen} disabled={!earlier.length} onChange={(event) => setTarget(event.target.value)}>
            {earlier.length ? earlier.map((release) => <option key={release.releaseId} value={release.releaseId}>{release.releaseId}</option>) : <option value="">No earlier release</option>}
          </select>
        </Field>
        <Field label="Why roll back"><TextArea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
        <Button type="submit" icon="history" busy={rollback.busy} disabled={Boolean(blocked) || rollback.busy} title={blocked ?? undefined}>Roll back</Button>
        {rollback.error ? <ApiErrorView error={rollback.error} title="The rollback was refused" /> : null}
        {rollback.state === "confirmed" ? <InlineMessage tone="ok">Rolled back. The other active releases of the process are deprecated.</InlineMessage> : null}
      </form>
    </section>
  );
}
