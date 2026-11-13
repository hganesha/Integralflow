import { ApiError } from "@ehf/ui-client";
import { Button, DigestValue, Disclosure, Field, InlineMessage, TextArea, TextInput } from "@ehf/ui-kit";
import { useState } from "react";
import { api } from "../../../../app/api";
import { ApiErrorView, useCommand, useSearchParam } from "../../../../platform/common";
import { StudioFrame } from "../../../../shell/studio-frame";
import { CaseViews } from "../../assurance/case-nav";
import { LedgerStatus, useLedgerVerification } from "../../assurance/ledger";
import styles from "../../assurance/assurance.module.css";

type ExportResult = { digest: string; caseSequence: number };

/** Hand a JSON body to the browser as a file without another request (N1: no fetch here). */
function saveJson(name: string, body: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Package({ caseId }: { caseId: string }) {
  const [purpose, setPurpose] = useState("");
  const generate = useCommand("postCasesCaseIdExports");
  const ledger = useLedgerVerification(caseId, { auto: false });
  const [download, setDownload] = useState<{ state: "idle" | "busy" | "saved"; error: ApiError | null }>({ state: "idle", error: null });
  const result = generate.result as ExportResult | null;
  const digest = result?.digest.replace(/^sha256:/, "");

  const saveExport = async () => {
    if (!digest) return;
    setDownload({ state: "busy", error: null });
    try {
      const response = await api.call("getCasesCaseIdExportsDigestFormat", { path: { caseId, digest, format: "json" } });
      saveJson(`${caseId}-audit-${digest.slice(0, 12)}.json`, response.data);
      setDownload({ state: "saved", error: null });
    } catch (caught) {
      setDownload({ state: "idle", error: caught instanceof ApiError ? caught : null });
      if (!(caught instanceof ApiError)) throw caught;
    }
  };

  return (
    <div className={styles.stack}>
      <section className={styles.panel} aria-labelledby="generate-title">
        <div className={styles.section}>
          <h2 id="generate-title" className={styles.sectionTitle}>Generate an audit export</h2>
          <form
            className={styles.section}
            onSubmit={(event) => {
              event.preventDefault();
              if (!purpose.trim()) return;
              setDownload({ state: "idle", error: null });
              void generate.run({ path: { caseId } });
              void ledger.verify();
            }}
          >
            <Field label="Purpose" hint="Required. Kept on this screen only: the export API does not record a purpose (G11).">
              <TextArea rows={3} value={purpose} onChange={(event) => setPurpose(event.target.value)} required />
            </Field>
            <span className={styles.inline}>
              <Button type="submit" variant="primary" icon="package" busy={generate.busy} disabled={!purpose.trim() || generate.busy}>Generate export</Button>
              {!purpose.trim() ? <span className={styles.small}>State the purpose to generate an export.</span> : null}
            </span>
          </form>
          {generate.error ? <ApiErrorView error={generate.error} title="The export could not be generated" /> : null}
        </div>
      </section>

      {result && digest ? (
        <section className={styles.panel} aria-labelledby="result-title">
          <div className={styles.section}>
            <h2 id="result-title" className={styles.sectionTitle}>Export ready</h2>
            <dl className={styles.counts}>
              <div><dt>Export digest</dt><dd><DigestValue value={result.digest} label="export digest" /></dd></div>
              <div><dt>Case sequence</dt><dd data-testid="export-sequence">{result.caseSequence}</dd></div>
              <div><dt>Purpose</dt><dd>{purpose}</dd></div>
            </dl>
            <span className={styles.inline}>
              <Button icon="download" busy={download.state === "busy"} onClick={() => void saveExport()}>Download JSON</Button>
              {download.state === "saved" ? <InlineMessage tone="ok">Saved the JSON export.</InlineMessage> : null}
            </span>
            {download.error ? <ApiErrorView error={download.error} title="The export could not be downloaded" /> : null}
            <Disclosure tone="info" title="Other formats" code="GAP-111">
              A zip package is not offered by the export API (it serves json, html and pdf), and the client reads JSON responses only, so JSON is the one download here.
            </Disclosure>
            <span className="t-engraved">Ledger verification at export</span>
            <LedgerStatus ledger={ledger} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** ASR-05 · Assurance packages — `/assurance/packages?case=`. */
export default function AssurancePackages() {
  const [caseParam, setCase] = useSearchParam("case");
  const [draft, setDraft] = useState(caseParam ?? "");
  const caseId = caseParam?.trim();

  return (
    <StudioFrame>
      <div className={styles.stack}>
        <header className={styles.header}>
          <div>
            <div className="t-engraved">ASR-05 · Assurance</div>
            <h1 className={styles.title}>Assurance packages</h1>
          </div>
          {caseId ? <CaseViews caseId={caseId} current="packages" /> : null}
        </header>
        <form className={styles.form} aria-label="Choose a case" onSubmit={(event) => { event.preventDefault(); setCase(draft.trim() || undefined); }}>
          <Field label="Case ID">
            <TextInput value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="KYB-1042" mono />
          </Field>
          <Button type="submit" disabled={!draft.trim() || draft.trim() === caseId}>Use this case</Button>
        </form>
        {caseId ? <Package key={caseId} caseId={caseId} /> : <p className={styles.muted}>Choose a case to package its audit record.</p>}
      </div>
    </StudioFrame>
  );
}
