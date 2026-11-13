# Synthetic document contract examples

Six authored source/answer pairs cover passport, bank statement, shareholder register, trust deed, W-8BEN-E excerpt and invoice semantics. All people, organizations, accounts and financial values are synthetic. `XTS` is used for test monetary examples.

Each JSON contains decoded `pages`, a version/hash-bound extraction `result`, and an `expected` validator outcome. The expected fields are authored in `scripts/document_catalog_examples.py`; the builder adds explicit nulls, exact spans and current contract hashes. These are **contract/source-span fixtures, not OCR or model extraction evaluations**. No extraction provider is called.

To validate one:

```python
import json
from pathlib import Path
from kyc_documents.runtime import validate_extraction

fixture = json.loads(Path("examples/documents/trust_deed.json").read_text())
report = validate_extraction("trust_deed", fixture["result"], fixture["pages"])
assert report["valid"]
assert report["promotion_allowed"] is False
```

The fixtures intentionally preserve nulls: the shareholder register has no inferred voting interests or denominator; the trust has a beneficiary class rather than fabricated named beneficiaries; masked bank identifiers remain masked; tax status remains a source declaration.

The tests also mutate contracts, source hashes, spans, Unicode offsets, nested shapes, percentages, dates and missingness. Real-document datasets, independent annotations, issuer/form/language variants, provider qualification and calibrated confidence thresholds remain future qualification work.
