import { describe, expect, it } from 'vitest';
import type { PrincipalResolver } from '@ehf/identity';
import { validateResponse } from '@ehf/ui-contracts/validate';
import { buildApp } from './app.js';
import type { Upstream } from './upstream.js';
function appFor(roles: string[], upstream?: Upstream) {
    const principalResolver: PrincipalResolver = { source: 'local', resolve: async () => ({ subjectId: 'reviewer', tenantId: 'tenant_demo', actorType: 'human', roles, source: 'local' }) };
    return buildApp({ principalResolver, ...(upstream ? { upstream } : {}) });
}
describe('authenticated source catalog reads', () => {
    it('serves optional collection filtering while preserving technical-domain links', async () => {
        const app = appFor(['Harness.Reader'], async () => ({ status: 200, body: { items: [] } }));
        try {
            const response = await app.inject('/api/v1/catalogs?kind=external-capabilities&entryType=definition&collection=Identity%20and%20credentials&limit=1');
            expect(response.statusCode).toBe(200);
            expect(validateResponse('getCatalogs', 200, response.json()).valid).toBe(true);
            expect(response.json().total).toBe(12);
            expect(response.json().collectionCounts).toHaveLength(9);
            const legacy = await app.inject('/api/v1/catalogs?kind=external-capabilities&entryType=definition&group=Identity');
            expect(legacy.json().total).toBe(10);
            expect((await app.inject(`/api/v1/catalogs?collection=${'x'.repeat(201)}`)).statusCode).toBe(400);
        } finally { await app.close(); }
    });
    it('serves canonical source definitions with contract-valid pagination and ETags', async () => {
        const app = appFor(['Harness.Author']);
        try {
            const response = await app.inject('/api/v1/catalogs?kind=skills&limit=5');
            expect(response.statusCode).toBe(200);
            expect(validateResponse('getCatalogs', 200, response.json()).valid).toBe(true);
            expect(response.json().total).toBe(232);
            expect(response.json().snapshot.scope).toBe('source_definitions');
            const cached = await app.inject({ url: '/api/v1/catalogs?kind=skills&limit=5', headers: { 'if-none-match': response.headers.etag! } });
            expect(cached.statusCode).toBe(304);
            const detail = await app.inject('/api/v1/catalogs/skills/ownership.ubo.resolve');
            expect(validateResponse('getCatalogsKindEntryId', 200, detail.json()).valid).toBe(true);
            expect(detail.json().relationships.some((link: {
                kind: string;
            }) => link.kind === 'context')).toBe(true);
        }
        finally {
            await app.close();
        }
    });
    it('denies a direct catalog read even when the catalog is hidden in navigation', async () => {
        const app = appFor(['Case.Analyst']);
        try {
            const home = await app.inject('/api/v1/catalogs');
            expect(home.json().boards.map((board: {
                kind: string;
            }) => board.kind)).toEqual(['policies', 'documents', 'products']);
            expect((await app.inject('/api/v1/catalogs?kind=skills')).statusCode).toBe(403);
            expect((await app.inject('/api/v1/catalogs/agents/agent.screening')).statusCode).toBe(403);
        }
        finally {
            await app.close();
        }
    });
    it('requires a principal and returns useful errors for invalid queries and missing definitions', async () => {
        const anonymous = buildApp();
        expect((await anonymous.inject('/api/v1/catalogs')).statusCode).toBe(401);
        await anonymous.close();
        const app = appFor(['Harness.Reader']);
        try {
            expect((await app.inject('/api/v1/catalogs?limit=0')).statusCode).toBe(400);
            expect((await app.inject('/api/v1/catalogs/skills/not-a-skill')).statusCode).toBe(404);
        }
        finally {
            await app.close();
        }
    });
    it('returns a retryable contract error when the canonical source is unavailable', async () => {
        const principalResolver: PrincipalResolver = { source: 'local', resolve: async () => ({ subjectId: 'reviewer', tenantId: 'tenant_demo', actorType: 'human', roles: ['Harness.Reader'], source: 'local' }) };
        const app = buildApp({ principalResolver, catalogSource: () => { throw new Error('Source cannot be loaded'); } });
        try {
            const response = await app.inject('/api/v1/catalogs?kind=context');
            expect(response.statusCode).toBe(503);
            expect(response.json().error).toBe('catalog.source_unavailable');
            expect(response.json().retryable).toBe(true);
            expect(validateResponse('getCatalogs', 503, response.json()).valid).toBe(true);
            expect(response.headers['cache-control']).toBe('no-store');
        }
        finally {
            await app.close();
        }
    });
});
