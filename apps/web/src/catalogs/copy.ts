import type { CatalogKind } from '@ehf/ui-contracts';
import type { IconName } from '@ehf/ui-kit';
/** Editorial copy is separate from rendering and canonical IDs. Change labels here without
 * changing route identity, permissions, source contracts or saved links. */
export const CATALOG_COPY: Record<CatalogKind, {
    title: string;
    singular: string;
    icon: IconName;
    description: string;
    question: string;
    groupLabel: string;
}> = {
    context: { title: 'Context', singular: 'Context product', icon: 'layers', description: 'The intelligence your agents can work with.', question: 'Explore products, declared fields and the agents that consume them.', groupLabel: 'Intelligence area' },
    skills: { title: 'Skills', singular: 'Skill', icon: 'grid', description: 'Find the right skill for the work.', question: 'Explore skills by category, with clear outcomes, context requirements and execution guardrails.', groupLabel: 'Skill category' },
    agents: { title: 'Agents', singular: 'Agent', icon: 'bot', description: 'A specialist workforce with clear boundaries.', question: 'Understand each mandate, its tasks, allowed skills and human review gates.', groupLabel: 'Agent type' },
    'external-capabilities': { title: 'External capabilities', singular: 'External capability', icon: 'link', description: 'Understand what external sources can provide.', question: 'Explore capabilities, provider research and source collections. Availability must be proven separately.', groupLabel: 'Capability domain' },
    policies: { title: 'Policies', singular: 'Policy', icon: 'book', description: 'The rules and evidence behind every decision.', question: 'Find decision tables, evidence obligations and the definitions that govern case work.', groupLabel: 'Policy type' },
    documents: { title: 'Documents', singular: 'Document type', icon: 'copy', description: 'Know what to collect and what to extract.', question: 'Explore document types and their field contracts. Collection requirements come from policy.', groupLabel: 'Document family' },
    products: { title: 'Products', singular: 'Product', icon: 'package', description: 'The financial products policy is written for.', question: 'Explore the canonical product taxonomy by domain: classes, types, capabilities and the risk dimensions they expose.', groupLabel: 'Product domain' },
};
export const CATALOG_TEXT = {
    name: 'Catalogs', eyebrow: 'Knowledge and capabilities', title: 'Everything your work is built on.',
    introduction: 'Explore the agents, skills, context and governed definitions behind your workflows.',
    recommendations: 'A good place to start', allCatalogs: 'Explore the catalogs', search: 'Search this catalog',
    emptyTitle: 'No definitions match your filters', emptyDescription: 'Try a different term or clear your filters to explore the full catalog.',
    sourceLabel: 'Source library', sourceNote: 'Definitions describe what is available to configure. They do not establish a published release or runtime readiness.',
    sourceAction: 'About this source', related: 'Related definitions', overview: 'Overview', contract: 'Contract', fields: 'Fields and requirements',
    workspace: 'Open workspace', close: 'Close definition', back: 'Back to results',
} as const;

export function catalogGrouping(kind: CatalogKind, entryType?: string, collections = false) {
    if (kind === 'skills') return {
        title: 'Browse skill categories', description: 'Choose a category to explore the skills your agents can use.',
        allGroups: 'All skill categories', groupLabel: 'Skill category', groupsLabel: 'categories', singular: 'skill', plural: 'skills',
    };
    if (kind === 'documents' && entryType === 'field') return {
        title: 'Browse field sections', description: 'Choose a section to explore its field contracts.',
        allGroups: 'All field sections', groupLabel: 'Field section', groupsLabel: 'sections', singular: 'field', plural: 'fields',
    };
    if (kind === 'documents') return {
        title: 'Browse document families', description: 'Choose a family to explore its document types and extraction contracts.',
        allGroups: 'All document families', groupLabel: 'Document family', groupsLabel: 'families', singular: 'document type', plural: 'document types',
    };
    if (kind === 'products') return {
        title: 'Browse product domains', description: 'Choose a domain to explore its product classes and types.',
        allGroups: 'All product domains', groupLabel: 'Product domain', groupsLabel: 'domains', singular: 'product', plural: 'products',
    };
    if (kind === 'external-capabilities' && collections) return {
        title: 'Browse capability collections', description: 'Explore related capabilities by the work they support. Technical domains remain available as a filter.',
        allGroups: 'All capability collections', groupLabel: 'Capability collection', groupsLabel: 'collections',
        singular: entryType === 'binding' ? 'provider binding' : 'capability', plural: entryType === 'binding' ? 'provider bindings' : 'capabilities',
    };
    if (kind === 'external-capabilities') return {
        title: 'Browse capability domains', description: entryType === 'binding' ? 'Choose a domain to explore the providers bound to its capabilities.' : 'Choose a domain to explore what external sources can provide.',
        allGroups: 'All capability domains', groupLabel: 'Capability domain', groupsLabel: 'domains',
        singular: entryType === 'binding' ? 'provider binding' : 'capability', plural: entryType === 'binding' ? 'provider bindings' : 'capabilities',
    };
    return undefined;
}
