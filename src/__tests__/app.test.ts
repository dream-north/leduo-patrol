import test from "node:test";
import assert from "node:assert/strict";
import { appTestables } from "../App";

type SidebarSession = Parameters<typeof appTestables.getSessionSidebarStatus>[0];

function makeSession(overrides: Partial<SidebarSession> = {}): SidebarSession {
  return {
    clientSessionId: "s1",
    title: "session",
    workspacePath: "/repo",
    connectionState: "connected",
    sessionId: "claude-1",
    modes: ["default"],
    defaultModeId: "default",
    currentModeId: "default",
    busy: false,
    timeline: [],
    historyTotal: 0,
    historyStart: 0,
    permissions: [],
    updatedAt: "2026-03-11T00:00:00.000Z",
    ...overrides,
  };
}

test("app path helpers normalize and guard navigation", () => {
  assert.equal(appTestables.normalizePath("/a/b///"), "/a/b");
  assert.equal(appTestables.canNavigateUp("/a/b", ["/a"]), true);
  assert.equal(appTestables.canNavigateUp("/a", ["/a"]), false);
});

test("app extractPlanPreview handles nested plan payload", () => {
  const preview = appTestables.extractPlanPreview({
    rawInput: {
      file_path: "/repo/.claude/plans/p1.md",
      content: "# Plan\n- item",
    },
  });

  assert.deepEqual(preview, { title: "计划", body: "# Plan\n- item" });
});

test("app summarizeToolTitle builds fallback summary", () => {
  const summary = appTestables.summarizeToolTitle("tool_exec", { cmd: ["npm", "run", "check"], cwd: "/repo" }, "tool-2");
  assert.equal(summary, "npm run check · /repo");
});

test("app mode/connection helpers return expected labels", () => {
  assert.equal(appTestables.labelForMode("plan"), "Plan");
  assert.equal(appTestables.toneForConnectionState("connected"), "positive");
  assert.equal(appTestables.toneForConnectionState("error"), "negative");
});

test("app session sidebar status prefers pending over running or completed", () => {
  const status = appTestables.getSessionSidebarStatus(
    makeSession({
      busy: true,
      permissions: [
        {
          clientSessionId: "s1",
          requestId: "p1",
          toolCall: { toolCallId: "tc-1" },
          options: [],
        },
      ],
      timeline: [{ id: "done-1", kind: "system", title: "本轮完成", body: "stop" }],
    }),
  );

  assert.deepEqual(status, { label: "待处理", tone: "pending" });
});

test("app session sidebar status handles running, completed, error, connecting", () => {
  assert.deepEqual(appTestables.getSessionSidebarStatus(makeSession({ busy: true })), {
    label: "运行中",
    tone: "running",
  });
  assert.deepEqual(
    appTestables.getSessionSidebarStatus(
      makeSession({
        timeline: [{ id: "done-1", kind: "system", title: "本轮完成", body: "stop" }],
      }),
    ),
    { label: "已完成", tone: "completed" },
  );
  assert.deepEqual(appTestables.getSessionSidebarStatus(makeSession({ connectionState: "error" })), {
    label: "异常",
    tone: "error",
  });
  assert.deepEqual(appTestables.getSessionSidebarStatus(makeSession({ connectionState: "connecting" })), {
    label: "连接中",
    tone: "connecting",
  });
  assert.equal(appTestables.getSessionSidebarStatus(makeSession()), null);
});

test("app relative updatedAt formatter uses minute hour and day buckets", () => {
  const now = Date.parse("2026-03-11T12:00:00.000Z");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-11T11:59:40.000Z", now), "刚刚");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-11T11:45:00.000Z", now), "15 分钟前");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-11T09:00:00.000Z", now), "3 小时前");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-08T12:00:00.000Z", now), "3 天前");
});

