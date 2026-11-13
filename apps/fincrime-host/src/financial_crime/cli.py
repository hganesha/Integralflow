"""Local, synthetic demonstrations and bundle integrity checks."""
import argparse
import asyncio
import json
from importlib.resources import files
from pathlib import Path

from .contracts import Principal, canonical, digest
from .execution import Executor
from .registry import bundle_code_hash, instructions_for, load_registry
from .store import Store
from . import synthetic


def validate_bundle():
    catalog = json.loads(files("financial_crime").joinpath("resources/catalog.json").read_text())
    registry = load_registry()
    if catalog["bundle_code_hash"] != bundle_code_hash() or {x["id"] for x in catalog["skills"]} != set(registry):
        raise RuntimeError("bundle code/catalog mismatch; rebuild catalog resources")
    for manifest in catalog["skills"]:
        if manifest["instruction_hash"] != digest(instructions_for(manifest["id"])):
            raise RuntimeError(f"instruction integrity mismatch: {manifest['id']}")
    return {"skill_count": len(registry), "bundle_code_hash": catalog["bundle_code_hash"], "valid": True, "production_qualified": False}


async def demo():
    from .workflows import WorkflowRunner, synthetic_kyb
    from .agents import AgentRunner, ScriptedPlanner, Selection
    store = Store()
    synthetic.seed(store)
    executor = Executor(store, [synthetic.profile()], synthetic.router())
    template = synthetic.invocation("case.create", execution_id="demo-template", trace_id="demo-trace")
    workflow = synthetic_kyb()
    runner = WorkflowRunner(executor)
    first = await runner.run(workflow, template, synthetic.principal(), "synthetic-kyb-demo")
    if first["state"] != "WAITING_FOR_HUMAN":
        raise RuntimeError(f"KYB did not reach approval: {first['state']}")
    pending = first["results"]["decision_disposition_record"]
    approval_id = pending["unresolved_items"][0]["approval_id"]
    reviewer = synthetic.principal("reviewer")
    reviewer.permissions.add("approve:decision.disposition.record")
    executor.approve(approval_id, reviewer)
    final = await runner.run(workflow, template, synthetic.principal(), "synthetic-kyb-demo", approvals={"decision_disposition_record": approval_id})
    if final["state"] != "COMPLETED":
        raise RuntimeError(f"KYB resume failed: {final['state']}")
    agent = await AgentRunner(executor).run("Validate a synthetic identifier and normalize an address", template.model_copy(update={"idempotency_key": "agent-demo"}), synthetic.principal(), ScriptedPlanner([
        Selection(skill_id="entity.identifiers.validate", parameters={"issuer": "synthetic-registry", "value": "SYN-0001"}),
        Selection(skill_id="entity.address.normalize", parameters={"address": " 1 TEST Street "}),
    ]))
    report = {"synthetic": True, "workflow_state": final["state"], "completed_steps": len(final["completed"]), "approval_required_and_consumed": True,
        "case_state": store.state("tenant-synthetic", "case", "case-demo")[1], "agent_state": agent["state"], "agent_steps": len(agent["steps"]),
        "risk_assessment": final["results"]["risk_customer_assess"]["payload"], "trace_events": len(store.events("tenant-synthetic"))}
    store.close()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list")
    sub.add_parser("validate")
    sub.add_parser("demo")
    export = sub.add_parser("export-ehf")
    export.add_argument("--output", type=Path, required=True)
    run = sub.add_parser("run")
    run.add_argument("invocation_file")
    run.add_argument("--synthetic", action="store_true", required=True)
    migrate = sub.add_parser("migrate-record")
    migrate.add_argument("input_file", type=Path)
    migrate.add_argument("--output", type=Path, required=True)
    diff = sub.add_parser("contract-diff")
    diff.add_argument("old_schema", type=Path)
    diff.add_argument("new_schema", type=Path)
    diff.add_argument("--direction", choices=["acceptance", "production"], default="acceptance")
    args = parser.parse_args()
    if args.command == "list":
        print("\n".join(sorted(load_registry())))
    elif args.command == "validate":
        print(json.dumps(validate_bundle(), indent=2))
    elif args.command == "demo":
        print(json.dumps(asyncio.run(demo()), indent=2))
    elif args.command == "export-ehf":
        from .ehf import export_catalog
        artifact = export_catalog()
        args.output.write_text(json.dumps(artifact, ensure_ascii=False, indent=2)+"\n")
        print(json.dumps({"sha256": artifact["sha256"], "skill_count": 222, "agent_count": 6, "task_count": 6}))
    elif args.command == "migrate-record":
        from .migrations import migrate_record
        from .contracts import SkillError
        if args.output.exists():
            parser.error("output already exists; choose a new file to preserve prior versions")
        try:
            record = migrate_record(json.loads(args.input_file.read_text()))
        except SkillError as error:
            print(json.dumps({"error": error.code, "message": error.message}))
            raise SystemExit(2)
        args.output.write_text(record.model_dump_json(indent=2)+"\n")
        print(json.dumps({"schema_version": record.schema_version, "version_id": record.version_id, "supersedes": record.supersedes}))
    elif args.command == "contract-diff":
        from .migrations import compare_schemas
        print(json.dumps(compare_schemas(json.loads(args.old_schema.read_text()), json.loads(args.new_schema.read_text()), direction=args.direction), indent=2))
    else:
        from .contracts import Invocation
        request = Invocation.model_validate_json(Path(args.invocation_file).read_text())
        store = Store()
        synthetic.seed(store)
        executor = Executor(store, [synthetic.profile()], synthetic.router())
        print(asyncio.run(executor.run(request, synthetic.principal())).model_dump_json(indent=2))
        store.close()


if __name__ == "__main__":
    main()
