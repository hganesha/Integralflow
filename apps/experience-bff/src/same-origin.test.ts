import { describe, expect, it } from "vitest";
import { sameOriginPath } from "./session.js";

describe("post-sign-in redirect target", () => {
  it("keeps same-origin paths", () => {
    expect(sameOriginPath("/cases/123?tab=evidence#top")).toBe("/cases/123?tab=evidence#top");
    expect(sameOriginPath(undefined)).toBe("/catalogs");
  });
  it("refuses every way of leaving the origin", () => {
    for (const value of ["//evil.example", "/\t/evil.example", "/\n/evil.example", "/\\evil.example", "\\\\evil.example", "https://evil.example/", "javascript:alert(1)", "evil.example", ["/x"]]) {
      expect(sameOriginPath(value)).toBe("/catalogs");
    }
  });
});
