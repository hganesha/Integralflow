import { expect, it, vi } from "vitest";
import { ManagedIdentityCredential } from "@azure/identity";
import { discoverOidc, referenceValue } from "./network.js";

it("accepts tenant-specific Entra discovery with omitted PKCE metadata and retains egress checks", async () => {
  const authority = "https://login.microsoftonline.com/fa3163fa-f1c7-4b8c-ab66-f6a62d3e38bd";
  const issuer = `${authority}/v2.0`;
  const document = { issuer, authorization_endpoint: `${authority}/oauth2/v2.0/authorize`, token_endpoint: `${authority}/oauth2/v2.0/token`, jwks_uri: `${authority}/discovery/v2.0/keys` };
  const fetcher: typeof fetch = async () => Response.json(document);
  await expect(discoverOidc(issuer, { ONBOARDING_ALLOWED_ORIGINS: "https://login.microsoftonline.com" }, fetcher)).resolves.toEqual(document);
  await expect(discoverOidc(issuer, {}, fetcher)).rejects.toThrow("endpoint.origin_not_allowed");
  await expect(discoverOidc(issuer, { ONBOARDING_ALLOWED_ORIGINS: "https://login.microsoftonline.com" }, async () => Response.json({ ...document, issuer: `${authority}/wrong` }))).rejects.toThrow("identity.discovery_invalid");
});

it("uses the approved vault binding ahead of legacy environment values and refuses foreign vaults", async () => {
  const credential = vi.spyOn(ManagedIdentityCredential.prototype, "getToken").mockResolvedValue({ token: "managed-token", expiresOnTimestamp: Date.now() + 60000 });
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ value: "new-vault-secret" }));
  const env = { ONBOARDING_SECRET_NAMES: "MODEL_PROVIDER_TOKEN", MODEL_PROVIDER_TOKEN: "legacy-value", ONBOARDING_VAULT_REFERENCES: "env:MODEL_PROVIDER_TOKEN", ONBOARDING_VAULT_URI: "https://dedicated.vault.azure.net/", ONBOARDING_SECRET_PREFIX: "test-env" };
  try {
    await expect(referenceValue("env:MODEL_PROVIDER_TOKEN", env)).resolves.toBe("new-vault-secret");
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://dedicated.vault.azure.net/secrets/test-env-model-provider-token?api-version=7.4");
    await expect(referenceValue("env:MODEL_PROVIDER_TOKEN", { ...env, ONBOARDING_VAULT_URI: "https://foreign.example/" })).rejects.toThrow("credential.reference_not_allowed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { credential.mockRestore(); fetcher.mockRestore(); }
});
