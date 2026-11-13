"""Least-privilege bitemporal context compilation with replayable manifests."""
from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any

from .contracts import AgentProfile, ContextManifest, Invocation, Principal, Record, RecordView, SkillError, Status, canonical, digest
from .versions import SCHEMA_VERSION


@dataclass
class Context:
    records: dict[str, list[RecordView]]
    manifest: ContextManifest
    policy: dict[str, Any]

    def rows(self, object_type):
        return [{"id": r.id, **r.data, "_ref": r.ref().model_dump(), "_synthetic": r.synthetic} for r in self.records.get(object_type, [])]

    def refs(self, object_type=None):
        return [r.ref() for k, rows in self.records.items() for r in rows if object_type is None or k == object_type]


class ContextCompiler:
    def __init__(self, store):
        self.store = store

    def policy(self, request, principal):
        candidates = [x for x in self.store.records(request.tenant_id, "Policy") if x.id == request.policy_snapshot_ref]
        candidates = [x for x in candidates if x.recorded_at <= request.knowledge_cutoff
                      and (x.valid_from is None or x.valid_from <= request.as_of_time)
                      and (x.valid_to is None or request.as_of_time < x.valid_to)]
        if not candidates:
            raise SkillError("POLICY_UNRESOLVED", "no effective policy snapshot")
        if request.purpose not in principal.purposes:
            raise SkillError("ACCESS_DENIED", "unauthorized purpose")
        record = max(candidates, key=lambda x: (x.recorded_at, x.version_id))
        if request.purpose not in record.purposes or record.classification not in principal.classifications:
            raise SkillError("ACCESS_DENIED", "policy access denied")
        return record

    def compile(self, request: Invocation, principal: Principal, profile: AgentProfile, spec):
        if principal.revoked or principal.tenant_id != request.tenant_id or principal.actor_id != request.actor_ref:
            raise SkillError("ACCESS_DENIED", "identity/tenant mismatch")
        if principal.subject_ids is not None and not set(request.subject_ids) <= principal.subject_ids:
            raise SkillError("ACCESS_DENIED", "subject scope denied")
        if principal.case_ids is not None and request.case_id and request.case_id not in principal.case_ids:
            raise SkillError("ACCESS_DENIED", "case scope denied")
        policy_record = self.policy(request, principal)
        policy_fields = getattr(spec, "policy_fields", list(policy_record.data))
        if profile.policy_fields is not None and not set(policy_fields) <= profile.policy_fields:
            raise SkillError("ACCESS_DENIED", "profile policy ceiling exceeded")
        policy = {k: policy_record.data[k] for k in policy_fields if k in policy_record.data}
        from .ontology import validate_policy
        validate_policy(policy)
        reqs = spec.requirements
        selected, gaps = {}, []
        count = 0
        if any(ref.schema_version != SCHEMA_VERSION for ref in request.object_refs):
            raise SkillError("SCHEMA_VERSION_UNSUPPORTED", "active context requires current-schema references")
        explicit = {(r.object_type, r.object_id, r.version_id, r.schema_version) for r in request.object_refs}
        if any(r.tenant_id != request.tenant_id for r in request.object_refs):
            raise SkillError("ACCESS_DENIED", "cross-tenant reference")
        for req in reqs:
            if profile.context_fields is not None and (req.object_type not in profile.context_fields
                    or not set(req.fields) <= profile.context_fields[req.object_type]):
                raise SkillError("ACCESS_DENIED", "profile context ceiling exceeded")
            rows = self.store.records(request.tenant_id, req.object_type)
            versions = {}
            for r in rows:
                if explicit and (r.object_type, r.id, r.version_id, r.schema_version) not in explicit:
                    continue
                if r.recorded_at > request.knowledge_cutoff or (r.valid_from and r.valid_from > request.as_of_time) or (r.valid_to and r.valid_to <= request.as_of_time):
                    continue
                if request.subject_ids and not set(r.subject_ids or [r.id]) & set(request.subject_ids):
                    continue
                if principal.subject_ids is not None and not set(r.subject_ids or [r.id]) <= principal.subject_ids:
                    continue
                if request.purpose not in r.purposes or r.classification not in principal.classifications:
                    continue
                prior = versions.get(r.id)
                if prior is None or (r.recorded_at, r.version_id) > (prior.recorded_at, prior.version_id):
                    versions[r.id] = r
            included = []
            for r in sorted(versions.values(), key=lambda x: (x.id, x.version_id)):
                allowed = principal.readable_fields.get(req.object_type)
                fields = req.fields or list(r.data)
                if allowed is not None and not set(fields) <= allowed:
                    raise SkillError("ACCESS_DENIED", f"required fields denied for {req.object_type}")
                absent = {f for f in fields if f not in r.data or r.data[f] is None}
                nullable = set(req.nullable_fields)
                fields = [f for f in fields if not (f in nullable and f in absent)]
                missing = [f for f in fields if f in absent]
                if missing:
                    gaps.append({"code": "CONTEXT_MISSING", "object": r.id, "fields": missing, "optional": req.optional})
                    continue
                from .ontology import validate_fields
                validate_fields(req.object_type, r.data, fields)
                max_age = req.max_age_seconds
                if max_age is None:
                    max_age = policy.get("freshness_seconds", {}).get(req.object_type)
                age = (request.as_of_time - r.observed_at).total_seconds()
                if max_age is not None and (age > max_age or age < 0):
                    gaps.append({"code": "CONTEXT_STALE", "object": r.id, "optional": req.optional})
                    continue
                data = {k: r.data[k] for k in fields}
                included.append(RecordView.project(r, fields))
            selected[req.object_type] = included
            count += len(included)
            if len(included) < req.min_count:
                gaps.append({"code": "CONTEXT_MISSING", "object_type": req.object_type, "minimum": req.min_count, "optional": req.optional})
        if count > profile.max_objects:
            raise SkillError("CONTEXT_BUDGET_EXCEEDED", "mandatory structured data exceeds object budget", Status.NEEDS_EVIDENCE)
        mandatory_gaps = [g for g in gaps if not g["optional"]]
        if mandatory_gaps:
            code = "CONTEXT_STALE" if any(x["code"] == "CONTEXT_STALE" for x in mandatory_gaps) else "CONTEXT_MISSING"
            raise SkillError(code, canonical(mandatory_gaps), Status.NEEDS_EVIDENCE)
        structured = {k: [json.loads(canonical(r)) for r in rows] for k, rows in selected.items()}
        visible = {q.object_type for q in reqs if q.model_visible}
        model_data = {k: [{"ref": r.ref().model_dump(), "data": r.data} for r in rows] for k, rows in selected.items() if k in visible}
        model_view = canonical({"untrusted_source_data": model_data})
        if spec.mode == "model" and len(model_view) > profile.model_char_budget:
            raise SkillError("CONTEXT_BUDGET_EXCEEDED", "required model evidence exceeds character budget", Status.NEEDS_EVIDENCE)
        if spec.mode != "model":
            model_view = ""  # deterministic computations do not pay model-context costs
        refs = [r.ref() for rows in selected.values() for r in rows]
        manifest = ContextManifest(tenant_id=request.tenant_id, actor_ref=principal.actor_id, purpose=request.purpose,
            skill_id=spec.id, skill_version=spec.version, profile_hash=digest(profile), policy_hash=digest(policy_record),
            policy_ref=policy_record.ref(), policy_fields=policy_fields,
            requirements_hash=digest([x.model_dump() for x in reqs]), authorization_hash=digest(principal),
            as_of_time=request.as_of_time, knowledge_cutoff=request.knowledge_cutoff, refs=refs,
            content_hashes={digest(r.ref()): digest(r) for rows in selected.values() for r in rows}, gaps=gaps,
            selected_fields={q.object_type: q.fields for q in reqs},
            scope={"subjects": sorted(request.subject_ids), "case_id": request.case_id, "explicit_refs": bool(explicit), "complete_for_declared_scope": True},
            model_view=model_view, structured_hash=digest(structured), synthetic=policy_record.synthetic and all(r.synthetic for rows in selected.values() for r in rows))
        return Context(selected, manifest, policy)

