import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { ensureExecutableBit } from "../pty-runtime.js";

test("ensureExecutableBit adds execute permissions when missing", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "leduo-patrol-pty-runtime-"));
  const helperPath = path.join(tempDir, "spawn-helper");
  writeFileSync(helperPath, "#!/bin/sh\n");
  chmodSync(helperPath, 0o644);

  const beforeMode = statSync(helperPath).mode & 0o777;
  const changed = ensureExecutableBit(helperPath);
  const afterMode = statSync(helperPath).mode & 0o777;

  assert.equal(beforeMode, 0o644);
  assert.equal(changed, true);
  assert.equal(afterMode, 0o755);
});

test("ensureExecutableBit is a no-op when execute permissions already exist", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "leduo-patrol-pty-runtime-"));
  const helperPath = path.join(tempDir, "spawn-helper");
  writeFileSync(helperPath, "#!/bin/sh\n");
  chmodSync(helperPath, 0o755);

  const changed = ensureExecutableBit(helperPath);
  const mode = statSync(helperPath).mode & 0o777;

  assert.equal(changed, false);
  assert.equal(mode, 0o755);
});
