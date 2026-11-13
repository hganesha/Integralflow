#!/usr/bin/env python3
"""Check the skill.execution.v1 host in the Linux image using a temporary bearer token."""
import argparse
import json
from pathlib import Path
import secrets
import subprocess
import time

import httpx


def docker(*args, check=True):
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check).stdout.strip()


def smoke(image):
    token = secrets.token_urlsafe(32)
    container_id = None
    try:
        container_id = docker("run", "--rm", "--platform", "linux/amd64", "-d", "-p", "127.0.0.1::8090",
            "-e", "SKILL_HOST_AUTH_TOKEN="+token, image)
        port = json.loads(docker("inspect", container_id))[0]["NetworkSettings"]["Ports"]["8090/tcp"][0]["HostPort"]
        base = f"http://127.0.0.1:{port}"
        with httpx.Client(timeout=3) as client:
            for _ in range(120):
                try:
                    health = client.get(base+"/healthz")
                    if health.status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                time.sleep(0.25)
            else:
                raise RuntimeError("skill host container did not become ready")
            anonymous = client.get(base+"/v1/bundle")
            assert anonymous.status_code == 401, anonymous.text
            headers = {"Authorization": "Bearer "+token}
            bundle = client.get(base+"/v1/bundle", headers=headers)
            assert bundle.status_code == 200, bundle.text
            assert bundle.json()["bundle_digest"] == health.json()["bundle_digest"]
            bad = client.post(base+"/v1/skills/entity.identifiers.validate/executions", headers=headers,
                json={"contract_version": "skill.execution.v1", "permissions": ["all"]})
            assert bad.status_code == 400, bad.text
        inspection = json.loads(docker("image", "inspect", image))[0]
        versions = json.loads(docker("exec", container_id, "python", "-c",
            "import sys,json,importlib.metadata as m; from financial_crime.versions import SCHEMA_VERSION; print(json.dumps({'python':sys.version.split()[0],'release':m.version('financial-crime-skills'),'context_schema_version':SCHEMA_VERSION}))"))
        return {"synthetic": True, "platform": inspection["Os"]+"/"+inspection["Architecture"], "user": inspection["Config"]["User"],
            "image_id": inspection["Id"], "versions": versions, "healthz": 200, "anonymous_denied": anonymous.status_code,
            "authenticated_bundle": bundle.status_code, "malformed_request_denied": bad.status_code,
            "bundle_digest": bundle.json()["bundle_digest"]}
    finally:
        if container_id:
            docker("stop", "--time", "3", container_id, check=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="financial-crime-skills:local")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = smoke(args.image)
    text = json.dumps(report, indent=2)+"\n"
    if args.output:
        args.output.write_text(text)
    print(text, end="")


if __name__ == "__main__":
    main()
