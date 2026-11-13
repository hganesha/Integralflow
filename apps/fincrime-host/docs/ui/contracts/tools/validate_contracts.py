#!/usr/bin/env python3
"""Validate the UI contract pack (v2): OpenAPI, upstream bundles, proposed schemas and every fixture.

Usage (from the kyc repo root):
  python3 docs/ui/contracts/tools/validate_contracts.py [--ehf-root PATH]

Requires jsonschema>=4.18, referencing, pyyaml. Exit code 1 on any failure.
--ehf-root (or $EHF_ROOT, or a sibling ehfconcept checkout) enables the route check:
every x-upstream path must be registered by the pinned control-api / case-api / gateway sources.
--current-ehf-root optionally includes routes added since that pin; schemas remain pinned.
"""
import argparse
import functools
import json
import os
import pathlib
import re
import sys

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

HERE = pathlib.Path(__file__).resolve()
CONTRACTS = HERE.parents[1]
ROOT = CONTRACTS.parent.parent.parent
OPENAPI = CONTRACTS / "experience-api.openapi.yaml"
FIX = CONTRACTS / "fixtures"
EHF_BUNDLE = CONTRACTS / "upstream" / "ehf-contracts.schema.json"
VIEW_BUNDLE = CONTRACTS / "upstream" / "control-ui-views.schema.json"

ap = argparse.ArgumentParser()
ap.add_argument("--ehf-root", type=pathlib.Path,
                default=pathlib.Path(os.environ["EHF_ROOT"]) if os.environ.get("EHF_ROOT") else ROOT.parent / "ehfconcept")
ap.add_argument("--current-ehf-root", type=pathlib.Path, help="Also inspect routes added in the current checkout; preserve pinned legacy routes and schemas.")
args = ap.parse_args()


def load(p):
    p = pathlib.Path(p)
    return yaml.safe_load(p.read_text()) if p.suffix in (".yaml", ".yml") else json.loads(p.read_text())


@functools.lru_cache(maxsize=None)
def retrieve(uri):  # cached: referencing does not keep retrieved resources between validations
    path = pathlib.Path(uri.replace("file://", "").split("#")[0])
    return Resource.from_contents(load(path), default_specification=DRAFT202012)


REG = Registry(retrieve=retrieve)
for bundle in (EHF_BUNDLE, VIEW_BUNDLE):          # bundles carry a urn $id; register it as well
    doc = load(bundle)
    res = DRAFT202012.create_resource(doc)
    REG = REG.with_resource(bundle.as_uri(), res).with_resource(doc["$id"], res)
FC = FormatChecker()
failures, checked = [], 0


_VALIDATORS = {}


def validator(uri):
    if uri not in _VALIDATORS:
        _VALIDATORS[uri] = Draft202012Validator({"$ref": uri}, registry=REG, format_checker=FC)
    return _VALIDATORS[uri]


def api(name): return validator(OPENAPI.as_uri() + f"#/components/schemas/{name}")
def ehf(name): return validator(EHF_BUNDLE.as_uri() + f"#/$defs/{name}")
def view(name): return validator(VIEW_BUNDLE.as_uri() + f"#/$defs/{name}")
def kyc(rel): return validator((ROOT / rel).as_uri())


def check(v, inst, where):
    global checked
    checked += 1
    for e in sorted(v.iter_errors(inst), key=lambda e: list(e.absolute_path))[:5]:
        failures.append(f"{where} :: /{'/'.join(map(str, e.absolute_path))} :: {e.message[:220]}")


def fail(msg):
    failures.append(msg)


# 1. schemas are valid JSON Schema
for p in [*sorted((CONTRACTS / "proposed").glob("*.schema.json")), EHF_BUNDLE, VIEW_BUNDLE]:
    try:
        Draft202012Validator.check_schema(load(p))
        checked += 1
    except Exception as e:  # noqa: BLE001
        fail(f"{p.name} :: invalid schema :: {e}")

# 2. OpenAPI structure + conventions
spec = load(OPENAPI)
try:
    from openapi_spec_validator import validate as oas_validate
    from openapi_spec_validator.readers import read_from_filename
    d, base = read_from_filename(str(OPENAPI))
    oas_validate(d, base_uri=base)
    checked += 1
except ImportError:
    print("note: openapi-spec-validator not installed; relying on `redocly lint` for structure")
except Exception as e:  # noqa: BLE001
    fail(f"openapi :: {str(e)[:300]}")

OPS = {}
for path, methods in spec["paths"].items():
    for m, o in methods.items():
        OPS[o["operationId"]] = (m, path, o)
        where = f"openapi {m.upper()} {path}"
        checked += 1
        if not o.get("x-mock-only") and "x-upstream" not in o and not path.startswith("/auth/"):
            fail(f"{where} :: missing x-upstream")
        if m in ("post", "put", "patch", "delete") and not o.get("x-mock-only") and path != "/auth/callback":
            if {"session": [], "csrf": []} not in o.get("security", []):
                fail(f"{where} :: mutation without csrf security")
        if o.get("x-upstream", {}).get("service") in ("control-api", "case-api", "capability-gateway") and "x-action" not in o:
            fail(f"{where} :: relay without x-action")

