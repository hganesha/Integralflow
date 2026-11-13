import { describe, expect, it } from 'vitest';
import { catalogPath, recommendedCatalogs, parseSavedViews } from './model';
describe('catalog navigation', () => {
    it('preserves provider binding identifiers in permanent links', () => {
        expect(catalogPath('external-capabilities', 'binding:a/b:v1')).toBe('/catalogs/external-capabilities/binding%3Aa%2Fb%3Av1');
    });
    it('recommends only catalogs granted to each role', () => {
        expect(recommendedCatalogs(['case.read', 'evidence.read', 'case.write'])).toEqual(['documents', 'policies']);
        expect(recommendedCatalogs(['draft.write', 'draft.read'])).toEqual(['skills', 'agents', 'context']);
        expect(recommendedCatalogs([])).toEqual([]);
    });
    it('ignores malformed browser preferences', () => {
        expect(parseSavedViews([{ name: 'Broken', view: 'table', q: { secret: 'value' } }])).toEqual([]);
        expect(parseSavedViews({ name: 'Not an array' })).toEqual([]);
    });
});
