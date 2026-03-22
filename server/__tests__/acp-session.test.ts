import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpSession } from "../acp-session.js";

function makeSession() {
  return new ClaudeAcpSession({
    workspacePath: "/tmp/workspace",
    agentBinPath: "claude-code-acp",
    claudeBin: "/tmp/custom-claude",
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

test("ClaudeAcpSession.answerQuestion resolves pending question", async () => {
  const session = makeSession();
  const calls: unknown[] = [];
  (session as any).pendingQuestions.set("q-1", {
    resolve: (value: unknown) => calls.push(value),
    reject: () => undefined,
  });

  await session.answerQuestion("q-1", "好的");

  assert.deepEqual(calls[0], { answer: "好的" });
  assert.equal((session as any).pendingQuestions.size, 0);
});

test("ClaudeAcpSession.handleExtMethod routes leduo/ask_question", async () => {
  const events: unknown[] = [];
  const session = new ClaudeAcpSession({
    workspacePath: "/tmp/workspace",
    agentBinPath: "claude-code-acp",
    onEvent: (event) => events.push(event),
  });

  const resultPromise = (session as any).handleExtMethod("leduo/ask_question", {
    question: "选择颜色",
    options: [{ id: "red", label: "红色" }],
    allowCustomAnswer: true,
  });

  const event = events[0] as { type: string; payload: { questionId: string } };
  assert.equal(event.type, "question_requested");
  await session.answerQuestion(event.payload.questionId, "红色");
  const result = await resultPromise;
  assert.deepEqual(result, { answer: "红色" });
});
