"""Vendor the atlas v2 capability model and build NativeOperationMapping records. No vendor calls.

1. Copies tools/kyc-provider-atlas/ (repository root){capability-model/registry, schemas/v2, examples/v2} into vendor/atlas/
   when the atlas checkout is present; otherwise the existing vendored copy is used.
2. Builds vendor_connections/mappings/operation-mappings.json from:
     vendor_connections/definitions/*.json            documented vendor operations
     vendor_connections/mappings/operation-review.json reviewed semantic mapping (edit this)
     vendor/atlas/capability-model/*.json             definitions, jurisdictions, bindings, aliases

The build fails if a definition gained, lost or changed an operation since the review, so drift is
re-reviewed instead of silently inheriting the old mapping. Every record stays proposed or blocked:
nothing is enabled, no field mapper is implied and produces[] stays empty until a response mapping is
validated. Design: ../docs/CANONICAL_EXTERNAL_CAPABILITY_MODEL.md, section 3.3 and Appendix C.
Run with --check to verify outputs are current without writing.
"""
from pathlib import Path
import hashlib, json, sys

P = Path(__file__).resolve().parents[1]
ATLAS = P.parents[1] / 'tools/kyc-provider-atlas'
VENDORED = P / 'vendor/atlas'
REVIEW = 'vendor_connections/mappings/operation-review.json'
OUTPUT = 'vendor_connections/mappings/operation-mappings.json'
GENERATOR = 'api-wiring/scripts/build_capability_mappings.py'
VENDOR_DIRS = {'capability-model/registry': 'capability-model', 'schemas/v2': 'schemas/v2', 'examples/v2': 'examples/v2'}

def sha_bytes(b): return hashlib.sha256(b).hexdigest()
def dumps(o): return json.dumps(o, indent=2, ensure_ascii=False) + '\n'

def vendored_files():
    """Map vendored relative path -> bytes from the atlas checkout (None when the atlas is absent)."""
    if not (ATLAS / 'capability-model/registry').is_dir(): return None
    out = {}
    for src, dst in VENDOR_DIRS.items():
        for f in sorted((ATLAS / src).glob('*.json')): out[f'vendor/atlas/{dst}/{f.name}'] = f.read_bytes()
    return out

def load_vendored(rel, override):
    key = f'vendor/atlas/{rel}'
    return json.loads(override[key] if override and key in override else (P / key).read_bytes())

