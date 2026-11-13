import { canUse, landingRoute, type SurfaceRoute } from "@ehf/ui-shell";
import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Navigate } from "@tanstack/react-router";
import { useSession } from "./app/session";
import { MODULES } from "./modules";
import { ANY_READ, PLATFORM_NAV, PLATFORM_ROUTES } from "./platform/routes";
import { AppRoot, RootNotFound } from "./shell/app-root";
import {CATALOG_ROUTES,CATALOG_READ_ACTIONS} from './catalogs/routes';
import { ModulesProvider } from "./shell/modules-context";
import type { Experience } from "./shell/chrome";
import { surfaceComponent, type PlatformNav } from "./shell/surface-frame";

/** Domain studios from registered modules, then the always-present Platform console (§8.1). */
export const EXPERIENCES: readonly Experience[] = [
  ...MODULES.flatMap((module) => module.studios.filter(studio=>studio.id==='work').map((studio) => ({ ...studio, kind: "domain" as const }))),
  {id:'catalogs',label:'Catalogs',icon:'stack',route:'/catalogs',requires:CATALOG_READ_ACTIONS,kind:'platform'},
  ...MODULES.flatMap((module) => module.studios.filter(studio=>studio.id!=='work').map((studio) => ({ ...studio, kind: "domain" as const }))),
  { id: "platform", label: "Platform", icon: "cpu", route: "/platform", requires: ANY_READ, kind: "platform" },
];

const ALL_ROUTES: readonly SurfaceRoute[] = [...CATALOG_ROUTES,...PLATFORM_ROUTES, ...MODULES.flatMap((module) => module.routes)];

const platformNav: PlatformNav = PLATFORM_NAV.map((item) => {
  const route = ALL_ROUTES.find((candidate) => candidate.path === item.path)!;
  return { ...item, requires: route.requires, ...(route.authoring ? { authoring: true } : {}) };
});

const rootRoute = createRootRoute({ component: () => <ModulesProvider value={MODULES}><AppRoot experiences={EXPERIENCES} /></ModulesProvider>, notFoundComponent: RootNotFound });

function Landing() {
  const session = useSession();
  const to = landingRoute(session, (path) => ALL_ROUTES.some((route) => route.path === path && canUse(session, route.requires, route.authoring)));
  return <Navigate to={to} replace />;
}

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Landing });
const aboutRoute = createRoute({ getParentRoute: () => rootRoute, path: "/about", component: lazyRouteComponent(() => import("./shell/about")) });
const surfaceRoutes = [
  ...CATALOG_ROUTES.map(route=>createRoute({getParentRoute:()=>rootRoute,path:route.path,component:surfaceComponent(route,{platformNav})})),
  ...PLATFORM_ROUTES.map((route) => createRoute({ getParentRoute: () => rootRoute, path: route.path, component: surfaceComponent(route, { platformNav }) })),
  ...MODULES.flatMap((module) => module.routes.map((route) => createRoute({ getParentRoute: () => rootRoute, path: route.path, component: surfaceComponent(route, route.template === "Console" ? {platformNav} : { module }) }))),
];

export const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, aboutRoute, ...surfaceRoutes]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
