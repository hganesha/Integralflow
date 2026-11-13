"""Named, closed JSON Schema vocabulary. Dynamic maps always declare their value type."""
from copy import deepcopy
import re

DEFS = {}


def ref(name):
    return {"$ref": "#/$defs/"+name}


# Upper bounds on every generated container and free text, so no payload is unbounded: large
# enough for any real case (a case's transactions, an OCR page), small enough to refuse a runaway.
MAX_ITEMS = 10000
MAX_TEXT = 200000


def array(item):
    return {"type": "array", "items": term(item), "maxItems": MAX_ITEMS}


def mapping(item, *, reason="keyed collection"):
    return {"type": "object", "additionalProperties": term(item), "x-dynamic-map-reason": reason}


def obj(fields, *, required=None):
    properties = {k.rstrip("?"): term(v) for k, v in fields.items()}
    return {"type": "object", "properties": properties,
            "required": [k for k in fields if not k.endswith("?")] if required is None else required,
            "additionalProperties": False}


def term(value):
    if isinstance(value, dict):
        return deepcopy(value)
    if value.endswith("?"):
        return {"anyOf": [term(value[:-1]), {"type": "null"}]}
    if value.startswith("[") and value.endswith("]"):
        return array(value[1:-1])
    if value.startswith("<") and value.endswith(">"):
        return mapping(value[1:-1])
    return ref(value)


def define(name, fields=None, **kwargs):
    if name in DEFS:
        raise ValueError(f"duplicate schema definition {name}")
    if isinstance(fields, str):
        fields = dict(token.split("=", 1) for token in fields.split())
    DEFS[name] = obj(fields, **kwargs) if fields is not None else kwargs
    return ref(name)


