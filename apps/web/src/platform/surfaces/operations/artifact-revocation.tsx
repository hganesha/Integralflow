import { Button, Field, Select, Sheet, TextInput } from "@ehf/ui-kit";
import { useState } from "react";
import { useCommand } from "../../common";
import { Card, CommandFeedback, GatedButton, styles, useAllowed } from "../admin/shared";

/** Revoke exactly one registry artifact; deployment signing keys are not platform artifacts. */
export function ArtifactRevocation() {
  const gate = useAllowed("release.revoke", "Requires release.revoke (process flow operator)");
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("policy-bundle");
  const [digest, setDigest] = useState("");
  const [reason, setReason] = useState("");
  const revoke = useCommand("postRegistryArtifactsKindDigestRevoke", { invalidate: [["getReleases"]] });
  const ready = /^(sha256:)?[a-f0-9]{64}$/.test(digest.trim()) && reason.trim() !== "";
  const onRevoke = async () => {
    const result = await revoke.run({ path: { kind, digest: digest.trim().replace(/^sha256:/, "") }, body: { reasonCode: reason.trim() } });
    if (result) setOpen(false);
  };
  return <Card title="Artifact registry" description="Revoking an artifact withdraws that exact artifact’s authority at its next authority check. Other registry entries retain their status.">
    <GatedButton allowed={gate.allowed} hint={gate.hint} icon="block" onClick={() => { revoke.reset(); setOpen(true); }}>Revoke an artifact…</GatedButton>
    <CommandFeedback state={revoke.state} error={revoke.error} okText={`Artifact ${digest} revoked.`} />
    <Sheet open={open} onClose={() => { if (!revoke.busy) setOpen(false); }} title="Revoke artifact" footer={<div className={styles.row}>
      <Button variant="quiet" disabled={revoke.busy} onClick={() => setOpen(false)}>Cancel</Button>
      <Button variant="primary" icon="block" busy={revoke.busy} disabled={!ready || revoke.busy} onClick={() => void onRevoke()}>Revoke artifact</Button>
    </div>}>
      <div className={styles.stack}>
        <Field label="Artifact kind"><Select value={kind} disabled={revoke.busy} onChange={event => setKind(event.target.value)}>{["policy-bundle", "release-manifest", "skill-bundle", "skill-qualification", "source-policy", "source-binding", "source-access", "source-context", "document-model-release"].map(value => <option key={value} value={value}>{value}</option>)}</Select></Field>
        <Field label="Artifact digest"><TextInput mono value={digest} disabled={revoke.busy} onChange={event => setDigest(event.target.value)} /></Field>
        <Field label="Reason code (required)"><TextInput value={reason} disabled={revoke.busy} maxLength={500} onChange={event => setReason(event.target.value)} /></Field>
        {revoke.state === "failed" ? <CommandFeedback state={revoke.state} error={revoke.error} okText="" /> : null}
      </div>
    </Sheet>
  </Card>;
}
