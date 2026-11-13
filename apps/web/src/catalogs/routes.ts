import type { SurfaceRoute } from '@ehf/ui-shell';
import { lazyRouteComponent } from '@tanstack/react-router';
const component = lazyRouteComponent(() => import('./catalog-page'));
export const CATALOG_READ_ACTIONS = ['draft.read', 'capability.read', 'case.read', 'evidence.read'];
export const CATALOG_ROUTES: readonly SurfaceRoute[] = [
    { path: '/catalogs', surfaceId: 'CAT-01', title: 'Catalogs', template: 'Catalog', requires: CATALOG_READ_ACTIONS, component },
    { path: '/catalogs/$kind', surfaceId: 'CAT-02', title: 'Catalog', template: 'Catalog', requires: CATALOG_READ_ACTIONS, component },
    { path: '/catalogs/$kind/$entryId', surfaceId: 'CAT-03', title: 'Catalog definition', template: 'Catalog', requires: CATALOG_READ_ACTIONS, component },
];
