#!/usr/bin/env python3
"""Build reviewable skill packages and installed resources from explicit implementations."""
from __future__ import annotations

import argparse
import hashlib
from collections import defaultdict
import json
from pathlib import Path
import re
import sys

import yaml

from skill_content import read_source, render_instructions, validate_sources

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from financial_crime import contracts, synthetic
from financial_crime.contracts import canonical, digest
from financial_crime.ontology import field_schema, policy_field_schema
from financial_crime.registry import bundle_code_hash, load_registry
from financial_crime.providers import ProviderResponse
from financial_crime.versions import RELEASE_VERSION, SCHEMA_VERSION


def render():
    registry = load_registry()
    validate_sources(ROOT, registry)
    limitations = {}
    for skill_id, spec in registry.items():
        body = read_source(ROOT / "skill-content" / "skills" / f"{skill_id}.md")
        limitations[skill_id] = [body.split("## Limitations\n", 1)[1].split("\n## ", 1)[0].strip()]
        spec.limitations = limitations[skill_id]
    source = (ROOT / "financial_crime_canonical_skills_spec_v1.md").read_text()
    canonical_ids = re.findall(r"^#### `([^`]+)`", source, re.M)
    extensions = (ROOT / "docs/skill-extensions.md").read_text()
    extension_ids = re.findall(r"^#### `([^`]+)`", extensions, re.M)
    if len(canonical_ids) != 222 or set(canonical_ids) & set(extension_ids):
        raise ValueError("the canonical catalog has exactly 222 IDs and extensions never reuse one")
    source_ids = canonical_ids + extension_ids
    if len(set(source_ids)) != len(source_ids) or set(source_ids) != set(registry):
        raise ValueError("catalog and implementations must match the 222 canonical IDs plus the declared extensions")
    for extension in extension_ids:
        wrapped = registry[extension].dependencies
        if len(wrapped) != 1 or wrapped[0] not in canonical_ids:
            raise ValueError(f"extension {extension} must wrap exactly one canonical skill")
    source = source + extensions
    outputs, manifests, matrix = {}, [], []
    def emit(path, value, format="json"):
        if format == "json":
            value = json.dumps(json.loads(canonical(value)), sort_keys=True, indent=2, ensure_ascii=False) + "\n"
        elif format == "yaml":
            value = yaml.safe_dump(json.loads(canonical(value)), sort_keys=True, allow_unicode=True)
        outputs[ROOT / path] = value
    names = set()
    emit("src/financial_crime/resources/skill-limitations.json", limitations)
    for skill_id in source_ids:
        spec = registry[skill_id]
        name = skill_id.replace(".", "-").replace("_", "-")
        if name in names:
            raise ValueError("harness name collision")
        names.add(name)
        instruction = render_instructions(ROOT, spec)
        manifest = spec.manifest()
        manifest.update({"harness_name": name, "instructions": "SKILL.md", "instruction_hash": digest(instruction), "bundle_code_hash": bundle_code_hash()})
        context = {"skill_id": skill_id, "schema_version": SCHEMA_VERSION, "requirements": [r.model_dump() for r in spec.requirements], "dynamic_target": "parameters.target_skill" if skill_id == "case.context.hydrate" else None}
        domain, leaf = skill_id.split(".", 1)
        for prefix in [Path("skills") / domain / leaf.replace(".", "-"), Path("src/financial_crime/resources/skills") / skill_id]:
            emit(prefix / "SKILL.md", instruction, "text")
            emit(prefix / "skill.yaml", manifest, "yaml")
            emit(prefix / "context.yaml", context, "yaml")
            emit(prefix / "input.schema.json", spec.params)
            emit(prefix / "output.schema.json", spec.output)
        manifests.append(manifest)
        for req in spec.requirements:
            for f in req.fields:
                matrix.append({"skill_id": skill_id, "version": spec.version, "object_type": req.object_type, "field": f,
                    "field_schema": field_schema(req.object_type, f), "required": not req.optional,
                    "min_count": req.min_count, "max_age_seconds": req.max_age_seconds, "freshness_policy": "tenant_policy.freshness_seconds",
                    "selector": "authorized request subject/explicit-ref scope", "temporal": "valid_at_as_of_and_recorded_by_cutoff", "on_missing": "NEEDS_EVIDENCE" if not req.optional else "record_optional_gap"})
        for f in spec.policy_fields:
            matrix.append({"skill_id": skill_id, "version": spec.version, "object_type": "Policy", "field": f,
                "field_schema": policy_field_schema(f), "required": f in {"permissions", "version", "jurisdiction"},
                "min_count": 1, "selector": "pinned effective tenant policy", "temporal": "valid_at_as_of_and_recorded_by_cutoff",
                "on_missing": "POLICY_UNRESOLVED or explicit per-skill unknown/default semantics"})
    catalog = {"version": RELEASE_VERSION, "context_schema_version": SCHEMA_VERSION, "synthetic": True, "source_hash": digest(source), "bundle_code_hash": bundle_code_hash(), "skills": manifests}
    emit("catalog/catalog.json", catalog)
    emit("src/financial_crime/resources/catalog.json", catalog)
    emit("catalog/context-matrix.json", matrix)
    reverse = defaultdict(list)
    for r in matrix:
        reverse[r["object_type"]+"."+r["field"]].append(r["skill_id"])
    emit("catalog/context-consumers.json", {k: sorted(set(v)) for k, v in sorted(reverse.items())})
    declared = {x.strip() for t in re.findall(r"\*\*Default context objects:\*\* (.*?)\. \*\*Default execution", source) for x in t.split(",")}
    fields = defaultdict(dict)
    for r in matrix:
        fields[r["object_type"]][r["field"]] = r["field_schema"]
    from financial_crime.context_types import CONTEXT_TYPES
    from financial_crime.ontology import canonical_data_schema
    ontology = contracts.Record.model_json_schema()
    ontology["$id"] = "urn:financial-crime:ontology:"+SCHEMA_VERSION
    ontology["x-context-types"] = sorted(CONTEXT_TYPES)
    ontology["description"] = "Closed canonical record schema; object_type selects its named data contract. Only explicit typed maps and versioned extensions accept dynamic keys."
    emit("schemas/context/ontology.schema.json", ontology)
    from build_context_relationships import relationship_artifact
    emit("catalog/context-relationships.json", relationship_artifact(outputs[ROOT / "schemas/context/ontology.schema.json"]))
    for object_type in sorted(CONTEXT_TYPES):
        emit(f"schemas/context/types/{object_type}.schema.json", canonical_data_schema(object_type))
    for model in [contracts.Invocation, contracts.SkillResult, contracts.Record, contracts.RecordView, contracts.Ref, contracts.Principal, contracts.AgentProfile, contracts.ContextManifest, contracts.Requirement, contracts.Computation, contracts.EffectCommand, contracts.ExecutionLock, contracts.Metrics, contracts.Failure, contracts.UnresolvedItem, ProviderResponse]:
        emit(Path("schemas/runtime") / (model.__name__+".schema.json"), model.model_json_schema())
    from financial_crime.schema_types import document, DEFS, audit_schema
    from financial_crime.payload_types import CAPABILITY_SCHEMAS
    for capability, (request, response) in sorted(CAPABILITY_SCHEMAS.items()):
        for kind, shape in [("request", request), ("response", response)]:
            emit(f"schemas/providers/{capability}.{kind}.schema.json", document(shape,
                schema_id=f"urn:financial-crime:provider:{capability}:{kind}:{SCHEMA_VERSION}"))
    emit("schemas/runtime/SkillManifest.schema.json", document("SkillManifest"))
    emit("schemas/runtime/Catalog.schema.json", document("Catalog"))
    from financial_crime.tasks import BusinessAgent, ContextProduct, TaskSpec, TaskPlan, workforce, context_products
    from financial_crime.ehf import AssignmentScope, BridgeRequest, PlanRequest, BridgeOutcome, ContextPacket, export_catalog
    agents, tasks = workforce()
    for agent in agents.values():
        emit(f"profiles/{agent.id}.json", agent)
        emit(f"src/financial_crime/resources/agents/{agent.id}.json", agent)
    for task in tasks.values():
        emit(f"tasks/{task.id}.json", task)
        emit(f"src/financial_crime/resources/tasks/{task.id}.json", task)
    emit("catalog/context-products.json", list(context_products().values()))
    rendered = {path.parent.name: value for path, value in outputs.items()
                if path.name == "SKILL.md" and path.parent.parent == ROOT / "src/financial_crime/resources/skills"}
    emit("catalog/ehf-catalog.json", export_catalog(lambda skill_id: rendered[skill_id]))
    for model in [BusinessAgent, ContextProduct, TaskSpec, TaskPlan, AssignmentScope, BridgeRequest, PlanRequest, BridgeOutcome, ContextPacket]:
        emit(f"schemas/integration/{model.__name__}.schema.json", model.model_json_schema())
    emit("policies/synthetic/neutral.json", synthetic.policy())
    emit("profiles/synthetic-analyst.json", synthetic.profile())
    emit("examples/records.json", synthetic.records())
    emit("examples/invocations.json", {k: synthetic.invocation(k, execution_id=digest([k, "example-execution"]), trace_id=digest([k, "example-trace"])) for k in source_ids})
    from financial_crime.workflows import Workflow, synthetic_kyb
    emit("workflows/synthetic-kyb.json", synthetic_kyb())
    emit("schemas/runtime/Workflow.schema.json", Workflow.model_json_schema())
    emit("catalog/release-lock.json", {"catalog_hash": digest(catalog), "bundle_code_hash": bundle_code_hash(), "skill_count": len(manifests), "source_context_types": len(declared), "field_requirements": len(matrix)})
    # Gate every published current schema, including all skill package copies.
    from financial_crime.registry import validate
    from jsonschema import Draft202012Validator
    inventory = []
    for path, content in sorted(outputs.items()):
        if not path.name.endswith(".schema.json"):
            continue
        schema = json.loads(content)
        Draft202012Validator.check_schema(schema)
        issues = audit_schema(schema)
        if issues:
            raise ValueError(f"untyped published contract {path}: {issues[:3]}")
        inventory.append({"path": str(path.relative_to(ROOT)), "schema_hash": digest(schema)})
    validate(document("Catalog"), catalog)
    for manifest in manifests:
        validate(document("SkillManifest"), manifest)
    # Keep the actual 0.1 contracts as immutable review evidence; this is not a compatibility promise.
    from financial_crime.migrations import compare_schemas
    archive_path = ROOT / "schemas/history/0.1.0/contracts.json"
    archive_hash = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    if archive_hash != (archive_path.parent / "SHA256").read_text().split()[0]:
        raise ValueError("historical contract snapshot hash mismatch")
    previous = json.loads(archive_path.read_text())
    comparisons = {skill_id: {kind: compare_schemas(previous["skills"][skill_id][kind], getattr(spec, attr), direction=direction)
        for kind, attr, direction in [("input", "params", "acceptance"), ("output", "output", "production")]}
        for skill_id, spec in sorted(registry.items()) if skill_id in previous["skills"]}
    emit("docs/schema-compatibility.json", {"from_release": previous["release"], "to_release": RELEASE_VERSION,
        "historical_snapshot_sha256": archive_hash, "automatic_release_upgrade_allowed": False, "skills": comparisons})
    emit("docs/schema-contract-report.json", {"release": RELEASE_VERSION, "context_schema_version": SCHEMA_VERSION,
        "skill_count": len(registry), "distinct_skill_schemas": len(registry)*2,
        "canonical_context_types": len(CONTEXT_TYPES), "named_definitions": len(DEFS),
        "untyped_containers": 0, "published_schema_count_including_bundle_copies": len(inventory),
        "schema_inventory": inventory, "historical_snapshot_sha256": archive_hash,
        "dynamic_values": "Only explicitly typed keyed maps, JSON source/fact/schema values, and versioned namespaced extensions.",
        "semantic_checks": ["reference tenant and version binding", "record temporal intervals", "projected field key equality and authorization", "provider entitlement and evidence binding"],
        "production_qualified": False})
    return outputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    outputs = render()
    stale = []
    for path, content in outputs.items():
        if args.check:
            if not path.exists() or path.read_text() != content:
                stale.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
    if stale:
        print("Generated artifacts differ:", *stale[:10], sep="\n")
        raise SystemExit(1)
    print(f"{'Checked' if args.check else 'Built'} {len(outputs)} artifacts for {len(load_registry())} executable skills (222 canonical plus extensions)")


if __name__ == "__main__":
    main()
