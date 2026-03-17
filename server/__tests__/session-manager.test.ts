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

test("sessionManagerTestables.summarizeToolTitle reads subagent description from stringified rawInput", () => {
  const rawInput = JSON.stringify({ rawInput: { description: "探索当前代码库结构" } });
  const result = sessionManagerTestables.summarizeToolTitle("Task", rawInput, "tool-9");
  assert.equal(result, "Task · 探索当前代码库结构");
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
      questions: [],
      availableCommands: [],
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

test("SessionManager.setSessionMode updates default and current mode together", async () => {
  const manager = new SessionManager({ allowedRoots: [process.cwd()], agentBinPath: "claude" });
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let requestedMode = "";
  manager.subscribe((event) => {
    events.push(event as { type: string; payload: Record<string, unknown> });
  });

  (manager as any).sessions.set("s1", {
    snapshot: {
      clientSessionId: "s1",
      title: "demo",
      workspacePath: process.cwd(),
      connectionState: "connected",
      sessionId: "x",
      modes: ["default", "plan"],
      defaultModeId: "default",
      currentModeId: "default",
      busy: false,
      timeline: [],
      historyTotal: 0,
      historyStart: 0,
      permissions: [],
      questions: [],
      availableCommands: [],
      updatedAt: new Date().toISOString(),
    },
    acpSession: {
      setMode: async (modeId: string) => {
        requestedMode = modeId;
      },
    },
    connectPromise: null,
    fullTimeline: [],
  });

  await manager.setSessionMode("s1", "plan");

  const entry = (manager as any).sessions.get("s1");
  assert.equal(requestedMode, "plan");
  assert.equal(entry.snapshot.defaultModeId, "plan");
  assert.equal(entry.snapshot.currentModeId, "plan");
  assert.deepEqual(events.at(-1), {
    type: "session_mode_changed",
    payload: {
      clientSessionId: "s1",
      defaultModeId: "plan",
      currentModeId: "plan",
    },
  });
});

test("sessionManagerTestables.formatEditToolChangeMessage summarizes edit diff payload", () => {
  const formatted = sessionManagerTestables.formatEditToolChangeMessage(
    JSON.stringify([
      {
        oldFileName: "/tmp/a.ts",
        newFileName: "/tmp/a.ts",
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-x", "+y"] }],
      },
      {
        index: "/tmp/b.ts",
        hunks: [],
      },
    ]),
  );

  assert.deepEqual(formatted, {
    title: "Edit 已修改 2 个文件",
    body: "Edit 工具已更新以下文件：\n- /tmp/a.ts（1 处修改）\n- /tmp/b.ts",
  });
});

test("sessionManagerTestables.normalizeAvailableCommandsSnapshot keeps slash names", () => {
  const normalized = sessionManagerTestables.normalizeAvailableCommandsSnapshot([
    { name: "help", description: "h" },
    { command: "mcp.list", title: "list" },
    "/help",
  ]);

  assert.deepEqual(
    normalized.map((item: { name: string }) => item.name),
    ["/help", "/mcp.list"],
  );
});

test("sessionManagerTestables.normalizeAcpToolTitle strips mcp__acp__ prefix", () => {
  assert.equal(sessionManagerTestables.normalizeAcpToolTitle("mcp__acp__Read"), "Read");
  assert.equal(sessionManagerTestables.normalizeAcpToolTitle("mcp__acp__Write"), "Write");
  assert.equal(sessionManagerTestables.normalizeAcpToolTitle("mcp__acp__Edit"), "Edit");
  assert.equal(sessionManagerTestables.normalizeAcpToolTitle("mcp__acp__Bash"), "Bash");
  assert.equal(sessionManagerTestables.normalizeAcpToolTitle("mcp__acp__CustomTool"), "CustomTool");
});

test("sessionManagerTestables.normalizeAcpToolTitle leaves normal titles unchanged", () => {
  assert.equal(sessionManagerTestables.normalizeAcpToolTitle("Read /path/file"), "Read /path/file");
  assert.equal(sessionManagerTestables.normalizeAcpToolTitle("Task"), "Task");
  assert.equal(sessionManagerTestables.normalizeAcpToolTitle(""), "");
  assert.equal(sessionManagerTestables.normalizeAcpToolTitle(null), "");
  assert.equal(sessionManagerTestables.normalizeAcpToolTitle(undefined), "");
});

test("sessionManagerTestables.summarizeToolTitle strips mcp__acp__ prefix before summarizing", () => {
  assert.equal(
    sessionManagerTestables.summarizeToolTitle("mcp__acp__Read", { file_path: "/src/index.ts" }, "tc-1"),
    "Read",
  );
  assert.equal(
    sessionManagerTestables.summarizeToolTitle("mcp__acp__CustomTool", null, "tc-2"),
    "CustomTool",
  );
});

test("sessionManagerTestables.isAskUserQuestionTitle detects AskUserQuestion variants", () => {
  assert.equal(sessionManagerTestables.isAskUserQuestionTitle("AskUserQuestion"), true);
  assert.equal(sessionManagerTestables.isAskUserQuestionTitle("askuserquestion"), true);
  assert.equal(sessionManagerTestables.isAskUserQuestionTitle("AskUserQuestion Choose a color"), true);
  assert.equal(sessionManagerTestables.isAskUserQuestionTitle("mcp__acp__AskUserQuestion"), false);
  assert.equal(sessionManagerTestables.isAskUserQuestionTitle("Write"), false);
  assert.equal(sessionManagerTestables.isAskUserQuestionTitle(undefined), false);
  assert.equal(sessionManagerTestables.isAskUserQuestionTitle(""), false);
});

test("handleSessionEvent: AskUserQuestion tool_call does not create duplicate question snapshot", () => {
  const manager = new SessionManager({ allowedRoots: [process.cwd()], agentBinPath: "claude" });

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
      busy: true,
      timeline: [],
      historyTotal: 0,
      historyStart: 0,
      permissions: [],
      questions: [],
      availableCommands: [],
      updatedAt: new Date().toISOString(),
    },
    acpSession: null,
    connectPromise: null,
    fullTimeline: [],
  });

  // Simulate a session_update / tool_call for AskUserQuestion
  (manager as any).handleSessionEvent("s1", {
    type: "session_update",
    payload: {
      sessionUpdate: "tool_call",
      toolCallId: "tc-ask-1",
      title: "AskUserQuestion",
      status: "pending",
      rawInput: { question: "你好吗?" },
    },
  });

  const entry = (manager as any).sessions.get("s1");
  // Should NOT create a question snapshot from tool_call — the permission_requested
  // handler will create it later.  This prevents duplicate questions.
  assert.equal(entry.snapshot.questions.length, 0);
  // Should still add a timeline entry for the tool call
  assert.ok(entry.fullTimeline.length > 0);
});

