.PHONY: compile fixtures check security-policy security up down logs trace

# The plan compiler (packages/compiler), run from source with the workspace's tsx.
HARNESSC = node --import tsx packages/compiler/src/cli.ts

compile:
	$(HARNESSC) compile domains/archive/kyc-v2-deterministic --out artifacts/archive/kyc-v2.plan.json
	$(HARNESSC) compile domains/archive/kyb-deterministic --out artifacts/archive/kyb.plan.json
	$(HARNESSC) compile domains/kyb-screening --out artifacts/kyb-screening.plan.json
	$(HARNESSC) compile packages/contracts/test-fixtures/agent-roster --out artifacts/agent-roster.plan.json
	$(HARNESSC) compile domains/kyc-agentic --out artifacts/kyc-agentic.plan.json
	$(HARNESSC) compile domains/kyb-agentic --out artifacts/kyb-agentic.plan.json
	$(HARNESSC) compile domains/kyc-edd-agentic --out artifacts/kyc-edd-agentic.plan.json
	$(HARNESSC) compile domains/kyb-edd-agentic --out artifacts/kyb-edd-agentic.plan.json
	$(HARNESSC) compile domains/kyb-sdd-agentic --out artifacts/kyb-sdd-agentic.plan.json
	$(HARNESSC) compile domains/securities-agentic --out artifacts/securities-agentic.plan.json

fixtures:
	$(HARNESSC) compile packages/contracts/test-fixtures/conformance \
		--out packages/contracts/test-fixtures/conformance.plan.json
	$(HARNESSC) compile packages/contracts/test-fixtures/agent-profiles \
		--out packages/contracts/test-fixtures/agent-profiles.plan.json
	$(HARNESSC) compile packages/contracts/test-fixtures/skill-bound \
		--out packages/contracts/test-fixtures/skill-bound.plan.json
	$(HARNESSC) compile packages/contracts/test-fixtures/skill-hosted \
		--out packages/contracts/test-fixtures/skill-hosted.plan.json
	$(HARNESSC) compile packages/contracts/test-fixtures/skill-commit \
		--out packages/contracts/test-fixtures/skill-commit.plan.json

security-policy:
	node --test scripts/security/*.test.mjs

# Install the checksum-pinned scanners first; unlike check, this needs network
# access to current vulnerability databases. Never implies live certification.
security:
	bash scripts/security/run.sh security-results

check: compile security-policy
	pnpm check

# The KYC v2 workflow calls the connector services (adverse media, identity document,
# and the investigation loop's tools), so the default stack starts them. They are built
# from apps/kyc-wiring and apps/evidence-pipeline.
# Override with `make up COMPOSE_PROFILES=` to run the platform alone.
COMPOSE_PROFILES ?= kyc-adapters

up: compile
	COMPOSE_PROFILES=$(COMPOSE_PROFILES) docker compose up --build -d

down:
	docker compose down

logs:
	docker compose logs -f control-api case-api capability-gateway runtime-dispatcher runtime-host-local

trace:
	@test -n "$(RUN_ID)" || (echo "usage: make trace RUN_ID=RUN-..." >&2; exit 1)
	./scripts/verify-trace.sh "$(RUN_ID)"
