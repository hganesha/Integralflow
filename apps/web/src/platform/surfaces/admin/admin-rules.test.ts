import { describe, expect, it } from "vitest";
import {
  coerceSetting, connectorFieldErrors, credentialRefError, intError, jsonDiff, parseJsonObject, profileFieldLocked, providerFieldLocked, reasonError, reasonFor,
  settingsSectionLocked, shortDigest, valueAt, withValueAt,
} from "./admin-rules";
import { localTone } from "./tones";

describe("credential references", () => {
  it("accepts environment variable names only", () => {
    expect(credentialRefError("")).toBeUndefined();
    expect(credentialRefError("OPENROUTER_API_KEY")).toBeUndefined();
    expect(credentialRefError("sk-or-v1-abcdef")).toMatch(/environment variable/);
    expect(credentialRefError("AB")).toBeDefined();
    expect(credentialRefError("lower_case")).toBeDefined();
    expect(credentialRefError("1ABC")).toBeDefined();
  });
});

describe("integration connectors", () => {
  const base = { channel: "outbound_webhook" as const, endpoint: "https://partner.example/hook", kind: "hmac" as const, tokenUrl: "", clientId: "", audience: "" };

  it("accepts HMAC on either channel and requires https outbound", () => {
    expect(connectorFieldErrors(base)).toEqual({});
    expect(connectorFieldErrors({ ...base, channel: "inbound_http", endpoint: "" })).toEqual({});
    expect(connectorFieldErrors({ ...base, endpoint: "http://partner.example/hook" })).toHaveProperty("endpoint");
  });

  it("requires inbound connectors to be HMAC-signed", () => {
    expect(connectorFieldErrors({ ...base, channel: "inbound_http", kind: "oauth2_client_credentials", tokenUrl: "https://idp.example/token", clientId: "c", audience: "a" })).toHaveProperty("kind");
  });

  it("requires an https token URL, client id and audience for client credentials", () => {
    const oauth = { ...base, kind: "oauth2_client_credentials" as const };
    expect(Object.keys(connectorFieldErrors(oauth)).sort()).toEqual(["audience", "clientId", "tokenUrl"]);
    expect(connectorFieldErrors({ ...oauth, tokenUrl: "http://idp.example/token", clientId: "c", audience: "a" })).toHaveProperty("tokenUrl");
    expect(connectorFieldErrors({ ...oauth, tokenUrl: "https://idp.example/oauth2/token", clientId: "ehf-delivery", audience: "partner.deliveries" })).toEqual({});
  });
});

describe("managed configuration", () => {
  it("requires a reason on every write", () => {
    expect(reasonError("", false)).toBeUndefined();
    expect(reasonError("  ", true)).toMatch(/required/);
    expect(reasonError("rotate", true)).toBeUndefined();
    expect(reasonError("x".repeat(501), false)).toMatch(/500/);
    expect(reasonFor("  ", "edited from the console")).toBe("edited from the console");
    expect(reasonFor(" tune ", "fallback")).toBe("tune");
  });

  it("locks binding fields of deployment-managed providers", () => {
    expect(providerFieldLocked("credentialRef", true, false)).toBe(true);
    expect(providerFieldLocked("baseUrl", undefined, true)).toBe(true);
    expect(providerFieldLocked("displayName", true, true)).toBe(false);
    expect(providerFieldLocked("kind", false, false)).toBe(false);
  });

  it("locks provider and model of profiles, and infrastructure settings", () => {
    expect(profileFieldLocked("model", true)).toBe(true);
    expect(profileFieldLocked("maxOutputTokens", true)).toBe(false);
    expect(profileFieldLocked("model", false)).toBe(false);
    expect(settingsSectionLocked("runtime", undefined, true)).toBe(true);
    expect(settingsSectionLocked("dispatcher", undefined, true)).toBe(false);
    expect(settingsSectionLocked("dispatcher", true, false)).toBe(true);
  });
});

describe("settings values", () => {
  it("reads and writes by dot path without mutating", () => {
    const value = { defaultBudgets: { maxCostUsd: 5 }, poll: 1 };
    expect(valueAt(value, "defaultBudgets.maxCostUsd")).toBe(5);
    expect(valueAt(value, "missing.path")).toBeUndefined();
    const next = withValueAt(value, "defaultBudgets.maxCostUsd", 7);
    expect(next).toEqual({ defaultBudgets: { maxCostUsd: 7 }, poll: 1 });
    expect(value.defaultBudgets.maxCostUsd).toBe(5);
    expect(withValueAt({}, "defaultBudgets.maxCapabilityCalls", 1)).toEqual({ defaultBudgets: { maxCapabilityCalls: 1 } });
  });

  it("never silently turns a bad number into 0 or NaN", () => {
    expect(coerceSetting("number", "750", false)).toBe(750);
    expect(coerceSetting("number", "abc", false)).toBe("abc");
    expect(coerceSetting("number", "", false)).toBe("");
    expect(coerceSetting("number", "", true)).toBeNull();
    expect(coerceSetting("boolean", "true", false)).toBe(true);
    expect(coerceSetting("string", "x", true)).toBe("x");
  });

  it("validates integers and JSON objects", () => {
    expect(intError("4", 1, 64)).toBeUndefined();
    expect(intError("0", 1, 64)).toMatch(/1 to 64/);
    expect(intError("1.5", 1, 64)).toMatch(/whole/);
    expect(parseJsonObject("{\"type\":\"object\"}")).toEqual({ value: { type: "object" } });
    expect(parseJsonObject("[]")).toHaveProperty("error");
    expect(parseJsonObject("{")).toHaveProperty("error");
  });
});

describe("change history", () => {
  it("diffs documents by dot path", () => {
    expect(jsonDiff({ a: 1, b: { c: 2, d: 3 } }, { a: 1, b: { c: 4 }, e: true })).toEqual([
      { path: "b.c", before: 2, after: 4, kind: "changed" },
      { path: "b.d", before: 3, after: undefined, kind: "removed" },
      { path: "e", before: undefined, after: true, kind: "added" },
    ]);
    expect(jsonDiff(null, { a: 1 })).toEqual([{ path: "(document)", before: null, after: { a: 1 }, kind: "added" }]);
    expect(jsonDiff({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it("shortens digests and marks absent ones", () => {
    expect(shortDigest("0123456789abcdef")).toBe("0123456789ab…");
    expect(shortDigest(null)).toBe("—");
  });

  it("maps unknown states to neutral, shown verbatim", () => {
    expect(localTone("binding", "ACTIVE")).toMatchObject({ tone: "positive", known: true });
    expect(localTone("delivery", "SOMETHING_NEW")).toEqual({ tone: "neutral", icon: "help", known: false });
  });
});
