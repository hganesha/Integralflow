import { usePolled } from "@ehf/ui-client/react";
import { Disclosure } from "@ehf/ui-kit";
import { useParams } from "@tanstack/react-router";
import { api } from "../../../../app/api";
import { ApiErrorView } from "../../../../platform/common";
import { CaseFrame } from "../../work/case-frame";
import { RiskAttribution } from "../../work/risk";

/** BIZ-07-AC7 · Risk lens: the decision desk's risk attribution, read-only and full width. */
export default function RiskLens() {
  const { caseId = "" } = useParams({ strict: false }) as { caseId?: string };
  const desk = usePolled(api, "getFincrimeCasesCaseIdDecision", { path: { caseId } });
  return (
    <CaseFrame caseId={caseId} location={{ lens: "risk" }} title="Risk">
      {() => {
        if (desk.data?.risk) return <RiskAttribution risk={desk.data.risk} />;
        if (desk.data || desk.error?.reason === "fincrime.not_available") {
          return <Disclosure tone="info" title="Risk not assessed yet">The risk attribution appears once the risk & EDD stage has scored the case.</Disclosure>;
        }
        return desk.error ? <ApiErrorView error={desk.error} /> : null;
      }}
    </CaseFrame>
  );
}
