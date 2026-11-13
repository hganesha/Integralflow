"""Document Model Factory: offline sourcing, dataset, labelling and evaluation tooling.

Nothing here runs a model, calls a network service or touches case state. It reads the
`kyc_documents` catalog (the single source of document contracts) and produces reviewable,
digest-pinned records: the sourcing manifest, dataset versions and evaluation reports.
See docs/implementation/document-intelligence-factory-plan.md.
"""

FACTORY_API_VERSION = "ehf.document-factory/v1alpha1"
