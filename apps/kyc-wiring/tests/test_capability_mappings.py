"""Proposed v2 native-operation mappings: coverage, referential integrity and lifecycle-role rules."""
import collections, copy, importlib.util, json, re
from pathlib import Path
import pytest
from jsonschema import Draft202012Validator, FormatChecker

P = Path(__file__).resolve().parents[1]
DOC = P.parent / 'docs/CANONICAL_EXTERNAL_CAPABILITY_MODEL.md'
spec = importlib.util.spec_from_file_location('build_capability_mappings', P / 'scripts/build_capability_mappings.py')
gen = importlib.util.module_from_spec(spec); spec.loader.exec_module(gen)
def read(rel): return json.loads((P / rel).read_text())
REG = read('vendor_connections/mappings/operation-mappings.json')
OPS = REG['records']
BINDS = {b['binding_id']: b for b in read('vendor/atlas/capability-model/capability-bindings.json')['records']}
FAM = {d['capability_path']: d for d in read('vendor/atlas/capability-model/capability-definitions.json')['records']}
SCHEMA = Draft202012Validator(read('vendor/atlas/schemas/v2/native-operation-mapping.schema.json'), format_checker=FormatChecker())
DEFINITIONS = {f.stem: json.loads(f.read_text()) for f in (P / 'vendor_connections/definitions').glob('*.json')}

def test_generated_outputs_are_current():
    out = gen.build()
    stale = [k for k, v in out.items() if (P / k).read_bytes() != v]
    assert stale == [], 'run python scripts/build_capability_mappings.py'

def test_vendored_model_matches_atlas_when_present():
    atlas = P.parent / 'kyc-provider-atlas'
    if not atlas.is_dir(): pytest.skip('atlas checkout absent')
    for src, dst in gen.VENDOR_DIRS.items():
        names = sorted(f.name for f in (atlas / src).glob('*.json'))
        assert names == sorted(f.name for f in (P / 'vendor/atlas' / dst).glob('*.json'))
        for n in names: assert (atlas / src / n).read_bytes() == (P / 'vendor/atlas' / dst / n).read_bytes(), n

def test_envelope_and_records_validate():
    Draft202012Validator(read('vendor/atlas/schemas/v2/registry-envelope.schema.json')).validate(REG)
    assert REG['record_count'] == len(OPS) == 732
    for r in OPS: SCHEMA.validate(r)

def test_sources_pin_inputs():
    for s in REG['sources']: assert gen.sha_bytes((P / s['path']).read_bytes()) == s['sha256'], s['path']

def test_every_documented_operation_maps_exactly_once():
    expected = sorted(f'operation-map:{d["provider_id"]}:{op}:v1' for d in DEFINITIONS.values() for op in d['operations'])
    assert sorted(r['operation_mapping_id'] for r in OPS) == expected
    assert len(DEFINITIONS) == 42
    for r in OPS:
        op = DEFINITIONS[r['vendor_definition_id']]['operations'][r['native_operation_id']]
        assert (r['native_method'], r['native_path'], r['native_semantics_original']) == (op['method'], op['path'], op['semantics'])

def test_no_operation_falls_back_to_person_verification():
    vendor_native = [r for r in OPS if r['native_semantics_original'] == 'vendor_native']
    assert len(vendor_native) == 626
    person = collections.Counter(r['primary_capability_path'] for r in vendor_native)['identity.person']
    assert person < 50, 'vendor_native must be mapped per operation, not defaulted to identity.person'
    assert all(r['primary_capability_path'] in FAM for r in OPS)

def test_role_counts_match_review():
    assert collections.Counter(r['operation_role'] for r in OPS) == collections.Counter(
        {'control': 285, 'retrieve': 225, 'lookup': 57, 'submit': 45, 'upload': 32, 'verify': 28, 'assess': 15, 'screen': 15, 'simulate': 14,
         'extract': 6, 'ingest': 5, 'validate': 3, 'derive': 1, 'enrich': 1})

def test_nothing_produces_or_is_enabled():
    for r in OPS:
        assert r['produces'] == [] and r['status'] in ('proposed', 'blocked') and r['mapping_relation'] == 'proposed_semantic_mapping'
        assert 'operation_kind_unassigned' in r['blockers'] and r['operation_kind'] is None
        assert r['live_tested'] is False and 'not_live_tested' in r['blockers']
        if r['jurisdiction']['code'] == 'unresolved': assert 'jurisdiction_unresolved' in r['blockers'] and r['jurisdiction']['source'] == 'binding_required'

