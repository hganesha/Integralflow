"""Acceptance tests for the evidence.* skills.

Each test names the acceptance criterion it encodes (the skill's "Examples and acceptance" or the
generic fail-closed contract: missing context is an evidence gap, unresolved policy is never a pass,
contradictory inputs are preserved and flagged rather than merged, and an integrity or lineage
check never passes on nothing).
"""
import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Status, digest
from financial_crime.execution import Executor
from financial_crime.store import Store
from financial_crime.versions import SCHEMA_VERSION

TENANT = "tenant-synthetic"
POLICY_ID = "synthetic-policy-v1"
SOURCE_TEXT = "Synthetic source: Acme exists and Alice is its owner."
COVERAGE = {"complete": True, "jurisdictions": ["synthetic-neutral"], "as_of": f.OLD.isoformat(), "limitations": ["synthetic test source only"]}


def ref(object_type, object_id, version="v1"):
    return {"tenant_id": TENANT, "object_type": object_type, "object_id": object_id, "version_id": version, "schema_version": SCHEMA_VERSION}


@pytest.fixture
def build():
    """Build a fresh synthetic store: all seeded records except `without` types, plus `extra` records
    (tuples or Records), and the synthetic policy with `policy` overrides and `drop` keys removed."""
    stores = []

    def make(*, without=(), extra=(), policy=None, drop=()):
        store = Store()
        stores.append(store)
        data = {**f.policy(), **(policy or {})}
        for key in drop:
            data.pop(key)
        store.put(f.make_record("Policy", POLICY_ID, data))
        for record in f.records():
            if record.object_type not in without:
                store.put(record)
        for item in extra:
            store.put(item if not isinstance(item, tuple) else f.make_record(*item))
        store.set_state(TENANT, "case", "case-demo", 0, {"state": "OPEN", "case_type": "KYB"})
        return store, Executor(store, [f.profile()], f.router()), f.principal()

    yield make
    for store in stores:
        store.close()


async def run(executor, principal, skill_id, parameters=None):
    request = f.invocation(skill_id, **({"parameters": parameters} if parameters is not None else {}))
    if parameters is not None:
        request = request.model_copy(update={"idempotency_key": skill_id + "-" + digest(parameters)[:16]})
    return await executor.run(request, principal)


def assert_not_favourable(result, code, status):
    assert result.status == status and result.lifecycle == "FAILED"
    assert result.error["code"] == code and result.payload == {}


def unresolved(result):
    return [(u["code"], u["subject_ref"]) for u in result.unresolved_items]


def evidence(key, content=SOURCE_TEXT, *, content_hash=None, source_id="source-1", requirement_ids=("identity",), verified=True):
    return ("Evidence", key, {"content": content, "content_hash": content_hash or digest(content), "source_id": source_id,
                              "requirement_ids": list(requirement_ids), "verified": verified})


def corrected(object_type, object_id, data, version="v2"):
    """A later version of a seeded record (recorded after v1, before the invocation)."""
    return f.make_record(object_type, object_id, data).model_copy(update={"version_id": version, "recorded_at": f.AT})


# ---------------------------------------------------------------------------------- evidence.collect

async def test_collect_positive_example(build):
    """Normal input: source-1 (synthetic-authority, complete coverage) is collected with its ref, content hash and coverage."""
    _, executor, principal = build()
    result = await run(executor, principal, "evidence.collect")
    assert result.status == Status.COMPLETED
    assert result.payload == {"artifacts": [{"ref": ref("SourceRecord", "source-1"), "content_hash": digest(SOURCE_TEXT),
                                             "source": "synthetic-authority", "coverage": COVERAGE}]}


async def test_collect_incomplete_coverage_is_partial(build):
    """Domain edge: a source reporting incomplete coverage is collected but PARTIAL with EVIDENCE_INSUFFICIENT for that record."""
    partial = {**COVERAGE, "complete": False}
    _, executor, principal = build(extra=[("SourceRecord", "source-2", {"content": "Partial register page", "source": "synthetic-registry", "coverage": partial})])
    result = await run(executor, principal, "evidence.collect")
    assert result.status == Status.PARTIAL
    assert [(a["ref"]["object_id"], a["coverage"]["complete"]) for a in result.payload["artifacts"]] == [("source-1", True), ("source-2", False)]
    assert unresolved(result) == [("EVIDENCE_INSUFFICIENT", "source-2")]


