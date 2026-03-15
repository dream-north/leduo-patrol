import assert from "node:assert/strict";
import test from "node:test";
import { launchModeTestables } from "../launch-mode.js";

test("launch mode parseBindMode accepts local/server", () => {
  assert.equal(launchModeTestables.parseBindMode("local"), "local");
  assert.equal(launchModeTestables.parseBindMode("SERVER"), "server");
});

test("launch mode parseBindMode rejects invalid values", () => {
  assert.equal(launchModeTestables.parseBindMode(""), null);
  assert.equal(launchModeTestables.parseBindMode("lan"), null);
  assert.equal(launchModeTestables.parseBindMode(undefined), null);
});

test("launch mode readOptionValue supports --mode=value and --mode value", () => {
  assert.equal(launchModeTestables.readOptionValue(["--mode=local"], "--mode"), "local");
  assert.equal(launchModeTestables.readOptionValue(["--mode", "server"], "--mode"), "server");
  assert.equal(launchModeTestables.readOptionValue(["--foo", "bar"], "--mode"), undefined);
});
