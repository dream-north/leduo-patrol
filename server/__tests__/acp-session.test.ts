import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAcpSession } from "../acp-session.js";

test("ClaudeAcpSession.resolveWorkspacePath allows path within workspace", () => {
  const session = new ClaudeAcpSession({
    workspacePath: "/tmp/workspace",
    agentBinPath: "claude",
    onEvent: () => undefined,
  });

  const resolved = (session as any).resolveWorkspacePath("a/b.txt");
  assert.equal(resolved, "/tmp/workspace/a/b.txt");
});

test("ClaudeAcpSession.resolveWorkspacePath rejects traversal", () => {
  const session = new ClaudeAcpSession({
    workspacePath: "/tmp/workspace",
    agentBinPath: "claude",
    onEvent: () => undefined,
  });

  assert.throws(() => (session as any).resolveWorkspacePath("../etc/passwd"), /outside workspace/);
});
