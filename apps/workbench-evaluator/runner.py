"""A computation runner inside a disposable container. Grading stays in the control plane."""
import asyncio
import contextlib
import importlib
import inspect
import json
import sys
import subprocess
from pathlib import Path
from types import SimpleNamespace

sys.path[:0] = ["/evaluation/source", "/evaluation/source/src"]

def main():
    payload = json.loads(Path("/evaluation/input.json").read_text())
    config, data = payload["config"], payload["input"]
    from jsonschema import Draft202012Validator, FormatChecker
    parameters = data.get("execution", {}).get("invocation", {}).get("parameters", data.get("parameters", data)) if config["engine"] == "library-skill" else data
    Draft202012Validator(config["inputSchema"], format_checker=FormatChecker()).validate(parameters)
    if config["engine"] == "javascript":
        result = subprocess.run(["node", "/opt/runner.mjs"], capture_output=True, timeout=12)
        if result.returncode != 0: raise ValueError("JavaScript execution failed")
        output = json.loads(result.stdout)
        if "error" in output: raise ValueError("JavaScript execution failed")
        Draft202012Validator(config["outputSchema"], format_checker=FormatChecker()).validate(output["actual"])
        return output["actual"]
    module, function = config["entrypoint"].split(":", 1)
    # Module loading is confined by the container, not by Python import restrictions.
    with contextlib.redirect_stdout(sys.stderr):
        handler = getattr(importlib.import_module(module), function)
        if config["engine"] == "library-skill":
            from financial_crime.context import Context
            from financial_crime.contracts import Record, RecordView, Computation, canonical
            from financial_crime.store import Store
            records = {}
            fixture = data if isinstance(data, dict) else {}
            if "execution" in fixture:
                from financial_crime.execution import Executor
                from financial_crime.contracts import AgentProfile, Principal, Invocation
                from financial_crime.providers import Router, RecordedProvider, ProviderResponse
                execution = fixture["execution"]
                store = Store()
                for record in execution.get("records", []): store.put(Record.model_validate(record))
                providers = {}
                for capability, responses in execution.get("providers", {}).items():
                    providers[capability] = RecordedProvider([ProviderResponse.model_validate(value) for value in responses])
                executor = Executor(store, [AgentProfile.model_validate(execution["profile"])], Router(providers))
                result = asyncio.run(executor.run(Invocation.model_validate(execution["invocation"]), Principal.model_validate(execution["principal"])))
                actual = json.loads(canonical(result if execution.get("resultEnvelope") else result.payload))
                store.close()
                Draft202012Validator(config["outputSchema"], format_checker=FormatChecker()).validate(actual)
                return actual
            for raw in fixture.get("records", []):
                record = Record.model_validate(raw)
                records.setdefault(record.object_type, []).append(RecordView.project(record, list(record.data)))
            context = Context(records, SimpleNamespace(synthetic=True), fixture.get("policy", {}))
            store = Store()
            class Services:
                invocation = SimpleNamespace(tenant_id=fixture.get("tenantId", "evaluation"), case_id=fixture.get("caseId", "case-evaluation"), execution_id="evaluation", actor_ref="evaluation", parameters=parameters)
                principal = SimpleNamespace(actor_id="evaluation", permissions=set(fixture.get("permissions", [])))
                captures = []
                synthetic = True
                def state(self, kind, object_id=None):
                    return (0, fixture.get("state", {}).get(kind, {}))
                async def provider(self, capability, body):
                    from financial_crime.providers import ProviderResponse
                    if capability not in fixture.get("providers", {}):
                        raise ValueError("No dataset fixture for provider " + capability)
                    return ProviderResponse.model_validate(fixture["providers"][capability])
            services = Services()
            services.store = store
            result = handler(parameters, context, services)
            if inspect.isawaitable(result): result = asyncio.run(result)
            if isinstance(result, Computation): result = result.payload
            result = json.loads(canonical(result))
            store.close()
        else:
            result = handler(data)
            if inspect.isawaitable(result): result = asyncio.run(result)
    # Schema checks apply to the edited revision's contracts.
    Draft202012Validator(config["outputSchema"], format_checker=FormatChecker()).validate(result)
    return result

try:
    print(json.dumps({"actual": main()}, allow_nan=False, separators=(",", ":")))
except Exception as error:
    trace = error.__traceback__
    location = ""
    while trace:
        file = trace.tb_frame.f_code.co_filename
        if file.startswith("/evaluation/source/"): location = " at " + file.removeprefix("/evaluation/source/") + ":" + str(trace.tb_lineno)
        trace = trace.tb_next
    print(json.dumps({"error": "workbench.source_test_failed:" + type(error).__name__ + location}))
