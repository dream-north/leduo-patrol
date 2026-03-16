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
