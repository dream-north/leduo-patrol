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
  assert.equal(appTestables.getSessionSidebarStatus(makeSession({ connectionState: "error" })), null);
  assert.deepEqual(
    appTestables.getSessionSidebarStatus(
      makeSession({
        connectionState: "error",
        timeline: [{ id: "err-1", kind: "error", title: "错误", body: "boom" }],
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

  assert.equal(appTestables.canMergeToolTimelineItem(existing, incomingSame, "tc-1"), true);
  assert.equal(appTestables.canMergeToolTimelineItem(existing, incomingChild, "tc-1"), false);
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
