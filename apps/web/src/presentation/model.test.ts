import { describe,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { categoryIcon, groupByCategory, presentationFor } from './model';
import { ICON_PATHS } from '../../../../packages/ui-kit/src/icon/sprite';
import type { CatalogKind } from '@ehf/ui-contracts';
const source=JSON.parse(readFileSync(new URL('../../../fincrime-host/docs/ui/contracts/fixtures/catalogs.json',import.meta.url),'utf8')) as {entries:Array<{id:string;kind:CatalogKind;title:string;group:string}>};
describe('source-backed identities and category coverage',()=>{
  it('resolves every current skill, capability, binding, document and field to an authored title and descriptive icon',()=>{
    const entries=source.entries.filter(entry=>['skills','external-capabilities','documents'].includes(entry.kind));
    expect(entries.length).toBeGreaterThan(1000);
    for(const entry of entries) {
      const item=presentationFor(entry.kind,entry.id);
      expect(item.title).toBe(entry.title);
      expect(item.category).not.toBe('Other');
      expect(ICON_PATHS[item.icon]).toBeTruthy();
      expect(['grid','layers','help']).not.toContain(item.icon);
      if(entry.kind==='documents')expect(item.icon).not.toBe('copy');
      expect(item.icon).toBe(categoryIcon(entry.group,entry.kind));
    }
  });
  it('retains new and unresolved skills in an explicit group without inventing a category',()=>{
    const groups=groupByCategory(['ownership.ubo.resolve','screening.sanctions.execute','tenant.new.skill'],'skills',id=>id);
    expect(groups.map(group=>group.category)).toEqual(['Ownership','Screening','Other']);
    expect(groups.flatMap(group=>group.items)).toContain('tenant.new.skill');
    expect(categoryIcon('Monitor')).toBe(categoryIcon('Monitoring'));
  });
});