# 3. route check against the pinned EHF sources (optional)
ROUTE_FILES = {"control-api": ["apps/control-api/src/app.ts", "apps/control-api/src/governance-routes.ts", "apps/control-api/src/deployment-routes.ts",
                               "apps/control-api/src/deployment-bootstrap-routes.ts", "apps/control-api/src/integration-routes.ts",
                               "apps/control-api/src/policy-authoring.ts", "apps/control-api/src/source-policy-routes.ts",
                               "apps/control-api/src/external-provider-routes.ts", "apps/control-api/src/external-binding-routes.ts",
                               "apps/control-api/src/intelligence-routes.ts", "apps/control-api/src/context-setup-routes.ts", "apps/control-api/src/context-refresh.ts", "apps/control-api/src/context-source-routes.ts", "apps/control-api/src/context-pulls.ts", "apps/control-api/src/platform-operations.ts", "apps/control-api/src/workbench.ts", "apps/control-api/src/draft-test-routes.ts", "apps/control-api/src/document-studio.ts", "apps/control-api/src/document-factory-routes.ts", "apps/control-api/src/sandbox-run-routes.ts", "apps/control-api/src/product-catalog-routes.ts", "apps/control-api/src/user-routes.ts", "apps/control-api/src/authoring-scope.ts", "apps/control-api/src/case-plans.ts"],
               "case-api": ["apps/case-api/src/app.ts", "apps/case-api/src/document-search.ts"], "capability-gateway": ["apps/capability-gateway/src/app.ts", "apps/capability-gateway/src/context-source-routes.ts"]}
if args.ehf_root.is_dir():
    registered = {}
    for svc, files in ROUTE_FILES.items():
        rs = set()
        roots = [args.ehf_root] + ([args.current_ehf_root] if args.current_ehf_root else [])
        for root in roots:
            for f in files:
                p = root / f
                if p.exists():
                    for m, route in re.findall(r'''(?:app|routes)\.(get|post|put|patch|delete)(?:<[^(]*?>)?\(\s*["']([^"']+)["']''', p.read_text()):
                        rs.add((m.upper(), route.replace("::", ":")))
        registered[svc] = rs

    def norm(route):  # :param and :paramAction collapse to one placeholder per segment
        route = re.sub(r"\{([A-Za-z]+)\}", r":\1", route)
        return re.sub(r":[A-Za-z]+(?=/|$)", ":_", re.sub(r"/:[A-Za-z]+:[a-z]+$", "/:_", route))

    for oid, (m, path, o) in OPS.items():
        u = o.get("x-upstream", {})
        if u.get("service") in registered and u.get("path"):
            want = (u["method"], norm(u["path"].split("?")[0]))
            have = {(mm, norm(r)) for mm, r in registered[u["service"]]}
            checked += 1
            if want not in have:
                fail(f"route {u['service']} {u['method']} {u['path']} (for {oid}) :: not registered upstream")
else:
    print(f"note: {args.ehf_root} not found; skipping upstream route check")

# 4. fixtures
per = load(FIX / "personas.json")
role_actions = per["roleActions"]
for p in per["personas"]:
    check(api("Persona"), p["persona"], f"personas/{p['persona']['personaId']}")
    check(api("Session"), p["session"], f"personas/{p['persona']['personaId']}/session")
    want = sorted({a for r in p["session"]["roles"] for a in role_actions[r]})
    if want != p["session"]["actions"]:
        fail(f"personas/{p['persona']['personaId']} :: actions do not equal the union of its roles")

cat = load(FIX / "fincrime.catalog.json")
check(api("CatalogView"), cat["catalog"], "fincrime.catalog/catalog")
for s in cat["skills"]:
    check(api("SkillSummary"), s, f"fincrime.catalog/skills/{s['skill_id']}")
for k, t in cat["tasks"].items():
    check(api("TaskComposition"), t, f"fincrime.catalog/tasks/{k}")
for k, pv in cat["contextProducts"].items():
    check(api("ContextProductView"), pv, f"fincrime.catalog/contextProducts/{k}")
check(api("ContextReadinessMatrix"), cat["readiness"], "fincrime.catalog/readiness")
agent_ids = {a["id"] for a in cat["catalog"]["agents"]}
task_ids = {t["id"] for t in cat["catalog"]["tasks"]}
for a in cat["catalog"]["agents"]:
    checked += 1
    if not set(a["task_ids"]) <= task_ids:
        fail(f"catalog agent {a['id']} :: unknown task ids")

