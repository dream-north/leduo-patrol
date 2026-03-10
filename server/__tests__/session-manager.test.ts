import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager, sessionManagerTestables, type TimelineItem } from "../session-manager.js";

test("sessionManagerTestables.summarizeToolTitle summarizes from raw input", () => {
  const result = sessionManagerTestables.summarizeToolTitle("tool_exec", { command: "npm test", cwd: "/repo" }, "tool-1");
  assert.equal(result, "npm test · /repo");
});

test("sessionManagerTestables.formatError handles Error and objects", () => {
  assert.equal(sessionManagerTestables.formatError(new Error("boom")), "boom");
  assert.match(sessionManagerTestables.formatError({ code: 1 }), /"code":1/);
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
