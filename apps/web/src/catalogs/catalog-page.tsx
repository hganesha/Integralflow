import { CATALOG_KINDS, canReadCatalog, type CatalogKind, type Schemas } from '@ehf/ui-contracts';
import { usePolled } from '@ehf/ui-client/react';
import { Button, Chip, DigestValue, EmptyState, Field, Icon, Id, InlineMessage, InspectorSection, JsonViewer, SegmentedControl, Select, Sheet, Skeleton, Table, TextInput, ToneBadge, type Column } from '@ehf/ui-kit';
import { Link, Navigate, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../app/api';
import { useSession } from '../app/session';
import { Region } from '../platform/common';
import { Forbidden } from '../shell/forbidden';
import { CATALOG_COPY as copy, CATALOG_TEXT as text, catalogGrouping } from './copy';
import { catalogInventoryLabel, catalogPath, isCatalogKind, recommendedCatalogs, parseSavedViews, type SavedCatalogView } from './model';
import styles from './catalogs.module.css';
import { BindingEditor } from './binding-editor';
import { ExternalProviders } from './external-providers';
import { CategoryHeading, DefinitionLabel, GroupedSection } from '../presentation/components';
import { categoryIcon, categoryLabel, groupByCategory, presentationFor } from '../presentation/model';
const PolicyTree = lazy(() => import('../policies/PolicyTree'));
type Summary = Schemas['CatalogSummary'];
type Index = Schemas['CatalogIndex'];
type Entry = Schemas['CatalogEntry'];
type View = 'groups' | 'board' | 'table';
function useWideInspector() {
    const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1440px)').matches);
    useEffect(() => { const media = window.matchMedia('(min-width: 1440px)'); const change = () => setWide(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
    return wide;
}
function State({ entry }: {
    entry: Summary;
}) {
    const attention = entry.status === 'quarantined' || entry.status === 'disabled';
    return <ToneBadge tone={attention ? 'attention' : 'neutral'} icon={attention ? 'alert' : entry.status.includes('draft') ? 'file' : 'minus'}>{entry.statusLabel}</ToneBadge>;
}
function versionLabel(version: string, compact = false) {
    return version === 'Not versioned' ? 'Version not declared' : `${compact ? 'v' : 'Version '}${version}`;
}
function CatalogNav({ kind, data }: {
    kind?: CatalogKind;
    data?: Index;
}) {
    const session = useSession();
    return <nav aria-label="Catalog navigation" className={styles.navigation}>
    <Link to={'/catalogs' as string} className={styles.homeLink} activeOptions={{ exact: true }}><Icon name="stack"/>{text.name}</Link>
    <div className={styles.navLabel}>Browse by definition</div>
    <ul className={styles.navList}>{CATALOG_KINDS.filter(key => canReadCatalog(session.actions, key)).map(key => <li key={key}>
      <Link to={catalogPath(key)} className={styles.navLink} aria-current={kind === key ? 'page' : undefined}>
        <Icon name={copy[key].icon}/><span className={styles.navIdentity}>{copy[key].title}{data?.boards.find(board=>board.kind===key)?.definitions!==undefined && (key==='documents'||key==='external-capabilities') ? <small>{catalogInventoryLabel(data.boards.find(board=>board.kind===key)!)}</small> : null}</span>
        {key!=='documents' && key!=='external-capabilities' && data?.boards.find(board => board.kind === key) ? <span className={styles.navCount}>{data.boards.find(board => board.kind === key)!.count.toLocaleString()}</span> : null}
      </Link>
    </li>)}</ul>
    <div className={styles.navFoot}><span className="t-engraved">Your workspace</span><Link to={(session.actions.includes('case.read') || session.actions.includes('human_work.read') ? '/work' : session.actions.includes('draft.read') ? '/studio' : '/platform') as string}><Icon name="arrowl"/>Return to your work</Link><p>Explore definitions here. Configure and execute them in their workspace.</p></div>
  </nav>;
}
export default function CatalogPage() {
    const search = useSearch({ strict: false }) as Record<string, unknown>;
    const { kind: rawKind, entryId } = useParams({ strict: false }) as {
        kind?: string;
        entryId?: string;
    };
    const session = useSession();
    if (rawKind && !isCatalogKind(rawKind))
        return <div className={styles.notFound}><EmptyState headingLevel={1} icon="search" title="This catalog does not exist"><Link to={'/catalogs' as string}>Explore the catalogs</Link></EmptyState></div>;
    const kind = isCatalogKind(rawKind) ? rawKind : undefined;
    if (kind && !canReadCatalog(session.actions, kind))
        return <Forbidden title={copy[kind].title} requires={kind === 'documents' ? ['evidence.read'] : kind === 'policies' || kind === 'products' ? ['case.read', 'draft.read'] : kind === 'external-capabilities' ? ['capability.read'] : ['draft.read']}/>;
    const skillId = kind === 'skills' ? entryId || (typeof search.selected === 'string' ? search.selected : undefined) : undefined;
    if (skillId) return <Navigate to={'/studio/skills' as string} search={{ source: skillId } as never} replace />;
    return kind ? <CatalogBoard key={`${kind}:${session.tenant.tenantId}:${session.subject.subjectId}`} kind={kind} entryId={entryId}/> : <CatalogHome />;
}
function CatalogHome() {
    const session = useSession();
    const index = usePolled(api, 'getCatalogs', { query: { limit: 1 } });
    const recommended = (session.navigation?.catalogs ?? recommendedCatalogs(session.actions)).filter(kind => canReadCatalog(session.actions, kind));
    return <div className={styles.layout}><CatalogNav data={index.data}/><div className={styles.main}>
    <header className={styles.landingHeader}><span className="t-engraved">{text.eyebrow}</span><h1>{text.title}</h1><p>{text.introduction}</p></header>
    <Region polled={index} label="catalogs">{data => <>
      <section className={styles.recommendations} aria-labelledby="recommended-heading"><div><span className="t-engraved">For your role</span><h2 id="recommended-heading">{text.recommendations}</h2><p>Shortcuts based on the access granted to your role.</p></div><div className={styles.quickLinks}>{recommended.map(kind => <Link key={kind} to={catalogPath(kind)}><Icon name={copy[kind].icon}/><span>{copy[kind].title}</span><Icon name="arrowr"/></Link>)}</div></section>
      <section aria-labelledby="all-catalogs-heading"><div className={styles.sectionHeading}><h2 id="all-catalogs-heading">{text.allCatalogs}</h2><span>{data.boards.length} catalogs available to you</span></div>
        <ul className={styles.catalogTiles}>
          {data.boards.map(board => {
            const { title, description, icon } = copy[board.kind];
            return <li key={board.kind}>
              <Link to={catalogPath(board.kind)} className={styles.catalogTile}>
                <div className={styles.tileTop}>
                  <span className={styles.tileIcon}><Icon name={icon} size="lg"/></span>
                  <div className={styles.tileCounts}><BoardCount board={board}/></div>
                </div>
                <h3>{title}</h3>
                <p>{description}</p>
                <span className={styles.tileCta}>Explore {title.toLowerCase()}<Icon name="arrowr"/></span>
              </Link>
            </li>;
          })}
        </ul>
      </section><SourceNote data={data}/>
    </>}</Region>
  </div></div>;
}
function BoardCount({ board }: { board: Index['boards'][number] }) {
    if (board.kind === 'external-capabilities' && board.definitions !== undefined) return <>
        <TileCount count={board.definitions} label="capability definitions"/>
        <TileCount count={board.providers ?? 0} label="provider records"/>
        <TileCount count={board.bindings ?? 0} label="provider bindings"/>
    </>;
    if (board.kind === 'documents' && board.definitions !== undefined) return <>
        <TileCount count={board.definitions} label="document types"/>
        <TileCount count={board.fields ?? 0} label="fields"/>
    </>;
    return <TileCount count={board.count} label={board.kind === 'skills' ? 'skills' : 'definitions'}/>;
}
function TileCount({ count, label }: { count: number; label: string }) {
    return <span><strong>{count.toLocaleString()}</strong> {label}</span>;
}
function SourceNote({ data }: {
    data: Index;
}) {
    return <details className={styles.sourceNote}><summary><Icon name="package"/>{text.sourceLabel} · {data.snapshot.sourceRelease}<span>{text.sourceAction}</span></summary><p>{data.snapshot.note}</p><DigestValue value={data.snapshot.digest} label="Catalog snapshot digest"/></details>;
}
function CatalogBoard({ kind, entryId }: {
    kind: CatalogKind;
    entryId?: string;
}) {
    const search = useSearch({ strict: false }) as Record<string, unknown>;
    const navigate = useNavigate();
    const session = useSession();
    const q = String(search.q ?? '').slice(0, 200), group = String(search.group ?? ''), status = String(search.status ?? '');
    const providerView = kind === 'external-capabilities' && ['provider', 'source', 'research'].includes(String(search.inventory)) && !entryId;
    const collection = kind === 'external-capabilities' ? String(search.collection ?? '') : '';
    const collectionMode = kind === 'external-capabilities' && search.groupBy !== 'domain' && (!group || Boolean(collection));
    const displayGroup = (item: Summary) => collectionMode ? item.collection ?? item.group : item.group;
    const displayCounts = (data: Index) => collectionMode ? data.collectionCounts ?? data.groupCounts : data.groupCounts;
    const selected = providerView ? undefined : entryId ?? (typeof search.selected === 'string' ? search.selected : undefined);
    const entryType = kind === 'documents' ? (search.inventory === 'field' ? 'field' : 'definition') : kind === 'external-capabilities' ? (search.inventory === 'binding' ? 'binding' : 'definition') : undefined;
    const bindingView = entryType === 'binding';
    const grouping = catalogGrouping(kind, entryType, collectionMode);
    const sort = search.sort === 'name' || search.sort === 'name-desc' || search.sort === 'group' ? search.sort : grouping ? 'group' : 'name';
    const view: View = search.view === 'table' || search.view === 'board' ? search.view : grouping ? 'groups' : kind === 'skills' ? 'table' : 'board';
    const groupLabel = grouping?.groupLabel ?? copy[kind].groupLabel;
    const [input, setInput] = useState(q);
    const [saveOpen, setSaveOpen] = useState(false), [saveName, setSaveName] = useState('');
    const [message, setMessage] = useState('');
    const saveKey = `ehf:catalog-views:v1:${session.tenant.tenantId}:${session.subject.subjectId}:${kind}`;
    const [saved, setSaved] = useState<SavedCatalogView[]>(() => { try {
        return parseSavedViews(JSON.parse(localStorage.getItem(saveKey) ?? '[]'));
    }
    catch {
        return [];
    } });
    const trigger = useRef<HTMLElement | null>(null);
    const wide = useWideInspector();
    const [debounced, setDebounced] = useState(q);
    useEffect(() => { const timer = setTimeout(() => setDebounced(input.trim()), 180); return () => clearTimeout(timer); }, [input]);
    const update = (patch: Record<string, unknown>, replace = true) => void navigate({ to: catalogPath(kind), replace, search: (previous: Record<string, unknown>) => { const next = { ...previous, ...patch }; for (const key of Object.keys(next))
            if (next[key] === '' || next[key] === undefined || next[key] === null)
                delete next[key]; return next; } } as never);
    useEffect(() => { if (debounced !== q)
        update({ q: debounced, cursor: undefined, selected: undefined }); }, [debounced]);
    useEffect(() => setInput(q), [q]);
    const index = usePolled(api, 'getCatalogs', { query: { kind, ...(entryType ? { entryType } : {}), ...(q ? { q } : {}), ...(group ? { group } : {}), ...(collection ? { collection } : {}), ...(status ? { status } : {}), sort, ...(typeof search.cursor === 'string' ? { cursor: search.cursor } : {}), limit: 30 } }, { enabled: !providerView });
    const detail = usePolled(api, 'getCatalogsKindEntryId', { path: { kind, entryId: selected ?? '' } }, { enabled: Boolean(selected) });
    const open = (id: string) => { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; update({ selected: id }, false); };
    const close = () => { update({ selected: undefined }, true); requestAnimationFrame(() => trigger.current?.focus()); };
    const select = (item: Summary) => kind === 'skills' ? <Link className={styles.objectLink} to={'/studio/skills' as string} search={{ source: item.id } as never}><DefinitionLabel kind={item.kind} id={item.id} title={item.title} category={item.group}/></Link> : <button type="button" className={styles.objectLink} aria-pressed={selected === item.id} onClick={() => open(item.id)}><DefinitionLabel kind={item.kind} id={item.id} title={item.title} category={item.group}/></button>;
    const columns: Column<Summary>[] = [
        { key: 'name', header: bindingView ? 'Provider binding' : 'Definition', render: item => <div className={styles.nameCell}>{select(item)}<span>{item.description}</span></div> },
        { key: 'group', header: groupLabel, render: item => categoryLabel(displayGroup(item)) },
        ...(bindingView ? [{ key: 'jurisdiction', header: 'Jurisdiction', render: (item: Summary) => item.facts.find(fact => fact.label === 'Jurisdiction')?.value ?? 'Not established' }] : []),
        { key: 'status', header: bindingView ? 'Binding status' : 'Definition status', render: item => <State entry={item}/> },
        { key: 'version', header: bindingView ? 'Model version' : 'Version', render: item => <span className={styles.version}>{item.version}</span> },
    ];
    const filtersActive = Boolean(q || group || collection || status);
    const browsingGroups = view === 'groups' && !q && !group && !collection;
    return <div className={`${styles.layout} ${wide && selected ? styles.withInspector : ''}`}><CatalogNav kind={kind} data={index.data}/>
    <div className={styles.main}>
      <header className={styles.boardHeader}><nav aria-label="Breadcrumb"><Link to={'/catalogs' as string}>Catalogs</Link><Icon name="chevr"/><span>{copy[kind].title}</span></nav><div className={styles.headingLine}><div><div className="t-engraved">Definition catalog</div><h1>{copy[kind].title}</h1><p>{copy[kind].question}</p></div><span className={styles.boardIcon}><Icon name={copy[kind].icon} size="lg"/></span></div></header>
      {kind === 'context' ? <div className={styles.inventory}><Link to={'/context/connections' as string} className={styles.workspaceLink}>Edit context · Connections and mappings</Link></div> : null}
      {kind === 'documents' ? <div className={styles.inventory}><SegmentedControl label="Document catalog sections" options={[{ value: 'definition', label: 'Document types' }, { value: 'field', label: 'Field library' }]} value={entryType!} onChange={value => update({ inventory: value, group: undefined, status: undefined, cursor: undefined, selected: undefined })}/></div> : kind === 'external-capabilities' ? <div className={styles.inventory}><SegmentedControl label="External capability sections" options={[{ value: 'definition', label: 'Capability definitions' }, { value: 'binding', label: 'Provider bindings' }, { value: 'provider', label: 'Providers' }, { value: 'source', label: 'Sources and networks' }, { value: 'research', label: 'Research queue' }]} value={providerView ? String(search.inventory) : entryType!} onChange={value => update({ inventory: value, group: undefined, collection: undefined, status: undefined, cursor: undefined, selected: undefined, provider: undefined, providerLane: undefined, providerCollection: undefined, providerResearch: undefined, providerFamily: undefined })}/></div> : null}
      {providerView ? <ExternalProviders key={String(search.inventory)} view={search.inventory === 'source' ? 'source' : search.inventory === 'research' ? 'research' : 'all'}/> : <>
      <div className={styles.toolbar}>
        <div className={styles.searchField}><Icon name="search"/><TextInput aria-label={text.search} placeholder={`Search ${copy[kind].title.toLowerCase()}…`} value={input} maxLength={200} onChange={event => setInput(event.target.value)}/></div>
        {kind === 'external-capabilities' ? <Field label="Browse by"><Select value={collectionMode ? 'collection' : 'domain'} onChange={event => update({ groupBy: event.target.value, group: undefined, collection: undefined, cursor: undefined, selected: undefined })}><option value="collection">Capability collections</option><option value="domain">Technical domains</option></Select></Field> : null}
        <Field label={groupLabel}><Select value={collectionMode ? collection : group} onChange={event => update({ [collectionMode ? 'collection' : 'group']: event.target.value, cursor: undefined, selected: undefined })}><option value="">{grouping?.allGroups ?? 'All groups'}</option>{(collectionMode ? index.data?.collections : index.data?.groups)?.map(value => <option key={value} value={value}>{categoryLabel(value)}</option>)}</Select></Field>
        <Field label="Status"><Select value={status} onChange={event => update({ status: event.target.value, cursor: undefined, selected: undefined })}><option value="">All statuses</option>{index.data?.statuses.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></Field>
      </div>
      <div className={styles.resultsBar}><div className={styles.resultCount} role="status">{index.data ? `${index.data.total.toLocaleString()} ${index.data.total === 1 ? 'entry' : 'entries'}` : 'Loading definitions…'}{filtersActive ? <Button variant="quiet" size="sm" onClick={() => { setInput(''); setDebounced(''); update({ q: undefined, group: undefined, collection: undefined, status: undefined, cursor: undefined }); }}>Clear filters</Button> : null}</div><div className={styles.viewControls}>
        <Select aria-label={browsingGroups ? 'Sort groups' : 'Sort definitions'} value={browsingGroups && sort === 'group' ? 'name' : sort} onChange={event => update({ sort: event.target.value, cursor: undefined })}><option value="name">Name A–Z</option><option value="name-desc">Name Z–A</option>{!browsingGroups ? <option value="group">Group</option> : null}</Select>
        <SegmentedControl label="Catalog view" size="sm" options={[...(grouping ? [{ value: 'groups' as const, label: <><Icon name="layers" size="sm"/>Groups</> }] : []), { value: 'board' as const, label: <><Icon name="grid" size="sm"/>Board</> }, { value: 'table' as const, label: <><Icon name="table" size="sm"/>Table</> }]} value={view} onChange={value => update({ view: value, cursor: undefined })}/>
        <Button variant="quiet" size="sm" icon="flag" onClick={() => setSaveOpen(true)}>Save view</Button>
      </div></div>
      {saved.length ? <div className={styles.savedViews} aria-label="Saved catalog views"><span>Saved on this browser</span>{saved.map(savedView => <span key={savedView.name}><button type="button" onClick={() => { setInput(savedView.q); setDebounced(savedView.q); update({ ...savedView, collection: savedView.collection, groupBy: savedView.groupBy, name: undefined, cursor: undefined, selected: undefined }); }}>{savedView.name}</button><Button size="sm" variant="quiet" icon="x" aria-label={`Remove saved view ${savedView.name}`} onClick={() => { const next = saved.filter(value => value.name !== savedView.name); try {
        localStorage.setItem(saveKey, JSON.stringify(next));
        setSaved(next);
    }
    catch {
        setMessage('Your browser could not update this saved view.');
    } }}/></span>)}</div> : null}
      <p className={styles.message} role="status">{message}</p>
      {(group || collection) && grouping ? <div className={styles.groupBack}><Button variant="quiet" size="sm" icon="arrowl" onClick={() => update({ group: undefined, collection: undefined, cursor: undefined, selected: undefined }, false)}>{grouping.allGroups}</Button></div> : null}
      <Region polled={index} label={`${copy[kind].title.toLowerCase()} definitions`}>{data => <>
        {!data.items.length ? <EmptyState headingLevel={2} icon="search" title={text.emptyTitle}>{text.emptyDescription}</EmptyState> : browsingGroups && grouping ? <GroupDirectory kind={kind} groups={sort === 'name-desc' ? [...displayCounts(data)].reverse() : displayCounts(data)} grouping={grouping} onSelect={name => { update({ [collectionMode ? 'collection' : 'group']: name, cursor: undefined, selected: undefined }, false); window.scrollTo({ top: 0 }); }}/> : <CatalogResults data={data} kind={kind} view={view} columns={columns} select={select} selected={selected} collectionMode={collectionMode}/>}
        {!browsingGroups ? <div className={styles.pagination}><span>Showing {data.items.length} of {data.total.toLocaleString()} matching entries</span><div>{search.cursor ? <Button size="sm" onClick={() => update({ cursor: undefined, selected: undefined })}>Back to first page</Button> : null}<Button size="sm" icon="arrowr" disabled={!data.nextCursor} onClick={() => { update({ cursor: data.nextCursor, selected: undefined }, false); window.scrollTo({ top: 0 }); }}>Next page</Button></div></div> : null}
        <SourceNote data={data}/>
      </>}</Region>
      </>}
    </div>
    {wide && selected ? <aside className={styles.inspector} aria-label={`${copy[kind].singular} inspector`}><div className={styles.inspectorClose}><span className="t-engraved">{bindingView ? 'Provider binding inspector' : 'Definition inspector'}</span><Button icon="x" size="sm" variant="quiet" aria-label={text.close} onClick={close}/></div><Region polled={detail} label="definition">{entry => entry.id === selected ? <EntryDetail key={selected} entry={entry} onClose={close}/> : <Skeleton label="Loading selected definition" height={240}/>}</Region></aside> : null}
    <Sheet open={Boolean(selected) && !wide} title={bindingView ? 'Provider binding details' : `${copy[kind].singular} details`} onClose={close} closeLabel={text.close}><Region polled={detail} label="definition">{entry => entry.id === selected ? <EntryDetail key={selected} entry={entry} onClose={close}/> : <Skeleton label="Loading selected definition" height={240}/>}</Region></Sheet>
    <Sheet open={saveOpen} title="Save this catalog view" description="Save these filters and display preferences on this browser. Saved views are private to your signed-in account." onClose={() => setSaveOpen(false)} footer={<Button variant="primary" disabled={!saveName.trim()} onClick={() => { const next = [...saved.filter(view => view.name !== saveName.trim()), { name: saveName.trim(), q, group, collection, groupBy: collectionMode ? 'collection' : 'domain', status, sort, view, inventory: entryType ?? '' }].slice(-12); try {
        localStorage.setItem(saveKey, JSON.stringify(next));
        setSaved(next);
        setSaveOpen(false);
        setSaveName('');
        setMessage('Catalog view saved on this browser.');
    }
    catch {
        setMessage('Your browser settings prevent saving this view.');
    } }}>Save view</Button>}><Field label="View name"><TextInput data-autofocus maxLength={60} value={saveName} onChange={event => setSaveName(event.target.value)} placeholder="For example, ownership skills"/></Field></Sheet>
  </div>;
}
function GroupDirectory({ kind, groups, grouping, onSelect }: {
    kind: CatalogKind;
    groups: Index['groupCounts'];
    grouping: NonNullable<ReturnType<typeof catalogGrouping>>;
    onSelect: (name: string) => void;
}) {
    return <section aria-labelledby="catalog-groups-heading">
      <div className={styles.directoryHeading}><div><h2 id="catalog-groups-heading">{grouping.title}</h2><p>{grouping.description}</p></div><span>{groups.length} {grouping.groupsLabel}</span></div>
      <ul className={styles.groupDirectory}>{groups.map(group => <li key={group.name}><button type="button" aria-label={`${categoryLabel(group.name)}, ${group.count} ${group.count === 1 ? grouping.singular : grouping.plural}`} onClick={() => onSelect(group.name)}><span className={styles.directoryIcon}><Icon name={categoryIcon(group.name,kind)}/></span><span className={styles.groupName}>{categoryLabel(group.name)}<span>{group.count.toLocaleString()} {group.count === 1 ? grouping.singular : grouping.plural}</span></span><Icon name="chevr" size="sm"/></button></li>)}</ul>
    </section>;
}
function CatalogResults({ data, kind, view, columns, select, selected, collectionMode = false }: { selected?:string; data:Index; kind:CatalogKind; view:View; columns:Column<Summary>[]; select:(item:Summary)=>ReactNode; collectionMode?:boolean }) {
    const groups = collectionMode ? [...new Set(data.items.map(item=>item.collection ?? item.group))].map(category=>({category,items:data.items.filter(item=>(item.collection ?? item.group)===category)})) : groupByCategory(data.items,kind,item=>item.id,item=>item.group);
    const counts = collectionMode ? data.collectionCounts ?? data.groupCounts : data.groupCounts;
    return <div className={styles.groups}>{groups.map(({category,items}) => {
      const total=counts.filter(group=>categoryLabel(group.name)===category).reduce((sum,group)=>sum+group.count,0) || items.length;
      return <section key={category} aria-label={category}>
        <CategoryHeading category={category} kind={kind} count={items.length < total ? `${items.length} shown · ${total.toLocaleString()} matching` : `${total.toLocaleString()} ${total===1?'entry':'entries'}`}/>
        {view==='board' ? <ul className={styles.objectGrid}>{items.map(item=><li key={item.id}><article className={styles.objectCard} data-selected={item.id===selected || undefined}>
          <div className={styles.cardTop}><Icon name={presentationFor(kind,item.id,{category:item.group}).icon}/><State entry={item}/></div>
          <h3>{select(item)}</h3><p>{item.description}</p><dl className={styles.facts}>{item.facts.map(fact=><div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl><span className={styles.cardVersion}>{versionLabel(item.version,true)}</span>
        </article></li>)}</ul> : <Table caption={category} captionHidden columns={columns.filter(column=>column.key!=='group')} rows={items} rowKey={item=>item.id}/>}
      </section>;
    })}</div>;
}
function EntryDetail({ entry, onClose }: {
    entry: Entry | undefined;
    onClose: () => void;
}) {
    const [tab, setTab] = useState<'overview' | 'fields' | 'contract' | 'tree'>('overview');
    const session = useSession();
    const [editing, setEditing] = useState(false);
    const [saved, setSaved] = useState(false);
    const detailRoot = useRef<HTMLDivElement>(null);
    const finishEditing = () => { setEditing(false); requestAnimationFrame(() => detailRoot.current?.querySelector<HTMLButtonElement>('[data-edit-binding]')?.focus()); };
    if (!entry)
        return null;
    if (editing && entry.entryType === 'binding' && session.actions.includes('admin.write')) return <BindingEditor bindingId={entry.id} onCancel={finishEditing} onSaved={() => { finishEditing(); setSaved(true); }}/>;
    const relatedKinds = CATALOG_KINDS.filter(kind => entry.relationships.some(link => link.kind === kind));
    const safeWorkspace = entry.workspace?.startsWith('/') && !entry.workspace.startsWith('//') ? entry.workspace : null;
    const isDocumentType = entry.kind === 'documents' && entry.entryType === 'definition';
    const keyFields = isDocumentType ? entry.fields.filter(field => field.key) : [];
    const fields = keyFields.length ? [...keyFields, ...entry.fields.filter(field => !field.key)] : entry.fields;
    const facts = isDocumentType ? entry.facts.filter(fact => fact.label !== 'Key fields') : entry.facts;
    return <div ref={detailRoot} className={styles.detail}>
    <header><span className={styles.detailIcon}><Icon name={presentationFor(entry.kind,entry.id,{category:entry.group}).icon} size="lg"/></span><div className={styles.detailCategory}>{categoryLabel(entry.group)}</div><h2>{entry.title}</h2><p>{entry.description}</p><div className={styles.detailStatus}><State entry={entry}/><span>{versionLabel(entry.version)}</span></div></header>
    {entry.kind === 'external-capabilities' ? <Link to={'/catalogs/external-capabilities' as string} search={{ inventory: 'provider', ...(entry.entryType === 'binding' && typeof entry.contract.provider_record_id === 'string' ? { provider: entry.contract.provider_record_id } : { providerQ: entry.title }) }}>Explore providers and research</Link> : null}
    {saved ? <InlineMessage tone="ok">Binding revision saved. The catalog now shows your changes.</InlineMessage> : null}
    {entry.kind === 'external-capabilities' && entry.entryType === 'binding' && session.actions.includes('admin.write') ? <Button data-edit-binding onClick={() => { setSaved(false); setEditing(true); }}>Edit binding</Button> : null}
    <SegmentedControl label="Definition details" size="sm" options={[{ value: 'overview', label: text.overview }, { value: 'fields', label: entry.fields.length ? `${text.fields} (${entry.fields.length})` : text.fields }, { value: 'contract', label: text.contract }, ...(entry.kind === 'policies' && ['Policy', 'DecisionTable'].includes(String(entry.contract.kind)) ? [{ value: 'tree' as const, label: 'Policy tree' }] : [])]} value={tab} onChange={setTab}/>
    {tab === 'tree' ? <Suspense fallback={<p>Loading policy viewer…</p>}><PolicyTree sources={{ [entry.source]: entry.contract }} compact/></Suspense> : tab === 'overview' ? <>
      {isDocumentType ? <InspectorSection title="Key fields" count={keyFields.length} defaultOpen>
        {keyFields.length ? <ul className={styles.keyFields}>{keyFields.map(field => <li key={field.name}><Id>{field.name}</Id></li>)}</ul>
          : <p className={styles.noKeyFields}>No key fields are declared for this document type.</p>}
      </InspectorSection> : null}
      <dl className={styles.detailFacts}>{facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>{entry.notice ? <div role="note" className={styles.scopeNote}><Icon name="info"/><div><strong>{entry.entryType === 'binding' ? 'Scope of this binding' : 'Scope of this definition'}</strong><p>{entry.notice}</p></div></div> : null}
      {entry.tags.length ? <div className={styles.tags}>{entry.tags.map(tag => <Chip key={tag}>{tag.replaceAll('_', ' ')}</Chip>)}</div> : null}
      <section aria-labelledby="related-title"><h3 id="related-title">{text.related}</h3>{relatedKinds.length ? relatedKinds.map(kind => <RelatedGroup key={kind} kind={kind} links={entry.relationships.filter(link => link.kind === kind)}/>) : <p className={styles.muted}>No cross-catalog relationships are declared in this source.</p>}</section>
    </> : tab === 'fields' ? <section><h3>{text.fields}</h3>{fields.length ? <ul className={styles.fieldList}>{fields.map(field => <li key={field.name}><div><Id>{field.name}</Id>{field.key ? <Chip outline>{entry.kind === 'documents' ? 'Key field' : 'Key requirement'}</Chip> : null}</div><p>{field.description}</p></li>)}</ul> : <p className={styles.muted}>No field requirements are declared for this definition. Inspect its contract for the complete source.</p>}</section> : <><div className={styles.identity}><span className="t-engraved">Canonical identifier</span><Id>{entry.id}</Id></div><JsonViewer label="Source contract" data={entry.contract} maxHeight={440}/><div className={styles.identity}><span className="t-engraved">Source</span><code>{entry.source}</code><DigestValue value={entry.digest} label="Definition digest"/></div></>}
    <footer className={styles.detailFooter}>{isDocumentType && session.actions.includes('draft.read') && session.actions.includes('evidence.read') ? <Link to={'/platform/document-studio' as string} search={{ documentType: entry.id }} className={styles.workspaceLink}>Test in Document Studio<Icon name="arrowr" size="sm"/></Link> : null}{safeWorkspace ? <Link to={safeWorkspace} className={styles.workspaceLink}>{({agents:'Open agent profile',skills:'Open skill contract',context:'Explore context product',policies:'Open Policy Studio',documents:'Open document workspace','external-capabilities':'Configure provider binding',products:'Open Policy Studio'} as Record<CatalogKind,string>)[entry.kind]}<Icon name="arrowr" size="sm"/></Link> : null}<Link to={catalogPath(entry.kind, entry.id)} search={{ inventory: entry.entryType }} className={styles.permalink}>Open permanent link</Link><Button variant="quiet" size="sm" onClick={onClose}>{text.back}</Button></footer>
  </div>;
}
function RelatedGroup({ kind, links }: { kind: CatalogKind; links: Entry['relationships'] }) {
    const [query, setQuery] = useState('');
    const [limit, setLimit] = useState(8);
    const matches = links.filter(link => `${link.label} ${link.id}`.toLowerCase().includes(query.toLowerCase().trim())).sort((a,b)=>presentationFor(kind,a.id).category.localeCompare(presentationFor(kind,b.id).category)||a.label.localeCompare(b.label));
    return <div className={styles.relatedGroup}>
      <span className="t-engraved">{kind === 'external-capabilities' && links.every(link => link.entryType === 'definition') ? 'Capability definitions' : copy[kind].title} · {links.length}</span>
      {links.length > 12 ? <TextInput aria-label={`Find related ${copy[kind].title.toLowerCase()}`} placeholder={`Find related ${copy[kind].title.toLowerCase()}…`} value={query} onChange={event => { setQuery(event.target.value); setLimit(8); }}/> : null}
      {groupByCategory(matches.slice(0,limit),kind,item=>item.id).map(({category,items})=><GroupedSection key={category} category={category} kind={kind} level={4} count={`${items.length} shown · ${matches.filter(item=>presentationFor(kind,item.id).category===category).length} matching`}>
        <ul>{items.map(link=><li key={link.id}><Link to={catalogPath(kind)} search={{selected:link.id,inventory:link.entryType}}><DefinitionLabel kind={kind} id={link.id} title={link.label}/><Icon name="chevr" size="sm"/></Link></li>)}</ul>
      </GroupedSection>)}
      {!matches.length ? <p className={styles.muted}>No related entries match this search.</p> : null}
      {matches.length > limit ? <Button variant="quiet" size="sm" onClick={() => setLimit(value => value + 20)}>Show {Math.min(20, matches.length - limit)} more ({matches.length - limit} remaining)</Button> : null}
      {limit > 8 ? <Button variant="quiet" size="sm" onClick={() => setLimit(8)}>Show fewer</Button> : null}
    </div>;
}