store = load(FIX / "ehf.kyb-1042.json")
for sname, st in store["states"].items():
    w = f"ehf/{sname}"
    check(ehf("caseSnapshot"), st["snapshot"], f"{w}/snapshot")
    check(view("CaseSummaryView"), st["caseSummary"], f"{w}/caseSummary")
    check(ehf("runRecord"), st["run"], f"{w}/run")
    for x in st["workItems"]:
        check(ehf("executionWorkItem"), x, f"{w}/workItems/{x['workItemId']}")
    for x in st["humanQueue"]:
        check(api("HumanQueueItem"), x, f"{w}/humanQueue/{x['workItem']['workItemId']}")
    for x in st["decisions"]:
        check(ehf("humanWorkDecision"), x, f"{w}/decisions/{x['decisionId']}")
    for x in st["runEvents"]:
        check(ehf("runtimeEvent"), x, f"{w}/runEvents/{x['sequence']}")
    for x in st["releases"]:
        check(ehf("releaseRecord"), x, f"{w}/releases/{x['releaseId']}")
    for x in st["caseEvents"]:
        check(api("CaseEventRow"), x, f"{w}/caseEvents/{x['sequence']}")
    checked += 1
    if st["snapshot"]["caseSequence"] != max(e["sequence"] for e in st["caseEvents"]):
        fail(f"{w} :: snapshot caseSequence != last case event")

scn = load(FIX / "scenario.kyb-1042.json")
SCHEMA_OF = {"attention": "AttentionQueue", "caseRoom": "CaseRoom", "claims": "ClaimsView", "ownership": "OwnershipView", "screening": "ScreeningView",
             "decision": "DecisionDesk", "recorder": "FlightRecorder", "causality": "CausalGraph", "lineage": "LineageGraph",
             "missionControl": "MissionControl", "agents": "AgentAtlas"}
for sname, st in scn["states"].items():
    w = f"scenario/{sname}"
    for key, sch in SCHEMA_OF.items():
        if st.get(key) is not None:
            check(api(sch), st[key], f"{w}/{key}")
    for k, v in st["contradictions"].items():
        check(api("ContradictionDetail"), v, f"{w}/contradictions/{k}")
    for k, v in st["screeningComparisons"].items():
        check(api("ScreeningComparison"), v, f"{w}/screeningComparisons/{k}")
    for o in st["ownershipOptions"]:
        check(api("DecisionOption"), o, f"{w}/ownershipOptions/{o['decision']}")
    ehf_st = store["states"][sname]
    checked += 1
    if st["caseRoom"]["caseSequence"] != ehf_st["snapshot"]["caseSequence"] or st["caseRoom"]["snapshotDigest"] != ehf_st["snapshot"]["snapshotDigest"]:
        fail(f"{w} :: case room basis differs from the EHF snapshot")
    if st.get("decision"):
        checked += 1
        if st["decision"]["basis"] != {"caseSequence": ehf_st["snapshot"]["caseSequence"], "snapshotDigest": ehf_st["snapshot"]["snapshotDigest"]}:
            fail(f"{w} :: decision basis differs from the EHF snapshot")
    for a in st["agents"]["agents"]:
        checked += 1
        if a["agent"]["id"] not in agent_ids:
            fail(f"{w} :: unknown agent {a['agent']['id']}")
for t in scn["transitions"]:
    checked += 1
    if t["on"]["operation"] not in OPS:
        fail(f"transition {t['from']}->{t['to']} :: unknown operation {t['on']['operation']}")
    wis = {x["workItem"]["workItemId"] for x in store["states"][t["from"]]["humanQueue"]}
    if t["on"]["workItemId"] not in wis:
        fail(f"transition {t['from']}->{t['to']} :: work item {t['on']['workItemId']} not open in {t['from']}")

plat = load(FIX / "platform.json")
for key, sch in {"overview": "OverviewView", "system": "SystemView", "gatewayStatus": "GatewayStatusView"}.items():
    check(view(sch), plat[key], f"platform/{key}")
for key, sch in {"drafts": "AuthoringDraftView", "harnesses": "HarnessSummary", "runs": "RunSummary", "cases": "CaseSummaryView", "modelTiers": "ModelTierProfileView",
                 "providers": "AdminProviderItemView", "modelProfiles": "AdminModelProfileView", "settings": "AdminSettingSectionView", "changeLog": "AdminChangeView"}.items():
    for i, x in enumerate(plat[key]):
        check(view(sch), x, f"platform/{key}/{i}")
for x in plat["releases"]:
    check(ehf("releaseRecord"), x, f"platform/releases/{x['releaseId']}")

recs = load(FIX / "records.kyb-1042.json")["records"]
for r in recs:
    check(kyc("schemas/runtime/Record.schema.json"), r, f"records/{r.get('object_type')}/{r.get('object_id')}")

print(f"{checked} checks, {len(failures)} failures")
for f in failures[:80]:
    print("  ✗", f)
sys.exit(1 if failures else 0)
