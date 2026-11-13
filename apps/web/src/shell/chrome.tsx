import { usePolled } from "@ehf/ui-client/react";
import { Button, Icon, SyntheticPill, type Readiness } from "@ehf/ui-kit";
import { canUse, type Studio } from "@ehf/ui-shell";
import { Link, useRouterState } from "@tanstack/react-router";
import { api } from "../app/api";
import { useSession } from "../app/session";
import brandMark from "../../icons/brand-mark.png";
import styles from "./shell.module.css";
import { ThemeSwitcher } from "./theme-switcher";

function roleLabel(role: string): string {
  return role.replace(/^Harness[. ]/, "Process flow ");
}

export type Experience = Studio & { kind: "domain" | "platform" };

function initials(name: string): string {
  return name.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("");
}

/**
 * P0 chrome (BUILD-SPEC v2 §8.1), application-owned. Every value comes from the session or
 * /v1/system; nothing about environment, mode or build is hard-coded (Shell AC1).
 */
export function Chrome({ experiences, onOpenSearch, onSignOut }: { experiences: readonly Experience[]; onOpenSearch: () => void; onSignOut: () => void }) {
  const session = useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const system = usePolled(api, "getSystem", undefined, { enabled: canUse(session, ["capability.read", "telemetry.read", "run.read"]) });
  const readiness: Readiness = system.data?.globalReadiness ?? "Unknown";
  const visible = experiences.filter((experience) => canUse(session, experience.requires));
  const active = visible.find((experience) => pathname === experience.route || pathname.startsWith(`${experience.route}/`));
  const { environment } = session;

  return (
    <header className={styles.chrome}>
      <Link to="/" className={styles.brand} aria-label="IntegralFlow home">
        <img className={styles.brandMark} src={brandMark} alt="" width={42} height={28} />
        IntegralFlow
      </Link>
      <nav aria-label="Experiences" className={styles.switcherNav}>
        <ul className={styles.switcher}>
          {visible.map((experience) => (
            <li key={experience.id}>
              <Link to={experience.route} title={experience.label} activeOptions={{ exact: false }} className={styles.switcherLink} aria-current={experience === active ? "page" : undefined}>
                <Icon name={experience.icon} />
                <span className={styles.switcherLabel}>{experience.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className={styles.spacer} />
      <Button className={styles.searchButton} size="sm" icon="search" onClick={onOpenSearch} aria-keyshortcuts="Control+K Meta+K">
        <span className={styles.searchLabel}>Search</span>
        <span className={styles.kbd} aria-hidden="true">⌘K</span>
      </Button>
      <div className={styles.cluster}>
        {environment.synthetic ? <SyntheticPill detail="All data in this environment is synthetic" /> : null}
        <span className={styles.envChip} title={`Build ${environment.build}`}>
          {environment.name} · {environment.runtimeMode}
        </span>
        <span className={styles.readinessLight} data-state={readiness} role="img" aria-label={`System readiness: ${readiness}`} title={`System readiness: ${readiness}`} />
        <ThemeSwitcher />
        <Link to="/about" className={styles.aboutLink} aria-label="About IntegralFlow" title="About IntegralFlow"><Icon name="info" size="sm" /></Link>
        <span className={styles.identity}>
          <span className={styles.identityName}>{session.subject.displayName}</span>
          <span className={styles.identityRole}>{session.roles[0] ? roleLabel(session.roles[0]) : "No role"}</span>
        </span>
        <span className={styles.avatar} aria-hidden="true">{initials(session.subject.displayName)}</span>
        <details className={styles.accountMenu}><summary aria-label={`Account: ${session.subject.displayName}`}><Icon name="more"/></summary><div><strong>{session.subject.displayName}</strong><span>{session.roles.map(roleLabel).join(' · ')}</span><Link to="/about">About IntegralFlow</Link><Button size="sm" variant="quiet" onClick={event => {
          const menu = event.currentTarget.closest('details');
          if (menu) menu.open = false;
          onSignOut();
        }}>Sign out</Button></div></details>
      </div>
    </header>
  );
}
