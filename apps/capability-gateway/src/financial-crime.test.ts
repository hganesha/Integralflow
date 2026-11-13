import {it,expect} from 'vitest';
import type {CapabilityDefinition} from '@ehf/contracts';
import {FinancialCrimeClient,type CanonicalCatalog} from '@ehf/fincrime-integration';
import type {Database} from '@ehf/persistence';
import {createAdapterRegistry} from './adapter-registry.js';

it('derives bridge authority from verified execution context and preserves evidence gaps',async()=>{
  const catalog={apiVersion:'fincrime.ehf/catalog-v1',sourceRelease:'0.3.0',contextSchemaVersion:'2.0.0',bundleCodeHash:'a'.repeat(64),
    skills:[{value:{id:'ownership.ubo.resolve',semver:'0.2.0',instruction_hash:'b'.repeat(64)},canonical:'',sha256:'c'.repeat(64),instructionContent:'test'}],
    agents:[{value:{id:'agent.identity_ownership'},canonical:'',sha256:'d'.repeat(64)}],
    tasks:[{value:{id:'task.identity_ownership',version:'1.0.0',agent_profile:'agent.identity_ownership',steps:[{skill_id:'ownership.ubo.resolve'}]},canonical:'',sha256:'e'.repeat(64)}],contextProducts:[]} as CanonicalCatalog;
  let sent:Record<string,any>|undefined;
  const client=new FinancialCrimeClient({endpoint:'http://127.0.0.1/invocations',allowLoopback:true,token:async()=> 'test',fetch:async(_url,init)=>{
    sent=JSON.parse(String(init?.body));return Response.json({api_version:'fincrime.ehf/outcome-v1',scope:sent!.scope,status:'NEEDS_EVIDENCE',
      payload:{},context_manifest:null,context_hash:null,evidence_refs:[],proposed_commands:[],provider_captures:[],unresolved_items:[],error_code:'CONTEXT_MISSING',effects_committed:false,synthetic:true});
  }});
  const registry=createAdapterRegistry({db:{} as Database,env:{SECURITY_PROFILE:'development'},fetch:globalThis.fetch,modelProfilesPath:'unused',
    financialCrime:{catalog,catalogDigest:'c'.repeat(64),client,resolveBasis:async e=>{expect(e.caseId).toBe('authorized-case');return {caseSequence:4,snapshotDigest:'f'.repeat(64)};}}});
  const capability:CapabilityDefinition={id:'fincrime.ubo',kind:'deterministic',effect:'read',adapterBindingId:'financial-crime:ownership.ubo.resolve@0.2.0',inputSchema:{},outputSchema:{},timeoutMs:1000,maxAttempts:1,idempotent:true};
  await expect(registry.invoke(capability,{target:'acme'},{tenantId:'tenant'})).rejects.toThrow('execution_authority_required');
  const result=await registry.invoke(capability,{target:'acme',profile_id:'untrusted-profile'},{tenantId:'tenant',financialCrimeExecution:{
    tenantId:'tenant',caseId:'authorized-case',runId:'run',nodeId:'node',workItemId:'work',executionId:'execution',runFencingEpoch:2,workFencingEpoch:3,
    planDigest:'0'.repeat(64),taskId:'task.identity_ownership',catalogDigest:'c'.repeat(64)}});
  expect(sent!.scope.profile_id).toBe('agent.identity_ownership');expect(sent!.scope.case_id).toBe('authorized-case');
  expect(sent!.scope.work_fencing_epoch).toBe(3);expect((result.output as {status:string}).status).toBe('NEEDS_EVIDENCE');
});
