import { Icon, Tabs } from "@ehf/ui-kit";
import { usePolled } from "@ehf/ui-client/react";
import { ConsoleHeader } from "@ehf/ui-shell";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { Freshness, Region, useSearchParam } from "../common";
import { CapabilitiesTab } from "./admin/capabilities-tab";
import { ChangesTab } from "./admin/changes-tab";
import { useHasDrafts } from "./admin/drafts";
import { ModelsTab } from "./admin/models-tab";
import { ProvidersTab } from "./admin/providers-tab";
import { SettingsTab } from "./admin/settings-tab";
import { styles } from "./admin/shared";

const TABS = ["models", "providers", "capabilities", "settings", "changes"] as const;
type Tab = (typeof TABS)[number];
const CHANGE_LOG_ARGS = { query: { limit: 100 } } as const;

function TabLabel({ label, prefix }: { label: string; prefix: string }) {
  const unsaved = useHasDrafts(`${prefix}:`);
  return <>{label}{unsaved ? <span className={styles.small} aria-label=" (unsaved edits)"> •</span> : null}</>;
}

/** PLT-14 · Administration (ui-specs §5, BUILD-SPEC §10). */
export default function Admin() {
  const session = useSession();
  const [rawTab, setTab] = useSearchParam("tab");
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "models";
  const profiles = usePolled(api, "getAdminModelProfiles");
  const providers = usePolled(api, "getAdminProviders");
  const registry = usePolled(api, "getGatewayRegistry", undefined, { enabled: session.actions.includes("capability.read") });
  const adapters = usePolled(api, "getGatewayAdapters", undefined, { enabled: session.actions.includes("capability.read") });
  const settings = usePolled(api, "getAdminSettings");
  const changes = usePolled(api, "getAdminChangeLog", CHANGE_LOG_ARGS);

  const counts = `${profiles.data?.items.length ?? "…"} profiles · ${providers.data?.items.length ?? "…"} providers · ${registry.data?.items.length ?? "…"} capabilities`;

  const panel = (value: Tab): ReactNode => {
    switch (value) {
      case "models":
        return <Region polled={profiles} label="model profiles">{(page) => <ModelsTab profiles={page.items} providers={providers.data?.items ?? []} />}</Region>;
      case "providers":
        return <Region polled={providers} label="providers">{(page) => <ProvidersTab providers={page.items} />}</Region>;
      case "capabilities":
        return <Region polled={registry} label="capability registry">{(page) => <CapabilitiesTab items={page.items} adapters={adapters.data?.items ?? []} />}</Region>;
      case "settings":
        return <Region polled={settings} label="platform settings">{(page) => <SettingsTab sections={page.items} />}</Region>;
      case "changes":
        return <Region polled={changes} label="change history">{(page) => <ChangesTab changes={page.items} />}</Region>;
    }
  };

  return (
    <div className={styles.page}>
      <ConsoleHeader
        breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "PLT-14" }]}
        title="Administration"
        meta={<span className={styles.muted}>{counts}{session.environment.managedConfiguration ? " · Managed configuration: deployment configuration is read-only" : ""}</span>}
        actions={<Freshness polled={profiles} />}
      />
      <section className={styles.boundary} aria-label="Administration boundary">
        <p>
          <Link to={"/platform/intelligence" as string} className={styles.link}>Open the Intelligence switchboard</Link> to configure reasoning tiers, runtimes, ML inference, Document Intelligence, System 1 Decisions and MCP servers/tools.{" "}
          <strong>Administered platform configuration.</strong> Capability definitions, the model-profile registry, the provider bindings a profile resolves through,
          and the operational knobs each service reads. Saving a profile mints a new revision, because every compiled plan carries the digest of the revision it was compiled against.
          {" "}<Link to={"/platform/intelligence" as string} className={styles.link}>Open the Intelligence switchboard</Link> to configure reasoning tiers, runtimes, ML inference, Document Intelligence and System 1 Decisions.
        </p>
        <p>
          Infrastructure, resource bindings, identity audience, signing trust, images and database topology belong to the environment's own deployment pipeline; Platform.Admin does not grant deployment authority.
          {session.environment.managedConfiguration && session.actions.includes("admin.write") ? <> <a href="/onboarding" className={styles.link}>Open environment setup and deployment</a> to review configuration and request an apply through the scoped operator executor.</> : null}
        </p>
        <p className={styles.callout}><Icon name="lock" size="sm" /> No provider credential passes through this screen. A binding names the environment variable that holds its credential; the capability gateway is the only component that resolves that name to a value.</p>
      </section>
      <Tabs<Tab>
        label="Administration sections"
        value={tab}
        onChange={(next) => setTab(next === "models" ? undefined : next)}
        items={[
          { value: "models", label: <TabLabel label="Model profiles" prefix="models" />, ...(profiles.data ? { count: profiles.data.items.length } : {}) },
          { value: "providers", label: <TabLabel label="Providers" prefix="providers" />, ...(providers.data ? { count: providers.data.items.length } : {}) },
          { value: "capabilities", label: <TabLabel label="Capabilities" prefix="capabilities" />, ...(registry.data ? { count: registry.data.items.length } : {}) },
          { value: "settings", label: <TabLabel label="Platform settings" prefix="settings" /> },
          { value: "changes", label: "Change history", ...(changes.data ? { count: changes.data.items.length } : {}) },
        ]}
        renderPanel={panel}
      />
    </div>
  );
}
