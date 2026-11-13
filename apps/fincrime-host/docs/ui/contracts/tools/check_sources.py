#!/usr/bin/env python3
"""Detect drift between docs/ui and the upstream contracts it is built on.

The UI pack is derived from two moving repositories:

  kyc         FinCrime domain contracts (tasks, BusinessAgents, context products,
              integration schemas, canonical records).
  ehfconcept  EHF platform (zod contracts, control-api / case-api / gateway routes,
              identity actions, the control-ui BFF this UI replaces).

SOURCES.lock.json pins a sha256 for every upstream file the pack depends on, plus
glob patterns so new files are noticed too. Each pin lists the parts of the pack
that consume it, so a drift report says what to re-check.

  python3 docs/ui/contracts/tools/check_sources.py              # report; exit 1 on drift
  python3 docs/ui/contracts/tools/check_sources.py --update     # re-pin after review
  options: --kyc-root PATH  --ehf-root PATH  --json

Default roots: kyc = three levels above contracts/ (the repo root);
ehfconcept = $EHF_ROOT or a sibling checkout named ehfconcept.
Exit codes: 0 clean, 1 drift, 2 a root is missing.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONTRACTS = HERE.parent
LOCK = CONTRACTS / "SOURCES.lock.json"
BUNDLE = CONTRACTS / "upstream" / "ehf-contracts.schema.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_head(root: Path) -> str | None:
    try:
        return subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True,
                              text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def git_dirty(root: Path, paths: list[str]) -> list[str]:
    try:
        out = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--", *paths],
                             capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return []
    return [line[3:] for line in out.splitlines() if line.strip()]


def expand(root: Path, patterns: list[str]) -> list[str]:
    found: set[str] = set()
    for pattern in patterns:
        for p in root.glob(pattern):
            if p.is_file() and not any(fnmatch.fnmatch(p.name, x) for x in ("* 2.*", ".DS_Store")):
                found.add(p.relative_to(root).as_posix())
    return sorted(found)


def scan(lock: dict, roots: dict[str, Path]) -> dict:
    """Return the current state of every source group in the lock."""
    state: dict = {}
    for gid, group in lock["groups"].items():
        root = roots[group["root"]]
        files = expand(root, group["include"])
        state[gid] = {f: sha256(root / f) for f in files}
    return state


def bundle_digest() -> str | None:
    if not BUNDLE.exists():
        return None
    data = json.loads(BUNDLE.read_text())
    return hashlib.sha256(json.dumps(data["$defs"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    kyc_default = CONTRACTS.parent.parent.parent          # docs/ui/contracts -> repo root
    ap.add_argument("--kyc-root", type=Path, default=kyc_default)
    ap.add_argument("--ehf-root", type=Path,
                    default=Path(os.environ["EHF_ROOT"]) if os.environ.get("EHF_ROOT") else kyc_default.parent / "ehfconcept")
    ap.add_argument("--update", action="store_true", help="re-pin every group to the current upstream state")
    ap.add_argument("--groups", nargs="+", help="with --update, re-pin only the reviewed source groups")
    ap.add_argument("--json", action="store_true", help="machine-readable report")
    args = ap.parse_args()

    roots = {"kyc": args.kyc_root.resolve(), "ehfconcept": args.ehf_root.resolve()}
    missing = [k for k, v in roots.items() if not v.is_dir()]
    if missing:
        print(f"source root not found: {', '.join(f'{k}={roots[k]}' for k in missing)}", file=sys.stderr)
        return 2

    lock = json.loads(LOCK.read_text())
    current = scan(lock, roots)
    report: dict = {"groups": {}, "repos": {}, "bundle": {}}
    drift = False

    for gid, group in lock["groups"].items():
        pinned: dict = group.get("files", {})
        now = current[gid]
        changed = sorted(f for f in pinned if f in now and now[f] != pinned[f])
        removed = sorted(f for f in pinned if f not in now)
        added = sorted(f for f in now if f not in pinned)
        status = "clean" if not (changed or removed or added) else ("watch" if group.get("watch") else "drift")
        if status == "drift":
            drift = True
        report["groups"][gid] = {"status": status, "changed": changed, "removed": removed, "added": added,
                                 "consumers": group.get("consumers", [])}

    for repo, pin in lock.get("repos", {}).items():
        head = git_head(roots[repo])
        dirty = git_dirty(roots[repo], pin.get("dirty_paths", []))
        moved = bool(head and pin.get("commit") and head != pin["commit"])
        report["repos"][repo] = {"pinned": pin.get("commit"), "head": head, "moved": moved, "uncommitted": dirty}

    pinned_bundle = lock.get("bundle", {}).get("defs_sha256")
    now_bundle = bundle_digest()
    src_pin = lock["groups"].get("ehf.contracts", {}).get("files", {}).get("packages/contracts/src/index.ts")
    stale_export = bool(BUNDLE.exists() and src_pin
                        and json.loads(BUNDLE.read_text())["x-source"]["sha256"] != current["ehf.contracts"].get("packages/contracts/src/index.ts"))
    report["bundle"] = {"pinned": pinned_bundle, "current": now_bundle, "changed": pinned_bundle != now_bundle,
                        "stale_export": stale_export}
    if report["bundle"]["changed"] or stale_export:
        drift = True

    if args.update:
        selected = set(args.groups or lock['groups'])
        unknown = selected - set(lock['groups'])
        if unknown:
            ap.error('unknown source groups: ' + ', '.join(sorted(unknown)))
        for gid in selected:
            lock["groups"][gid]["files"] = current[gid]
        for repo, pin in lock.get("repos", {}).items():
            if args.groups:
                continue
            head = git_head(roots[repo])
            if head:
                pin["commit"] = head
        if not args.groups or 'ehf.contracts' in selected:
            lock.setdefault("bundle", {})["defs_sha256"] = now_bundle
        LOCK.write_text(json.dumps(lock, indent=2, sort_keys=False) + "\n")
        print(f"re-pinned {sum(len(current[gid]) for gid in selected)} files in {len(selected)} groups")
        if stale_export:
            print("warning: ehf-contracts.schema.json was exported from a different index.ts; re-run export_ehf_contracts.mts")
        return 0

    if args.json:
        print(json.dumps(report, indent=2))
        return 1 if drift else 0

    for gid, r in report["groups"].items():
        mark = {"clean": "ok   ", "watch": "watch", "drift": "DRIFT"}[r["status"]]
        print(f"{mark} {gid}")
        for kind in ("changed", "removed", "added"):
            for f in r[kind]:
                print(f"        {kind:7} {f}")
        if r["status"] != "clean" and r["consumers"]:
            print(f"        re-check: {'; '.join(r['consumers'])}")
    for repo, r in report["repos"].items():
        note = "moved" if r["moved"] else "at pin"
        print(f"repo  {repo}: {note} (pinned {str(r['pinned'])[:7]}, head {str(r['head'])[:7]})")
        for f in r["uncommitted"]:
            print(f"        uncommitted upstream work: {f}")
    b = report["bundle"]
    if b["stale_export"]:
        print("DRIFT upstream/ehf-contracts.schema.json is older than packages/contracts/src/index.ts -> run export_ehf_contracts.mts")
    elif b["changed"]:
        print("DRIFT upstream/ehf-contracts.schema.json $defs changed since pin -> regenerate types, re-run validate_contracts.py")
    print("drift detected" if drift else "no drift")
    return 1 if drift else 0


if __name__ == "__main__":
    sys.exit(main())
