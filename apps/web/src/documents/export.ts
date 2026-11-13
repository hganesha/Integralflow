import type { Schemas } from "@ehf/ui-contracts";
type Detail = Schemas["CaseDocumentDetail"];
export function extractionExport(detail: Detail) {
  return { document: detail.document, caseSequence: detail.caseSequence, assertions: detail.assertions, conflicts: detail.conflicts, review: detail.review ?? null, offsetBasis: "unicode_code_points", epistemicStatus: "EXTRACTED_ASSERTION" };
}
export function extractionCsv(detail: Detail) {
  const cell = (value: unknown) => { const text = typeof value === "string" ? value : JSON.stringify(value) ?? ""; return `"${(/^[\s]*[=+\-@\t\r]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`; };
  const rows = [["assertion_id", "assertion_version", "field", "original_value", "review_outcome", "corrected_value", "document_version", "source_spans"], ...detail.assertions.map(assertion => [assertion.objectId, assertion.versionId ?? "", assertion.field, assertion.value, assertion.review?.outcome ?? "PENDING_REVIEW", assertion.review?.correctedValue ?? "", detail.document.documentVersion, assertion.spans])];
  return rows.map(row => row.map(cell).join(",")).join("\r\n");
}
export function downloadFile(name: string, value: string | Blob, mediaType = "application/json") {
  const url = URL.createObjectURL(value instanceof Blob ? value : new Blob([value], { type: mediaType }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name.replace(/[\\/\r\n]/g, "_"); anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
