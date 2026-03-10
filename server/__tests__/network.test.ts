import test from "node:test";
import assert from "node:assert/strict";
import { networkTestables } from "../network.js";

test("network helper skips virtual/bridge interfaces", () => {
  assert.equal(networkTestables.shouldSkipInterface("lo"), true);
  assert.equal(networkTestables.shouldSkipInterface("br-f017ab"), true);
  assert.equal(networkTestables.shouldSkipInterface("vethf0aa"), true);
  assert.equal(networkTestables.shouldSkipInterface("bond0"), false);
  assert.equal(networkTestables.shouldSkipInterface("eth0"), false);
});
