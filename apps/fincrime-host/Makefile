PYTHON ?= .venv/bin/python

.PHONY: catalog documents check demo package
catalog:
	$(PYTHON) scripts/build_catalog.py

documents:
	$(PYTHON) scripts/build_document_catalog.py

check:
	$(PYTHON) scripts/build_catalog.py --check
	$(PYTHON) scripts/build_document_catalog.py --check
	$(PYTHON) -m pytest -q
	$(PYTHON) -m financial_crime.cli validate

demo:
	$(PYTHON) -m financial_crime.cli demo

package:
	$(PYTHON) -m build --wheel

