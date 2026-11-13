import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent } from "react";
import {Button,Disclosure,Sheet,Skeleton,StaleDataBanner,Table,ToneBadge,type Column} from '@ehf/ui-kit';
import {Link, useNavigate, useSearch} from '@tanstack/react-router';
import { DocumentWorkspace } from "./DocumentWorkspace";
import { api } from "../app/api";
import { useSession } from "../app/session";
import styles from './documents.module.css';

/**
 * BIZ-02 documents section (EHF document intelligence): what documentary evidence the case holds,
 * which requirements it covers, and every extracted value on its page. Extracted values are shown as
 * unverified assertions with their exact source spans; presence of a document is never acceptance.
 */
export function CaseDocumentsPage({ caseId }: { caseId: string }) {
  const client = useQueryClient();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const selected = typeof search.document === "string" ? search.document : null;
  const version = typeof search.version === "string" ? search.version : undefined;
  const setSelected = (document: string | null) => void navigate({ search: (previous: Record<string, unknown>) => { const next: Record<string, unknown> = { ...previous, document: document ?? undefined }; for (const key of ["field", "page", "view", "version"]) delete next[key]; return next; } } as never);
  const session = useSession();
  const documents = useQuery({ queryKey: ["documents", caseId], queryFn: () => api.getFincrimeCasesCaseIdDocuments({ path: { caseId } }) });
  const detail = useQuery({
    queryKey: ["document", caseId, selected, version], enabled: Boolean(selected),
    queryFn: ({ signal }) => api.getFincrimeCasesCaseIdDocumentsDocumentId({ path: { caseId, documentId: selected! }, query: { version }, signal }),
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return api.postFincrimeCasesCaseIdDocuments({ path: { caseId }, body: { filename: file.name, mediaType: file.type || "application/octet-stream", contentBase64: btoa(binary) }, idempotencyKey: crypto.randomUUID() });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["documents", caseId] }),
  });
  const canUpload = (session.actions as readonly string[] | undefined)?.includes("evidence.write") ?? false;

  if (documents.isPending) return <Skeleton label="Loading case documents" height={320}/>;
  if (documents.isError&&!documents.data) return <Disclosure tone="attention" title="Documents are unavailable"><p>{documents.error.message}</p><Button onClick={()=>void documents.refetch()}>Try again</Button></Disclosure>;
  const view = documents.data!;
  if (selected && detail.data?.document.documentId === selected) return <DocumentWorkspace key={`${selected}:${detail.data.document.documentVersion}`} caseId={caseId} detail={detail.data} documents={view.documents} stale={detail.isError || documents.isError} onRefresh={() => { void detail.refetch(); void documents.refetch(); }} onClose={() => setSelected(null)}/>;
  const missingRequirements = view.requirements.filter(requirement => !requirement.satisfied).length;
  type Document=typeof view.documents[number];
  const columns:Column<Document>[]=[
    {key:'name',header:'Document',render:document=><div className={styles.documentName}><button type="button" className={styles.documentButton} onClick={()=>setSelected(document.documentId)}>{document.filename??document.documentId}</button>{document.synthetic?<span className={styles.muted}>Synthetic evidence</span>:null}</div>},
    {key:'type',header:'Document type',render:document=>document.documentType?<Link to={'/catalogs/documents' as string} search={{selected:document.documentType}}>{document.documentType.replaceAll('_',' ')}</Link>:'Unclassified'},
    {key:'review',header:'Extraction',render:document=><ToneBadge tone="attention" icon="eye">{document.extractionStatus.replaceAll('_',' ').toLowerCase()}</ToneBadge>},
    {key:'validity',header:'Validity',render:document=>document.validity??'Not assessed'},
    {key:'fields',header:'To review',render:document=>`${document.reviewPending} of ${document.assertionCount}`},
    {key:'conflicts',header:'Conflicts',render:document=>document.conflicts},
  ];
  return (
    <div aria-label="Case documents" className={styles.page}>
      {documents.isError?<StaleDataBanner lastValidAt={new Date(documents.dataUpdatedAt).toISOString()} reason="The latest document update could not be loaded." onRetry={()=>void documents.refetch()}/>:null}
      <div className={styles.introduction}><p role="note">{view.epistemicNote}</p><Link to={'/catalogs/documents' as string}>Explore document types and field contracts</Link>{missingRequirements ? <a className={styles.missingLink} href="#requirements-title">Review {missingRequirements} missing {missingRequirements === 1 ? 'requirement' : 'requirements'}</a> : null}</div>

      <section aria-labelledby="list-title">
        <h3 id="list-title">Documents</h3>
        <Table caption="Document evidence" captionHidden columns={columns} rows={view.documents} rowKey={document=>document.documentId} empty="No documents have been added to this case."/>
        {canUpload && (
          <label className={styles.upload}>
            <span>Add documentary evidence</span>
            <input type="file" disabled={upload.isPending} onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const file = event.target.files?.[0];
              if (file) upload.mutate(file);
            }} />
          </label>
        )}
        {upload.isSuccess && <p role="status">Uploaded {upload.data.filename}: stored, not yet parsed or reviewed.</p>}
        {upload.isError && <p role="alert">Upload failed: {upload.error.message}</p>}
      </section>

      <section aria-labelledby="requirements-title">
        <h3 id="requirements-title">Documentary requirements</h3>
        <ul className={styles.requirements}>
          {view.requirements.map((requirement) => (
            <li key={requirement.id} data-satisfied={requirement.satisfied}>
              <ToneBadge tone={requirement.satisfied?'neutral':'attention'} icon={requirement.satisfied?'file':'alert'}>{requirement.satisfied ? "Present" : "Missing"}</ToneBadge><div><strong>{requirement.description ?? requirement.id}</strong><span>{requirement.satisfied?`Evidence: ${requirement.satisfiedBy.join(', ')}`:'Accepted document types:'}</span>{!requirement.satisfied?<div className={styles.typeLinks}>{requirement.anyOf.map(type=><Link key={type} to={'/catalogs/documents' as string} search={{selected:type}}>{type.replaceAll('_',' ')}</Link>)}</div>:null}</div>
            </li>
          ))}
        </ul>
        {view.requestTypes.length > 0 && <p className={styles.requestNote}>Document requests are prepared for review and are not sent automatically.</p>}
      </section>

      <Sheet open={Boolean(selected)} onClose={()=>setSelected(null)} title={detail.data?.document.filename??'Review document evidence'} description="Extracted values are assertions. Review the source and its evidence spans before accepting any value.">
        <section aria-label="Document viewer" className={styles.viewer}>
          {detail.isPending && <p>Loading document…</p>}
          {detail.isError && <p role="alert">{detail.error.message}</p>}

        </section>
      </Sheet>
    </div>
  );
}
