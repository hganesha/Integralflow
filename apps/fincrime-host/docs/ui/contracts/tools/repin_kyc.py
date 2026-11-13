#!/usr/bin/env python3
"""Re-pin only the kyc source groups of SOURCES.lock.json to the in-repository library.

The library now lives in this repository (apps/fincrime-host), so a library release is reviewed in the
same change that re-pins it. The EHF groups keep their pins and their acknowledged drift
(check_sources.py --update would re-pin those too).
"""
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[5]
spec = importlib.util.spec_from_file_location("check_sources", HERE / "check_sources.py")
check_sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_sources)
lock_path = HERE.parent / "SOURCES.lock.json"
lock = json.loads(lock_path.read_text())
current = check_sources.scan(lock, {"kyc": REPO / "apps/fincrime-host", "ehfconcept": REPO})
changed = [gid for gid, group in lock["groups"].items() if group["root"] == "kyc" and group["files"] != current[gid]]
for gid in changed:
    lock["groups"][gid]["files"] = current[gid]
lock_path.write_text(json.dumps(lock, indent=2, sort_keys=False) + "\n")
print(f"re-pinned {len(changed)} kyc group(s)" + (": " + ", ".join(changed) if changed else ""))
