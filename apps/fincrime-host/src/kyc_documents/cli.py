"""Inspect and validate KYC field contracts without invoking an extraction provider."""
import argparse
import json
from pathlib import Path

from .artifacts import write_bundle
from .model import ConfidencePolicy
from .profiles import PROFILES
from .runtime import audit_catalog, contract, extraction_schema, validate_extraction


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list")
    listing.add_argument("--family")
    listing.add_argument("--coverage")
    commands.add_parser("audit")
    for name in ("show", "schema"):
        command = commands.add_parser(name)
        command.add_argument("document_type")
    validation = commands.add_parser("validate")
    validation.add_argument("document_type")
    validation.add_argument("--result", type=Path, required=True)
    validation.add_argument("--pages", type=Path, required=True)
    validation.add_argument("--confidence-policy", type=Path)
    exporting = commands.add_parser("export")
    exporting.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "list":
            value = [{"id": p.id, "name": p.display_name, "family": p.family, "key_fields": p.key_fields}
                for p in sorted(PROFILES.values(), key=lambda p: p.id)
                if (not args.family or p.family == args.family) and (not args.coverage or args.coverage in p.coverage)]
        elif args.command == "audit":
            value = audit_catalog()
        elif args.command == "show":
            value = contract(args.document_type)
        elif args.command == "schema":
            value = extraction_schema(args.document_type)
        elif args.command == "export":
            value = write_bundle(args.output)
        else:
            policy = ConfidencePolicy.model_validate_json(args.confidence_policy.read_text()) if args.confidence_policy else None
            value = validate_extraction(args.document_type, json.loads(args.result.read_text()),
                json.loads(args.pages.read_text()), confidence_policy=policy)
    except (ValueError, OSError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False))
    if args.command == "validate" and not value["valid"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
