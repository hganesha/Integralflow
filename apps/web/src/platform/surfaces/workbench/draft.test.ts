import { expect, it } from "vitest";
import { applyChanges, changesBetween } from "./draft";

it("rebases changed files without undoing another author’s changes to untouched files", () => {
  const original = {
    "main.py": "original",
    "guide.md": "original guide",
    "obsolete.txt": "old",
  };
  const mine = {
    "main.py": "my edit",
    "guide.md": "original guide",
    "new/data.json": "{}",
  };
  const server = {
    "main.py": "their edit",
    "guide.md": "their updated guide",
    "obsolete.txt": "old",
    "server-only.md": "new",
  };
  const delta = changesBetween(original, mine);
  expect(applyChanges(server, delta)).toEqual({
    "main.py": "my edit",
    "guide.md": "their updated guide",
    "new/data.json": "{}",
    "server-only.md": "new",
  });
  expect(JSON.parse(JSON.stringify(delta))).toEqual(delta);
});
