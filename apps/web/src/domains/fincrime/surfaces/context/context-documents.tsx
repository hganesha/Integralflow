import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button, Field, TextInput } from "@ehf/ui-kit";
import { canUse } from "@ehf/ui-shell";
import type { DocumentCitation } from "@ehf/contracts/document-search";
import { api } from "../../../../app/api";
import { useSession } from "../../../../app/session";
import { useSearchParam } from "../../../../platform/common";
import { StudioFrame } from "../../../../shell/studio-frame";
import styles from "../../context/context.module.css";
type Match = {
  citation: DocumentCitation;
  text: string;
  score: number;
  excerpt?: { start: number; end: number };
};
type Search = {
  matches: Match[];
  indexedDocumentCount: number;
  authorizedDocumentCount: number;
  indexComplete: boolean;
  limitations: string[];
};
export default function ContextDocuments() {
  const session = useSession(),
    [caseParam] = useSearchParam("caseId");
  const [caseId, setCaseId] = useState(caseParam ?? ""),
    [purpose, setPurpose] = useState("kyc.review"),
    [subjects, setSubjects] = useState(""),
    [query, setQuery] = useState("");
  const [expected, setExpected] = useState(""),
    [limit, setLimit] = useState("5"),
    [snippet, setSnippet] = useState("500"),
    [budget, setBudget] = useState("4000");
  const [result, setResult] = useState<Search | null>(null),
    [resolved, setResolved] = useState<Match | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const scope = () => ({
    purpose,
    ...(subjects.trim()
      ? {
          subjects: subjects
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : {}),
  });
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Document operation failed.");
    } finally {
      setBusy(false);
    }
  };
  const missing = expected
    .split(",")
    .map((s) => s.trim())
    .filter(
      (id) => id && !result?.matches.some((m) => m.citation.documentId === id),
    );
  return (
    <StudioFrame>
      <div className={styles.page}>
        <header className={styles.header}>
          <div>
            <h1>Document search</h1>
            <p>
              Search captured, authorized page text and inspect exact citations.
            </p>
          </div>
          <Link to={"/context" as string}>Contextboard</Link>
        </header>
        <section className={styles.panel}>
          <h2>Collection and scope</h2>
          <div className={styles.selectorGrid}>
            <Field label="Document collection case ID">
              <TextInput
                value={caseId}
                onChange={(e) => {
                  setCaseId(e.target.value);
                  setResult(null);
                  setResolved(null);
                }}
              />
            </Field>
            <Field label="Permitted purpose">
              <TextInput
                value={purpose}
                onChange={(e) => {
                  setPurpose(e.target.value);
                  setResult(null);
                  setResolved(null);
                }}
              />
            </Field>
            <Field label="Subject IDs (blank uses case subjects)">
              <TextInput
                value={subjects}
                onChange={(e) => {
                  setSubjects(e.target.value);
                  setResult(null);
                  setResolved(null);
                }}
              />
            </Field>
          </div>
          <p>
            The service checks current case permissions, subject links, purpose,
            residency and canonical versions before returning snippets. This
            profile indexes captured uploads; source-backed documents need
            additional source-use authority.
          </p>
          <Button
            disabled={
              busy ||
              !caseId ||
              !purpose ||
              !canUse(session, ["evidence.write"])
            }
            onClick={() =>
              void perform(async () => {
                const value = await api.call(
                  "postContextDocumentsCaseIdIndex",
                  {
                    path: { caseId },
                    body: { ...scope(), rebuildKey: crypto.randomUUID() },
                  },
                );
                const docs = (
                  value.data as unknown as {
                    documents: Array<{ documentId: string; chunks: number }>;
                  }
                ).documents;
                setMessage(
                  `Indexed ${docs.length} documents and ${docs.reduce((n, d) => n + d.chunks, 0)} chunks.`,
                );
                setResult(null);
                setResolved(null);
              })
            }
          >
            Build / refresh index
          </Button>
        </section>
        <section className={styles.panel}>
          <h2>Search and retrieve</h2>
          <div className={styles.selectorGrid}>
            <Field label="Lexical query">
              <TextInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </Field>
            <Field label="Maximum matches">
              <TextInput
                type="number"
                min={1}
                max={20}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            </Field>
            <Field label="Excerpt characters">
              <TextInput
                type="number"
                min={80}
                max={1600}
                value={snippet}
                onChange={(e) => setSnippet(e.target.value)}
              />
            </Field>
            <Field label="Context character budget">
              <TextInput
                type="number"
                min={100}
                max={16000}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </Field>
            <Field label="Expected document IDs (optional test)">
              <TextInput
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
              />
            </Field>
          </div>
          <Button
            disabled={
              busy ||
              !caseId ||
              !purpose ||
              !query ||
              !canUse(session, ["case.read"])
            }
            onClick={() =>
              void perform(async () => {
                setResolved(null);
                setResult(null);
                const response = await api.call(
                  "postContextDocumentsCaseIdSearch",
                  {
                    path: { caseId },
                    body: {
                      ...scope(),
                      query,
                      mode: "lexical",
                      maxResults: Number(limit),
                      snippetChars: Number(snippet),
                      contextBudget: Number(budget),
                    },
                  },
                );
                setResult(response.data as unknown as Search);
              })
            }
          >
            Test retrieval
          </Button>
          {result ? (
            <div aria-live="polite">
              <p>
                {result.matches.length} matches · {result.indexedDocumentCount}{" "}
                / {result.authorizedDocumentCount} authorized documents indexed
                ·{" "}
                {result.indexComplete
                  ? "Index current for this scope"
                  : "Index incomplete or changed; refresh needed"}
              </p>
              {!result.matches.length ? (
                <p>
                  No matching indexed text in the tested scope. This does not
                  establish that a document or risk is absent.
                </p>
              ) : null}
              {missing.length ? (
                <p>
                  Expected documents not returned: {missing.join(", ")}. Check
                  query, scope and index state.
                </p>
              ) : null}
              {result.matches.map((item) => (
                <article
                  key={item.citation.citationId}
                  className={styles.panel}
                >
                  <h3>
                    {item.citation.documentId} · page {item.citation.page}
                  </h3>
                  <p>
                    Untrusted extracted text · coverage:{" "}
                    {item.citation.textCoverage} · relevance{" "}
                    {item.score.toFixed(3)}
                  </p>
                  <blockquote>{item.text}</blockquote>
                  <p>
                    Version {item.citation.documentVersion} · span{" "}
                    {item.excerpt?.start ?? item.citation.start}–
                    {item.excerpt?.end ?? item.citation.end} (Unicode code
                    points)
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const response = await api.call(
                          "postContextDocumentsCaseIdCitationsResolve",
                          {
                            path: { caseId },
                            body: {
                              ...scope(),
                              citationId: item.citation.citationId,
                            },
                          },
                        );
                        setResolved(response.data as unknown as Match);
                      })
                    }
                  >
                    Resolve exact citation
                  </Button>
                  <Button
                    disabled={busy || !canUse(session, ["evidence.write"])}
                    onClick={() =>
                      void perform(async () => {
                        await api.call(
                          "deleteContextDocumentsCaseIdIndexDocumentId",
                          {
                            path: {
                              caseId,
                              documentId: item.citation.documentId,
                            },
                            body: scope(),
                          },
                        );
                        setResult(null);
                        setResolved(null);
                        setMessage(
                          "Derived text withdrawn; captured evidence remains under its retention policy.",
                        );
                      })
                    }
                  >
                    Withdraw from index
                  </Button>
                </article>
              ))}
              {result.limitations.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          ) : null}
        </section>
        {resolved ? (
          <section
            className={styles.panel}
            aria-label="Resolved document citation"
          >
            <h2>Resolved citation</h2>
            <blockquote>{resolved.text}</blockquote>
            <p>{resolved.citation.citationId}</p>
            <p>
              Page {resolved.citation.page}, span {resolved.citation.start}–
              {resolved.citation.end}; generation {resolved.citation.generation}
              . Artifact {resolved.citation.artifactHash}. Chunk{" "}
              {resolved.citation.chunkDigest}.
            </p>
            <p>
              Extraction and retrieval do not verify assertions in this text.
            </p>
          </section>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
      </div>
    </StudioFrame>
  );
}
