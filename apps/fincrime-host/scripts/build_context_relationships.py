"""Generate semantic relationships against the closed canonical ontology."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def relationship_artifact(ontology_text):
    ontology = json.loads(ontology_text)
    source = json.loads((ROOT / 'ontology/relationships.json').read_text())
    types = set(ontology['x-context-types'])
    seen = set()
    for relation in source['relationships']:
        key = relation['id']
        if key in seen or relation['source'] not in types or relation['target'] not in types:
            raise ValueError(f'invalid relationship identity or type: {key}')
        seen.add(key)
        model = ontology['$defs'][relation['source']]
        field = model['properties'].get(relation['field'])
        if not field:
            raise ValueError(f'unknown relationship field: {key}')
        many = field.get('type') == 'array'
        value = field.get('items', {}) if many else field
        if value.get('$ref') != '#/$defs/' + ('Ref' if relation['representation'] == 'exact_ref' else 'Id'):
            raise ValueError(f'relationship representation differs from field: {key}')
        relation['multiple'] = many
        relation['optional'] = relation['field'] not in model.get('required', [])
        relation['targetCardinality'] = None
    payload = {**source, 'schemaVersion': ontology['properties']['schema_version']['const'],
               'ontologyDigest': hashlib.sha256(ontology_text.encode()).hexdigest()}
    payload['digest'] = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    return payload


def render(ontology_text):
    return json.dumps(relationship_artifact(ontology_text), sort_keys=True, indent=2, ensure_ascii=False) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    content = render((ROOT / 'schemas/context/ontology.schema.json').read_text())
    output = ROOT / 'catalog/context-relationships.json'
    if args.check:
        if not output.exists() or output.read_text() != content:
            raise SystemExit('Context relationships are stale. Run scripts/build_context_relationships.py.')
    else:
        output.write_text(content)
    print(f'{"Checked" if args.check else "Built"} canonical relationship catalog')


if __name__ == '__main__':
    main()
