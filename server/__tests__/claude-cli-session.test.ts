import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { claudeCliSessionTestables } from "../claude-cli-session.js";

test("claudeCliSessionTestables.findExecutableOnPath resolves commands from PATH entries", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "leduo-patrol-claude-bin-"));
  const binaryName = process.platform === "win32" ? "claude.cmd" : "claude";
  const binaryPath = path.join(tempDir, binaryName);
  writeFileSync(binaryPath, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");

  const resolved = claudeCliSessionTestables.findExecutableOnPath("claude", tempDir);
  assert.equal(resolved, binaryPath);
});

test("claudeCliSessionTestables.resolveClaudeBin accepts explicit executable paths", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "leduo-patrol-claude-explicit-"));
  const binaryPath = path.join(tempDir, "claude");
  writeFileSync(binaryPath, "#!/bin/sh\n");

  const resolved = claudeCliSessionTestables.resolveClaudeBin(binaryPath, { PATH: "" });
  assert.equal(resolved, binaryPath);
});

test("claudeCliSessionTestables.resolveClaudeBin throws actionable error when claude is missing", () => {
  assert.throws(
    () => claudeCliSessionTestables.resolveClaudeBin(undefined, { PATH: "" }),
    /LEDUO_PATROL_CLAUDE_BIN/,
  );
});
