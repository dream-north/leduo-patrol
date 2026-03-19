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
    questions: [],
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
  assert.equal(appTestables.getSessionSidebarStatus(makeSession({ connectionState: "error" })), null);
  assert.deepEqual(
    appTestables.getSessionSidebarStatus(
      makeSession({
        connectionState: "error",
        timeline: [{ id: "err-1", kind: "error", title: "错误", body: "boom" }],
      }),
    ),
    { label: "运行中", tone: "running" },
  );
  assert.deepEqual(
    appTestables.getSessionSidebarStatus(
      makeSession({
        connectionState: "error",
        timeline: [
          { id: "err-1", kind: "error", title: "错误", body: "boom" },
          { id: "done-1", kind: "system", title: "本轮完成", body: "stop" },
        ],
      }),
    ),
    { label: "异常", tone: "error" },
  );
  assert.deepEqual(appTestables.getSessionSidebarStatus(makeSession({ connectionState: "connecting" })), {
    label: "连接中",
    tone: "connecting",
  });
  assert.equal(appTestables.getSessionSidebarStatus(makeSession()), null);
});

test("app session sidebar status shows pending for questions", () => {
  const status = appTestables.getSessionSidebarStatus(
    makeSession({
      questions: [
        {
          clientSessionId: "s1",
          questionId: "q1",
          question: "选择颜色",
          options: [{ id: "red", label: "红色" }],
          allowCustomAnswer: false,
        },
      ],
    }),
  );
  assert.deepEqual(status, { label: "待处理", tone: "pending" });
});

test("app relative updatedAt formatter uses minute hour and day buckets", () => {
  const now = Date.parse("2026-03-11T12:00:00.000Z");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-11T11:59:40.000Z", now), "刚刚");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-11T11:45:00.000Z", now), "15 分钟前");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-11T09:00:00.000Z", now), "3 小时前");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-08T12:00:00.000Z", now), "3 天前");
});