test("app completed prompt helper checks completion marker", () => {
  assert.equal(
    appTestables.hasCompletedPrompt(
      makeSession({
        timeline: [{ id: "done-1", kind: "system", title: "本轮完成", body: "stop" }],
      }),
    ),
    true,
  );
  assert.equal(
    appTestables.hasCompletedPrompt(
      makeSession({
        timeline: [{ id: "msg-1", kind: "agent", title: "Claude", body: "hi" }],
      }),
    ),
    false,
  );
});

test("app preview text helpers trim and condense", () => {
  assert.equal(appTestables.toSingleLine("a\n b"), "a b");
  assert.match(appTestables.toPreviewText("x".repeat(220)), /^x{177}/);
});

test("app path helpers parent/isWithinRoot", () => {
  assert.equal(appTestables.parentDirectory("/a/b/c"), "/a/b");
  assert.equal(appTestables.isWithinRoot("/a", "/a/b/c"), true);
  assert.equal(appTestables.isWithinRoot("/a", "/x/y"), false);
});

test("app markdown decision and plan parsing helpers", () => {
  assert.equal(appTestables.shouldRenderMarkdown({ id: "1", kind: "plan", title: "p", body: "b" }), true);
  assert.equal(appTestables.shouldUseExpandedPreview({ id: "1", kind: "tool", title: "t", body: "line1\nline2" }), false);
  assert.equal(appTestables.extractPlanText({ rawInput: { file_path: "/repo/.claude/plans/p2.md", content: "abc" } }), "abc");
  assert.deepEqual(appTestables.tryParseJson('{"a":1}'), { a: 1 });
});

test("app extractChunkText handles ACP content variants", () => {
  assert.equal(appTestables.extractChunkText({ type: "text", text: "hello" }), "hello");
  assert.equal(appTestables.extractChunkText({ type: "resource", resource: { text: "world" } }), "world");
  assert.equal(
    appTestables.extractChunkText({ type: "resource_link", uri: "file:///repo/.claude/plans/p1.md" }),
    "[resource] file:///repo/.claude/plans/p1.md",
  );
});

test("app timeline tree helpers group subagent span", () => {
  const rows = appTestables.buildTimelineTreeRows([
    {
      id: "tool-start",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-1", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "agent-1",
      kind: "agent",
      title: "Claude",
      body: "subagent output",
    },
    {
      id: "tool-end",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-1", title: "Task", status: "completed" }),
      meta: "completed",
    },
  ]);

  assert.equal(rows[1]?.depth, 1);
  assert.equal(rows[1]?.rootId, "tool-start");
  assert.deepEqual(appTestables.countChildrenByRoot(rows), { "tool-start": 2 });
  assert.equal(appTestables.isSubagentToolTitle("Task"), true);
});

test("app applyDemoPreset injects demo session for subagent tree preview", () => {
  const fixtures = appTestables.buildDemoFixtures("/repo", "subagent-tree");
  const sessions = appTestables.applyDemoPreset([], fixtures);
  assert.equal(sessions[0]?.title, "Demo · SubAgent 树状折叠");
  assert.equal(sessions[0]?.timeline[1]?.title, "Task");
  assert.equal(sessions[0]?.timeline[1]?.meta, "running");
});

test("app buildDemoFixtures includes session diff showcase data", () => {
  const fixtures = appTestables.buildDemoFixtures("/repo", "subagent-tree");
  const session = fixtures?.bySessionId["demo-subagent-tree"];
  assert.equal(session?.sessionDiff.workingTree.length, 2);
  assert.equal(session?.fileDiffs["workingTree:src/App.tsx"]?.category, "workingTree");
});

test("app markdown table helpers parse table syntax", () => {
  assert.equal(appTestables.isMarkdownTableRow("| col1 | col2 |"), true);
  assert.equal(appTestables.isMarkdownTableSeparator("| --- | :---: |"), true);
  assert.deepEqual(appTestables.parseMarkdownTableRow("| a | b |"), ["a", "b"]);
});
