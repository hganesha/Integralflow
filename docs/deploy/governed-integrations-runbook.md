# Governed integrations runbook

The integrations feature is disabled until an operator creates, verifies, and activates a deployment binding. Publishing a plan with integration contracts does not open an endpoint or begin outbound delivery by itself.

## Deployment requirements

- Build and pin the `integration-worker` image alongside the existing service images.
- Apply migration `025_governed_integrations.sql` to the control database.
- Give the integration worker its own workload identity (mapped to `integration-worker` in `WORKLOAD_IDENTITIES`; role `Integration.Dispatch` at the control and case APIs) and its own PostgreSQL role.
- Under `ENVELOPE_SIGNER=private_key`, mount the worker's RSA key as `INTEGRATION_ENVELOPE_PRIVATE_KEY_FILE` with `INTEGRATION_ENVELOPE_KEY_ID`, and give the control API and case API the matching `INTEGRATION_ENVELOPE_PUBLIC_KEY_PEM`.
- Leave the case API `OUTBOX_SINK` unset so its outbox relay delivers events to the control API under the case API's own identity (`Case.Outbox.Publish`). Use `OUTBOX_SINK=log` only for diagnostics.
- The worker polls PostgreSQL for work (`INTEGRATION_POLL_INTERVAL_MS`, default 1 s); nothing calls it to wake it. The case API fills each integration command's pinned policy digest, so the worker reads no integration authority.
- Keep connector credentials in the deployment's secret manager and reference them as `env:NAME` or `file:/path` (`credentialRef`). Connector definitions contain references only. A connector's channel is `inbound_http` (HMAC-verified) or `outbound_webhook`, authenticated with `hmac` or `oauth2_client_credentials` (`tokenUrl`, `clientId`, `audience`).

## Activation procedure

1. Publish a plan containing the required trigger, human-action, or publication contract.
2. In **Operate → Integrations**, create a connector revision.
3. Create a draft binding for one plan contract and deployment.
4. Run **Test**. Resolve TLS, DNS, authentication, schema, or synthetic-reference failures before continuing.
5. Activate the verified binding. Its activation time is the publication watermark; older platform events are not delivered automatically.
6. Monitor deliveries and dead letters. Pausing a binding stops new ingress and fan-out without deleting history.

## Smoke tests

- Human API: list actions for a test case, execute an eligible reversible action with the displayed case sequence and a unique request ID, then confirm the case ledger and outbox advanced. Repeat the same request ID and confirm the stored response is returned. Retry with an old sequence and expect `409` plus the current sequence.
- Ingress: send a signed reference-only event with `x-integration-event-id`, `x-integration-timestamp`, and `x-integration-signature`; expect `202` and poll the returned status URL. Repeat it unchanged and confirm the same receipt; change the payload under the same key and expect an idempotency conflict.
- Webhook: activate a binding against a test receiver, publish an allowlisted event, and verify CloudEvents JSON plus `x-integration-delivery-id`, timestamp, and HMAC-SHA256 signature. Exercise `429`, `500`, and a terminal `400`, then verify retry, dead-letter, and manual replay history.
- OAuth 2.0 client credentials: activate a binding whose connector uses `oauth2_client_credentials`, confirm the worker obtains a token from `tokenUrl` and the receiver sees a bearer token for the configured audience, and that the delivery carries references and trace context but no case or evidence payload.

## Operational response

- Repeated retryable failures: pause the binding, repair DNS/authentication/endpoint health, test it, then reactivate.
- Terminal `4xx`: inspect the immutable delivery attempt and receiver contract, correct the endpoint or create a new connector revision, then replay the dead letter.
- Suspected credential exposure: rotate the secret behind the connector's `env:`/`file:` reference (or the OAuth client secret); connector and binding history does not contain secret material.
- Suspected loop: pause the implicated binding and inspect causation IDs, hop counts, and inbox deduplication before replaying anything.
- Replay never edits prior attempts. It creates a new delivery linked through `replayedFrom`.

## Release evidence

Retain compiler compatibility tests, integration authorization and envelope tests, migration output, the repository `pnpm check` result, and smoke-test output from the target environment with secrets redacted. Record active connector and binding revision digests, activation watermark, the worker's workload identity mapping and roles, and the test webhook delivery ID.
