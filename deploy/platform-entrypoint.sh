#!/bin/sh
# The single application image: SERVICE_NAME selects the entrypoint. Production and the
# development Compose stack run the same image.
set -eu
if [ "${INTEGRALFLOW_RUNTIME_LAUNCH:-}" = "true" ]; then
  NODE_EXTRA_CA_CERTS= node /app/services/runtime-launch/server.mjs --prepare-files
  exec node /app/services/runtime-launch/server.mjs "$@"
fi
service="${SERVICE_NAME:-launcher}"
case "$service" in
  launcher|experience-bff|control-api|case-api|capability-gateway|runtime-host|runtime-worker|integration-worker|runtime-verify|skill-host-reference)
    exec node "/app/services/$service/server.mjs"
    ;;
  seed-authoring|migrate|onboarding-recover|ledger-export|evidence-governance|context-release|context-refresh|discovery-worker)
    exec node "/app/services/$service/server.mjs" "$@"
    ;;
  dev-migrate)
    # Local stack and CI: create missing databases through DATABASE_BOOTSTRAP_URL, migrate
    # control, case and context, create development blob containers and, when
    # DATABASE_DEV_LOGIN_PASSWORD is set, one password login per service. The development
    # steps refuse the production security profile; deployments use `migrate`.
    for step in ensure-databases migrate-control migrate-case migrate-context migrate-discovery ensure-containers; do
      node "/app/services/$step/server.mjs"
    done
    if [ -n "${DATABASE_DEV_LOGIN_PASSWORD:-}" ]; then exec node /app/services/dev-logins/server.mjs; fi
    ;;
  *) echo 'Unsupported SERVICE_NAME' >&2; exit 64 ;;
esac
