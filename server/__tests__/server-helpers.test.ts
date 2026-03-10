import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { formatError, resolveAllowedPath } from "../server-helpers.js";

test("server helpers formatError handles Error and primitives", () => {
  assert.equal(formatError(new Error("boom")), "boom");
  assert.equal(formatError("plain"), '"plain"');
  assert.equal(formatError(12), "12");
});

test("server helpers resolveAllowedPath returns normalized path in root", () => {
  const root = path.resolve("/tmp/repo");
  const resolved = resolveAllowedPath("/tmp/repo/src", [root]);
  assert.equal(resolved, path.resolve("/tmp/repo/src"));
});

test("server helpers resolveAllowedPath rejects outside roots", () => {
  const root = path.resolve("/tmp/repo");
  assert.throws(() => resolveAllowedPath("/etc", [root]), /outside allowed roots/);
});
