"""Document Model Factory command line: offline sourcing, dataset and evaluation tooling."""
import argparse
import json
from importlib import resources
from pathlib import Path

from datetime import datetime, timezone

from .datasets import build_dataset_version, load_directory, split_policy_for, write_json
from .evaluation import Prediction, RunInfo, evaluate
from .sourcing import build_manifest, expand


def committed_manifest() -> dict:
    text = resources.files("document_factory").joinpath("resources/sourcing-manifest.json").read_text(encoding="utf-8")
    return json.loads(text)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="document-factory", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    sourcing = commands.add_parser("sourcing", help="inspect the sourcing manifest")
    sourcing_commands = sourcing.add_subparsers(dest="action", required=True)
    sourcing_commands.add_parser("summary")
    show = sourcing_commands.add_parser("show")
    show.add_argument("document_type")
    listing = sourcing_commands.add_parser("list")
    listing.add_argument("--pilot", choices=["model", "sourcing", "none"])
    listing.add_argument("--status")
    synthetic = commands.add_parser("synthetic", help="generate synthetic samples with labels known by construction")
    synthetic.add_argument("action", choices=["generate"])
    synthetic.add_argument("--type", required=True, dest="document_type")
    synthetic.add_argument("--count", type=int, default=20)
    synthetic.add_argument("--seed", type=int, default=0)
    synthetic.add_argument("--dir", type=Path, required=True)
    dataset = commands.add_parser("dataset", help="build a digest-pinned dataset version from a dataset directory")
    dataset.add_argument("action", choices=["build"])
    dataset.add_argument("--type", required=True, dest="document_type")
    dataset.add_argument("--dir", type=Path, required=True)
    dataset.add_argument("--salt", required=True, help="pinned by the type's first dataset version")
    dataset.add_argument("--previous", type=Path)
    dataset.add_argument("--out", type=Path, required=True)
    requests = commands.add_parser("baseline-requests",
                                   help="write the production document.fields request for each sealed test sample")
    requests.add_argument("--type", required=True, dest="document_type")
    requests.add_argument("--dataset", type=Path, required=True)
    requests.add_argument("--dir", type=Path, required=True)
    requests.add_argument("--limit", type=int, help="first N sealed test samples (cost control); the report says so")
    requests.add_argument("--out", type=Path, required=True)
    evaluation = commands.add_parser("evaluate", help="score a route's predictions on a dataset version's sealed test split")
    evaluation.add_argument("--type", required=True, dest="document_type")
    evaluation.add_argument("--dataset", type=Path, required=True)
    evaluation.add_argument("--dir", type=Path, required=True)
    evaluation.add_argument("--predictions", type=Path, required=True, help="JSON lines, one Prediction per sample")
    evaluation.add_argument("--route", required=True, choices=["llm", "azure_di", "adjudicated", "oracle", "other"])
    evaluation.add_argument("--run-id", required=True)
    evaluation.add_argument("--limit", type=int, help="score the first N sealed test samples, as in baseline-requests --limit")
    evaluation.add_argument("--source-pages", type=Path, help="JSON lines {sample_id, pages}: the pages the route read (e.g. OCR of a scan)")
    evaluation.add_argument("--model-profile")
    evaluation.add_argument("--model-profile-digest")
    evaluation.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    manifest = committed_manifest()
    if manifest["manifest_digest"] != build_manifest()["manifest_digest"]:
        parser.exit(2, "the committed sourcing manifest is stale; run scripts/build_sourcing_manifest.py\n")
    entries = {e.document_type: e for e in expand(manifest)}
    if args.command == "synthetic":
        from .synthetic import generate
        (args.dir / "samples").mkdir(parents=True, exist_ok=True)
        (args.dir / "labels").mkdir(exist_ok=True)
        records = []
        for seed in range(args.seed, args.seed + args.count):
            data, sample, label = generate(args.document_type, seed)
            (args.dir / "samples" / sample.sample_id).write_bytes(data)
            (args.dir / "labels" / f"{sample.sample_id}.json").write_text(label.model_dump_json(indent=2) + "\n", encoding="utf-8")
            records.append(sample.model_dump_json())
        with (args.dir / "samples.jsonl").open("a", encoding="utf-8") as handle:
            handle.writelines(line + "\n" for line in records)
        print(json.dumps({"generated": len(records), "dir": str(args.dir)}))
        return
    if args.command == "dataset":
        if args.document_type not in entries:
            parser.exit(2, f"unknown document type: {args.document_type}\n")
        samples, labels = load_directory(args.dir)
        previous = json.loads(args.previous.read_text()) if args.previous else None
        version = build_dataset_version(entries[args.document_type], samples, labels,
                                        policy=split_policy_for(entries[args.document_type], args.salt), previous=previous)
        write_json(args.out, version)
        print(json.dumps({k: version[k] for k in ("dataset_digest", "counts", "readiness")}, indent=2))
        return
    if args.command == "baseline-requests":
        from kyc_document_studio import prepare  # the skill host's request builder, so the request is the production one
        version = json.loads(args.dataset.read_text())
        if version["document_type"] != args.document_type:
            parser.exit(2, "the dataset version is for another document type\n")
        _, labels = load_directory(args.dir)
        ids = version["sealed_test"][:args.limit] if args.limit else version["sealed_test"]
        with args.out.open("w", encoding="utf-8") as handle:
            for sample_id in ids:
                prepared = prepare({"documentType": args.document_type,
                                    "pages": [p.model_dump(mode="json") for p in labels[sample_id].pages]})
                classification = [{"document_type": c.get("document_type"), "basis": c.get("basis")}
                                  for c in prepared["classification"].get("classifications", [])] if isinstance(prepared["classification"], dict) else None
                handle.write(json.dumps({"sample_id": sample_id, "document_type": args.document_type, "request": prepared["request"],
                                         "catalog_classification": classification}, ensure_ascii=False) + "\n")
        print(json.dumps({"requests": len(ids), "of_sealed_test": len(version["sealed_test"])}))
        return
    if args.command == "evaluate":
        if args.document_type not in entries:
            parser.exit(2, f"unknown document type: {args.document_type}\n")
        _, labels = load_directory(args.dir)
        predictions = [Prediction.model_validate_json(line) for line in args.predictions.read_text(encoding="utf-8").splitlines() if line.strip()]
        run = RunInfo(route=args.route, run_id=args.run_id, started_at=datetime.now(timezone.utc),
                      model_profile=args.model_profile, model_profile_digest=args.model_profile_digest)
        source = None
        if args.source_pages:
            source = {row["sample_id"]: row["pages"] for row in map(json.loads, args.source_pages.read_text(encoding="utf-8").splitlines()) if row}
        report = evaluate(entries[args.document_type], json.loads(args.dataset.read_text()), labels, predictions, run,
                          limit=args.limit, source_pages=source)
        write_json(args.out, report)
        print(json.dumps({"report_digest": report["report_digest"], "claim_level": report["claim_level"],
                          "documents_with_issue": report["documents_with_issue"],
                          "documents": report["documents"], "key_fields": report["fields"]["key"]}, indent=2))
        return
    if args.action == "summary":
        value = manifest["summary"]
    elif args.action == "show":
        if args.document_type not in entries:
            parser.exit(2, f"unknown document type: {args.document_type}\n")
        value = entries[args.document_type].model_dump(mode="json")
    else:
        value = [{"document_type": e.document_type, "pilot": e.pilot, "status": e.status,
                  "strategy": e.strategy_hypothesis, "sources": [s.id for s in e.sources]}
                 for e in entries.values()
                 if (not args.pilot or e.pilot == args.pilot) and (not args.status or e.status == args.status)]
    print(json.dumps(value, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