def document(shape, *, schema_id=None):
    """Include only the transitive reference closure; reject missing definitions."""
    root = deepcopy(term(shape))
    pending, selected = [], {}
    def scan(value):
        if isinstance(value, dict):
            if "$ref" in value:
                path = value["$ref"]
                if not path.startswith("#/$defs/"):
                    raise ValueError("external schema references are not permitted")
                pending.append(path.split("/")[-1])
            for v in value.values():
                scan(v)
        elif isinstance(value, list):
            for v in value:
                scan(v)
    scan(root)
    while pending:
        name = pending.pop()
        if name in selected:
            continue
        if name not in DEFS:
            raise ValueError(f"undefined schema type {name}")
        selected[name] = deepcopy(DEFS[name])
        scan(selected[name])
    root["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    if schema_id:
        root["$id"] = schema_id
    if selected:
        root["$defs"] = dict(sorted(selected.items()))
    return root


DEFS.update({
    "Text": {"type": "string", "maxLength": MAX_TEXT}, "Id": {"type": "string", "minLength": 1, "maxLength": 512},
    "Bool": {"type": "boolean"}, "Integer": {"type": "integer"}, "Count": {"type": "integer", "minimum": 0},
    "Number": {"type": "number"}, "Probability": {"type": "number", "minimum": 0, "maximum": 1},
    "Decimal": {"type": "string", "pattern": r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$"},
    "Fraction": {"type": "string", "pattern": r"^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$"},
    "Timestamp": {"type": "string", "format": "date-time"}, "Date": {"type": "string", "format": "date"},
    "Hash": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
    "Semver": {"type": "string", "pattern": r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$"},
    "JsonValue": {"anyOf": [{"type": "null"}, {"type": "boolean"}, {"type": "string", "maxLength": MAX_TEXT}, {"type": "number"},
                            array("JsonValue"), mapping("JsonValue", reason="raw JSON source value")]},
    "JsonObject": mapping("JsonValue", reason="schema-selected or source-domain JSON values"),
    "Outcome": {"enum": ["PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"]},
    "EntityKind": {"enum": ["individual", "company", "trust", "fund", "partnership", "organization", "unknown"]},
    "Lifecycle": {"enum": ["QUEUED", "RUNNING", "WAITING_FOR_HUMAN", "SUCCEEDED", "FAILED", "CANCELLED"]},
})
define("Ref", "tenant_id=Id object_type=Id object_id=Id version_id=Id schema_version=Semver")
DEFS["Ref"]["required"].remove("schema_version")
DEFS["Ref"]["properties"]["schema_version"]["default"] = "2.0.0"
define("Extension", "schema_version=Semver source_ref=Ref? value=JsonValue", required=["schema_version", "value"])
DEFS["Extensions"] = mapping("Extension", reason="explicit versioned source/institution extensions")
DEFS["Extensions"]["propertyNames"] = {"type": "string", "pattern": r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$"}
define("Coverage", "complete=Bool jurisdictions?=[Id] as_of?=Timestamp limitations?=[Text] provider?=Id query?=Text pages_complete?=Bool")
define("Window", "start=Timestamp end=Timestamp")
define("Bounds", "minimum=Decimal maximum=Decimal")
define("Profile", "legal_name?=Id business_purpose?=Text employees?=Count extensions?=Extensions")
define("EntityAttributes", "address?=Text email?=Id phone?=Id registration_id?=Id extensions?=Extensions")
define("IdentityAttributes", "name?=Id identifiers?=[Id] synthetic?=Bool date_of_birth?=Date extensions?=Extensions")
define("DeviceAttributes", "os?=Id browser?=Id device_id?=Id extensions?=Extensions")
define("Activity", "monthly_amount?=Decimal currency?=Id count?=Count extensions?=Extensions")
define("Verification", "status=Id method=Id actor_ref?=Id verified_at?=Timestamp evidence_ids?=[Id]")
define("MatchFeatures", "score=Probability shared_identifiers=[Id] identifier_conflict=Bool name_score=Probability verified_match=Bool")
define("HitFeatures", "identifier_conflict=Bool score?=Probability name_score?=Probability shared_identifiers?=[Id] verified_match?=Bool")
define("RiskContribution", "factor?=Id name?=Id value=Decimal weight?=Decimal contribution?=Decimal")
define("ScoreSample", "score=Probability label=BinaryLabel")
DEFS["BinaryLabel"] = {"type": "integer", "enum": [0, 1]}
define("OwnershipGap", "node=Id reason=Id path?=[Id] interest?=Decimal")
define("OwnershipPath", "owner=Id path=[Id] interest=Decimal")
define("OwnershipCalculation", "interests=<Decimal> paths=[OwnershipPath] cycles=[[Id]] unresolved=[OwnershipGap]")
define("Change", "field=Id before=JsonValue after=JsonValue")
define("RuleLeaf", "field=Id op=RuleOperator value?=JsonValue")
DEFS["RuleOperator"] = {"enum": ["eq", "ne", "in", "contains", "excludes", "gte", "gt", "lte", "lt", "present"]}
DEFS["Predicate"] = {"oneOf": [ref("RuleLeaf"), obj({"all": {"type": "array", "items": ref("Predicate"), "minItems": 1, "maxItems": 100}}), obj({"any": {"type": "array", "items": ref("Predicate"), "minItems": 1, "maxItems": 100}})]}
define("RequirementControl", "pass=Predicate fail?=Predicate")
define("PolicyRequirement", "id=Id description?=Text when?=Predicate control?=RequirementControl")
define("PolicyRule", "id=Id predicate=Predicate")
define("RiskTier", "minimum=Decimal tier=Id")
define("IdentifierRule", "pattern=Id checksum?=Checksum")
DEFS["Checksum"] = {"enum": ["luhn"]}
define("EddTrigger", "id=Id predicate=Predicate tasks=[Id]")
define("MonitorTrigger", "id=Id event_type=Id predicate=Predicate")
define("ReportingObligation", "id=Id type=ReportType deadline_days=DeadlineDays business_days=Bool time_zone=Id")
DEFS["ReportType"] = {"enum": ["SAR", "CTR"]}
DEFS["DeadlineDays"] = {"type": "integer", "minimum": 0, "maximum": 366}
define("SanctionsAggregation", "rule=SyntheticAggregation threshold=Fraction")
DEFS["SyntheticAggregation"] = {"enum": ["synthetic_aggregate", "ofac_50_percent"]}
DEFS["ListOrMediaType"] = {"enum": ["sanctions", "pep", "watchlist", "adverse_media"]}
DEFS["SearchStatus"] = {"enum": ["COMPLETED", "PARTIAL", "FAILED"]}
define("CtrBusinessDay", "cutoff=LocalTime roll_non_working_days=Bool")
DEFS["LocalTime"] = {"type": "string", "pattern": r"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$"}
define("AmlDetectorConfig", "amount_threshold=Decimal currency=Id minimum_count=PositiveCount window_seconds=PositiveCount max_hops?=Hops throughput_ratio?=Fraction")
DEFS["PositiveCount"] = {"type": "integer", "minimum": 1}
DEFS["Hops"] = {"type": "integer", "minimum": 1, "maximum": 30}
define("FilingData", "report_type=ReportType subject_id=Id narrative?=Text citations?=[Id] totals?=<Decimal> extensions?=Extensions")
define("Receipt", "receipt_id=Id filing_hash?=Hash accepted_by_local_test_endpoint?=Bool synthetic?=Bool")
define("DetectorAssessment", "score=Fraction model_version=Id limitations=[Text] assessment=Id")
define("ForensicsAssessment", "assessment=Id limitations=[Text] indicators?=[Id] model_version?=Id")
define("Mention", "page_id=Id text=Id start=Count end=PositiveCount")
define("Translation", "page_id=Id source_text=Text text=Text language=Id synthetic=Bool")
define("SpanAssertion", "field=Id value=Text page_id=Id document_version=Id start=Count end=PositiveCount epistemic_status=AssertionStatus source_ref?=Ref")
DEFS["AssertionStatus"] = {"const": "EXTRACTED_ASSERTION"}
define("SourceArtifact", "media_type=Id encoding=Id value=JsonValue")
DEFS["SourceContent"] = {"anyOf": [ref("Text"), ref("SourceArtifact")]}


def audit_schema(schema, *, bounded=False):
    """No untyped containers, wildcard properties, or absent item types.

    ``bounded`` (skill input and output contracts) also refuses an array without ``maxItems`` and a
    free string without a length, pattern, format or enumeration."""
    issues = []
    def walk(value, path):
        if isinstance(value, dict):
            if value == {}:
                issues.append(path+": empty schema")
            types = value.get("type")
            types = [types] if isinstance(types, str) else types or []
            if "object" in types:
                extra = value.get("additionalProperties", True)
                if extra is True or not (extra is False or isinstance(extra, dict) and extra):
                    issues.append(path+": object is open or untyped")
                if isinstance(extra, dict) and not value.get("x-dynamic-map-reason"):
                    issues.append(path+": dynamic map needs an explicit reason")
            if "array" in types and ("items" not in value or not value["items"]):
                issues.append(path+": array item type missing")
            if bounded and "array" in types and "maxItems" not in value:
                issues.append(path+": array is unbounded (maxItems)")
            if bounded and "string" in types and not any(k in value for k in ("maxLength", "pattern", "format", "enum", "const")):
                issues.append(path+": string is unbounded (maxLength, pattern, format or enum)")
            for key, child in value.items():
                if key in {"properties", "$defs", "patternProperties"}:
                    for name, nested in child.items():
                        walk(nested, path+"/"+key+"/"+name)
                elif key in {"items", "additionalProperties", "if", "then", "else", "not"} and isinstance(child, dict):
                    walk(child, path+"/"+key)
                elif key in {"allOf", "anyOf", "oneOf", "prefixItems"}:
                    for index, nested in enumerate(child):
                        walk(nested, path+"/"+key+"/"+str(index))
    walk(schema, "#")
    return issues
