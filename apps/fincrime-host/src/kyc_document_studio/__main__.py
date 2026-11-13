"""Serve stateless Studio helpers alongside the unchanged, pinned library host."""
import asyncio
import json
import os
from http.server import ThreadingHTTPServer

from financial_crime.contracts import SkillError
from financial_crime.runtimes.skill_host import GATEWAY_CALLER, SkillHost, make_handler as skill_handler
from financial_crime.runtimes.workload_identity import CallerVerifier, OutboundToken, WorkloadIdentityError
from . import prepare, evaluate


def make_handler(host, studio_authorized=None):
    authorize = studio_authorized or host.authorized

    class Handler(skill_handler(host)):
        def do_POST(self):
            if self.path not in ("/v1/document-studio/prepare", "/v1/document-studio/evaluate"):
                return super().do_POST()
            if not authorize(self.headers.get("Authorization")):
                return self._error(401, "ACCESS_DENIED")
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= 4 * 1024 * 1024:
                    return self._error(400, "INPUT_INVALID")
                body = json.loads(self.rfile.read(length))
                result = prepare(body) if self.path.endswith("/prepare") else asyncio.run(evaluate(body))
                return self._send(200, result)
            except SkillError as error:
                return self._error(422, error.code)
            except (KeyError, TypeError, ValueError):
                return self._error(400, "INPUT_INVALID")
    return Handler


def main():
    try:
        verifier = CallerVerifier({GATEWAY_CALLER: "SKILL_HOST_AUTH_TOKEN", "control-api": "DOCUMENT_STUDIO_SKILL_HOST_TOKEN"})
        outbound = OutboundToken("SKILL_HOST_GATEWAY_TOKEN")
    except WorkloadIdentityError as error:
        raise SystemExit(str(error)) from None
    host = SkillHost(verifier=verifier, gateway_token=outbound)
    def studio_authorized(header):
        return verifier.caller(header) in (GATEWAY_CALLER, "control-api")

    ThreadingHTTPServer((os.environ.get("SKILL_HOST_BIND", "0.0.0.0"), int(os.environ.get("SKILL_HOST_PORT", "8090"))), make_handler(host, studio_authorized)).serve_forever()


if __name__ == "__main__":
    main()
