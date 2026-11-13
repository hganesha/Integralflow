import { describe,it,expect } from "vitest";
import type { CaseSnapshot } from "@ehf/contracts";
import { searchableDocuments } from "./document-search.js";
const record=(object_type:string,data:Record<string,unknown>,extra:Record<string,unknown>={})=>({object_type,object_id:object_type,version_id:'v1',subject_ids:['s1'],purposes:['kyc.review'],provenance:{method:'platform'},classification:'CONFIDENTIAL',data,...extra});
const version=record('DocumentVersion',{document_id:'doc1',artifact_hash:'a'.repeat(64),artifact_ref:'ehf:case-evidence:e1',page_count:1});
const page=record('DocumentPage',{document_version:'a'.repeat(64),page:1,text:'Acme evidence',extensions:{'ehf.connector':{value:{text_basis:'full_text'}}}});
const snapshot=(versions:unknown[]=[version],pages:unknown[]=[page],evidence:unknown[]=[{evidence_id:'e1',raw_digest:`sha256:${'a'.repeat(64)}`,subject_refs:['s1'],residency:'US',source:{type:'UPLOAD'}}])=>({data:{records:{DocumentVersion:versions,DocumentPage:pages},evidence}} as unknown as CaseSnapshot);
describe('case document retrieval scope',()=>{
 it('binds canonical pages to captured bytes and distinguishes text coverage',()=>{
  const docs=searchableDocuments(snapshot(),['s1'],'kyc.review',['Case.Analyst'],['US']);
  expect(docs).toHaveLength(1);expect(docs[0]).toMatchObject({artifactRef:'e1',textCoverage:'extracted_text'});
  // Older decoded pages may derive subject labels from the captured upload; the
  // server retrieval profile provides their permitted purposes, never the request.
  expect(searchableDocuments(snapshot([{...version,subject_ids:[],purposes:[]}],[{...page,subject_ids:[],purposes:[]}]),['s1'],'kyc.review',['Case.Analyst'],['US'])).toHaveLength(1);
 });
 it('excludes unknown artifacts, changed hashes, unlinked subjects, disallowed purposes/residency and source-backed text',()=>{
  const denied=[snapshot([],[]),snapshot([version],[page],[]),snapshot([{...version,data:{...version.data,artifact_hash:'b'.repeat(64)}}]),snapshot([version],[{...page,subject_ids:['s2']}]),snapshot([version],[{...page,purposes:['other']}]),snapshot([version],[{...page,classification:'RESTRICTED'}]),snapshot([version],[{...page,provenance:{method:'platform',source_decision_id:'source-proof'}}])];
  for(const value of denied)expect(searchableDocuments(value,['s1'],'kyc.review',['Case.Analyst'],['US'])).toEqual([]);
  expect(searchableDocuments(snapshot(),['s1'],'kyc.review',['Case.Analyst'],['EU'])).toEqual([]);
 });
});
