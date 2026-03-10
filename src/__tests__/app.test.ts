import test from "node:test";
import assert from "node:assert/strict";
import { appTestables } from "../App";

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
  const sessions = appTestables.applyDemoPreset([], "/repo", "subagent-tree");
  assert.equal(sessions[0]?.title, "Demo · SubAgent 树状折叠");
  assert.equal(sessions[0]?.timeline[1]?.title, "Task");
  assert.equal(sessions[0]?.timeline[1]?.meta, "running");
});

test("app buildDemoFixtures provides unified timeline and git diff demo data", () => {
  const fixtures = appTestables.buildDemoFixtures([], "/repo", "git-diff");
  assert.equal(fixtures.sessions[0]?.title, "Demo · Git Diff 展示");
  const sessionId = fixtures.sessions[0]?.clientSessionId ?? "";
  assert.equal(fixtures.diffBySessionId[sessionId]?.workingTree.length > 0, true);
  assert.equal(Boolean(fixtures.fileDiffBySessionId[sessionId]?.["workingTree:src/App.tsx"]), true);
});

test("app markdown table helpers parse table syntax", () => {
  assert.equal(appTestables.isMarkdownTableRow("| col1 | col2 |"), true);
  assert.equal(appTestables.isMarkdownTableSeparator("| --- | :---: |"), true);
  assert.deepEqual(appTestables.parseMarkdownTableRow("| a | b |"), ["a", "b"]);
});
