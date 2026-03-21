import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import {
  buildSpawnFailureMessage,
  ensureDirectoryExistsSync,
  formatError,
  resolveAllowedPath,
} from "../server-helpers.js";

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

test("server helpers ensureDirectoryExistsSync accepts existing directories", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "leduo-patrol-dir-"));
  assert.equal(ensureDirectoryExistsSync(tempDir, "Workspace"), tempDir);
});

test("server helpers ensureDirectoryExistsSync rejects files and missing paths", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "leduo-patrol-file-"));
  const filePath = path.join(tempDir, "file.txt");
  writeFileSync(filePath, "hello");

  assert.throws(() => ensureDirectoryExistsSync(filePath, "Workspace"), /is not a directory/);
  assert.throws(() => ensureDirectoryExistsSync(path.join(tempDir, "missing"), "Workspace"), /does not exist/);
});

test("server helpers buildSpawnFailureMessage includes command cwd and hint", () => {
  assert.equal(
    buildSpawnFailureMessage("shell", "/bin/zsh", "/repo", new Error("posix_spawnp failed"), "Try another shell."),
    'Failed to start shell "/bin/zsh" in "/repo": posix_spawnp failed. Try another shell.',
  );
});
