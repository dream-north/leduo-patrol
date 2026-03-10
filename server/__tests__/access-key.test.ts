import test from "node:test";
import assert from "node:assert/strict";
import { createAccessKey, isAccessKeyAuthorized } from "../access-key.js";

test("createAccessKey returns a non-empty hex string", () => {
  const key = createAccessKey();
  assert.match(key, /^[a-f0-9]{48}$/);
});

test("isAccessKeyAuthorized validates key in query", () => {
  assert.equal(isAccessKeyAuthorized("/api/state?key=abc", "abc"), true);
  assert.equal(isAccessKeyAuthorized("/api/state?key=wrong", "abc"), false);
  assert.equal(isAccessKeyAuthorized("/api/state", "abc"), false);
});

test("isAccessKeyAuthorized allows requests when key enforcement disabled", () => {
  assert.equal(isAccessKeyAuthorized("/api/state", ""), true);
  assert.equal(isAccessKeyAuthorized(undefined, ""), true);
});
