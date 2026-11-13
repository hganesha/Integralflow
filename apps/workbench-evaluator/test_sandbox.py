"""Run inside the evaluator image as root with Docker's normal network enabled.
This exercises the Azure coordinator's actual kernel restrictions, not a mock."""
import sys
sys.path.insert(0, "/opt")
from azure_job import run

program = '''import os, socket
def run(data):
    result = {"uid": os.getuid(), "secret": os.environ.get("PARENT_ONLY_SECRET")}
    try:
        socket.socket()
        result["network"] = "allowed"
    except PermissionError:
        result["network"] = "blocked"
    try:
        open("/proc/1/environ", "rb").read()
        result["parent"] = "readable"
    except PermissionError:
        result["parent"] = "blocked"
    try:
        open("/evaluation/source/main.py", "w").write("changed")
        result["source"] = "writable"
    except PermissionError:
        result["source"] = "read-only"
    return result
'''
payload = {"requestId":"test", "sourceDigest":"a"*64,"files":{"main.py":program},
    "config":{"engine":"python","entrypoint":"main:run","inputSchema":{"type":"object"},"outputSchema":{"type":"object"}},"input":{}}
result = run(payload)
assert result["requestId"] == "test"
assert result["actual"] == {"uid":65534,"secret":None,"network":"blocked","parent":"blocked","source":"read-only"}, result
print("Azure source sandbox: UID, environment, sockets, parent process and source permissions verified")
