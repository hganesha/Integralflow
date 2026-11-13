import json
from pathlib import Path
import subprocess
import sys

from jsonschema import Draft202012Validator

from financial_crime.cli import validate_bundle
from financial_crime.contracts import Principal, Record, digest, canonical
from financial_crime import synthetic as f
from financial_crime.execution import Executor
from financial_crime.registry import load_registry
from financial_crime.store import Store

ROOT = Path(__file__).resolve().parents[1]


def test_bundle_integrity_and_context_consumers_cover_all_declared_fields():
    assert validate_bundle()["skill_count"] == 232
    matrix = json.loads((ROOT / "catalog/context-matrix.json").read_text())
    reverse = json.loads((ROOT / "catalog/context-consumers.json").read_text())
    for spec in load_registry().values():
        for req in spec.requirements:
            for field in req.fields:
                assert spec.id in reverse[req.object_type+"."+field]
        for field in spec.policy_fields:
            assert spec.id in reverse["Policy."+field]
    assert len({(x["skill_id"], x["object_type"], x["field"]) for x in matrix}) == len(matrix)


def test_all_published_json_schemas_are_well_formed():
    for path in (ROOT / "schemas").rglob("*.json"):
        Draft202012Validator.check_schema(json.loads(path.read_text()))
    schema = json.loads((ROOT / "schemas/runtime/SkillManifest.schema.json").read_text())
    for manifest in json.loads((ROOT / "catalog/catalog.json").read_text())["skills"]:
        Draft202012Validator(schema).validate(manifest)


def test_current_schema_inventory_is_strict_and_content_addressed():
    from financial_crime.schema_types import audit_schema
    import hashlib
    report = json.loads((ROOT / "docs/schema-contract-report.json").read_text())
    assert report["distinct_skill_schemas"] == 2 * 232 and report["canonical_context_types"] == 89
    assert len(report["schema_inventory"]) == report["published_schema_count_including_bundle_copies"]
    for item in report["schema_inventory"]:
        schema = json.loads((ROOT / item["path"]).read_text())
        assert digest(schema) == item["schema_hash"]
        assert not audit_schema(schema), item["path"]
    snapshot = ROOT / "schemas/history/0.1.0/contracts.json"
    assert hashlib.sha256(snapshot.read_bytes()).hexdigest() == report["historical_snapshot_sha256"]


def test_record_migration_cli_preserves_the_input_and_refuses_output_overwrite(tmp_path):
    from test_migrations import legacy_record
    source, output = tmp_path / "old.json", tmp_path / "new.json"
    original = json.dumps(legacy_record()); source.write_text(original)
    command = [sys.executable, "-m", "financial_crime.cli", "migrate-record", str(source), "--output", str(output)]
    assert subprocess.run(command, capture_output=True).returncode == 0
    assert json.loads(output.read_text())["schema_version"] == "2.0.0"
    assert source.read_text() == original
    saved = output.read_bytes()
    assert subprocess.run(command, capture_output=True).returncode != 0
    assert output.read_bytes() == saved


def test_canonical_hash_stable_across_json_roundtrips_and_interpreters():
    record = f.records()[0]
    assert digest(record) == digest(Record.model_validate_json(canonical(record)))
    command = "from financial_crime import synthetic as f; from financial_crime.contracts import digest; print(digest(f.principal()))"
    other = subprocess.check_output([sys.executable, "-c", command], text=True).strip()
    assert other == digest(f.principal())


async def test_replay_survives_separate_process_hash_randomization(tmp_path):
    path = tmp_path / "replay.sqlite"
    store = Store(path); f.seed(store)
    executor = Executor(store, [f.profile()], f.router())
    result = await executor.run(f.invocation("entity.classify"), f.principal())
    store.close()
    script = "\n".join([
        "from financial_crime import synthetic as f",
        "from financial_crime.execution import Executor",
        "from financial_crime.store import Store",
        f"s=Store({str(path)!r})",
        "e=Executor(s,[f.profile()],f.router())",
        f"r=e.replay({result.context_hash!r},f.principal())",
        "print(len(r['structured']['Entity']))",
    ])
    assert subprocess.check_output([sys.executable, "-c", script], text=True).strip() == "2"
