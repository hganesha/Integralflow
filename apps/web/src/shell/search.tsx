import type { Schemas } from "@ehf/ui-contracts";
import { ApiError } from "@ehf/ui-client";
import { Icon, InlineMessage, Sheet, TextInput, type IconName } from "@ehf/ui-kit";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../app/api";
import styles from "./shell.module.css";
import { categoryIcon, entryTypeLabel, presentationFor } from '../presentation/model';
import type { CatalogKind } from '@ehf/ui-contracts';
const CATALOG_KIND:Record<string,CatalogKind>={skill:'skills',external_capability:'external-capabilities',agent:'agents',context_product:'context',policy:'policies',document_type:'documents',product:'products'};
const RESULT_ICONS:Record<string,IconName>={case:'inbox',work_item:'hand',run:'activity',plan:'package',draft:'file',task:'workflow',release:'send'};

type Item = Schemas["SearchResults"]["groups"][number]["items"][number];

const GROUP_LABELS: Record<string, string> = {
  case: "Cases", work_item: "Work items", run: "Runs", plan: "Plans", draft: "Drafts", agent: "Agents", task: "Tasks",
  skill: "Skills", context_product: "Context products", release: "Releases",
  external_capability:'External capabilities',policy:'Policies',document_type:'Documents and fields',product:'Products',
};

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** ⌘K search over cases, work, runs, plans, drafts and the catalog (§5.5 getSearch). */
export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const q = useDebounced(query.trim(), 150);
  const navigate = useNavigate();
  const listId = useId();
  const results = useQuery({
    queryKey: ["getSearch", { q }],
    enabled: open && q.length > 0,
    queryFn: () => api.getSearch({ query: { q } }),
  });
  const listRef=useRef<HTMLUListElement>(null);
  const groups=useMemo(()=>(results.data?.groups ?? []).flatMap(group=>{
    const kind=CATALOG_KIND[group.kind];
    const partitions=new Map<string, {item:Item;icon:IconName}[]>();
    for(const item of group.items) {
      const info=kind ? presentationFor(kind,item.id,{title:item.title,category:item.subtitle??undefined}) : null;
      const grouped=group.kind==='skill'||group.kind==='external_capability';
      const type=group.kind==='external_capability' ? new URL(item.route,'http://local.invalid').searchParams.get('inventory') ?? 'definition' : '';
      const label=grouped ? `${info!.category}${type ? ` · ${entryTypeLabel(type)}`:''}` : '';
      const rows=partitions.get(label)??[];
      rows.push({item,icon:info?.icon??RESULT_ICONS[group.kind]??'search'});
      partitions.set(label,rows);
    }
    return [...partitions].sort(([a],[b])=>a.localeCompare(b)).map(([label,items])=>({key:`${group.kind}:${label}`,label:[GROUP_LABELS[group.kind]??group.kind,label].filter(Boolean).join(' · '),items}));
  }),[results.data]);
  const flat=useMemo(()=>groups.flatMap(group=>group.items),[groups]);
  useEffect(()=>{listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});},[active]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the highlight when results change
  useEffect(() => setActive(0), [results.data]);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  function go(item: Item) {
    onClose();
    void navigate({ to: item.route });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.max(0,Math.min(index + 1, flat.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && flat[active]) {
      event.preventDefault();
      go(flat[active].item);
    }
  }

  let index = -1;
  return (
    <Sheet open={open} onClose={onClose} title="Search" description="Find your work and the catalog definitions your role can access.">
      <TextInput
        className={styles.searchInput}
        role="combobox"
        aria-label="Search"
        aria-expanded={flat.length > 0}
        aria-controls={listId}
        aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
        data-autofocus
        value={query}
        placeholder="Search work, agents, skills, policies or documents"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {results.error ? (
        <InlineMessage tone="error">{results.error instanceof ApiError ? results.error.message : "Search failed."}</InlineMessage>
      ) : null}
      <ul ref={listRef} id={listId} role="listbox" aria-label="Search results" className={styles.results}>
        {groups.map((group,groupIndex) => (
          <li key={group.key} role="presentation">
            <div id={`${listId}-group-${groupIndex}`} className={`${styles.groupLabel} t-engraved`}>{group.label}</div>
            <ul role="group" aria-labelledby={`${listId}-group-${groupIndex}`} className={styles.results}>
              {group.items.map(({item,icon}) => {
                index+=1;const position=index;
                return <li key={item.id} id={`${listId}-${position}`} role="option" aria-selected={position===active} className={styles.result} onMouseEnter={()=>setActive(position)} onClick={()=>go(item)}>
                  <span className={styles.searchResultIcon}><Icon name={icon}/></span><span className={styles.searchResultBody}><span className={styles.resultTitle}>{item.title}</span>{item.subtitle ? <span className={styles.resultSub}>{item.subtitle}</span>:null}</span>
                </li>;
              })}
            </ul>
          </li>
        ))}
      </ul>
      {q && flat.length > 0 ? <p className={styles.resultSub}>Showing a limited set of matches. Open a catalog for complete results and filters.</p> : null}
      {q && results.data && flat.length === 0 ? <p role="status">No results for “{q}” that you can see.</p> : null}
    </Sheet>
  );
}
