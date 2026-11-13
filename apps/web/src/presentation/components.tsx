import type { CatalogKind } from '@ehf/ui-contracts';
import { Icon, type IconName } from '@ehf/ui-kit';
import type { ReactNode } from 'react';
import { categoryIcon, categoryLabel, groupByCategory, presentationFor } from './model';
import { Link } from '@tanstack/react-router';
import { canReadCatalog } from '@ehf/ui-contracts';
import { useSession } from '../app/session';
import styles from './presentation.module.css';

export function CategoryHeading({ category, kind, count, children, level = 2 }: { category:string; kind?:CatalogKind; count?:ReactNode; children?:ReactNode; level?:2|3|4 }) {
  const Heading = `h${level}` as 'h2'|'h3'|'h4';
  return <div className={styles.categoryHeader}><Heading><span className={styles.categoryIcon}><Icon name={categoryIcon(category,kind)}/></span>{categoryLabel(category)}</Heading>{count !== undefined ? <span className={styles.count}>{count}</span> : null}{children}</div>;
}
export function DefinitionLabel({ kind, id, title, category, showId = false }: { kind:CatalogKind; id:string; title?:string; category?:string; showId?:boolean }) {
  const item = presentationFor(kind,id,{title,category});
  return <span className={styles.identity}><Icon name={item.icon}/><span className={styles.identityText}><span>{item.title}</span>{showId && item.title !== id ? <code>{id}</code> : null}</span></span>;
}
export function GroupedSection({ category, kind, count, children, level=3 }: {category:string;kind?:CatalogKind;count?:ReactNode;children:ReactNode;level?:2|3|4}) {
  return <section className={styles.group} aria-label={categoryLabel(category)}><CategoryHeading category={category} kind={kind} count={count} level={level}/>{children}</section>;
}
export function IdentityIcon({ icon }: { icon:IconName }) { return <span className={styles.categoryIcon}><Icon name={icon}/></span>; }

export function GroupedItems<T>({items,kind,idOf,categoryOf,children,level=3}:{items:readonly T[];kind:CatalogKind;idOf:(item:T)=>string;categoryOf?:(item:T)=>string|undefined;children:(items:T[])=>ReactNode;level?:2|3|4}) {
  return <>{groupByCategory(items,kind,idOf,categoryOf).map(group=><GroupedSection key={group.category} category={group.category} kind={kind} count={group.items.length} level={level}>{children(group.items)}</GroupedSection>)}</>;
}
export function DefinitionReferences({kind,ids,label}:{kind:CatalogKind;ids:readonly string[];label:string}) {
  const session=useSession();
  if(!ids.length)return <span className={styles.empty}>None declared</span>;
  return <div aria-label={label}><GroupedItems items={ids} kind={kind} idOf={id=>id} level={4}>{items=><ul className={styles.references}>{items.map(id=><li key={id}>{canReadCatalog(session.actions,kind) && presentationFor(kind,id).known?<Link to={(kind === "skills" ? "/studio/skills" : `/catalogs/${kind}/${encodeURIComponent(id)}`) as never} search={kind === "skills" ? { source: id } as never : undefined}><DefinitionLabel kind={kind} id={id} showId/></Link>:<DefinitionLabel kind={kind} id={id} showId/>}</li>)}</ul>}</GroupedItems></div>;
}
