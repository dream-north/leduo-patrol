import test from "node:test";
import assert from "node:assert/strict";
import { appTestables } from "../App";

test("app path helpers normalize and guard navigation", () => {
  assert.equal(appTestables.normalizePath("/a/b///"), "/a/b");
  assert.equal(appTestables.isWithinRoot("/a", "/a/b/c"), true);
  assert.equal(appTestables.isWithinRoot("/a", "/x/y"), false);
});

test("app relative updatedAt formatter uses minute hour and day buckets", () => {
  const now = Date.parse("2026-03-11T12:00:00.000Z");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-11T11:59:40.000Z", now), "刚刚");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-11T11:45:00.000Z", now), "15 分钟前");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-11T09:00:00.000Z", now), "3 小时前");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-08T12:00:00.000Z", now), "3 天前");
});

test("app mode/connection helpers return expected labels", () => {
  assert.equal(appTestables.toneForConnectionState("connected"), "positive");
  assert.equal(appTestables.toneForConnectionState("error"), "negative");
});

test("app access key helpers read and preserve search params", () => {
  assert.equal(appTestables.getAccessKeyFromSearch("?demo=subagent-tree&key=abc123"), "abc123");
  assert.equal(
    appTestables.buildLocationWithAccessKey("http://localhost/?demo=subagent-tree", " next-key "),
    "/?demo=subagent-tree&key=next-key",
  );
  assert.equal(
    appTestables.buildLocationWithAccessKey("http://localhost/?demo=subagent-tree&key=old#gate", ""),
    "/?demo=subagent-tree#gate",
  );
});

test("app path helpers parent/isWithinRoot", () => {
  assert.equal(appTestables.parentDirectory("/a/b/c"), "/a/b");
  assert.equal(appTestables.isWithinRoot("/a", "/a/b/c"), true);
  assert.equal(appTestables.isWithinRoot("/a", "/x/y"), false);
});

test("app resolveWorkspaceLookupPath falls back to parent for partial directory names", () => {
  assert.equal(
    appTestables.resolveWorkspaceLookupPath(
      "/repo",
      "src/compo",
      [{ name: "components", path: "/repo/src/components" }],
    ),
    "/repo/src",
  );
  assert.equal(
    appTestables.resolveWorkspaceLookupPath(
      "/repo",
      "src/components",
      [{ name: "components", path: "/repo/src/components" }],
    ),
    "/repo/src/components",
  );
});

test("app formatSessionTitleForDisplay inserts zero-width space after underscores", () => {
  assert.equal(appTestables.formatSessionTitleForDisplay("my_session"), "my_\u200bsession");
  assert.equal(appTestables.formatSessionTitleForDisplay("no_underscore_test"), "no_\u200bunderscore_\u200btest");
});

test("app formatWorkspacePathForSidebar truncates allowed root prefix", () => {
  assert.equal(appTestables.formatWorkspacePathForSidebar("/repo/project", ["/repo"]), "…/project");
  assert.equal(appTestables.formatWorkspacePathForSidebar("/repo", ["/repo"]), "…/");
  assert.equal(appTestables.formatWorkspacePathForSidebar("/other/path", ["/repo"]), "/other/path");
});

test("app splitWorkspacePathByAllowedRoots splits path correctly", () => {
  const result = appTestables.splitWorkspacePathByAllowedRoots("/repo/src/app", ["/repo", "/tmp"]);
  assert.equal(result.root, "/repo");
  assert.equal(result.suffix, "src/app");

  const exact = appTestables.splitWorkspacePathByAllowedRoots("/repo", ["/repo"]);
  assert.equal(exact.root, "/repo");
  assert.equal(exact.suffix, "");
});

test("app mobile terminal detection prefers narrow touch devices", () => {
  assert.equal(
    appTestables.shouldEnableMobileTerminalInput({
      viewportWidth: 430,
      coarsePointer: true,
      touchPoints: 5,
    }),
    true,
  );
  assert.equal(
    appTestables.shouldEnableMobileTerminalInput({
      viewportWidth: 430,
      coarsePointer: false,
      touchPoints: 0,
    }),
    false,
  );
  assert.equal(
    appTestables.shouldEnableMobileTerminalInput({
      viewportWidth: 1280,
      coarsePointer: true,
      touchPoints: 5,
    }),
    false,
  );
});

test("app mobile terminal key mapping returns expected control sequences", () => {
  assert.equal(appTestables.mapMobileTerminalActionToSequence("backspace"), "\u007f");
  assert.equal(appTestables.mapMobileTerminalActionToSequence("shiftTab"), "\u001b[Z");
  assert.equal(appTestables.mapMobileTerminalActionToSequence("arrowUp"), "\u001b[A");
  assert.equal(appTestables.mapMobileTerminalActionToSequence("arrowRight"), "\u001b[C");
  assert.equal(appTestables.mapMobileTerminalActionToSequence("ctrlC"), "\u0003");
});

test("app terminal font size uses compact value on mobile", () => {
  assert.equal(appTestables.getTerminalFontSize(true), 12);
  assert.equal(appTestables.getTerminalFontSize(false), 13);
});

