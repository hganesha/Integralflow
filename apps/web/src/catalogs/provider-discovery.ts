import type { Schemas } from '@ehf/ui-contracts';

type Provider = Schemas['ExternalProviderView'];
export const PROVIDER_PRIORITIES = {
  core: 'Core shortlist', specialist: 'Specialists', discovery: 'Discovery backlog',
  source: 'Sources and networks', quarantined: 'Quarantined',
} as const;
export const RESEARCH_FILTERS = {
  not_reviewed: 'Public research pending', jurisdiction: 'Source jurisdiction unresolved',
  coverage: 'Coverage not established', mapping: 'Native operation mapping missing', correction: 'Semantic review required',
} as const;

export function providerResearchIssues(provider: Provider): Array<{ code: keyof typeof RESEARCH_FILTERS; label: string; count: number }> {
  const capabilities = provider.capabilities;
  const counts = {
    not_reviewed: provider.discovery?.researchState === 'public_material_reviewed' ? 0 : 1,
    jurisdiction: capabilities.filter(capability => capability.jurisdiction === 'unresolved').length,
    coverage: capabilities.filter(capability => !capability.coverageStatus || capability.coverageStatus === 'unknown').length,
    mapping: capabilities.filter(capability => capability.blockers.includes('native_operation_mapping_missing')).length,
    correction: capabilities.filter(capability => capability.blockers.some(blocker => ['semantic_correction_review_required', 'conditional_split_review_required'].includes(blocker))).length,
  };
  return Object.entries(counts).filter(([, count]) => count > 0).map(([code, count]) => ({ code: code as keyof typeof RESEARCH_FILTERS, label: RESEARCH_FILTERS[code as keyof typeof RESEARCH_FILTERS], count }));
}

/** Discovery order never selects a connector or changes readiness. */
export function filterProviderDiscovery(providers: readonly Provider[], query: { term?: string; priority?: string; collection?: string; family?: string; research?: string; queue?: boolean }) {
  const term = (query.term ?? '').trim().toLowerCase();
  const rank = { core: 0, specialist: 1, source: 2, discovery: 3, quarantined: 4 };
  return providers.filter(provider => {
    const discovery = provider.discovery;
    if (query.priority && discovery?.priority !== query.priority) return false;
    if (query.collection && !discovery?.collections.includes(query.collection)) return false;
    if (query.family && (discovery?.familyId ?? provider.id) !== query.family) return false;
    if (query.research || query.queue) {
      const issues = providerResearchIssues(provider);
      if (query.research ? !issues.some(issue => issue.code === query.research) : !issues.length) return false;
    }
    return !term || [provider.id, provider.name, discovery?.familyId ?? '', ...provider.domains, ...(discovery?.collections ?? []),
      ...provider.capabilities.flatMap(capability => [capability.name, capability.id]), ...provider.gatewayBindings.map(binding => binding.capabilityId)]
      .join(' ').toLowerCase().includes(term);
  }).sort((a, b) => {
    const priority = (provider: Provider) => provider.quarantined ? rank.quarantined : rank[provider.discovery?.priority ?? 'discovery'];
    return priority(a) - priority(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}
