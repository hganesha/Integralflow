import { createHmac } from "node:crypto";
import { canonicalJson } from "@ehf/contracts";
import { clientCredentialsToken, requestIntegrationDestination, validateIntegrationDestination } from "@ehf/identity";
import type { ClaimedDelivery } from "@ehf/persistence";

export async function deliverIntegrationEvent(
  delivery: ClaimedDelivery, secretFromRef: (reference: string) => Promise<string>, env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number }> {
  // This check must precede acquisition of either a token or a destination secret.
  const destination = await validateIntegrationDestination(delivery.connector, env);
  if (!destination) throw new Error("integration.destination_invalid");
  const body = canonicalJson(delivery.cloudEvent);
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const headers: Record<string, string> = { "content-type": "application/cloudevents+json",
    "x-ehf-delivery-id": delivery.deliveryId, "x-ehf-timestamp": timestamp };
  const authentication = delivery.connector.authentication;
  if (authentication.kind === "hmac") {
    const secret = await secretFromRef(authentication.credentialRef);
    headers["x-ehf-signature"] = `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  } else if (authentication.kind === "oauth2_client_credentials") {
    const { audience, tokenUrl, clientId } = authentication;
    if (!audience) throw new Error("integration.connector_audience_missing");
    if (!tokenUrl || !clientId) throw new Error("integration.connector_client_missing");
    const clientSecret = await secretFromRef(authentication.credentialRef);
    headers.authorization = `Bearer ${await clientCredentialsToken({ tokenUrl, clientId, clientSecret, scope: audience })}`;
  } else {
    throw new Error("integration.connector_auth_unsupported");
  }
  return requestIntegrationDestination(destination, { method: "POST", headers, body });
}