test("app mobile terminal input disables when session or connection is unavailable", () => {
  assert.equal(appTestables.shouldDisableMobileTerminalInput(null, "connected"), true);
  assert.equal(appTestables.shouldDisableMobileTerminalInput("session-1", "closed"), true);
  assert.equal(appTestables.shouldDisableMobileTerminalInput("session-1", "connected", "error"), true);
  assert.equal(appTestables.shouldDisableMobileTerminalInput("session-1", "connected"), false);
});

test("app mobile terminal draft payload supports type and submit flows", () => {
  assert.equal(appTestables.buildMobileTerminalDraftPayload("", false), "");
  assert.equal(appTestables.buildMobileTerminalDraftPayload("", true), "\r");
  assert.equal(appTestables.buildMobileTerminalDraftPayload("hello", false), "hello");
  assert.equal(appTestables.buildMobileTerminalDraftPayload("hello", true), "hello\r");
});

test("app normalizeSessionRecord fills ACP defaults", () => {
  const normalized = appTestables.normalizeSessionRecord({
    clientSessionId: "s1",
    title: "demo",
    workspacePath: "/repo",
    connectionState: "connected",
    activityState: "idle",
    sessionId: "shared",
    engine: "acp",
    updatedAt: new Date().toISOString(),
  });

  assert.equal(normalized.engine, "acp");
  assert.equal(normalized.acp?.defaultModeId, "default");
  assert.deepEqual(normalized.acp?.timeline, []);
});

test("app getSwitchBlockedReasonFromSession reflects ACP pending state", () => {
  const reason = appTestables.getSwitchBlockedReasonFromSession({
    clientSessionId: "s1",
    title: "demo",
    workspacePath: "/repo",
    connectionState: "connected",
    activityState: "idle",
    sessionId: "shared",
    engine: "acp",
    updatedAt: new Date().toISOString(),
    acp: {
      ...appTestables.createEmptyAcpState(),
      permissions: [{
        clientSessionId: "s1",
        requestId: "req-1",
        toolCall: { toolCallId: "tool-1", title: "Write" },
        options: [{ optionId: "allow", name: "允许", kind: "allow" }],
      }],
    },
  });

  assert.equal(reason, "待审批");
});

test("app applyAcpSessionUpdate appends timeline chunk and mode updates", () => {
  const session = appTestables.normalizeSessionRecord({
    clientSessionId: "s1",
    title: "demo",
    workspacePath: "/repo",
    connectionState: "connected",
    activityState: "idle",
    sessionId: "shared",
    engine: "acp",
    updatedAt: new Date().toISOString(),
  });

  const withChunk = appTestables.applyAcpSessionUpdate(session, {
    clientSessionId: "s1",
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hello" },
  });
  assert.equal(withChunk.acp?.timeline.at(-1)?.body, "hello");

  const withMode = appTestables.applyAcpSessionUpdate(withChunk, {
    clientSessionId: "s1",
    sessionUpdate: "current_mode_update",
    currentModeId: "plan",
  });
  assert.equal(withMode.acp?.currentModeId, "plan");
});

test("app applyAcpSessionUpdate merges tool updates and keeps subagent tree rows", () => {
  const session = appTestables.normalizeSessionRecord({
    clientSessionId: "s1",
    title: "demo",
    workspacePath: "/repo",
    connectionState: "connected",
    activityState: "idle",
    sessionId: "shared",
    engine: "acp",
    updatedAt: new Date().toISOString(),
  });

  const withTaskStart = appTestables.applyAcpSessionUpdate(session, {
    clientSessionId: "s1",
    sessionUpdate: "tool_call",
    toolCallId: "task-1",
    title: "Task",
    status: "running",
    rawInput: { description: "梳理组件结构" },
  });
  const withTaskFinish = appTestables.applyAcpSessionUpdate(withTaskStart, {
    clientSessionId: "s1",
    sessionUpdate: "tool_call_update",
    toolCallId: "task-1",
    title: "Task",
    status: "completed",
    rawInput: { description: "梳理组件结构" },
  });
  const withChildTool = appTestables.applyAcpSessionUpdate(withTaskFinish, {
    clientSessionId: "s1",
    sessionUpdate: "tool_call",
    toolCallId: "read-1",
    title: "Read",
    status: "completed",
    rawInput: { filePath: "/repo/src/App.tsx" },
    _meta: { claudeCode: { parentToolUseId: "task-1" } },
  });

  assert.equal(withTaskFinish.acp?.timeline.length, 1);
  assert.equal(withTaskFinish.acp?.timeline[0]?.kind, "tool");

  const rows = appTestables.buildTimelineTreeRows(withChildTool.acp?.timeline ?? []);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.depth, 0);
  assert.equal(rows[1]?.depth, 1);
  assert.equal(rows[1]?.rootId, rows[0]?.item.id);
});

test("app parseExecutionPlanSteps parses structured plan entries", () => {
  const steps = appTestables.parseExecutionPlanSteps(JSON.stringify([
    { content: "恢复 ACP 时间线布局", status: "completed" },
    { content: "验证双引擎切换", status: "in_progress" },
  ]));

  assert.deepEqual(steps, [
    { content: "恢复 ACP 时间线布局", status: "completed" },
    { content: "验证双引擎切换", status: "in_progress" },
  ]);
});
