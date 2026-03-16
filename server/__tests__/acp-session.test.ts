import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpSession } from "../acp-session.js";

function makeSession() {
  return new ClaudeAcpSession({
    workspacePath: "/tmp/workspace",
    agentBinPath: "claude",
    onEvent: () => undefined,
  });
}

test("ClaudeAcpSession.resolveWorkspacePath allows path within workspace", () => {
  const session = makeSession();
  const resolved = (session as any).resolveWorkspacePath("a/b.txt");
  assert.equal(resolved, "/tmp/workspace/a/b.txt");
});

test("ClaudeAcpSession.resolveWorkspacePath rejects traversal", () => {
  const session = makeSession();
  assert.throws(() => (session as any).resolveWorkspacePath("../etc/passwd"), /outside workspace/);
});

test("ClaudeAcpSession.resolvePermission rejects unknown request", async () => {
  const session = makeSession();
  await assert.rejects(() => session.resolvePermission("missing", "allow"), /not found|already resolved/);
});

test("ClaudeAcpSession.cancel is a no-op when no active prompt", async () => {
  const session = makeSession();
  await session.cancel();
  assert.ok(true);
});


test("ClaudeAcpSession.shouldIgnoreAgentStderr filters known ACP session/update invalid params noise", () => {
  const session = makeSession();
  const ignored = (session as any).shouldIgnoreAgentStderr(`Error handling notification { method: 'session/update' } { message: 'Invalid params' }`);
  assert.equal(ignored, true);
});



test("ClaudeAcpSession.shouldIgnoreAgentStderr filters missing onPostToolUseHook noise", () => {
  const session = makeSession();
  const ignored = (session as any).shouldIgnoreAgentStderr("No onPostToolUseHook found for tool use ID: toolu_123");
  assert.equal(ignored, true);
});
test("ClaudeAcpSession.shouldIgnoreAgentStderr keeps non-matching errors", () => {
  const session = makeSession();
  const ignored = (session as any).shouldIgnoreAgentStderr("Error: connection reset");
  assert.equal(ignored, false);
});


test("ClaudeAcpSession.resolvePermission forwards optional note via _meta", async () => {
  const session = makeSession();
  const calls: unknown[] = [];
  (session as any).pendingPermissions.set("req-1", {
    resolve: (value: unknown) => calls.push(value),
    reject: () => undefined,
  });

  await session.resolvePermission("req-1", "deny", "请先解释影响范围");

  assert.deepEqual(calls[0], {
    outcome: {
      outcome: "selected",
      optionId: "deny",
      _meta: { note: "请先解释影响范围" },
    },
  });
});

test("ClaudeAcpSession.answerQuestion rejects unknown question", async () => {
  const session = makeSession();
  await assert.rejects(() => session.answerQuestion("missing", "yes"), /not found|already answered/);
});

test("ClaudeAcpSession.answerQuestion resolves pending question with answer", async () => {
  const session = makeSession();
  const calls: unknown[] = [];
  (session as any).pendingQuestions.set("q-1", {
    resolve: (value: unknown) => calls.push(value),
    reject: () => undefined,
  });

  await session.answerQuestion("q-1", "选项A");

  assert.deepEqual(calls[0], { answer: "选项A" });
  assert.equal((session as any).pendingQuestions.size, 0);
});

test("ClaudeAcpSession.answerQuestion emits question_answered event", async () => {
  const events: unknown[] = [];
  const session = new ClaudeAcpSession({
    workspacePath: "/tmp/workspace",
    agentBinPath: "claude",
    onEvent: (event) => events.push(event),
  });
  (session as any).pendingQuestions.set("q-2", {
    resolve: () => undefined,
    reject: () => undefined,
  });

  await session.answerQuestion("q-2", "自定义回答");

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "question_answered",
    payload: { questionId: "q-2", answer: "自定义回答" },
  });
});

test("ClaudeAcpSession.handleExtMethod routes leduo/ask_question", async () => {
  const events: unknown[] = [];
  const session = new ClaudeAcpSession({
    workspacePath: "/tmp/workspace",
    agentBinPath: "claude",
    onEvent: (event) => events.push(event),
  });

  const resultPromise = (session as any).handleExtMethod("leduo/ask_question", {
    question: "选择颜色",
    options: [
      { id: "red", label: "红色" },
      { id: "blue", label: "蓝色" },
    ],
    allowCustomAnswer: true,
  });

  // Verify event was emitted
  assert.equal(events.length, 1);
  const event = events[0] as any;
  assert.equal(event.type, "question_requested");
  assert.equal(event.payload.question, "选择颜色");
  assert.equal(event.payload.options.length, 2);
  assert.equal(event.payload.allowCustomAnswer, true);

  // Simulate user answering the question
  const questionId = event.payload.questionId;
  await session.answerQuestion(questionId, "红色");

  const result = await resultPromise;
  assert.deepEqual(result, { answer: "红色" });
});

test("ClaudeAcpSession.handleExtMethod rejects unknown method", async () => {
  const session = makeSession();
  await assert.rejects(
    () => (session as any).handleExtMethod("unknown/method", {}),
    /Unknown extension method/,
  );
});

test("ClaudeAcpSession.handleExtMethod handles missing options gracefully", async () => {
  const events: unknown[] = [];
  const session = new ClaudeAcpSession({
    workspacePath: "/tmp/workspace",
    agentBinPath: "claude",
    onEvent: (event) => events.push(event),
  });

  const resultPromise = (session as any).handleExtMethod("leduo/ask_question", {
    question: "你的名字是？",
  });

  const event = events[0] as any;
  assert.equal(event.payload.options.length, 0);
  assert.equal(event.payload.allowCustomAnswer, false);

  await session.answerQuestion(event.payload.questionId, "张三");
  const result = await resultPromise;
  assert.deepEqual(result, { answer: "张三" });
});

test("ClaudeAcpSession.handleReadTextFile reads file content", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = "/tmp/test-acp-read-" + Date.now();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "test.txt"), "line1\nline2\nline3\n", "utf8");
  const session = new ClaudeAcpSession({
    workspacePath: dir,
    agentBinPath: "claude",
    onEvent: () => undefined,
  });
  const result = await (session as any).handleReadTextFile({
    path: path.join(dir, "test.txt"),
    sessionId: "s1",
  });
  assert.equal(result.content, "line1\nline2\nline3\n");
  await fs.rm(dir, { recursive: true, force: true });
});

test("ClaudeAcpSession.handleReadTextFile supports line/limit params", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = "/tmp/test-acp-read-limit-" + Date.now();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "test.txt"), "a\nb\nc\nd\ne\n", "utf8");
  const session = new ClaudeAcpSession({
    workspacePath: dir,
    agentBinPath: "claude",
    onEvent: () => undefined,
  });
  const result = await (session as any).handleReadTextFile({
    path: path.join(dir, "test.txt"),
    sessionId: "s1",
    line: 2,
    limit: 2,
  });
  assert.equal(result.content, "b\nc");
  await fs.rm(dir, { recursive: true, force: true });
});

test("ClaudeAcpSession.handleWriteTextFile creates file and directories", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = "/tmp/test-acp-write-" + Date.now();
  const session = new ClaudeAcpSession({
    workspacePath: dir,
    agentBinPath: "claude",
    onEvent: () => undefined,
  });
  const filePath = path.join(dir, "sub", "file.txt");
  await (session as any).handleWriteTextFile({
    path: filePath,
    content: "hello world",
    sessionId: "s1",
  });
  const content = await fs.readFile(filePath, "utf8");
  assert.equal(content, "hello world");
  await fs.rm(dir, { recursive: true, force: true });
});
