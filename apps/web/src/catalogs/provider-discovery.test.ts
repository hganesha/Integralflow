import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { externalProviderIndex, type CatalogSnapshot } from '@ehf/fincrime-views';
import { filterProviderDiscovery, providerResearchIssues } from './provider-discovery';

const snapshot = JSON.parse(readFileSync(new URL('../../../../packages/ui-contracts/vendor/docs/ui/contracts/fixtures/catalogs.json', import.meta.url), 'utf8')) as CatalogSnapshot;
const providers = externalProviderIndex(snapshot, [], null, '2026-11-11T00:00:00Z').items;

it('browses every provider, surfaces core candidates first and preserves each proposed lane', () => {
  const result = filterProviderDiscovery(providers, {});
  expect(result).toHaveLength(376);
  expect(result.slice(0, 29).every(provider => provider.discovery?.priority === 'core')).toBe(true);
  expect(filterProviderDiscovery(providers, { priority: 'specialist' })).toHaveLength(13);
  expect(filterProviderDiscovery(providers, { priority: 'source' })).toHaveLength(88);
  expect(filterProviderDiscovery(providers, { priority: 'discovery' })).toHaveLength(245);
  expect(result.at(-1)?.id).toBe('finantier');
});

it('combines family, collection, name and research filters without discarding source restrictions', () => {
  expect(filterProviderDiscovery(providers, { family: 'lexisnexis-risk-solutions' })).toHaveLength(5);
  expect(filterProviderDiscovery(providers, { term: 'Persona', collection: 'Identity and credentials', priority: 'core' }).map(provider => provider.id)).toEqual(['persona']);
  expect(filterProviderDiscovery(providers, { research: 'not_reviewed' })).toHaveLength(327);
  expect(filterProviderDiscovery(providers, { research: 'correction', term: 'FinCEN' }).map(provider => provider.id)).toEqual(['fincen-boi']);
  const quarantined = filterProviderDiscovery(providers, { term: 'finantier' })[0]!;
  expect(quarantined.quarantined).toBe(true);
  expect(quarantined.capabilities.every(capability => capability.blockers.includes('provider_quarantined'))).toBe(true);
});

it('public research does not clear unresolved scope, coverage or mapping needs', () => {
  const persona = providers.find(provider => provider.id === 'persona')!;
  expect(persona.discovery?.researchState).toBe('public_material_reviewed');
  expect(providerResearchIssues(persona).map(issue => issue.code)).toEqual(['jurisdiction', 'coverage', 'mapping']);
  const before = JSON.stringify(providers);
  filterProviderDiscovery(providers, { priority: 'core' });
  expect(JSON.stringify(providers)).toBe(before);
});
