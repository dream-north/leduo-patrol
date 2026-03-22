import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager, sessionManagerTestables, type SessionSnapshot } from "../session-manager.js";

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    clientSessionId: "s1",
    title: "demo",
    workspacePath: process.cwd(),
    connectionState: "connected",
    activityState: "idle",
    sessionId: "shared-session-id",
    engine: "cli",
    switchable: true,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEntry(overrides: Partial<SessionSnapshot> = {}) {
  return {
    snapshot: makeSnapshot(overrides),
    cliSession: null,
    cliExitExpected: false,
    acpSession: null,
    acpFullTimeline: [],
    outputBuffer: "",
    switchInProgress: false,
  };
}

function makeManager(options: ConstructorParameters<typeof SessionManager>[0]) {
  const manager = new SessionManager(options) as any;
  manager.activityMonitor.watch = () => undefined;
  manager.activityMonitor.unwatch = () => undefined;
  return manager;
}

test("sessionManagerTestables.formatError handles Error and objects", () => {
  assert.equal(sessionManagerTestables.formatError(new Error("boom")), "boom");
  assert.match(sessionManagerTestables.formatError({ code: 1 }), /"code":1/);
});

test("SessionManager.getAvailableEngines exposes ACP only when agent path exists", () => {
  const cliOnly = makeManager({ allowedRoots: [process.cwd()] });
  const dual = makeManager({ allowedRoots: [process.cwd()], agentBinPath: "/tmp/acp" });

  assert.deepEqual(cliOnly.getAvailableEngines(), ["cli"]);
  assert.deepEqual(dual.getAvailableEngines(), ["cli", "acp"]);
});

test("SessionManager.switchEngine keeps the same Claude sessionId", async () => {
  const manager = makeManager({ allowedRoots: [process.cwd()], agentBinPath: "/tmp/acp" });
  const started: Array<{ engine: string; resume: boolean; sessionId: string }> = [];
  const stopped: string[] = [];
  const events: string[] = [];

  manager.startEngine = async (entry: { snapshot: SessionSnapshot }, resume: boolean) => {
    started.push({ engine: entry.snapshot.engine, resume, sessionId: entry.snapshot.sessionId });
    entry.snapshot.connectionState = "connected";
  };
  manager.stopEngine = async (entry: { snapshot: SessionSnapshot }) => {
    stopped.push(entry.snapshot.engine);
  };
  manager.subscribe((event: { type: string }) => events.push(event.type));
  manager.sessions.set("s1", makeEntry());

  await manager.switchEngine("s1", "acp");

  const entry = manager.sessions.get("s1");
  assert.equal(entry.snapshot.engine, "acp");
  assert.equal(entry.snapshot.sessionId, "shared-session-id");
  assert.deepEqual(stopped, ["cli"]);
  assert.deepEqual(started, [{ engine: "acp", resume: true, sessionId: "shared-session-id" }]);
  assert.equal(events.at(-1), "session_updated");
});

test("SessionManager.createSession starts fresh CLI sessions and emits a connected snapshot", async () => {
  const manager = makeManager({ allowedRoots: [process.cwd()], agentBinPath: "/tmp/acp" });
  const started: Array<{ engine: string; resume: boolean; sessionId: string }> = [];
  const events: Array<{ type: string; payload: SessionSnapshot }> = [];

  manager.resolveRequestedWorkspace = async (requestedWorkspacePath: string) => requestedWorkspacePath;
  manager.startEngine = async (entry: { snapshot: SessionSnapshot }, resume: boolean) => {
    started.push({ engine: entry.snapshot.engine, resume, sessionId: entry.snapshot.sessionId });
    entry.snapshot.connectionState = "connected";
  };
  manager.subscribe((event: { type: string; payload: SessionSnapshot }) => {
    if (event.type === "session_registered" || event.type === "session_updated") {
      events.push(event);
    }
  });

  const snapshot = await manager.createSession("/tmp/fresh-cli-workspace", "fresh-cli", false, "cli");

  assert.equal(snapshot.engine, "cli");
  assert.ok(snapshot.sessionId);
  assert.deepEqual(started, [{ engine: "cli", resume: false, sessionId: snapshot.sessionId }]);
  assert.deepEqual(events.map((event) => event.type), ["session_registered", "session_updated"]);
  assert.equal(events[0]?.payload.connectionState, "connecting");
  assert.equal(events[1]?.payload.connectionState, "connected");
});

test("SessionManager.createSession emits an error snapshot when startup fails", async () => {
  const manager = makeManager({ allowedRoots: [process.cwd()] });
  const events: Array<{ type: string; payload: SessionSnapshot }> = [];

  manager.resolveRequestedWorkspace = async (requestedWorkspacePath: string) => requestedWorkspacePath;
  manager.startEngine = async (entry: { snapshot: SessionSnapshot }) => {
    entry.snapshot.connectionState = "error";
    throw new Error("boom");
  };
  manager.subscribe((event: { type: string; payload: SessionSnapshot }) => {
    if (event.type === "session_registered" || event.type === "session_updated") {
      events.push(event);
    }
  });

  await assert.rejects(
    () => manager.createSession("/tmp/broken-cli-workspace", "broken-cli", false, "cli"),
    /boom/,
  );

  assert.deepEqual(events.map((event) => event.type), ["session_registered", "session_updated"]);
  assert.equal(events[0]?.payload.connectionState, "connecting");
  assert.equal(events[1]?.payload.connectionState, "error");
});

test("SessionManager.switchEngine rejects busy sessions", async () => {
  const manager = makeManager({ allowedRoots: [process.cwd()], agentBinPath: "/tmp/acp" });
  manager.sessions.set("s1", makeEntry({ activityState: "running" }));
  manager.startEngine = async () => undefined;
  manager.stopEngine = async () => undefined;

  await assert.rejects(
    () => manager.switchEngine("s1", "acp"),
    /Session is not switchable: 运行中/,
  );
});

test("SessionManager.switchEngine rejects pending ACP approvals", async () => {
  const manager = makeManager({ allowedRoots: [process.cwd()], agentBinPath: "/tmp/acp" });
  manager.sessions.set("s1", makeEntry({
    engine: "acp",
    acp: {
      modes: ["default"],
      defaultModeId: "default",
      currentModeId: "default",
      busy: false,
      timeline: [],
      historyTotal: 0,
      historyStart: 0,
      permissions: [{
        clientSessionId: "s1",
        requestId: "req-1",
        toolCall: { toolCallId: "tool-1", title: "Write" },
        options: [{ optionId: "allow", name: "允许", kind: "allow" }],
      }],
      questions: [],
      availableCommands: [],
    },
  }));
  manager.startEngine = async () => undefined;
  manager.stopEngine = async () => undefined;

  await assert.rejects(
    () => manager.switchEngine("s1", "cli"),
    /Session is not switchable: 待审批/,
  );
});
