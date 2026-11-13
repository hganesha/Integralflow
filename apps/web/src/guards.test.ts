import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Lint guards from BUILD-SPEC v2 §13.3, enforced as a test so CI fails on a violation.
const root = new URL("..", import.meta.url).pathname;
const src = join(root, "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const sources = files(src).map((path) => ({ path: relative(src, path), text: readFileSync(path, "utf8") }));

describe("BUILD-SPEC §13.3 guards", () => {
  it("N13: shell and platform never import a domain module", () => {
    const offenders = sources.filter(({ path, text }) => /^(shell|platform)\//.test(path) && /from\s+["'][^"']*domains\//.test(text));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it("N1: only mock-bootstrap.ts touches fetch, MSW or the mock", () => {
    const offenders = sources.filter(({ path, text }) => path !== "mock-bootstrap.ts" && (/\bfetch\(/.test(text) || /from\s+["'](msw|@ehf\/ui-mock)/.test(text) || /contracts\/fixtures/.test(text)));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it("N11: the browser never sets identity headers", () => {
    const offenders = sources.filter(({ text }) => /["']x-(actor|ehf-authenticated|tenant)[a-z-]*["']/i.test(text));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it("the trusted button is used only by TrustedDecisionSheet", () => {
    const offenders = sources.filter(({ path, text }) => /TrustedButton|btn--trusted|@ehf\/ui-kit\/trusted/.test(text) && !/TrustedDecisionSheet/.test(path));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it("no colour literals in app code", () => {
    const offenders = sources.filter(({ text }) => /#[0-9a-fA-F]{3,8}\b(?![\w-])|rgba?\(/.test(text.replace(/\/\/.*$/gm, "")));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });
});
