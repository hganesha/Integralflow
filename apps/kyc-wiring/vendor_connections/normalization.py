"""Conservative common-schema envelope, plus shape-specific existing deep mappings.
The capability and lifecycle role come from the reviewed versioned operation mapping
(vendor_connections/mappings/operation-mappings.json), never from coarse native semantics or a
caller label. Operations the v1 host envelope cannot represent honestly (controls, uploads,
simulations, blocked mappings, native-only families) return a typed operation receipt instead.
Native resource creation is not completed identity verification. Unmapped fields stay
in encrypted native evidence, not fabricated canonical assertions.
"""
from wiring.core import uid,stamp,WiringError
from .client import definitions,field
from .capability_mapping import mapping,check_requested,receipt_reason,legacy_capability,definition,summary,operation_receipt,NON_PRODUCING_ROLES
from vendor.atlas.normalizers import normalize as deep_normalize,ADAPTERS
DEEP={('veriff','get_decision'):'veriff',('persona','get_inquiry'):'persona',('middesk','get_business'):'middesk',('gleif','get_lei'):'gleif',('opencorporates','get_company'):'opencorporates',('plaid','identityMatch'):'plaid'}
def interpret(native,context,artifact_ref):
 """Return exactly one of a v1 host result or an operation receipt, plus the mapping that selected it."""
 m=mapping(native['provider_id'],native['operation_id']);check_requested(m,context.get('capability'))
 if receipt_reason(m):return {'capability_mapping':summary(m),'host':None,'operation_receipt':operation_receipt(native,m,context,artifact_ref)}
 return {'capability_mapping':summary(m),'host':normalize(native,context,artifact_ref),'operation_receipt':None}
def normalize(native,context,artifact_ref):
 vendor=native['provider_id'];operation=native['operation_id'];sem=native['semantics'];status=native['native_status'];payload=native['native_payload'];sid=context['subject_entity_id'];tenant=context['tenant_id']
 m=mapping(vendor,operation);check_requested(m,context.get('capability'));reason=receipt_reason(m)
 if reason:raise WiringError('OPERATION_RECEIPT_ONLY',f'{vendor}:{operation} maps to {m["capability_id"]} ({m["operation_role"]}); it returns an operation receipt, not a host result ({reason})',409)
 cap=legacy_capability(m);role=m['operation_role'];d=definition(m);kind=d['result_family']
 result={'verification':{'kind':kind,'checks':[],'assertion_ids':[]},'business':{'kind':kind,'organization_entity_id':sid,'checks':[],'assertion_ids':[]},'screening':{'kind':kind,'matches':[],'dataset_versions':[],'scope':[],'truncated':False,'total_candidates':0},'risk':{'kind':kind,'scores':[],'signals':[]},'account':{'kind':kind,'accounts':[]}}.get(kind,{'kind':kind})
 # Some result families require extra non-evidentiary metadata.
 if kind=='ownership':result.update(root_entity_id=sid,relationship_ids=[],completeness='unknown',legal_test_policy_ref='not_evaluated',unresolved_reasons=['NATIVE_FIELDS_NOT_MAPPED'])
 h={'schema_version':'1.0.0','result_id':uid(),'request_id':context['request_id'],'tenant_id':tenant,'subject_entity_id':sid,'capability':cap,'provider':{'provider_id':vendor,'product':operation,'api_version':definitions()[vendor]['version'],'adapter_version':'vendor-connections-2.0','status_original':str(status)if status is not None else None,'decision_origin':'unknown'},'execution':{'status':'completed'if native['successful_http']else 'failed','received_at':stamp()},'assessment':{'outcome':'inconclusive'if native['successful_http']else 'unknown','reason_codes':[],'bank_decision':'not_evaluated'},'coverage':{'status':'unknown','requested_scope':[cap],'checked_scope':[],'not_checked_scope':[cap],'reason':'Wire operation completed; entitled dataset coverage and canonical field mapping not established'},'entities':context.get('entities')or [{'entity_id':sid,'entity_type':'unknown','names':[],'identifiers':[]}],'relationships':[],'assertions':[],'evidence':[],'result':result,'errors':[],'warnings':['VENDOR_IMPLEMENTATION_NOT_LIVE_TESTED','NATIVE_FIELDS_NOT_FULLY_NORMALIZED','HTTP_SUCCESS_IS_NOT_IDENTITY_APPROVAL','CAPABILITY_MAPPING_PROPOSED'],'raw_payload':{'vault_ref':artifact_ref,'sha256':native['raw_sha256'],'classification':'restricted'},'extensions':{'execution_mode':'vendor_test','operation_id':operation,'documentation_source':native['source'],'maturity':'implemented_unverified','native_semantics':sem,'digest_representation':'original HTTP response bytes','capability_mapping':summary(m)}}
 if native.get('resource_id')is not None:h['provider']['provider_record_id']=str(native['resource_id'])
 # A submitted check or opened session is pending; it never carries a finding.
 if sem in ['session','submission']or role=='submit':
  h['execution']['status']='pending'if native['successful_http']else 'failed';h['assessment']['outcome']='not_checked';h['provider']['decision_origin']='provider_workflow'
 aid=DEEP.get((vendor,operation));deep=False
 if aid and native['successful_http']and role not in NON_PRODUCING_ROLES and ADAPTERS[aid][1]==cap:
  mapped=deep_normalize(aid,payload,request_id=context['request_id'],tenant_id=tenant,subject_entity_id=sid,received_at=stamp(),raw_vault_ref=artifact_ref)
  if not mapped['errors']:
   for name in ['provider','assessment','result','entities','relationships','assertions','evidence','capability']:h[name]=mapped[name]
   h['execution']=mapped['execution'];h['provider'].update(adapter_version='vendor-connections-2.0',product=operation,api_version=definitions()[vendor]['version'])
   for ev in h['evidence']:ev['content_sha256']=native['raw_sha256']
   h['warnings']=[w for w in h['warnings']if w!='NATIVE_FIELDS_NOT_FULLY_NORMALIZED'];deep=True
 if vendor=='sumsub'and operation=='review_status'and native['successful_http']:
  answer=field(payload,'/reviewResult/reviewAnswer');review=field(payload,'/reviewStatus');reject=field(payload,'/reviewResult/reviewRejectType')
  h['provider'].update(status_original=str(answer or review)if answer or review else None,decision_origin='provider_workflow')
  if review=='completed'and answer in ['GREEN','RED']:
   h['assessment']['outcome']='passed'if answer=='GREEN'else 'resubmit'if reject=='RETRY'else 'failed'if reject=='FINAL'else 'inconclusive'
  elif review in ['init','pending','prechecked','queued','onHold']:h['execution']['status']='pending';h['assessment']['outcome']='not_checked'
 # Reference data (list snapshots, identifier records) is not a subject check outcome.
 if native['successful_http']and(sem=='dataset'or(d['kind']=='reference'and not deep)):h['assessment']['outcome']='not_applicable'
 if not native['successful_http']:h['errors']=[{'code':'UPSTREAM_HTTP_'+str(native['http_status']),'category':'provider_unavailable','message':'Vendor returned an unsuccessful HTTP response; inspect restricted artifact','retryable':False}]
 if role in NON_PRODUCING_ROLES or h['execution']['status']=='pending':h['assertions']=[]
 h['assessment']['bank_decision']='not_evaluated'
 return h