async def test_collect_without_sources_needs_evidence(build):
    """Missing evidence: no admitted SourceRecord is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("SourceRecord",))
    assert_not_favourable(await run(executor, principal, "evidence.collect"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# -------------------------------------------------------------------------------- evidence.normalize

async def test_normalize_positive_example(build):
    """Normal input: evidence-1 keeps its raw content and source id, with the content hash added."""
    _, executor, principal = build()
    result = await run(executor, principal, "evidence.normalize")
    assert result.status == Status.COMPLETED
    assert result.payload == {"evidence": [{"id": "evidence-1", "source_id": "source-1", "hash": digest(SOURCE_TEXT), "content": SOURCE_TEXT}]}


async def test_normalize_keeps_a_structured_artifact_as_supplied(build):
    """Domain edge: structured artifact content is returned unchanged, hashed over its canonical form."""
    artifact = {"media_type": "application/json", "encoding": "utf-8", "value": {"name": "Acme"}}
    _, executor, principal = build(without=("Evidence",), extra=[evidence("evidence-json", artifact)])
    result = await run(executor, principal, "evidence.normalize")
    assert result.payload == {"evidence": [{"id": "evidence-json", "source_id": "source-1", "hash": digest(artifact), "content": artifact}]}


async def test_normalize_without_evidence_needs_evidence(build):
    """Missing evidence: no admitted Evidence is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("Evidence",))
    assert_not_favourable(await run(executor, principal, "evidence.normalize"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ----------------------------------------------------------------------- evidence.provenance.attach

async def test_provenance_attach_positive_example(build):
    """Normal input: evidence-1 is linked to source-1, its own record version and its content hash."""
    _, executor, principal = build()
    result = await run(executor, principal, "evidence.provenance.attach")
    assert result.status == Status.COMPLETED
    assert result.payload == {"lineage": [{"evidence_id": "evidence-1", "source_id": "source-1", "source_ref": ref("Evidence", "evidence-1"),
                                           "content_hash": digest(SOURCE_TEXT)}]}


async def test_provenance_attach_links_the_corrected_version(build):
    """Changed basis: a corrected v2 of evidence-1 is linked by its v2 ref and v2 content hash, not the superseded v1."""
    text = "Synthetic source: Acme exists; Alice owns 60%."
    _, executor, principal = build(extra=[corrected(*evidence("evidence-1", text))])
    result = await run(executor, principal, "evidence.provenance.attach")
    assert result.payload["lineage"] == [{"evidence_id": "evidence-1", "source_id": "source-1", "source_ref": ref("Evidence", "evidence-1", "v2"),
                                          "content_hash": digest(text)}]


async def test_provenance_attach_without_evidence_needs_evidence(build):
    """Missing evidence: no admitted Evidence is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("Evidence",))
    assert_not_favourable(await run(executor, principal, "evidence.provenance.attach"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ------------------------------------------------------------------------ evidence.integrity.verify

async def test_integrity_verify_positive_example(build):
    """Normal input: evidence-1's content matches its recorded hash: valid, COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "evidence.integrity.verify")
    assert result.status == Status.COMPLETED and result.payload == {"checks": [{"id": "evidence-1", "valid": True}], "valid": True}


async def test_integrity_verify_altered_content_needs_review(build):
    """Contradictory input: content changed after its hash was recorded fails that check: NEEDS_REVIEW with INTEGRITY_FAILURE."""
    altered = evidence("evidence-2", "Synthetic source: Acme exists and Bob is its owner.", content_hash=digest(SOURCE_TEXT))
    _, executor, principal = build(extra=[altered])
    result = await run(executor, principal, "evidence.integrity.verify")
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload == {"checks": [{"id": "evidence-1", "valid": True}, {"id": "evidence-2", "valid": False}], "valid": False}
    assert unresolved(result) == [("INTEGRITY_FAILURE", "evidence-2")]


async def test_integrity_verify_without_evidence_needs_evidence(build):
    """Missing evidence: nothing to verify is CONTEXT_MISSING / NEEDS_EVIDENCE, never valid."""
    _, executor, principal = build(without=("Evidence",))
    assert_not_favourable(await run(executor, principal, "evidence.integrity.verify"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- evidence.facts.extract

def assertion(key, *, status="VERIFIED", method="synthetic-authority", evidence_ids=("evidence-1",), field="name", value="Acme"):
    return ("Assertion", key, {"subject": "acme", "field": field, "value": value, "claim": f"The {field} is {value}.",
                               "evidence_ids": list(evidence_ids), "verification": {"status": status, "method": method}})


async def test_facts_extract_positive_example(build):
    """Normal input: assertion-1, VERIFIED by synthetic-authority (a policy method) citing evidence-1, is a verified fact."""
    _, executor, principal = build()
    result = await run(executor, principal, "evidence.facts.extract")
    assert result.status == Status.COMPLETED
    assert [x["id"] for x in result.payload["assertions"]] == ["assertion-1"]
    assert [x["id"] for x in result.payload["verified_facts"]] == ["assertion-1"]


async def test_facts_extract_unverified_assertions_stay_assertions(build):
    """An unverified assertion, one verified by a method outside the policy, or one citing no evidence is listed but not a fact."""
    extra = [assertion("a-unverified", status="UNVERIFIED"), assertion("a-self-declared", method="self-declared"), assertion("a-uncited", evidence_ids=())]
    _, executor, principal = build(extra=extra)
    result = await run(executor, principal, "evidence.facts.extract")
    assert [x["id"] for x in result.payload["assertions"]] == ["a-self-declared", "a-uncited", "a-unverified", "assertion-1"]
    assert [x["id"] for x in result.payload["verified_facts"]] == ["assertion-1"]


async def test_facts_extract_without_methods_policy_is_unresolved(build):
    """Unresolved policy: no `verification_methods` is POLICY_UNRESOLVED / BLOCKED, never 'nothing verified'."""
    _, executor, principal = build(drop=("verification_methods",))
    assert_not_favourable(await run(executor, principal, "evidence.facts.extract"), "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_facts_extract_without_assertions_needs_evidence(build):
    """Missing evidence: no admitted Assertion is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("Assertion",))
    assert_not_favourable(await run(executor, principal, "evidence.facts.extract"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ------------------------------------------------------------------------ evidence.conflicts.resolve

async def test_conflicts_resolve_positive_example(build):
    """Normal input: assertion-1 (acme name Acme) and an agreeing second source: no conflict, COMPLETED."""
    _, executor, principal = build(extra=[assertion("assertion-2", evidence_ids=("evidence-2",))])
    result = await run(executor, principal, "evidence.conflicts.resolve")
    assert result.status == Status.COMPLETED and result.payload == {"conflicts": []} and result.unresolved_items == []


@pytest.mark.parametrize("value", ["Acme Holdings", "ACME"])
async def test_conflicts_resolve_keeps_both_values_for_review(build, value):
    """Contradictory input: Acme vs Acme Holdings (or ACME: values are compared exactly) is one UNRESOLVED conflict holding
    both assertions: NEEDS_REVIEW with SOURCE_CONFLICT on acme."""
    _, executor, principal = build(extra=[assertion("assertion-2", value=value, evidence_ids=("evidence-2",))])
    result = await run(executor, principal, "evidence.conflicts.resolve")
    assert result.status == Status.NEEDS_REVIEW
    [conflict] = result.payload["conflicts"]
    assert (conflict["subject"], conflict["field"], conflict["resolution"]) == ("acme", "name", "UNRESOLVED")
    assert [(a["id"], a["value"]) for a in conflict["assertions"]] == [("assertion-1", "Acme"), ("assertion-2", value)]
    assert unresolved(result) == [("SOURCE_CONFLICT", "acme")]


async def test_conflicts_resolve_without_assertions_needs_evidence(build):
    """Missing evidence: no admitted Assertion is CONTEXT_MISSING / NEEDS_EVIDENCE, not 'no conflicts'."""
    _, executor, principal = build(without=("Assertion",))
    assert_not_favourable(await run(executor, principal, "evidence.conflicts.resolve"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------- evidence.sufficiency.assess

TWO_REQUIREMENTS = {"requirements": [{"id": "identity"}, {"id": "ubo"}]}


async def test_sufficiency_positive_example(build):
    """Normal input: the single policy requirement identity is covered by verified evidence-1: sufficient."""
    _, executor, principal = build()
    result = await run(executor, principal, "evidence.sufficiency.assess")
    assert result.status == Status.COMPLETED and result.payload == {"sufficient": True, "missing": []}


async def test_sufficiency_is_judged_per_requirement_not_by_count(build):
    """Three verified identity items and one for an unlisted requirement do not cover ubo: insufficient, missing ubo."""
    extra = [evidence("evidence-2"), evidence("evidence-3"), evidence("evidence-4", requirement_ids=("sanctions",))]
    _, executor, principal = build(policy=TWO_REQUIREMENTS, extra=extra)
    result = await run(executor, principal, "evidence.sufficiency.assess")
    assert result.payload == {"sufficient": False, "missing": ["ubo"]}


async def test_sufficiency_unverified_evidence_does_not_cover(build):
    """Missing evidence: evidence for ubo that is not verified leaves ubo missing."""
    _, executor, principal = build(policy=TWO_REQUIREMENTS, extra=[evidence("evidence-2", requirement_ids=("ubo",), verified=False)])
    result = await run(executor, principal, "evidence.sufficiency.assess")
    assert result.status == Status.COMPLETED and result.payload == {"sufficient": False, "missing": ["ubo"]}


async def test_sufficiency_without_requirements_policy_is_unresolved(build):
    """Unresolved policy: no `requirements` is POLICY_UNRESOLVED / BLOCKED, never sufficient."""
    _, executor, principal = build(drop=("requirements",))
    assert_not_favourable(await run(executor, principal, "evidence.sufficiency.assess"), "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_sufficiency_without_evidence_needs_evidence(build):
    """Missing evidence: no admitted Evidence is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("Evidence",))
    assert_not_favourable(await run(executor, principal, "evidence.sufficiency.assess"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- evidence.lineage.trace

def provenance(key, target, sources):
    return ("Provenance", key, {"target": target, "sources": list(sources)})


async def test_lineage_trace_positive_example(build):
    """Normal input: finding-1 derives from evidence-1: sources [evidence-1], no cycles."""
    _, executor, principal = build()
    result = await run(executor, principal, "evidence.lineage.trace", {"target": "finding-1"})
    assert result.status == Status.COMPLETED and result.payload == {"sources": ["evidence-1"], "cycles": []}


async def test_lineage_trace_returns_roots_through_intermediate_derivations(build):
    """finding-1 <- summary-1 <- evidence-1, evidence-2: the roots are the two evidence items, not the summary."""
    _, executor, principal = build(without=("Provenance",), extra=[provenance("p-1", "finding-1", ["summary-1"]),
                                                                    provenance("p-2", "summary-1", ["evidence-1", "evidence-2"])])
    result = await run(executor, principal, "evidence.lineage.trace", {"target": "finding-1"})
    assert result.payload == {"sources": ["evidence-1", "evidence-2"], "cycles": []}


async def test_lineage_trace_unrecorded_target_needs_evidence(build):
    """Missing evidence: a target no provenance derives (finding-9) is EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE, not 'no sources'."""
    _, executor, principal = build()
    result = await run(executor, principal, "evidence.lineage.trace", {"target": "finding-9"})
    assert_not_favourable(result, "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


async def test_lineage_trace_cycle_needs_review(build):
    """Contradictory input: finding-1 <- derived-1 <- finding-1 has no root: NEEDS_REVIEW with the cycle and INTEGRITY_FAILURE."""
    _, executor, principal = build(without=("Provenance",), extra=[provenance("p-1", "finding-1", ["derived-1"]),
                                                                    provenance("p-2", "derived-1", ["finding-1"])])
    result = await run(executor, principal, "evidence.lineage.trace", {"target": "finding-1"})
    assert result.status == Status.NEEDS_REVIEW and result.payload["sources"] == []
    assert [sorted(c) for c in result.payload["cycles"]] == [["derived-1", "finding-1"]]
    assert unresolved(result) == [("INTEGRITY_FAILURE", "finding-1")]


# -------------------------------------------------------------------------- evidence.bundle.compile

async def test_bundle_compile_positive_example(build):
    """Normal input: evidence-1 is the manifest's one item (ref, content hash, source); the bundle hash is the manifest's hash."""
    _, executor, principal = build()
    result = await run(executor, principal, "evidence.bundle.compile")
    manifest = [{"ref": ref("Evidence", "evidence-1"), "hash": digest(SOURCE_TEXT), "source_id": "source-1"}]
    assert result.status == Status.COMPLETED and result.payload == {"manifest": manifest, "bundle_hash": digest(manifest)}


async def test_bundle_compile_is_ordered_by_evidence_id(build):
    """Items are ordered by evidence ID whatever order they were recorded in, so equal inputs give an equal bundle hash."""
    _, executor, principal = build(without=("Evidence",), extra=[evidence("ev-b", "Second"), evidence("ev-a", "First")])
    result = await run(executor, principal, "evidence.bundle.compile")
    assert [x["ref"]["object_id"] for x in result.payload["manifest"]] == ["ev-a", "ev-b"]
    assert result.payload["bundle_hash"] == digest(result.payload["manifest"])


async def test_bundle_compile_changed_evidence_changes_the_bundle_hash(build):
    """Changed basis: a corrected v2 of evidence-1 is bundled by its v2 ref, and the bundle hash changes."""
    _, executor, principal = build()
    before = (await run(executor, principal, "evidence.bundle.compile")).payload
    _, executor, principal = build(extra=[corrected(*evidence("evidence-1", "Corrected source text."))])
    after = (await run(executor, principal, "evidence.bundle.compile")).payload
    assert after["manifest"][0]["ref"] == ref("Evidence", "evidence-1", "v2") and after["bundle_hash"] != before["bundle_hash"]


async def test_bundle_compile_without_evidence_needs_evidence(build):
    """Missing evidence: no admitted Evidence is CONTEXT_MISSING / NEEDS_EVIDENCE, never an empty bundle."""
    _, executor, principal = build(without=("Evidence",))
    assert_not_favourable(await run(executor, principal, "evidence.bundle.compile"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ----------------------------------------------------------------------- evidence.retention.enforce

def rule(key, object_id, *, retain_until=f.START, legal_hold=False):
    return ("RetentionRule", key, {"retain_until": retain_until, "legal_hold": legal_hold, "object_id": object_id})


async def retention(build, rules):
    _, executor, principal = build(without=("RetentionRule",), extra=rules)
    return await run(executor, principal, "evidence.retention.enforce")


async def test_retention_expired_record_is_proposed_for_deletion_after_review(build):
    """Normal input: evidence-1 retained until 2026-11-01, no hold: a deletion candidate, waiting for an independent reviewer."""
    result = await retention(build, [rule("retention-1", "evidence-1")])
    assert result.status == Status.NEEDS_REVIEW and result.lifecycle == "WAITING_FOR_HUMAN" and not result.effects_committed
    assert result.payload == {"deletion_candidates": ["evidence-1"], "held": []}


async def test_retention_unexpired_record_is_kept(build):
    """A record retained until 2027 is neither a candidate nor held."""
    result = await retention(build, [rule("retention-1", "evidence-1", retain_until=f.FUTURE)])
    assert result.payload == {"deletion_candidates": [], "held": []}


async def test_retention_legal_hold_wins_over_expiry(build):
    """Domain edge: an expired record under legal hold is held, never a deletion candidate."""
    result = await retention(build, [rule("retention-1", "evidence-1", legal_hold=True)])
    assert result.payload == {"deletion_candidates": [], "held": ["evidence-1"]}


@pytest.mark.parametrize("second,payload", [
    ({"legal_hold": True}, {"deletion_candidates": [], "held": ["evidence-1"]}),     # another rule holds it
    ({"retain_until": f.FUTURE}, {"deletion_candidates": [], "held": []}),          # another rule still retains it
])
async def test_retention_every_rule_for_an_object_applies(build, second, payload):
    """Contradictory input: an expired rule cannot delete an object another rule holds or still retains."""
    result = await retention(build, [rule("retention-1", "evidence-1"), rule("retention-2", "evidence-1", **second)])
    assert result.payload == payload


async def test_retention_without_rules_needs_evidence(build):
    """Missing evidence: no admitted RetentionRule is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("RetentionRule",))
    assert_not_favourable(await run(executor, principal, "evidence.retention.enforce"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)