test("handleSessionEvent: AskUserQuestion permission_requested still creates question snapshot", () => {
  const manager = new SessionManager({ allowedRoots: [process.cwd()], agentBinPath: "claude" });

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
      busy: true,
      timeline: [],
      historyTotal: 0,
      historyStart: 0,
      permissions: [],
      questions: [],
      availableCommands: [],
      updatedAt: new Date().toISOString(),
    },
    acpSession: null,
    connectPromise: null,
    fullTimeline: [],
  });

  // Simulate a permission_requested event for AskUserQuestion (from the
  // patched canUseTool).  This should create a question snapshot.
  (manager as any).handleSessionEvent("s1", {
    type: "permission_requested",
    payload: {
      requestId: "req-ask-1",
      toolCall: {
        toolCallId: "tc-ask-1",
        title: "AskUserQuestion",
        status: "pending",
        rawInput: { question: "选择颜色" },
      },
      options: [
        { optionId: "allow", name: "Answer", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  });

  const entry = (manager as any).sessions.get("s1");
  // Should create a question (not a permission)
  assert.equal(entry.snapshot.questions.length, 1);
  assert.equal(entry.snapshot.questions[0].question, "选择颜色");
  assert.equal(entry.snapshot.permissions.length, 0);
});

test("handleSessionEvent: AskUserQuestion permission_requested emits question_requested (not permission_requested)", () => {
  const manager = new SessionManager({ allowedRoots: [process.cwd()], agentBinPath: "claude" });

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
      busy: true,
      timeline: [],
      historyTotal: 0,
      historyStart: 0,
      permissions: [],
      questions: [],
      availableCommands: [],
      updatedAt: new Date().toISOString(),
    },
    acpSession: null,
    connectPromise: null,
    fullTimeline: [],
  });

  // Capture emitted events
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  (manager as any).subscribe((event: { type: string; payload: Record<string, unknown> }) => {
    emitted.push(event);
  });

  (manager as any).handleSessionEvent("s1", {
    type: "permission_requested",
    payload: {
      requestId: "req-ask-2",
      toolCall: {
        toolCallId: "tc-ask-2",
        title: "AskUserQuestion",
        status: "pending",
        rawInput: { question: "你需要哪种颜色？" },
      },
      options: [
        { optionId: "allow", name: "Answer", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  });

  // The emitted event should be question_requested, NOT permission_requested
  assert.ok(emitted.length > 0, "should have emitted at least one event");
  const questionEvent = emitted.find((e) => e.type === "question_requested");
  assert.ok(questionEvent, "should emit question_requested event");
  assert.equal((questionEvent!.payload as any).question, "你需要哪种颜色？");
  assert.equal((questionEvent!.payload as any).allowCustomAnswer, true);
  assert.equal((questionEvent!.payload as any).clientSessionId, "s1");
  // Should NOT emit permission_requested to the frontend
  const permissionEvent = emitted.find((e) => e.type === "permission_requested");
  assert.equal(permissionEvent, undefined, "should NOT emit permission_requested for AskUserQuestion");
});

test("handleSessionEvent: AskUserQuestion permission_requested with questions array creates multiple question snapshots", () => {
  const manager = new SessionManager({ allowedRoots: [process.cwd()], agentBinPath: "claude" });

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
      busy: true,
      timeline: [],
      historyTotal: 0,
      historyStart: 0,
      permissions: [],
      questions: [],
      availableCommands: [],
      updatedAt: new Date().toISOString(),
    },
    acpSession: null,
    connectPromise: null,
    fullTimeline: [],
  });

  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  (manager as any).subscribe((event: { type: string; payload: Record<string, unknown> }) => {
    emitted.push(event);
  });

  // Simulate the real-world rawInput format with questions array
  (manager as any).handleSessionEvent("s1", {
    type: "permission_requested",
    payload: {
      requestId: "req-multi-1",
      toolCall: {
        toolCallId: "tc-multi-1",
        title: "AskUserQuestion",
        status: "pending",
        rawInput: {
          questions: [
            {
              question: "接口是否已排序？",
              header: "排序",
              multiSelect: false,
              options: [
                { label: "已排序", description: "直接取第一个" },
                { label: "未排序", description: "需要手动排序" },
              ],
            },
            {
              question: "选择哪种状态的作业？",
              header: "状态",
              multiSelect: false,
              options: [
                { label: "只选已完成的", description: "确保数据完整" },
                { label: "选最新的", description: "无论状态如何" },
              ],
            },
          ],
        },
      },
      options: [
        { optionId: "allow", name: "Answer", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  });

  const entry = (manager as any).sessions.get("s1");
  // Should create 2 questions (one per item in questions array)
  assert.equal(entry.snapshot.questions.length, 2);
  assert.equal(entry.snapshot.questions[0].question, "接口是否已排序？");
  assert.equal(entry.snapshot.questions[0].header, "排序");
  assert.equal(entry.snapshot.questions[0].options.length, 2);
  assert.equal(entry.snapshot.questions[0].options[0].label, "已排序");
  assert.equal(entry.snapshot.questions[0].options[0].description, "直接取第一个");
  assert.equal(entry.snapshot.questions[0].allowCustomAnswer, true);
  // All questions in the same AskUserQuestion call should share a groupId
  assert.ok(entry.snapshot.questions[0].groupId, "should have a groupId");
  assert.equal(entry.snapshot.questions[0].groupId, entry.snapshot.questions[1].groupId);
  assert.equal(entry.snapshot.questions[1].question, "选择哪种状态的作业？");
  assert.equal(entry.snapshot.questions[1].header, "状态");
  assert.equal(entry.snapshot.questions[1].options.length, 2);
  assert.equal(entry.snapshot.permissions.length, 0);

  // Should emit 2 question_requested events
  const questionEvents = emitted.filter((e) => e.type === "question_requested");
  assert.equal(questionEvents.length, 2);
  assert.equal((questionEvents[0].payload as any).question, "接口是否已排序？");
  assert.equal((questionEvents[0].payload as any).header, "排序");
  assert.equal((questionEvents[1].payload as any).question, "选择哪种状态的作业？");
});

test("handleSessionEvent: AskUserQuestion tool_call_update with failed status shows as completed", () => {
  const manager = new SessionManager({ allowedRoots: [process.cwd()], agentBinPath: "claude" });

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
      busy: true,
      timeline: [],
      historyTotal: 0,
      historyStart: 0,
      permissions: [],
      questions: [],
      availableCommands: [],
      updatedAt: new Date().toISOString(),
    },
    acpSession: null,
    connectPromise: null,
    fullTimeline: [],
  });

  // Simulate the tool_call_update that arrives after canUseTool returns
  // "deny" with the user's answer.  The SDK marks it as "failed" but the
  // session-manager should override this to "completed" for AskUserQuestion.
  (manager as any).handleSessionEvent("s1", {
    type: "session_update",
    payload: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-ask-1",
      title: "AskUserQuestion",
      status: "failed",
      rawInput: { question: "选择颜色" },
      rawOutput: "红色",
    },
  });

  const entry = (manager as any).sessions.get("s1");
  assert.ok(entry.fullTimeline.length > 0, "timeline should have at least one entry");
  const lastItem = entry.fullTimeline[entry.fullTimeline.length - 1];
  // The meta should be "completed", not "failed"
  assert.equal(lastItem.meta, "completed");
});

