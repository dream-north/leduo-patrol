import test from "node:test";
import assert from "node:assert/strict";
import { sessionManagerTestables } from "../session-manager.js";

test("sessionManagerTestables.formatError handles Error and objects", () => {
  assert.equal(sessionManagerTestables.formatError(new Error("boom")), "boom");
  assert.match(sessionManagerTestables.formatError({ code: 1 }), /"code":1/);
});