def build(vendored=None):
    vendored = vendored_files() if vendored is None else vendored
    defs_reg = load_vendored('capability-model/capability-definitions.json', vendored)
    jur_reg = load_vendored('capability-model/jurisdictions.json', vendored)
    bind_reg = load_vendored('capability-model/capability-bindings.json', vendored)
    cross = load_vendored('capability-model/legacy-crosswalk.json', vendored)
    families = {d['capability_path']: d for d in defs_reg['records']}
    tokens = {j['token'] for j in jur_reg['records']}
    providers = {p['provider_id'] for p in json.loads((VENDORED / 'catalog/providers.json').read_text())}
    aliases = {a['source_id']: a for a in cross['provider_aliases'] if a['source_layer'] == 'vendor_definition'}
    bindings_by = {}
    for b in bind_reg['records']: bindings_by.setdefault((b['provider_record_id'], b['capability_id']), []).append(b['binding_id'])
    review = json.loads((P / REVIEW).read_text())['definitions']

    files = sorted((P / 'vendor_connections/definitions').glob('*.json'))
    errors, records = [], []
    if sorted(f.stem for f in files) != sorted(review): errors.append(f'definition set differs from review: {sorted(set(f.stem for f in files) ^ set(review))}')
    for f in files:
        d = json.loads(f.read_text()); vid = d['provider_id']; rev = review.get(f.stem, {})
        if vid != f.stem: errors.append(f'{f.name}: provider_id {vid} differs from file name')
        if vid in providers: pid, rel = vid, 'same_id'
        elif vid in aliases: pid, rel = aliases[vid]['provider_record_id'], aliases[vid]['relationship']
        else: errors.append(f'{vid}: no provider record or reviewed alias'); continue
        if pid not in providers: errors.append(f'{vid}: alias target {pid} is not a provider record')
        missing, extra = set(d['operations']) - set(rev), set(rev) - set(d['operations'])
        if missing or extra: errors.append(f'{vid}: operations not reviewed {sorted(missing)}; reviewed but absent {sorted(extra)}')
        digest = sha_bytes(f.read_bytes())
        for op_id, op in d['operations'].items():
            r = rev.get(op_id)
            if r is None: continue
            if r['method_path'] != f'{op["method"]} {op["path"]}' or r['semantics_original'] != op['semantics']:
                errors.append(f'{vid}:{op_id}: definition changed since review ({r["method_path"]}/{r["semantics_original"]} -> {op["method"]} {op["path"]}/{op["semantics"]})'); continue
            path, jur, role = r['capability_path'], r['jurisdiction'], r['role']
            if path not in families: errors.append(f'{vid}:{op_id}: unknown capability path {path}'); continue
            if jur not in tokens: errors.append(f'{vid}:{op_id}: unregistered jurisdiction {jur}'); continue
            capability_id = f'{path}.intelligence.{jur}'
            blockers = ['operation_kind_unassigned', 'request_response_mapping_missing', 'mapping_evidence_missing']
            if jur == 'unresolved': blockers.append('jurisdiction_unresolved')
            else: blockers.append('jurisdiction_not_approved')
            if r['disposition'] == 'conditional_dispatch_required': blockers.append('conditional_dispatch_unconfigured')
            if r['disposition'] == 'blocked_source_conflict': blockers.append('source_definition_conflict')
            if path == 'screening.watchlist' and role == 'screen': blockers.append('watchlist_category_dispatch_unconfigured')
            if path == 'platform.testing': blockers.append('synthetic_only')
            if not d.get('live_tested'): blockers.append('not_live_tested')
            candidates = sorted(bindings_by.get((pid, capability_id), []))
            if not candidates: blockers.append('no_candidate_binding')
            source = 'binding_required' if jur == 'unresolved' else 'publisher_authority' if path == 'reference.list' else 'native_source_hint'
            records.append({
                'operation_mapping_id': f'operation-map:{vid}:{op_id}:v1', 'vendor_definition_id': vid, 'provider_record_id': pid, 'provider_identity_relationship': rel,
                'native_operation_id': op_id, 'native_method': op['method'], 'native_path': op['path'], 'native_api_version': d.get('version'),
                'native_semantics_original': op['semantics'], 'primary_capability_path': path, 'capability_id': capability_id,
                'jurisdiction': {'code': jur, 'source': source}, 'operation_role': role, 'operation_kind': None, 'mapping_relation': 'proposed_semantic_mapping',
                'rationale': r['rationale'], 'mapping_evidence_refs': [], 'request_schema_ref': None, 'response_schema_ref': None, 'request_mapping_ref': None,
                'response_mapping_ref': None, 'preconditions': [], 'enables': [], 'produces': [], 'conditional_dispatch': [],
                'dispatch_status': 'required_unconfigured' if r['disposition'] == 'conditional_dispatch_required' else 'not_required',
                'status': 'proposed' if r['disposition'] == 'mapped' else 'blocked', 'blockers': blockers, 'candidate_binding_refs': candidates,
                'live_tested': bool(d.get('live_tested')),
                'lineage': {'review_source': REVIEW, 'definition_file': f'vendor_connections/definitions/{f.name}', 'definition_sha256': digest}})
    if errors: raise SystemExit('Operation mapping build failed:\n  ' + '\n  '.join(errors))
    ids = [r['operation_mapping_id'] for r in records]
    assert len(ids) == len(set(ids))
    index = {}
    for r in records:
        for b in r['candidate_binding_refs']: index.setdefault(b, []).append(r['operation_mapping_id'])
    def src(rel, data=None): return {'path': rel, 'sha256': sha_bytes(data if data is not None else (P / rel).read_bytes())}
    reg_paths = [f'vendor/atlas/capability-model/{n}.json' for n in ['capability-definitions', 'jurisdictions', 'capability-bindings', 'legacy-crosswalk']]
    sources = [src(REVIEW)] + [src(p, vendored.get(p) if vendored else None) for p in reg_paths] + [src('vendor/atlas/catalog/providers.json')] + \
              [src(f'vendor_connections/definitions/{f.name}') for f in files]
    env = {'registry': 'operation_mappings', 'model_version': defs_reg['model_version'], 'record_schema': 'schemas/v2/native-operation-mapping.schema.json',
           'generated_by': GENERATOR, 'status': 'proposed_not_enabled', 'sources': sources, 'record_count': len(records), 'records': records,
           'binding_index': dict(sorted(index.items()))}
    out = {k.decode() if isinstance(k, bytes) else k: v for k, v in (vendored or {}).items()}
    out[OUTPUT] = dumps(env).encode()
    return out

def main(argv):
    out = build()
    stale = [k for k, v in out.items() if not (P / k).exists() or (P / k).read_bytes() != v]
    if '--check' in argv:
        if stale: print('Stale generated files:\n  ' + '\n  '.join(stale)); return 1
        print('Capability mappings are current (%d files).' % len(out)); return 0
    for k in stale:
        (P / k).parent.mkdir(parents=True, exist_ok=True); (P / k).write_bytes(out[k])
    reg = json.loads(out[OUTPUT])
    print('Wrote %d of %d files; %d operation mappings, %d blocked, %d with a candidate binding.' % (
        len(stale), len(out), reg['record_count'], sum(r['status'] == 'blocked' for r in reg['records']), sum(bool(r['candidate_binding_refs']) for r in reg['records'])))
    return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
