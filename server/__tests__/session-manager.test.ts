import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager, sessionManagerTestables, type TimelineItem } from "../session-manager.js";

test("sessionManagerTestables.summarizeToolTitle summarizes from raw input", () => {
  const result = sessionManagerTestables.summarizeToolTitle("tool_exec", { command: "npm test", cwd: "/repo" }, "tool-1");
  assert.equal(result, "npm test · /repo");
});

test("sessionManagerTestables.summarizeToolTitle falls back to tool id", () => {
  const result = sessionManagerTestables.summarizeToolTitle("tool_exec", null, "tool-7");
  assert.equal(result, "tool_exec");
});

test("sessionManagerTestables.labelForMode maps known and unknown modes", () => {
  assert.equal(sessionManagerTestables.labelForMode("plan"), "Plan");
  assert.equal(sessionManagerTestables.labelForMode("custom"), "custom");
  assert.equal(sessionManagerTestables.labelForMode(undefined), "默认模式");
});

test("sessionManagerTestables.formatError handles Error and objects", () => {
  assert.equal(sessionManagerTestables.formatError(new Error("boom")), "boom");
  assert.match(sessionManagerTestables.formatError({ code: 1 }), /"code":1/);
});

test("sessionManagerTestables.stringifyMaybe and asRecord behave as expected", () => {
  assert.equal(sessionManagerTestables.stringifyMaybe("ok"), "ok");
  assert.equal(sessionManagerTestables.asRecord(["x"]), null);
  assert.deepEqual(sessionManagerTestables.asRecord({ a: 1 }), { a: 1 });
});

test("sessionManagerTestables.extractChunkText handles ACP content variants", () => {
  assert.equal(sessionManagerTestables.extractChunkText({ type: "text", text: "hello" }), "hello");
  assert.equal(
    sessionManagerTestables.extractChunkText({ type: "resource", resource: { text: "from-resource" } }),
    "from-resource",
  );
  assert.equal(
    sessionManagerTestables.extractChunkText({ type: "resource_link", uri: "file:///tmp/demo.txt" }),
    "[resource] file:///tmp/demo.txt",
  );
  assert.equal(
    sessionManagerTestables.extractChunkText([
      { type: "text", text: "line-1" },
      { type: "resource", resource: { text: "line-2" } },
    ]),
    "line-1\nline-2",
  );
});

test("SessionManager.getSessionHistory returns bounded page", () => {
  const manager = new SessionManager({ allowedRoots: [process.cwd()], agentBinPath: "claude" });
  const timeline: TimelineItem[] = Array.from({ length: 10 }, (_, index) => ({
    id: String(index),
    kind: "system",
    title: `t-${index}`,
    body: `b-${index}`,
  }));

  (manager as any).sessions.set("s1", {
    snapshot: {
      clientSessionId: "s1",
      title: "demo",
      workspacePath: process.cwd(),
      connectionState: "connected",
      sessionId: "x",
      modes: [],
      defaultModeId: "default",
      currentModeId: "default",
      busy: false,
      timeline: [],
      historyTotal: 0,
      historyStart: 0,
      permissions: [],
      updatedAt: new Date().toISOString(),
    },
    acpSession: null,
    connectPromise: null,
    fullTimeline: timeline,
  });

  const page = manager.getSessionHistory("s1", 9, 3);
  assert.equal(page.start, 6);
  assert.equal(page.total, 10);
  assert.deepEqual(page.items.map((item: TimelineItem) => item.id), ["6", "7", "8"]);
});
