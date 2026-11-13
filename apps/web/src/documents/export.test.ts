import { expect, it } from "vitest";
import type { Schemas } from "@ehf/ui-contracts";
import { extractionCsv, extractionExport } from "./export";
it("exports original assertions, correction provenance and inert spreadsheet cells", () => {
  const detail = { document: { documentVersion: "source-hash" }, assertions: [{ objectId: "a", versionId: "v1", field: "name", value: '=HYPERLINK("https://example.test")', spans: [{ page: 1, start: 0, end: 7, quote: "source" }], review: { outcome: "CORRECTED", correctedValue: "Human value", actor: "reviewer" } }], conflicts: [], caseSequence: 12 } as unknown as Schemas["CaseDocumentDetail"];
  const csv = extractionCsv(detail);
  expect(csv).toContain('"\'=HYPERLINK(""https://example.test"")"');
  expect(csv).toContain('"CORRECTED","Human value","source-hash"');
  expect(extractionExport(detail)).toMatchObject({ caseSequence: 12, offsetBasis: "unicode_code_points", epistemicStatus: "EXTRACTED_ASSERTION", assertions: [{ value: detail.assertions[0]!.value, review: { actor: "reviewer" } }] });
});
