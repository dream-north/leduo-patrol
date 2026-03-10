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
