"""Trusted I/O coordinator. The source process has a different UID, no credentials,
no sockets, bounded CPU/output and no write access to the input or source tree."""
import ctypes
import errno
import json
import os
from pathlib import Path
import resource
import subprocess
import urllib.request

def isolate():
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    resource.setrlimit(resource.RLIMIT_FSIZE, (512_000, 512_000))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0: raise RuntimeError("sandbox")  # no_new_privs
    seccomp = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    context = seccomp.seccomp_init(0x7FFF0000)  # allow by default
    if not context: raise RuntimeError("sandbox")
    for name in (b"socket", b"socketpair", b"connect", b"ptrace", b"process_vm_readv", b"process_vm_writev", b"bpf", b"mount", b"unshare", b"keyctl"):
        syscall = seccomp.seccomp_syscall_resolve_name(name)
        if syscall >= 0 and seccomp.seccomp_rule_add(context, 0x00050000 | errno.EPERM, syscall, 0) != 0: raise RuntimeError("sandbox")
    if seccomp.seccomp_load(context) != 0: raise RuntimeError("sandbox")
    seccomp.seccomp_release(context)
    os.setgroups([])
    os.setgid(65534)
    os.setuid(65534)

def run(payload):
    root = Path("/evaluation")
    root.mkdir(mode=0o755)
    for path, content in payload["files"].items():
        parts = path.split("/")
        if path.startswith("/") or "\\" in path or any(part in ("", ".", "..") for part in parts): raise ValueError("path")
        target = root / "source" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        target.chmod(0o444)
    for directory, _, _ in os.walk(root / "source"):
        Path(directory).chmod(0o555)
    (root / "input.json").write_text(json.dumps({"config": payload["config"], "input": payload["input"]}))
    (root / "input.json").chmod(0o444)
    private = Path("/private")
    private.mkdir(mode=0o700)
    with (private / "stdout").open("wb") as output, (private / "stderr").open("wb") as errors:
        process = subprocess.run(["python", "/opt/runner.py"], stdout=output, stderr=errors, timeout=15, close_fds=True,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "PYTHONDONTWRITEBYTECODE": "1"}, preexec_fn=isolate)
    if process.returncode != 0: raise ValueError("source")
    result = json.loads((private / "stdout").read_bytes())
    return {"requestId": payload["requestId"], "sourceDigest": payload["sourceDigest"], **result}

def main():
    payload = None
    try:
        with urllib.request.urlopen(os.environ["WORKBENCH_INPUT_URL"], timeout=30) as response:
            payload = json.loads(response.read(12_000_000))
        result = run(payload)
    except Exception:
        if payload is None: raise RuntimeError("workbench.input_unavailable") from None
        result = {"requestId":payload["requestId"],"sourceDigest":payload["sourceDigest"],"error":"workbench.source_test_failed"}
    data = json.dumps(result, allow_nan=False).encode()
    request = urllib.request.Request(os.environ["WORKBENCH_OUTPUT_URL"], data=data, method="PUT",
        headers={"x-ms-blob-type":"BlockBlob","content-type":"application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status not in (200,201): raise RuntimeError("workbench.output_unavailable")

if __name__ == "__main__":
    try: main()
    except Exception:
        print("workbench.azure_job_failed", file=__import__("sys").stderr)
        raise SystemExit(1)