def test_conditional_and_conflicting_operations_are_blocked():
    blocked = {r['operation_mapping_id']: r for r in OPS if r['status'] == 'blocked'}
    assert len(blocked) == 16
    assert sum(r['dispatch_status'] == 'required_unconfigured' for r in blocked.values()) == 15
    assert 'source_definition_conflict' in blocked['operation-map:prembly:documented_national_id:v1']['blockers']
    for oid in ['operation-map:entrust-onfido:create_check:v1', 'operation-map:truora:create_check:v1', 'operation-map:complycube:create_check:v1']:
        assert 'conditional_dispatch_unconfigured' in blocked[oid]['blockers']

def test_semantic_corrections_from_review():
    by = {r['operation_mapping_id']: r for r in OPS}
    assert by['operation-map:plaid:identityMatch:v1']['capability_id'] == 'account.ownership.intelligence.unresolved'
    assert by['operation-map:plaid:accountsGet:v1']['capability_id'] == 'account.profile.intelligence.unresolved'
    assert by['operation-map:plaid:transactionsGet:v1']['capability_id'] == 'financial.transactions.intelligence.unresolved'
    assert by['operation-map:incode:generaterfc:v1']['capability_id'] == 'identity.identifier.derivation.intelligence.mx'
    assert by['operation-map:gleif:get_lei:v1']['capability_id'] == 'reference.identifier.intelligence.unresolved'
    assert by['operation-map:dilisense:individual_media:v1']['primary_capability_path'] == 'screening.adverse_media'
    assert by['operation-map:ofac-sanctions-list-service:download_sdn:v1']['jurisdiction'] == {'code': 'us', 'source': 'publisher_authority'}
    assert by['operation-map:companies-house:get_company_company_number_persons_with_significant_control:v1']['capability_id'] == 'business.ownership.intelligence.gb'
    assert all(r['operation_role'] == 'simulate' for r in OPS if r['primary_capability_path'] == 'platform.testing')

def test_provider_identity_uses_reviewed_alias_only():
    rel = {(r['vendor_definition_id'], r['provider_record_id'], r['provider_identity_relationship']) for r in OPS}
    assert {x for x in rel if x[2] != 'same_id'} == {('entrust-onfido', 'entrust-identity-verification', 'proposed_alias')}

def test_candidate_bindings_are_exact_scope_matches():
    for r in OPS:
        for b in r['candidate_binding_refs']:
            assert BINDS[b]['provider_record_id'] == r['provider_record_id'] and BINDS[b]['capability_id'] == r['capability_id']
        assert bool(r['candidate_binding_refs']) != ('no_candidate_binding' in r['blockers'])
    assert REG['binding_index']['binding:plaid:account.ownership.intelligence.unresolved:v1'] == ['operation-map:plaid:identityMatch:v1', 'operation-map:plaid:identityMatchList:v1']
    for b, ops in REG['binding_index'].items():
        assert b in BINDS and all(b in next(r for r in OPS if r['operation_mapping_id'] == o)['candidate_binding_refs'] for o in ops)

def test_schema_rejects_unsafe_mappings():
    control = copy.deepcopy(next(r for r in OPS if r['operation_role'] == 'control'))
    control['produces'] = ['identity_verification_outcome']
    assert not SCHEMA.is_valid(control), 'control operations never produce check outcomes'
    approved = copy.deepcopy(next(r for r in OPS if r['jurisdiction']['code'] == 'unresolved'))
    approved.update(status='approved', mapping_relation='validated_mapping', blockers=[])
    assert not SCHEMA.is_valid(approved), 'unresolved jurisdiction cannot be approved'
    cond = copy.deepcopy(next(r for r in OPS if r['dispatch_status'] == 'required_unconfigured'))
    cond['status'] = 'proposed'
    assert not SCHEMA.is_valid(cond)
    testing = copy.deepcopy(next(r for r in OPS if r['primary_capability_path'] == 'platform.testing'))
    testing['operation_role'] = 'verify'
    assert not SCHEMA.is_valid(testing)

def test_definition_drift_fails_the_build(monkeypatch, tmp_path):
    review = read(gen.REVIEW)
    review['definitions']['plaid']['identityMatch']['method_path'] = 'GET /identity/match'
    (tmp_path / 'review.json').write_text(json.dumps(review))
    monkeypatch.setattr(gen, 'REVIEW', str(tmp_path / 'review.json'))
    with pytest.raises(SystemExit, match='definition changed since review'): gen.build()

@pytest.mark.skipif(not DOC.exists(), reason='design document not in this checkout')
def test_mappings_match_reviewed_design_document():
    text = DOC.read_text().split('## Appendix C')[1].split('## Appendix D')[0]
    rows = {m.group(1): (m.group(2), m.group(3)) for m in re.finditer(r'^\| `([^`]+)` \| `[^`]*` \| `[^`]*` \| `([^`]+)` \| `(\w+)` \|', text, re.M)}
    assert len(rows) == 732
    for r in OPS: assert rows[f'{r["vendor_definition_id"]}:{r["native_operation_id"]}'] == (r['capability_id'], r['operation_role'])
