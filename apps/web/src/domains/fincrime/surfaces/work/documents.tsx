import { useParams } from "@tanstack/react-router";
import { CaseDocumentsPage } from "../../../../documents/case-documents-page";
import { CaseFrame } from "../../work/case-frame";

/** BIZ-02 · Documents lens: documentary evidence, requirements and span-bound extracted values. */
export default function DocumentsLens() {
  const { caseId = "" } = useParams({ strict: false }) as { caseId?: string };
  return (
    <CaseFrame caseId={caseId} location={{ lens: "documents" }} title="Documents">
      {() => <CaseDocumentsPage caseId={caseId} />}
    </CaseFrame>
  );
}
