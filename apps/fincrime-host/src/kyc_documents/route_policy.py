"""Which extraction routes run for a document type, and which one's values are proposed (factory plan §4.3).

Three modes:

* `llm_only`: the LLM contract extraction alone, exactly as `document.fields.contract_extract`.
* `shadow`: the LLM route and the provider model route (Azure Document Intelligence) both run and are
  adjudicated. The outcomes are recorded beside the LLM route's values, which stay the proposed values.
  Adjudication can only add review: a conflict raises a work item, and nothing selected by adjudication
  replaces a proposed value.
* `selective`: the LLM route runs first; the model route runs only on a trigger, a key field the LLM route
  did not find (`KEY_FIELD_GAP`, which is what makes an extraction need evidence). The routes are then adjudicated as in shadow, with
  one addition: a key field the LLM route did not find, which the model route read and the page text
  grounds (`SINGLE_ROUTE`), is proposed from the model route instead of raising a gap. It awaits review
  like every other value. A value the LLM route did propose is never replaced.

A type moves to `selective` only on measured evidence that its model route is precise: the Phase 3
release gates (key-field precision 1.00 for passports on the sealed test set). Types whose model route
failed the gates stay in `shadow` (national identity cards: recall 0.71) or `llm_only` (bank statements:
precision 0.84 with wrong values read), so the model route's errors can never fill a gap.
"""
from __future__ import annotations

from typing import Literal

from pydantic import Field, model_validator

from .model import ClosedModel, fingerprint
from .profiles import PROFILES

RouteMode = Literal["llm_only", "shadow", "selective"]
LLM_ROUTE = "llm"
MODEL_ROUTE = "azure_di"


class RoutePolicy(ClosedModel):
    policy_id: str = Field(min_length=1)
    version: str = Field(min_length=1)
    default_mode: RouteMode = "llm_only"
    modes: dict[str, RouteMode] = {}

    @model_validator(mode="after")
    def _known(self):
        unknown = set(self.modes) - set(PROFILES)
        if unknown:
            raise ValueError(f"route policy names unknown document types: {sorted(unknown)}")
        return self

    @property
    def digest(self) -> str:
        return fingerprint(self.model_dump(mode="json"))

    def mode_of(self, document_type: str) -> RouteMode:
        return self.modes.get(document_type, self.default_mode)


# Per the measured results (factory plan Phase 4): the pilot types with a prebuilt Azure model
# (packages/adapters azure-prebuilt-routes.json), each in the mode its evaluation supports.
DEFAULT_ROUTE_POLICY = RoutePolicy(policy_id="ehf.default-routes", version="0.2.0",
                                   modes={"passport": "selective", "national_identity_card": "shadow", "bank_statement": "llm_only"})
# Every prebuilt type in shadow (the Phase 2 policy): the Test Bench compares both routes whatever the
# case policy, and a deployment can pin it to stop the model route proposing anything.
SHADOW_ROUTE_POLICY = RoutePolicy(policy_id="ehf.default-routes", version="0.1.0",
                                  modes={t: "shadow" for t in ("passport", "national_identity_card", "bank_statement")})
