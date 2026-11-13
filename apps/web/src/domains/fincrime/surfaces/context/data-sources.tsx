import { ConsoleHeader, canUse } from "@ehf/ui-shell";
import { Button, Tabs, InlineMessage } from "@ehf/ui-kit";
import { useNavigate } from "@tanstack/react-router";
import { useSession } from "../../../../app/session";
import { useSearchParam } from "../../../../platform/common";
import ContextSources from "../../../../platform/surfaces/context-sources";
import {
  SourceStatus,
  SourceCalls,
  RefreshHistory,
} from "../../../../platform/surfaces/data-connectors";
import ContextSetup from "./context-setup";
import { ConnectorCatalog } from "../../context/connectors/ConnectorCatalog";
import styles from "../../context/context.module.css";

const TABS = [
  {
    value: "connections",
    label: "Connections",
    requires: ["draft.read", "capability.read"],
  },
  { value: "mappings", label: "Mappings", requires: ["draft.read"] },
  {
    value: "bindings",
    label: "Product bindings",
    requires: ["capability.read"],
  },
  { value: "status", label: "Status", requires: ["draft.read"] },
  { value: "calls", label: "Calls", requires: ["receipt.read"] },
  {
    value: "refresh",
    label: "Refresh",
    requires: ["draft.read", "capability.read"],
  },
] as const;
export default function DataSources() {
  const session = useSession();
  const [raw, setTab] = useSearchParam("tab");
  const [mode, setMode] = useSearchParam("connectionMode");
  const [provider] = useSearchParam("provider");
  const [source] = useSearchParam("source");
  const navigate = useNavigate();
  const visible = TABS.filter((item) => canUse(session, item.requires));
  const tab =
    visible.find((item) => item.value === raw)?.value ?? visible[0]!.value;
  const canSetup = canUse(session, ["draft.read"]);
  const canBind = canUse(session, ["capability.read"]);
  const enterprise = canBind && (mode === "enterprise" || !canSetup);
  const browsing = tab === "connections" && !mode && !provider && !source;
  return (
    <div className={styles.page}>
      <ConsoleHeader
        breadcrumb={[
          { label: "Platform", href: "/platform" },
          { label: "Data sources" },
        ]}
        title="Data sources"
      />
      <p>
        Connect source systems, map canonical records, bind context products and
        inspect acquisition activity.
      </p>
      <Tabs
        label="Data source sections"
        items={visible}
        value={tab}
        onChange={(value) =>
          setTab(value === "connections" ? undefined : value)
        }
        renderPanel={() => (
          <>
            <div hidden={tab !== "connections"}>
              {browsing ? (
                <ConnectorCatalog />
              ) : (
                <Button
                  onClick={() =>
                    void navigate({
                      to: ".",
                      search: (previous: Record<string, unknown>) => {
                        const {
                          connectionMode: _m,
                          provider: _p,
                          source: _s,
                          ...scope
                        } = previous;
                        return scope;
                      },
                    } as never)
                  }
                >
                  Browse connector catalog
                </Button>
              )}
              <div hidden={browsing}>
                <Tabs
                  label="Connection purpose"
                  items={[
                    ...(canSetup
                      ? [
                          {
                            value: "shared",
                            label: "Shared dataset connections",
                          },
                        ]
                      : []),
                    ...(canBind
                      ? [
                          {
                            value: "enterprise",
                            label: "Product source connections",
                          },
                        ]
                      : []),
                  ]}
                  value={enterprise ? "enterprise" : "shared"}
                  onChange={(value) =>
                    setMode(value === "enterprise" ? "enterprise" : undefined)
                  }
                />
                <p>
                  Shared dataset connections support discovery and record
                  mappings. Product source connections supply versioned
                  context-product bindings.
                </p>
              </div>
            </div>
            {canSetup && !browsing ? (
              <div
                hidden={
                  !(
                    tab === "mappings" ||
                    (tab === "connections" && !enterprise)
                  )
                }
              >
                <ContextSetup
                  embedded
                  section={tab === "connections" ? "connections" : "mappings"}
                  onSectionChange={(value) => setTab(value)}
                />
              </div>
            ) : null}
            {tab === "connections" && enterprise && !browsing ? (
              <ContextSources embedded section="connections" />
            ) : null}
            {tab === "bindings" ? (
              <>
                <InlineMessage tone="ok">
                  Product bindings retain their reviewed connection revisions
                  and activation history.
                </InlineMessage>
                <ContextSources embedded section="bindings" />
              </>
            ) : null}
            {tab === "status" ? <SourceStatus /> : null}
            {tab === "calls" ? <SourceCalls /> : null}
            {tab === "refresh" ? (
              <>
                {canSetup ? <RefreshHistory /> : null}
                {canUse(session, ["capability.read"]) ? (
                  <ContextSources embedded section="refresh" />
                ) : null}
              </>
            ) : null}
          </>
        )}
      />
    </div>
  );
}
