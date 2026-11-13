import { CATALOG_KINDS, canReadCatalog, type CatalogKind, type Schemas } from '@ehf/ui-contracts';
export function catalogInventoryLabel(board: Schemas['CatalogBoard']): string {
    if (board.kind === 'external-capabilities' && board.definitions !== undefined)
        return `${board.definitions} definitions${board.providers !== undefined ? ` · ${board.providers} provider records` : ''}${board.bindings !== undefined ? ` · ${board.bindings} bindings` : ''}`;
    if (board.kind === 'documents' && board.definitions !== undefined)
        return `${board.definitions} types · ${board.fields ?? 0} fields`;
    return `${board.count.toLocaleString()} entries`;
}
export function catalogPath(kind: CatalogKind, id?: string): string {
    return `/catalogs/${kind}${id ? `/${encodeURIComponent(id)}` : ''}`;
}
export function isCatalogKind(value: string | undefined): value is CatalogKind {
    return CATALOG_KINDS.includes(value as CatalogKind);
}
/** Recommendations use granted actions; they never grant access or assume a persona ID. */
export function recommendedCatalogs(actions: readonly string[]): CatalogKind[] {
    const preferred: CatalogKind[] = actions.includes('draft.write') ? ['skills', 'agents', 'context']
        : actions.includes('admin.write') || actions.includes('run.start') ? ['external-capabilities', 'agents', 'policies']
            : actions.includes('event.read') && !actions.includes('case.write') ? ['policies', 'context', 'external-capabilities']
                : ['documents', 'policies', 'agents'];
    return preferred.filter(kind => canReadCatalog(actions, kind));
}
export type SavedCatalogView = {
    name: string;
    q: string;
    group: string;
    status: string;
    sort: string;
    view: 'groups' | 'board' | 'table';
    inventory?: string;
    collection?: string;
    groupBy?: string;
};
/** Browser preferences are untrusted input and contain presentation settings only. */
export function parseSavedViews(value: unknown): SavedCatalogView[] {
    if (!Array.isArray(value))
        return [];
    return value.filter((item): item is SavedCatalogView => Boolean(item) && typeof item === 'object'
        && ['name', 'q', 'group', 'status'].every(key => typeof item[key] === 'string' && item[key].length <= 200)
        && item.name.trim().length > 0 && ['name', 'name-desc', 'group'].includes(item.sort)
        && ['groups', 'board', 'table'].includes(item.view) && (item.inventory === undefined || ['', 'definition', 'binding', 'field'].includes(item.inventory))
        && (item.collection === undefined || typeof item.collection === 'string' && item.collection.length <= 200)
        && (item.groupBy === undefined || ['collection', 'domain'].includes(item.groupBy))).slice(0, 12);
}
