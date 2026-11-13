import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {validateResponse} from '@ehf/ui-contracts/validate';
import {buildApp} from './app.js';
import type {Upstream} from './upstream.js';
const docs=JSON.parse(readFileSync(new URL('../../../packages/fincrime-views/src/fixtures/documents.kyb-1042.json',import.meta.url),'utf8'));
const digest='a'.repeat(64);
const records=docs.records.reduce((groups:Record<string,unknown[]>,r:any)=>{(groups[r.object_type]??=[]).push(r);return groups;},{});
const snapshot={caseId:'case-test',tenantId:'tenant-verified',caseSequence:7,snapshotDigest:digest,planDigest:digest,
  policyAuthority:{policyId:'policy-test',policyVersion:'1.0.0',policySnapshotDigest:digest,policyBundleDigest:digest},
  data:{case:{caseType:'kyc_onboarding',jurisdiction:'US',status:'INTAKE'},records,subjects:[],workItems:[],evidence:[],reviews:[]}};
it('serves case documents from the tenant snapshot and leaves every extraction unverified',async()=>{
  const upstream=vi.fn<Upstream>(async(_s,_m,path)=>({status:200,body:path.startsWith('/v1/operations/human-work')?{items:[]}:snapshot}));
  const app=buildApp({principalResolver:{source:'local',resolve:async()=>({subjectId:'analyst',tenantId:'tenant-verified',actorType:'human',roles:['Case.Analyst'],source:'local'})},upstream});
  try {
    const list=await app.inject('/api/v1/fincrime/cases/case-test/documents');expect(list.statusCode,list.body).toBe(200);
    expect(validateResponse('getFincrimeCasesCaseIdDocuments',200,list.json()).valid).toBe(true);
    const id=list.json().documents[0].documentId;
    const detail=await app.inject('/api/v1/fincrime/cases/case-test/documents/'+id);expect(detail.statusCode,detail.body).toBe(200);
    expect(detail.json().assertions.every((a:any)=>a.verification==='UNVERIFIED')).toBe(true);
    const room=await app.inject('/api/v1/fincrime/cases/case-test/room');expect(room.statusCode,room.body).toBe(200);
    upstream.mockResolvedValue({status:200,body:{...snapshot,tenantId:'different-tenant'}});
    expect((await app.inject('/api/v1/fincrime/cases/case-test/documents')).statusCode).toBe(403);
  }finally{await app.close();}
});
