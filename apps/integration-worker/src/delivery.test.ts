import { expect, it, vi } from "vitest";
const token = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
vi.mock("@ehf/identity", async (original) => ({ ...await original<typeof import("@ehf/identity")>(),
  clientCredentialsToken: token, requestIntegrationDestination: send }));
import { deliverIntegrationEvent } from "./delivery.js";

const oauth = { kind: "oauth2_client_credentials", credentialRef: "env:CLIENT_SECRET", audience: "api://receiver/.default",
  tokenUrl: "https://idp.example.test/oauth2/token", clientId: "ehf-delivery" } as const;

it("acquires no token or secret and makes no delivery for rejected configurations", async () => {
  const secret = vi.fn();
  for (const authentication of [oauth, { kind: "hmac", credentialRef: "env:WEBHOOK_SECRET", audience: null }] as const) {
    await expect(deliverIntegrationEvent({ connector: { channel: "outbound_webhook", endpoint: "https://attacker.example/collect",
      authentication } } as never, secret, {}))
      .rejects.toThrow("integration.destination_not_approved");
  }
  const connector = { channel: "outbound_webhook", endpoint: "https://127.0.0.1/collect", authentication: oauth };
  const env = { INTEGRATION_DESTINATIONS_JSON: JSON.stringify([{ endpoint: connector.endpoint, ...connector.authentication }]) };
  await expect(deliverIntegrationEvent({ connector } as never, secret, env)).rejects.toThrow("integration.destination_address_denied");
  // An approval for one client does not cover another client against the same destination.
  const otherClient = { ...connector, endpoint: "https://receiver.example.test/collect", authentication: { ...oauth, clientId: "someone-else" } };
  const approved = { INTEGRATION_DESTINATIONS_JSON: JSON.stringify([{ endpoint: otherClient.endpoint, ...oauth }]) };
  await expect(deliverIntegrationEvent({ connector: otherClient } as never, secret, approved)).rejects.toThrow("integration.destination_not_approved");
  expect(token).not.toHaveBeenCalled(); expect(secret).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});
