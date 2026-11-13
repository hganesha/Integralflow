import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { catalogEntry, catalogIndex, type CatalogQuery, type CatalogSnapshot } from '@ehf/fincrime-views';
import { actionsForRoles, AuthorizationError, type Principal, type PrincipalResolver } from '@ehf/identity';
import { CATALOG_KINDS, canReadCatalog, type CatalogKind } from '@ehf/ui-contracts';
import { validatorFor } from '@ehf/ui-contracts/validate';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
export type CatalogOptions = {
    resolver: PrincipalResolver;
    loadSnapshot: (request: FastifyRequest, principal: Principal) => CatalogSnapshot | Promise<CatalogSnapshot>;
};
let cached: {
    path: string;
    modified: number;
    size: number;
    snapshot: CatalogSnapshot;
} | undefined;
export function loadCatalogSnapshot(): CatalogSnapshot {
    const path = process.env.CATALOG_SNAPSHOT_PATH ?? fileURLToPath(new URL('../../fincrime-host/docs/ui/contracts/fixtures/catalogs.json', import.meta.url));
    // One descriptor for the freshness check and the read, so they see the same file.
    const fd = openSync(path, 'r');
    try {
        const stat = fstatSync(fd);
        if (cached?.path === path && cached.modified === stat.mtimeMs && cached.size === stat.size)
            return cached.snapshot;
        const snapshot: unknown = JSON.parse(readFileSync(fd, 'utf8'));
        if (!validatorFor('CatalogSnapshot')(snapshot))
            throw new Error('catalog.snapshot_invalid');
        cached = { path, modified: stat.mtimeMs, size: stat.size, snapshot: snapshot as CatalogSnapshot };
        return cached.snapshot;
    } finally { closeSync(fd); }
}
/** Source catalog with tenant authoring revisions. Execution state and secrets never enter the snapshot.
 * Principal resolution is injected by the same identity boundary as the other services. */
export function registerCatalogRoutes(app: FastifyInstance, options: CatalogOptions) {
    const failure = (request: FastifyRequest, reply: FastifyReply, status: number, error: string, message: string) => reply.code(status).header('cache-control', 'no-store').send({ error, message, status, retryable: status >= 500, correlationId: request.id });
    const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const principal = await options.resolver.resolve(request);
            if (principal.actorType !== 'human') {
                failure(request, reply, 403, 'authorization.interactive_user_required', 'An interactive user is required.');
                return null;
            }
            const actions = [...actionsForRoles(principal.roles)];
            if (!CATALOG_KINDS.some(kind => canReadCatalog(actions, kind))) {
                failure(request, reply, 403, 'authorization.role_missing', 'Your role does not have catalog read access.');
                return null;
            }
            return { actions, principal };
        }
        catch (error) {
            if (error instanceof AuthorizationError) {
                failure(request, reply, error.httpStatus, error.decision.reasonCode, 'Sign in with an account authorized to view this catalog.');
                return null;
            }
            throw error;
        }
    };
    const respond = (request: FastifyRequest, reply: FastifyReply, body: unknown) => {
        const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex')}"`;
        reply.header('etag', etag).header('cache-control', 'private, no-cache').header('x-correlation-id', request.id ?? randomUUID());
        if (request.headers['if-none-match'] === etag)
            return reply.code(304).send();
        return reply.send(body);
    };
    app.get('/api/v1/catalogs', async (request, reply) => {
        const authorized = await authorize(request, reply);
        if (!authorized)
            return;
        const { actions, principal } = authorized;
        const query = request.query as Record<string, string>;
        const kind = query.kind as CatalogKind | undefined;
        if (kind && !CATALOG_KINDS.includes(kind))
            return failure(request, reply, 400, 'catalog.kind_invalid', 'Choose a known catalog.');
        if (kind && !canReadCatalog(actions, kind))
            return failure(request, reply, 403, 'authorization.role_missing', 'Your role does not have access to this catalog.');
        if (query.entryType && !['definition', 'binding', 'field'].includes(query.entryType))
            return failure(request, reply, 400, 'catalog.entry_type_invalid', 'Choose a supported definition type.');
        if ((query.q?.length ?? 0) > 200 || (query.collection?.length ?? 0) > 200 || query.limit !== undefined && (!/^\d+$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 100))
            return failure(request, reply, 400, 'catalog.query_invalid', 'Search and collection filters must be 200 characters or fewer and page size between 1 and 100.');
        if (query.sort && !['name', 'name-desc', 'group'].includes(query.sort))
            return failure(request, reply, 400, 'catalog.sort_invalid', 'Choose a supported sort order.');
        try {
            return respond(request, reply, catalogIndex(await options.loadSnapshot(request, principal), actions, { ...query, ...(query.limit ? { limit: Number(query.limit) } : {}) } as CatalogQuery));
        }
        catch {
            return failure(request, reply, 503, 'catalog.source_unavailable', 'Catalog definitions are temporarily unavailable. Try again shortly.');
        }
    });
    app.get<{
        Params: {
            kind: string;
            entryId: string;
        };
    }>('/api/v1/catalogs/:kind/:entryId', async (request, reply) => {
        const authorized = await authorize(request, reply);
        if (!authorized)
            return;
        const { actions, principal } = authorized;
        const { kind, entryId } = request.params;
        if (!CATALOG_KINDS.includes(kind as CatalogKind))
            return failure(request, reply, 404, 'resource.not_found', 'This catalog does not exist.');
        if (!canReadCatalog(actions, kind as CatalogKind))
            return failure(request, reply, 403, 'authorization.role_missing', 'Your role does not have access to this catalog.');
        try {
            const entry = catalogEntry(await options.loadSnapshot(request, principal), actions, kind as CatalogKind, entryId);
            return entry ? respond(request, reply, entry) : failure(request, reply, 404, 'resource.not_found', 'This definition does not exist in the current source snapshot.');
        }
        catch {
            return failure(request, reply, 503, 'catalog.source_unavailable', 'Catalog definitions are temporarily unavailable. Try again shortly.');
        }
    });
}
