import { canUse, ConsoleLayout, type ConsoleNavItem, type DomainModule, type SurfaceRoute } from "@ehf/ui-shell";
import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useSession } from "../app/session";
import { Forbidden } from "./forbidden";
import { StudioContext } from "./studio-frame";
import styles from "./shell.module.css";

export type PlatformNav = ReadonlyArray<{ id: string; label: string; icon: ConsoleNavItem["icon"]; path: string; requires: readonly string[]; authoring?: boolean }>;

/** Guard plus template for one routed surface (§8.2, §8.3). */
export function surfaceComponent(route: SurfaceRoute, context: { platformNav: PlatformNav } | { module: DomainModule }): () => ReactElement {
  function Surface() {
    const session = useSession();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    if (route.authoring && !session.authoringEnabled) return <Forbidden title={route.title} requires={route.requires} authoringDisabled />;
    if (!canUse(session, route.requires)) return <Forbidden title={route.title} requires={route.requires} />;
    const Body = route.component;
    if (route.template === 'Catalog') return <Body />;

    if ("platformNav" in context) {
      const nav: ConsoleNavItem[] = context.platformNav
        .filter((item) => canUse(session, item.requires, item.authoring))
        .map((item) => ({
          id: item.id, label: item.label, icon: item.icon, href: item.path,
          active: item.path === "/platform" ? pathname === "/platform" : pathname === item.path || pathname.startsWith(`${item.path}/`),
        }));
      return (
        <ConsoleLayout
          navTitle="Platform"
          nav={nav}
          pathKey={pathname}
          renderLink={(item, props) => <Link to={item.href} activeOptions={{ exact: item.href === "/platform" }} {...props} />}
        >
          <Body />
        </ConsoleLayout>
      );
    }

    const studio = context.module.studios.find((candidate) => pathname === candidate.route || pathname.startsWith(`${candidate.route}/`));
    const studioRoutes = context.module.routes.filter((candidate) => studio && candidate.path.startsWith(studio.route) && !candidate.path.includes("$") && canUse(session, candidate.requires));
    const orient = studio ? (
      <nav aria-label={studio.label}>
        <div className="t-engraved">{studio.label}</div>
        <ul className={styles.studioNav}>
          {(studio.catalogLinks??[]).filter(link=>canUse(session,link.requires)).map(link=><li key={link.route}><Link to={link.route} className={styles.studioLink}>{link.label}</Link></li>)}
          {(studio.navigation ?? studioRoutes.map(candidate=>({label:candidate.title,route:candidate.path,requires:candidate.requires,authoring:candidate.authoring}))).filter(item=>canUse(session,item.requires,item.authoring)).map((candidate) => (
            <li key={candidate.route}>
              <Link to={candidate.route} activeOptions={{ exact: false }} className={styles.studioLink}>{candidate.label}</Link>
            </li>
          ))}
        </ul>
      </nav>
    ) : null;
    // Domain surfaces render their own StudioFrame (orient · main · inspector · rail).
    return (
      <StudioContext.Provider value={{ orient, orientLabel: `${studio?.label ?? context.module.label} navigation` }}>
        <Body />
      </StudioContext.Provider>
    );
  }
  Surface.displayName = `Surface(${route.surfaceId} ${route.path})`;
  return Surface;
}
