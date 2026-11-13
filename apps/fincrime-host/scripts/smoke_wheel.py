#!/usr/bin/env python3
"""Install a trusted built wheel into an isolated target and run outside the checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheel", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    wheel = args.wheel.resolve()
    with tempfile.TemporaryDirectory(prefix="fc-wheel-") as directory:
        target = Path(directory) / "installed"
        install = subprocess.run([sys.executable, "-m", "pip", "install", "--no-deps", "--target", str(target), str(wheel)], capture_output=True, text=True)
        if install.returncode:
            raise RuntimeError(install.stderr)
        code = "\n".join([
            "import sys,json,asyncio",
            f"sys.path.insert(0,{str(target)!r})",
            "import financial_crime",
            f"assert financial_crime.__file__.startswith({str(target)!r})",
            "from financial_crime.cli import validate_bundle,demo",
            "from financial_crime.versions import RELEASE_VERSION,SCHEMA_VERSION",
            "from financial_crime.contracts import Record",
            "from financial_crime import synthetic",
            "from financial_crime.registry import validate",
            "validate(Record.model_json_schema(),synthetic.records()[0].model_dump(mode='json'))",
            "print(json.dumps({'release':RELEASE_VERSION,'context_schema_version':SCHEMA_VERSION,'bundle':validate_bundle(),'demo':asyncio.run(demo()),'strict_record_contract':True}))",
        ])
        report = json.loads(subprocess.check_output([sys.executable, "-I", "-c", code], cwd=directory, text=True))
        report["wheel_sha256"] = hashlib.sha256(wheel.read_bytes()).hexdigest()
        report["outside_checkout"] = True
        text = json.dumps(report, indent=2)+"\n"
        if args.output:
            args.output.write_text(text)
        print(text, end="")


if __name__ == "__main__":
    main()