test("app prompt finished keep-running helper handles permission stop reasons", () => {
  assert.equal(appTestables.shouldKeepSessionRunningAfterPromptFinished("pause_turn"), true);
  assert.equal(appTestables.shouldKeepSessionRunningAfterPromptFinished("permission_required"), true);
  assert.equal(appTestables.shouldKeepSessionRunningAfterPromptFinished("end_turn"), false);
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

test("app markdown decision and plan parsing helpers", () => {
  assert.equal(appTestables.shouldRenderMarkdown({ id: "1", kind: "plan", title: "p", body: "b" }), true);
  assert.equal(appTestables.shouldUseExpandedPreview({ id: "1", kind: "tool", title: "t", body: "line1\nline2" }), false);
  assert.equal(appTestables.extractPlanText({ rawInput: { file_path: "/repo/.claude/plans/p2.md", content: "abc" } }), "abc");
  assert.equal(appTestables.extractPlanText({ plan: "# Plan\n- step 1" }), "# Plan\n- step 1");
  assert.equal(appTestables.extractPlanText({ rawInput: { plan: "# Plan\n- step 1" } }), "# Plan\n- step 1");
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


test("app buildPathBreadcrumbs supports root shortcut and nested path", () => {
  const crumbs = appTestables.buildPathBreadcrumbs("/workspace/leduo-patrol/src/components", ["/workspace", "/tmp"]);
  assert.equal(crumbs[0]?.label, "根目录");
  assert.equal(crumbs[0]?.path, "/workspace");
  assert.equal(crumbs.at(-1)?.path, "/workspace/leduo-patrol/src/components");
  assert.equal(crumbs.at(-1)?.active, true);
});

test("app buildPathBreadcrumbs falls back to absolute root when outside allowed roots", () => {
  const crumbs = appTestables.buildPathBreadcrumbs("/opt/demo/project", ["/workspace"]);
  assert.equal(crumbs[0]?.label, "/");
  assert.equal(crumbs[1]?.path, "/opt");
  assert.equal(crumbs.at(-1)?.path, "/opt/demo/project");
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
  assert.deepEqual(appTestables.countChildrenByRoot(rows), { "tool-start": 1 });
  assert.equal(appTestables.isSubagentToolTitle("Task"), true);
});

test("app timeline tree helpers exit collapsed subtree after matching completion", () => {
  const rows = appTestables.buildTimelineTreeRows([
    {
      id: "task-running",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-task", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "tool-inside",
      kind: "tool",
      title: "Read",
      body: "inside",
      meta: "running",
    },
    {
      id: "task-completed",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-task", title: "Task", status: "completed" }),
      meta: "completed",
    },
    {
      id: "tool-outside",
      kind: "tool",
      title: "Write",
      body: "outside",
      meta: "completed",
    },
  ]);

  assert.equal(rows[2]?.item.id, "tool-outside");
  assert.equal(rows[2]?.depth, 0);
});

test("app timeline tree helpers support concurrent subagent roots by toolCallId", () => {
  const rows = appTestables.buildTimelineTreeRows([
    {
      id: "task-1",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-1", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "task-2",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-2", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "task-1-done",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-1", title: "Task", status: "completed" }),
      meta: "completed",
    },
    {
      id: "still-in-task-2",
      kind: "agent",
      title: "Claude",
      body: "inside task 2",
    },
  ]);

  assert.equal(rows[2]?.item.id, "still-in-task-2");
  assert.equal(rows[2]?.depth, 1);
  assert.equal(rows[2]?.rootId, "task-2");
});

test("app timeline tree parallel subagents are siblings at same depth with children routed by toolCallId", () => {
  // Children share the same toolCallId as their parent (legacy / self-match path)
  const rows = appTestables.buildTimelineTreeRows([
    {
      id: "task-1",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-1", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "task-2",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-2", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "task-3",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-3", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "child-of-1",
      kind: "tool",
      title: "Read",
      body: JSON.stringify({ toolCallId: "tc-1", title: "Read", status: "running" }),
      meta: "running",
    },
    {
      id: "child-of-2",
      kind: "tool",
      title: "Bash",
      body: JSON.stringify({ toolCallId: "tc-2", title: "Bash", status: "running" }),
      meta: "running",
    },
    {
      id: "child-of-3",
      kind: "tool",
      title: "Write",
      body: JSON.stringify({ toolCallId: "tc-3", title: "Write", status: "running" }),
      meta: "running",
    },
  ]);

  // All three tasks should be at depth 0 (siblings, not nested)
  assert.equal(rows[0]?.depth, 0);
  assert.equal(rows[0]?.rootId, null);
  assert.equal(rows[1]?.depth, 0);
  assert.equal(rows[1]?.rootId, null);
  assert.equal(rows[2]?.depth, 0);
  assert.equal(rows[2]?.rootId, null);

  // Children should be at depth 1 under the correct parent
  assert.equal(rows[3]?.depth, 1);
  assert.equal(rows[3]?.rootId, "task-1");
  assert.equal(rows[4]?.depth, 1);
  assert.equal(rows[4]?.rootId, "task-2");
  assert.equal(rows[5]?.depth, 1);
  assert.equal(rows[5]?.rootId, "task-3");

  // Each root should have exactly 1 child
  const counts = appTestables.countChildrenByRoot(rows);
  assert.equal(counts["task-1"], 1);
  assert.equal(counts["task-2"], 1);
  assert.equal(counts["task-3"], 1);
});

test("app timeline tree parallel subagents route children via parentToolCallId", () => {
  // Realistic scenario: children have their OWN toolCallId and use
  // parentToolCallId to link to the parent Task.
  const rows = appTestables.buildTimelineTreeRows([
    {
      id: "task-a",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-a", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "task-b",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-b", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "task-c",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-c", title: "Task", status: "running" }),
      meta: "running",
    },
    // child tool calls have their own IDs and explicit parentToolCallId
    {
      id: "agent-text-a",
      kind: "agent",
      title: "Claude",
      body: "Working on task A",
      parentToolCallId: "tc-a",
    },
    {
      id: "read-a",
      kind: "tool",
      title: "Read",
      body: JSON.stringify({ toolCallId: "child-read-1", title: "Read", status: "running" }),
      meta: "running",
      parentToolCallId: "tc-a",
    },
    {
      id: "agent-text-b",
      kind: "agent",
      title: "Claude",
      body: "Working on task B",
      parentToolCallId: "tc-b",
    },
    {
      id: "grep-b",
      kind: "tool",
      title: "Grep",
      body: JSON.stringify({ toolCallId: "child-grep-1", title: "Grep", status: "running" }),
      meta: "running",
      parentToolCallId: "tc-b",
    },
    {
      id: "agent-text-c",
      kind: "agent",
      title: "Claude",
      body: "Working on task C",
      parentToolCallId: "tc-c",
    },
    {
      id: "bash-c",
      kind: "tool",
      title: "Bash",
      body: JSON.stringify({ toolCallId: "child-bash-1", title: "Bash", status: "completed" }),
      meta: "completed",
      parentToolCallId: "tc-c",
    },
    // More interleaved children
    {
      id: "read-a2",
      kind: "tool",
      title: "Read",
      body: JSON.stringify({ toolCallId: "child-read-2", title: "Read", status: "completed" }),
      meta: "completed",
      parentToolCallId: "tc-a",
    },
  ]);

  // All three tasks at depth 0
  assert.equal(rows[0]?.depth, 0, "task-a depth");
  assert.equal(rows[1]?.depth, 0, "task-b depth");
  assert.equal(rows[2]?.depth, 0, "task-c depth");

  // Agent text + tool children routed to correct parents
  assert.equal(rows[3]?.rootId, "task-a", "agent-text-a → task-a");
  assert.equal(rows[4]?.rootId, "task-a", "read-a → task-a");
  assert.equal(rows[5]?.rootId, "task-b", "agent-text-b → task-b");
  assert.equal(rows[6]?.rootId, "task-b", "grep-b → task-b");
  assert.equal(rows[7]?.rootId, "task-c", "agent-text-c → task-c");
  assert.equal(rows[8]?.rootId, "task-c", "bash-c → task-c");
  assert.equal(rows[9]?.rootId, "task-a", "read-a2 → task-a");

  // All children at depth 1
  for (let i = 3; i <= 9; i++) {
    assert.equal(rows[i]?.depth, 1, `row ${i} depth`);
  }

  // Child counts
  const counts = appTestables.countChildrenByRoot(rows);
  assert.equal(counts["task-a"], 3); // agent-text-a, read-a, read-a2
  assert.equal(counts["task-b"], 2); // agent-text-b, grep-b
  assert.equal(counts["task-c"], 2); // agent-text-c, bash-c
});



test("app canMergeToolTimelineItem only merges same toolCallId", () => {
  const existing = {
    id: "existing",
    kind: "tool" as const,
    title: "Task",
    body: JSON.stringify({ toolCallId: "tc-1", title: "Task", status: "running" }),
    meta: "running",
  };
  const incomingSame = {
    id: "incoming-1",
    kind: "tool" as const,
    title: "Task",
    body: JSON.stringify({ toolCallId: "tc-1", title: "Task", status: "completed" }),
    meta: "completed",
  };
  const incomingChild = {
    id: "incoming-2",
    kind: "tool" as const,
    title: "探索当前代码库结构",
    body: JSON.stringify({ toolCallId: "tc-1", title: "探索当前代码库结构", status: "completed" }),
    meta: "completed",
  };

  // Subagent-to-subagent merging is now allowed so status updates (running→completed)
  // merge in place, preventing duplicate roots that trap post-completion output.
  assert.equal(appTestables.canMergeToolTimelineItem(existing, incomingSame, "tc-1"), true);
  // Cross-type (subagent + non-subagent) merging is still blocked.
  assert.equal(appTestables.canMergeToolTimelineItem(existing, incomingChild, "tc-1"), false);
});


test("app timeline tree keeps subagent children nested and updates root to completed", () => {
  const rows = appTestables.buildTimelineTreeRows([
    {
      id: "task-root-running",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-4", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "task-child-1",
      kind: "agent",
      title: "子任务输出",
      body: "正在处理",
      meta: "running",
    },
    {
      id: "task-root-completed",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-4", title: "Task", status: "completed" }),
      meta: "completed",
    },
    {
      id: "main-agent",
      kind: "agent",
      title: "主代理",
      body: "回到主会话",
      meta: "ok",
    },
  ]);

  assert.equal(rows[0]?.item.id, "task-root-running");
  assert.equal(rows[0]?.item.meta, "completed");
  assert.equal(rows[1]?.depth, 1);
  assert.equal(rows[1]?.rootId, "task-root-running");
  assert.equal(rows[2]?.item.id, "main-agent");
  assert.equal(rows[2]?.depth, 0);
});
test("app timeline tree helpers use first child title for Task parent summary when toolCallId matches", () => {
  const rows = appTestables.buildTimelineTreeRows([
    {
      id: "task-root",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-1", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "task-child",
      kind: "tool",
      title: "探索当前代码库结构",
      body: JSON.stringify({ toolCallId: "tc-1", title: "探索当前代码库结构", status: "running" }),
      meta: "running",
    },
  ]);

  assert.equal(rows[0]?.displayTitle, "Task · 探索当前代码库结构");
});
test("app summarizeToolTitle uses subagent description in Task title", () => {
  assert.equal(
    appTestables.summarizeToolTitle("Task", { description: "探索当前代码库结构" }, "tc-1"),
    "Task · 探索当前代码库结构",
  );
});

test("app summarizeToolTitle reads subagent description from stringified rawInput", () => {
  const rawInput = JSON.stringify({
    rawInput: {
      description: "探索当前代码库结构",
    },
  });
  assert.equal(appTestables.summarizeToolTitle("Task", rawInput, "tc-2"), "Task · 探索当前代码库结构");
});

test("app normalizeAcpToolTitle strips mcp__acp__ prefix", () => {
  assert.equal(appTestables.normalizeAcpToolTitle("mcp__acp__Read"), "Read");
  assert.equal(appTestables.normalizeAcpToolTitle("mcp__acp__Write"), "Write");
  assert.equal(appTestables.normalizeAcpToolTitle("mcp__acp__Edit"), "Edit");
  assert.equal(appTestables.normalizeAcpToolTitle("mcp__acp__Bash"), "Bash");
  assert.equal(appTestables.normalizeAcpToolTitle("mcp__acp__KillShell"), "KillShell");
});

test("app normalizeAcpToolTitle leaves normal titles unchanged", () => {
  assert.equal(appTestables.normalizeAcpToolTitle("Read /path/file"), "Read /path/file");
  assert.equal(appTestables.normalizeAcpToolTitle("Task"), "Task");
  assert.equal(appTestables.normalizeAcpToolTitle(""), "");
  assert.equal(appTestables.normalizeAcpToolTitle(null), "");
  assert.equal(appTestables.normalizeAcpToolTitle(42), "");
});

test("app summarizeToolTitle strips mcp__acp__ prefix", () => {
  assert.equal(
    appTestables.summarizeToolTitle("mcp__acp__Read", null, "tc-1"),
    "Read",
  );
  assert.equal(
    appTestables.summarizeToolTitle("mcp__acp__CustomTool", null, "tc-2"),
    "CustomTool",
  );
});

test("app isReadToolTitle detects read variants", () => {
  // Exact names
  assert.equal(appTestables.isReadToolTitle("Read"), true);
  assert.equal(appTestables.isReadToolTitle("read"), true);
  assert.equal(appTestables.isReadToolTitle("ReadFile"), true);
  assert.equal(appTestables.isReadToolTitle("read_file"), true);
  assert.equal(appTestables.isReadToolTitle("Read File"), true);
  assert.equal(appTestables.isReadToolTitle("file_read"), true);
  assert.equal(appTestables.isReadToolTitle("FileRead"), true);
  // Titles with path suffix (from ACP toolInfoFromToolUse)
  assert.equal(appTestables.isReadToolTitle("Read /src/index.ts"), true);
  assert.equal(appTestables.isReadToolTitle("Read /src/index.ts (1 - 100)"), true);
  assert.equal(appTestables.isReadToolTitle("Read File"), true);
  // mcp__acp__ prefixed
  assert.equal(appTestables.isReadToolTitle("mcp__acp__Read"), true);
  // Non-read tools
  assert.equal(appTestables.isReadToolTitle("Write"), false);
  assert.equal(appTestables.isReadToolTitle("Bash"), false);
  assert.equal(appTestables.isReadToolTitle(null), false);
  assert.equal(appTestables.isReadToolTitle(""), false);
});

test("app isWriteToolTitle detects write variants", () => {
  // Exact names
  assert.equal(appTestables.isWriteToolTitle("Write"), true);
  assert.equal(appTestables.isWriteToolTitle("write"), true);
  assert.equal(appTestables.isWriteToolTitle("WriteFile"), true);
  assert.equal(appTestables.isWriteToolTitle("write_file"), true);
  assert.equal(appTestables.isWriteToolTitle("Write File"), true);
  assert.equal(appTestables.isWriteToolTitle("Create"), true);
  assert.equal(appTestables.isWriteToolTitle("CreateFile"), true);
  // Titles with path suffix (from ACP toolInfoFromToolUse)
  assert.equal(appTestables.isWriteToolTitle("Write /src/index.ts"), true);
  // mcp__acp__ prefixed
  assert.equal(appTestables.isWriteToolTitle("mcp__acp__Write"), true);
  // Non-write tools
  assert.equal(appTestables.isWriteToolTitle("Read"), false);
  assert.equal(appTestables.isWriteToolTitle("Bash"), false);
  assert.equal(appTestables.isWriteToolTitle(null), false);
  assert.equal(appTestables.isWriteToolTitle(""), false);
});

test("app available command helpers normalize group and complete", () => {
  const normalized = appTestables.normalizeAvailableCommands([
    { name: " mcp.list ", description: "list mcp" },
    { name: "/skill.search", description: "search skill" },
    { command: "tool.run", title: "run tool" },
    { name: "/tool.run", description: "duplicate" },
    { name: "", description: "invalid" },
  ]);

  assert.deepEqual(normalized.map((item) => item.name), ["/mcp.list", "/skill.search", "/tool.run"]);
  const completions = appTestables.getPromptCommandCompletions("请执行 /to", normalized);
  assert.deepEqual(completions.map((item) => item.name), ["/tool.run"]);
  const allCompletions = appTestables.getPromptCommandCompletions("/", normalized);
  assert.deepEqual(allCompletions.map((item) => item.name), ["/mcp.list", "/skill.search", "/tool.run"]);
  const sections = appTestables.buildCompletionSections(allCompletions, "/");
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.title, null);
  assert.equal(appTestables.extractPromptCommandQuery("/mc"), "/mc");
  assert.equal(appTestables.applyPromptCommandCompletion("先试试 /to", "/tool.run"), "先试试 /tool.run ");
  assert.deepEqual(appTestables.splitCompletionLabel("/tool.run", "/to"), {
    matched: "/to",
    rest: "ol.run",
  });
});

test("app applyDemoPreset injects demo session for subagent tree preview", () => {
  const fixtures = appTestables.buildDemoFixtures("/repo", "subagent-tree");
  const sessions = appTestables.applyDemoPreset([], fixtures);
  assert.equal(sessions[0]?.title, "demo_release_readiness_multi_service_validation_timeline_and_diff_walkthrough");

  const taskRow = sessions[0]?.timeline.find((item) => item.kind === "tool" && item.title === "Task");
  assert.equal(taskRow?.meta, "running");

  const planBody = appTestables.findLatestExecutionPlanBody(sessions[0]?.timeline ?? []);
  const steps = appTestables.parseExecutionPlanSteps(planBody);
  assert.equal(steps.length, 4);
  assert.equal(steps[2]?.status, "in_progress");
});



test("app buildDemoFixtures includes create-session showcase data", () => {
  const fixtures = appTestables.buildDemoFixtures("/repo", "subagent-tree");
  assert.equal(fixtures?.createSession?.modeId, "plan");
  assert.equal(fixtures?.createSession?.title, "demo_new_session_path_picker_showcase");
  assert.equal(fixtures?.createSession?.workspacePath, "/repo/demo/new-session-showcase/client-dashboard");
});

test("app buildDemoFixtures includes 8 sessions for overflow sidebar regression", () => {
  const fixtures = appTestables.buildDemoFixtures("/repo", "subagent-tree");
  assert.equal(Object.keys(fixtures?.bySessionId ?? {}).length, 8);
});

test("app buildDemoFixtures includes session diff showcase data", () => {
  const fixtures = appTestables.buildDemoFixtures("/repo", "subagent-tree");
  const session = fixtures?.bySessionId["demo-subagent-tree"];
  assert.equal(session?.sessionDiff.workingTree.length, 3);
  assert.equal(session?.fileDiffs["workingTree:src/App.tsx"]?.category, "workingTree");
  assert.equal(session?.session.permissions.length, 1);
});

test("app formatWorkspacePathForSidebar trims allowed root prefix", () => {
  assert.equal(
    appTestables.formatWorkspacePathForSidebar(
      "/home/user/repo/project-a",
      ["/tmp", "/home/user/repo"],
    ),
    "…/project-a",
  );
  assert.equal(appTestables.formatWorkspacePathForSidebar("/home/user/repo", ["/home/user/repo"]), "…/");
  assert.equal(appTestables.formatWorkspacePathForSidebar("/outside/path", ["/home/user/repo"]), "/outside/path");
});

test("app session title helpers normalize and format underscores", () => {
  assert.equal(appTestables.normalizeSessionTitle("  "), "未命名会话");
  assert.equal(appTestables.formatSessionTitleForDisplay("abc_def"), "abc_​def");
});

test("app resolveToolDisplayTitle prefers description then title then toolCallId", () => {
  assert.equal(
    appTestables.resolveToolDisplayTitle(
      [
        { toolCallId: "tool-1", status: "running" },
        { toolCallId: "tool-1", title: "", status: "completed" },
        { toolCallId: "tool-1", title: "final title", status: "completed" },
      ],
      "fallback",
    ),
    "final title",
  );
  assert.equal(
    appTestables.resolveToolDisplayTitle(
      [{ toolCallId: "tool-2", status: "completed" }],
      "fallback",
    ),
    "tool-2",
  );
  // description in rawInput is preferred over title
  assert.equal(
    appTestables.resolveToolDisplayTitle(
      [
        {
          toolCallId: "tool-3",
          title: "`ls -d */`",
          status: "pending",
          rawInput: { command: "ls -d */", description: "列出所有子目录" },
        },
      ],
      "fallback",
    ),
    "列出所有子目录",
  );
});


test("app timeline tree exits subagent when terminal tool update shares Task toolCallId", () => {
  const rows = appTestables.buildTimelineTreeRows([
    {
      id: "task-root",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-1", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "task-child",
      kind: "agent",
      title: "Claude",
      body: "inside subagent",
    },
    {
      id: "task-marker",
      kind: "tool",
      title: "tool_exec",
      body: JSON.stringify({ toolCallId: "tc-1", status: "completed" }),
      meta: "completed",
    },
    {
      id: "main-agent",
      kind: "agent",
      title: "Claude",
      body: "back to main",
    },
  ]);

  assert.equal(rows[1]?.item.id, "task-child");
  assert.equal(rows[1]?.depth, 1);
  assert.equal(rows[2]?.item.id, "main-agent");
  assert.equal(rows[2]?.depth, 0);
});

test("app markdown table helpers parse table syntax", () => {
  assert.equal(appTestables.isMarkdownTableRow("| col1 | col2 |"), true);
  assert.equal(appTestables.isMarkdownTableSeparator("| --- | :---: |"), true);
  assert.deepEqual(appTestables.parseMarkdownTableRow("| a | b |"), ["a", "b"]);
});


test("app normalizeMergedTimeline merges tool updates on restore", () => {
  const merged = appTestables.normalizeMergedTimeline([
    {
      id: "t1",
      kind: "tool",
      title: "Read",
      body: JSON.stringify({ toolCallId: "tc-1", title: "Read", status: "running" }),
      meta: "running",
    },
    {
      id: "t2",
      kind: "tool",
      title: "Read",
      body: JSON.stringify({ toolCallId: "tc-1", title: "Read", status: "completed" }),
      meta: "completed",
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, "t1");
  assert.equal(merged[0]?.kind, "tool");
});

test("app helpers truncate pending preview text", () => {
  const longText = "x".repeat(900);
  const truncated = appTestables.truncateUnknownText(longText, 120);
  assert.match(truncated, /^x{120}\.\.\.（已截断，原始 900 字符）$/);
});

test("app findLatestExecutionPlan returns latest plan entry", () => {
  const plan = appTestables.findLatestExecutionPlan([
    { id: "1", kind: "system", title: "执行计划", body: "plan 1" },
    { id: "2", kind: "agent", title: "Claude", body: "doing" },
    { id: "3", kind: "system", title: "执行计划", body: "plan 2" },
  ]);

  assert.equal(plan, "plan 2");
});


test("app parseExecutionPlanSteps parses known statuses", () => {
  const steps = appTestables.parseExecutionPlanSteps(
    JSON.stringify([
      { content: "step 1", status: "completed" },
      { content: "step 2", status: "in_progress" },
      { content: "step 3", status: "pending" },
      { content: "step 4", status: "mystery" },
      { content: "   ", status: "pending" },
    ]),
  );

  assert.deepEqual(steps, [
    { content: "step 1", status: "completed" },
    { content: "step 2", status: "in_progress" },
    { content: "step 3", status: "pending" },
    { content: "step 4", status: "unknown" },
  ]);
});

test("app findLatestExecutionPlanBody returns untruncated raw body", () => {
  const rawBody = JSON.stringify([{ content: "x".repeat(200), status: "completed" }]);
  const body = appTestables.findLatestExecutionPlanBody([
    { id: "1", kind: "system", title: "执行计划", body: "old" },
    { id: "2", kind: "system", title: "执行计划", body: rawBody },
  ]);

  assert.equal(body, rawBody);
});

test("app mergeToolTimelineItems preserves parentToolCallId when incoming lacks it", () => {
  const existing = {
    id: "t1",
    kind: "tool" as const,
    title: "Read",
    body: JSON.stringify({ toolCallId: "child-read-1", title: "Read", status: "running" }),
    meta: "running",
    parentToolCallId: "tc-parent",
  };
  const incoming = {
    id: "t1-update",
    kind: "tool" as const,
    title: "Read",
    body: JSON.stringify({ toolCallId: "child-read-1", title: "Read", status: "completed" }),
    meta: "completed",
    // parentToolCallId intentionally missing — simulates vendor hook callback without it
  };

  const merged = appTestables.mergeToolTimelineItems(existing, incoming);
  assert.equal(merged.parentToolCallId, "tc-parent", "should preserve existing parentToolCallId");
  assert.equal(merged.id, "t1", "should keep existing id");
  assert.equal(merged.meta, "completed", "should use incoming status");
});

test("app mergeToolTimelineItems uses incoming parentToolCallId when both present", () => {
  const existing = {
    id: "t1",
    kind: "tool" as const,
    title: "Read",
    body: JSON.stringify({ toolCallId: "child-read-1", title: "Read", status: "running" }),
    meta: "running",
    parentToolCallId: "tc-old",
  };
  const incoming = {
    id: "t1-update",
    kind: "tool" as const,
    title: "Read",
    body: JSON.stringify({ toolCallId: "child-read-1", title: "Read", status: "completed" }),
    meta: "completed",
    parentToolCallId: "tc-new",
  };

  const merged = appTestables.mergeToolTimelineItems(existing, incoming);
  assert.equal(merged.parentToolCallId, "tc-new", "should prefer incoming parentToolCallId");
});

test("app buildTimelineTreeRows does not misattribute children across multiple concurrent roots without parentToolCallId", () => {
  // Three concurrent Task roots, an unmatched child (no parentToolCallId, different toolCallId)
  // should NOT be assigned to any root — it should remain at depth 0 (orphaned).
  const rows = appTestables.buildTimelineTreeRows([
    {
      id: "task-1",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-1", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "task-2",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-2", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "task-3",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-3", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      // This item has no parentToolCallId and a unique toolCallId that doesn't match any root.
      // With the old buggy fallback it would go under task-3; now it should be orphaned at depth 0.
      id: "orphan-tool",
      kind: "tool",
      title: "Grep",
      body: JSON.stringify({ toolCallId: "tc-unknown", title: "Grep", status: "running" }),
      meta: "running",
    },
  ]);

  const orphanRow = rows.find((r) => r.item.id === "orphan-tool");
  assert.equal(orphanRow?.depth, 0, "orphan should stay at depth 0 in multi-root scenario");
  assert.equal(orphanRow?.rootId, null, "orphan should have no rootId");
});

test("app buildTimelineTreeRows single-root fallback still works", () => {
  // With only one active root the fallback should still route unmatched children to it.
  const rows = appTestables.buildTimelineTreeRows([
    {
      id: "task-solo",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-solo", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "child-unmatched",
      kind: "agent",
      title: "Claude",
      body: "some output",
      // no parentToolCallId, toolCallId won't match root
    },
  ]);

  const childRow = rows.find((r) => r.item.id === "child-unmatched");
  assert.equal(childRow?.depth, 1, "single-root fallback should nest child at depth 1");
  assert.equal(childRow?.rootId, "task-solo", "single-root fallback should use the only active root");
});

test("app readToolMeta and isTerminalToolStatus parse tool status correctly", () => {
  const item = {
    id: "t1",
    kind: "tool" as const,
    title: "Read",
    body: JSON.stringify({ toolCallId: "tc-1", title: "Read", status: "completed" }),
    meta: "completed",
  };
  const meta = appTestables.readToolMeta(item);
  assert.equal(meta?.toolCallId, "tc-1");
  assert.equal(meta?.status, "completed");
  assert.equal(appTestables.isTerminalToolStatus("completed"), true);
  assert.equal(appTestables.isTerminalToolStatus("failed"), true);
  assert.equal(appTestables.isTerminalToolStatus("canceled"), true);
  assert.equal(appTestables.isTerminalToolStatus("error"), false);
  assert.equal(appTestables.isTerminalToolStatus("running"), false);
  assert.equal(appTestables.isTerminalToolStatus(null), false);
});

test("app buildTimelineTreeRows temporal-locality fallback routes consecutive items to last matched root", () => {
  // Simulate: 2 active roots, one child matched via parentToolCallId,
  // then subsequent children WITHOUT parentToolCallId use temporal-locality
  // to land under the same root.
  const rows = appTestables.buildTimelineTreeRows([
    {
      id: "task-a",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-a", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "task-b",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-b", title: "Task", status: "running" }),
      meta: "running",
    },
    // First child explicitly matched to task-a via parentToolCallId
    {
      id: "child-1",
      kind: "tool",
      title: "Read",
      body: JSON.stringify({ toolCallId: "child-tc-1", title: "Read", status: "running" }),
      meta: "running",
      parentToolCallId: "tc-a",
    },
    // Subsequent child has NO parentToolCallId — temporal-locality should
    // assign it to task-a (last matched root).
    {
      id: "child-2",
      kind: "agent",
      title: "Claude",
      body: "output from subagent a",
    },
    {
      id: "child-3",
      kind: "tool",
      title: "Bash",
      body: JSON.stringify({ toolCallId: "child-tc-3", title: "Bash", status: "completed" }),
      meta: "completed",
    },
  ]);

  assert.equal(rows[2]?.item.id, "child-1");
  assert.equal(rows[2]?.rootId, "task-a", "child-1 matched via parentToolCallId");
  assert.equal(rows[3]?.item.id, "child-2");
  assert.equal(rows[3]?.rootId, "task-a", "child-2 should use temporal-locality fallback to task-a");
  assert.equal(rows[4]?.item.id, "child-3");
  assert.equal(rows[4]?.rootId, "task-a", "child-3 should use temporal-locality fallback to task-a");
});

test("app buildTimelineTreeRows temporal-locality clears when root closes", () => {
  // When a root closes, subsequent unmatched items should NOT fall back
  // to the closed root.
  const rows = appTestables.buildTimelineTreeRows([
    {
      id: "task-a",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-a", title: "Task", status: "running" }),
      meta: "running",
    },
    {
      id: "task-b",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-b", title: "Task", status: "running" }),
      meta: "running",
    },
    // Child matched to task-a
    {
      id: "child-a",
      kind: "tool",
      title: "Read",
      body: JSON.stringify({ toolCallId: "child-tc-a", title: "Read", status: "running" }),
      meta: "running",
      parentToolCallId: "tc-a",
    },
    // task-a closes
    {
      id: "task-a-done",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-a", title: "Task", status: "completed" }),
      meta: "completed",
    },
    // Unmatched item after task-a closes — lastMatchedRoot was task-a but
    // it's no longer active.  Single root fallback should kick in (task-b).
    {
      id: "child-after-close",
      kind: "agent",
      title: "Claude",
      body: "some output",
    },
  ]);

  const childRow = rows.find((r) => r.item.id === "child-after-close");
  assert.equal(childRow?.rootId, "task-b", "should fall back to single remaining root, not closed task-a");
  assert.equal(childRow?.depth, 1);
});

test("app timeline tree groups subagent with rawInput description", () => {
  const rows = appTestables.buildTimelineTreeRows([
    {
      id: "task-running",
      kind: "tool",
      title: "Task · 调研bedrock_common架构",
      body: JSON.stringify({
        toolCallId: "tc-1",
        title: "Task",
        status: "running",
        rawInput: { description: "调研bedrock_common架构", prompt: "...", subagent_type: "explore-agent" },
      }),
      meta: "running",
    },
    {
      id: "child-glob",
      kind: "tool",
      title: "Glob",
      body: JSON.stringify({ toolCallId: "child-tc-1", title: "Glob", status: "completed" }),
      meta: "completed",
      parentToolCallId: "tc-1",
    },
    {
      id: "task-done",
      kind: "tool",
      title: "Task",
      body: JSON.stringify({ toolCallId: "tc-1", title: "Task", status: "completed" }),
      meta: "completed",
    },
  ]);

  // The Task root should be recognized as subagent even though item.title contains description
  assert.equal(rows[0]?.item.id, "task-running");
  assert.equal(rows[1]?.depth, 1, "child should be nested under the Task root");
  assert.equal(rows[1]?.rootId, "task-running", "child should reference the Task root");
});
