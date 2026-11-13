import type { CatalogKind } from '@ehf/ui-contracts';
import type { IconName } from '@ehf/ui-kit';
import metadata from './catalog.generated.json';

const identities: Readonly<Record<string, readonly string[]>> = metadata;
const reported = new Set<string>();
export const CATEGORY_ICONS: Readonly<Record<string, IconName>> = {
  AML:'shield', Alert:'bell', Case:'inbox', Decision:'gavel', Document:'copy', EDD:'searchcheck',
  Entity:'building', Evidence:'file', Fraud:'scan', Investigation:'search', Monitoring:'activity',
  Network:'graph', Ownership:'branch', Party:'users', Quality:'checkcircle', Registry:'database',
  Regulatory:'scale', Risk:'gauge', Screening:'shieldcheck', Transaction:'swap', Account:'lock',
  Business:'building', Credential:'lock', Crypto:'hash', Financial:'table', Identity:'fingerprint',
  Platform:'cpu', Questionnaire:'file', Reference:'book', 'Travel rule':'globe', Workflow:'workflow',
};
export const CONTEXT_CATEGORY_ICONS: Readonly<Record<string, IconName>> = {
  'Subject intelligence':'users',
  'Sources and evidence':'database',
  Governance:'scale',
};
const CONTEXT_PRODUCT_ICONS: Readonly<Record<string, IconName>> = {
  'identity.intelligence':'fingerprint',
  'ownership.intelligence':'branch',
  party360:'users',
  'network.intelligence':'graph',
  'document.intelligence':'copy',
  'registry.intelligence':'building',
  'screening.intelligence':'shieldcheck',
  'transaction.intelligence':'swap',
  'evidence.intelligence':'file',
  'risk.intelligence':'gauge',
  'case.intelligence':'inbox',
  'policy.intelligence':'book',
};
/** Document families and field sections share the product's outline icon family. */
export const DOCUMENT_CATEGORY_ICONS: Readonly<Record<string, IconName>> = {
  'Address evidence':'pin',
  'Asset realization and investment':'gauge',
  'Bank and account evidence':'lock',
  'Business operations':'building',
  'Certification and translation':'globe',
  'Civil and representative':'users',
  'Commercial and trade':'swap',
  'Constitutional and governance':'book',
  'Digital and verification':'scan',
  'Digital asset provenance':'hash',
  'Digital credentials':'lock',
  'Earnings and benefits':'table',
  'Employment and support':'user',
  'Entity changes':'history',
  'Entity formation':'building',
  Estate:'branch',
  'Financial reporting':'table',
  'Funding and distributions':'swap',
  'Funds and nonprofits':'users',
  'Institutional assessments':'gauge',
  'Institutional controls':'shieldcheck',
  'Insurance evidence':'shield',
  'Legal and regulatory context':'scale',
  'Management and authority':'gavel',
  'Ownership records':'branch',
  'Ownership transactions and control':'graph',
  'Personal identity':'fingerprint',
  'Physical evidence':'eye',
  'Property and occupancy':'building',
  'Relationship and application':'link',
  'Residence and status':'pin',
  'Sector licensing':'checkcircle',
  'Shipping and trade finance':'globe',
  'Tax registration and returns':'table',
  'Tax self certification':'checkcircle',
  'Trust and fiduciary':'scale',
  'US tax forms':'flag',
  'Wealth and EDD declarations':'searchcheck',
  'Addresses and physical presence':'pin',
  'Amounts, accounts and financial position':'table',
  'Authority and signatures':'gavel',
  'Business and expected activity':'activity',
  'Digital credentials and verification results':'scan',
  'Document particulars':'file',
  'Funding and wealth provenance':'branch',
  'Identity and personal particulars':'fingerprint',
  'Legal existence and governance':'building',
  'Occupation and income':'user',
  'Ownership and control':'branch',
  'Parties and capacities':'users',
  'Reviews, findings and decisions':'checkcircle',
  'Sector and institutional controls':'shieldcheck',
  'Tax residence and classifications':'globe',
  'Trade, goods and logistics':'package',
  'Trust and fiduciary arrangements':'scale',
};
const KIND_ICONS: Record<CatalogKind, IconName> = {skills:'grid',agents:'bot',context:'layers','external-capabilities':'link',policies:'book',documents:'copy',products:'package'};
export const categoryLabel = (value: string) => value === 'Monitor' ? 'Monitoring' : value || 'Other';
export function categoryIcon(category: string, kind?: CatalogKind): IconName {
  const icons = kind === 'documents' ? DOCUMENT_CATEGORY_ICONS : kind === 'context' ? CONTEXT_CATEGORY_ICONS : CATEGORY_ICONS;
  return icons[categoryLabel(category)] ?? (category === 'Other' ? 'help' : kind ? KIND_ICONS[kind] : 'help');
}
export function presentationFor(kind: CatalogKind, id: string, fallback?: { title?: string; category?: string }) {
  const entry = identities[`${kind}:${id}`];
  const sourceCategory = categoryLabel(entry?.[1] ?? fallback?.category ?? 'Other');
  const categorized = kind === 'skills' || kind === 'external-capabilities' || kind === 'documents';
  const icons = kind === 'documents' ? DOCUMENT_CATEGORY_ICONS : CATEGORY_ICONS;
  const category = categorized && !icons[sourceCategory] ? 'Other' : sourceCategory;
  if (import.meta.env?.DEV && categorized && category === 'Other' && !reported.has(id)) {
    reported.add(id);
    console.warn(`Presentation metadata is missing for ${kind}:${id}; retained in Other.`);
  }
  const icon = (kind === 'context' ? CONTEXT_PRODUCT_ICONS[id] : undefined) ?? categoryIcon(category, kind);
  return { id, title: entry?.[0] ?? fallback?.title ?? id, category, icon, known: Boolean(entry) };
}
export function groupByCategory<T>(items: readonly T[], kind: CatalogKind, idOf: (item: T) => string, categoryOf?: (item: T) => string | undefined) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const { category } = presentationFor(kind, idOf(item), { category: categoryOf?.(item) });
    const rows = groups.get(category) ?? [];
    rows.push(item);
    groups.set(category, rows);
  }
  return [...groups].sort(([a],[b]) => a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b))
    .map(([category, rows]) => ({ category, icon: categoryIcon(category, kind), items: rows }));
}
export function entryTypeLabel(type: string) {
  return type === 'binding' ? 'Provider binding' : type === 'field' ? 'Field' : 'Definition';
}
