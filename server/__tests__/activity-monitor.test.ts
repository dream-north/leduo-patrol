import test from "node:test";
import assert from "node:assert/strict";
import { determineActivityState } from "../activity-monitor.js";

// ── assistant + stop_reason variants ────────────────────────────────────────

test("assistant with stop_reason null → running", () => {
  assert.equal(
    determineActivityState({
      type: "assistant",
      message: { stop_reason: null, content: [{ type: "thinking" }] },
    }),
    "running",
  );
});

test("assistant with stop_reason undefined → running", () => {
  assert.equal(
    determineActivityState({
      type: "assistant",
      message: { content: [{ type: "text" }] },
    }),
    "running",
  );
});

test("assistant with no message field → running", () => {
  assert.equal(
    determineActivityState({ type: "assistant" }),
    "running",
  );
});

test("assistant with stop_reason tool_use → pending", () => {
  assert.equal(
    determineActivityState({
      type: "assistant",
      message: { stop_reason: "tool_use", content: [{ type: "tool_use" }] },
    }),
    "pending",
  );
});

test("assistant with stop_reason end_turn → completed", () => {
  assert.equal(
    determineActivityState({
      type: "assistant",
      message: { stop_reason: "end_turn", content: [{ type: "text" }] },
    }),
    "completed",
  );
});

test("assistant with stop_reason stop_sequence → completed", () => {
  assert.equal(
    determineActivityState({
      type: "assistant",
      message: { stop_reason: "stop_sequence", content: [{ type: "text" }] },
    }),
    "completed",
  );
});

test("assistant with stop_reason max_tokens → completed", () => {
  assert.equal(
    determineActivityState({
      type: "assistant",
      message: { stop_reason: "max_tokens", content: [{ type: "text" }] },
    }),
    "completed",
  );
});

// ── user entries ────────────────────────────────────────────────────────────

test("user with text content → running", () => {
  assert.equal(
    determineActivityState({
      type: "user",
      message: { content: [{ type: "text", text: "hello" }] },
    }),
    "running",
  );
});

test("user with tool_result → running", () => {
  assert.equal(
    determineActivityState({
      type: "user",
      message: { content: [{ type: "tool_result" }] },
    }),
    "running",
  );
});

// ── progress entries ────────────────────────────────────────────────────────

test("progress entry with PreToolUse hook → running", () => {
  assert.equal(
    determineActivityState({
      type: "progress",
      data: { type: "hook_progress", hookEvent: "PreToolUse" },
    }),
    "running",
  );
});

test("progress entry with Stop hook → completed", () => {
  assert.equal(
    determineActivityState({
      type: "progress",
      data: { type: "hook_progress", hookEvent: "Stop" },
    }),
    "completed",
  );
});

test("progress entry without hookEvent → running", () => {
  assert.equal(
    determineActivityState({
      type: "progress",
      data: { type: "hook_progress" },
    }),
    "running",
  );
});

// ── unknown type ────────────────────────────────────────────────────────────

test("unknown type falls back to idle", () => {
  assert.equal(
    determineActivityState({ type: "unknown" }),
    "idle",
  );
});