test("handleSessionEvent: AskUserQuestion tool_call_update without title uses _meta.claudeCode.toolName fallback", () => {
  const manager = new SessionManager({ allowedRoots: [process.cwd()], agentBinPath: "claude" });

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
      busy: true,
      timeline: [],
      historyTotal: 0,
      historyStart: 0,
      permissions: [],
      questions: [],
      availableCommands: [],
      updatedAt: new Date().toISOString(),
    },
    acpSession: null,
    connectPromise: null,
    fullTimeline: [],
  });

  // Real ACP tool_call_update for AskUserQuestion: title is absent,
  // but _meta.claudeCode.toolName is "AskUserQuestion".  The status
  // override should still fire.
  (manager as any).handleSessionEvent("s1", {
    type: "session_update",
    payload: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-ask-2",
      // no title field — this is what actually happens in production
      status: "failed",
      rawOutput: "红色",
      _meta: {
        claudeCode: {
          toolName: "AskUserQuestion",
        },
      },
    },
  });

  const entry = (manager as any).sessions.get("s1");
  assert.ok(entry.fullTimeline.length > 0, "timeline should have at least one entry");
  const lastItem = entry.fullTimeline[entry.fullTimeline.length - 1];
  // The meta should be "completed", not "failed"
  assert.equal(lastItem.meta, "completed");
});
