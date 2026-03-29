import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile, access, readdir, open, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import { ClaudeCliSession } from "./claude-cli-session.js";
import { ClaudeAcpSession, type ServerEvent as AcpServerEvent } from "./acp-session.js";
import { ActivityMonitor, projectDirPath, type ActivityState } from "./activity-monitor.js";

export type { ActivityState } from "./activity-monitor.js";

export type SessionEngine = "cli" | "acp";

export type TimelineItem = {
  id: string;
  kind: "system" | "user" | "agent" | "thought" | "tool" | "plan" | "error";
  title: string;
  body: string;
  meta?: string;
  images?: Array<{ data: string; mimeType: string }>;
  parentToolCallId?: string;
};

export type PermissionSnapshot = {
  clientSessionId: string;
  requestId: string;
  toolCall: { toolCallId: string; title?: string; status?: string; rawInput?: unknown };
  options: Array<{ optionId: string; name: string; kind: string }>;
};

export type QuestionSnapshot = {
  clientSessionId: string;
  questionId: string;
  groupId?: string;
  question: string;
  header?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  allowCustomAnswer: boolean;
};

export type AvailableCommandSnapshot = {
  name: string;
  description: string;
  inputType: "unstructured";
};

export type AcpSessionState = {
  modes: string[];
  defaultModeId: string;
  currentModeId: string;
  busy: boolean;
  timeline: TimelineItem[];
  historyTotal: number;
  historyStart: number;
  permissions: PermissionSnapshot[];
  questions: QuestionSnapshot[];
  availableCommands: AvailableCommandSnapshot[];
};

export type SessionSnapshot = {
  clientSessionId: string;
  title: string;
  workspacePath: string;
  connectionState: "connecting" | "connected" | "error";
  activityState: ActivityState;
  sessionId: string;
  engine: SessionEngine;
  switchable: boolean;
  switchBlockedReason?: string;
  updatedAt: string;
  allowSkipPermissions?: boolean;
  acp?: AcpSessionState;
};

type PersistedSession = {
  clientSessionId: string;
  title: string;
  workspacePath: string;
  sessionId: string;
  engine?: SessionEngine;
  updatedAt: string;
  allowSkipPermissions?: boolean;
  acpDefaultModeId?: string;
  acpCurrentModeId?: string;
};

export type SocketEvent =
  | {
      type: "ready";
      payload: {
        sessions: SessionSnapshot[];
      };
    }
  | {
      type: "session_registered";
      payload: SessionSnapshot;
    }
  | {
      type: "session_updated";
      payload: SessionSnapshot;
    }
  | {
      type: "session_closed";
      payload: {
        clientSessionId: string;
      };
    }
  | {
      type: "cli_output";
      payload: {
        clientSessionId: string;
        data: string;
      };
    }
  | {
      type: "cli_exited";
      payload: {
        clientSessionId: string;
        exitCode: number;
      };
    }
  | {
      type: "session_activity";
      payload: {
        clientSessionId: string;
        activityState: ActivityState;
      };
    }
  | {
      type: "session_id_updated";
      payload: {
        clientSessionId: string;
        newSessionId: string;
      };
    }
  | {
      type: "prompt_started";
      payload: { clientSessionId: string; promptId: string; text: string };
    }
  | {
      type: "prompt_finished";
      payload: { clientSessionId: string; promptId: string; stopReason: string };
    }
  | {
      type: "session_update";
      payload: Record<string, unknown> & { clientSessionId: string; sessionUpdate: string };
    }
  | {
      type: "session_mode_changed";
      payload: { clientSessionId: string; defaultModeId: string; currentModeId: string };
    }
  | {
      type: "permission_requested";
      payload: PermissionSnapshot;
    }
  | {
      type: "permission_resolved";
      payload: { clientSessionId: string; requestId: string; optionId: string };
    }
  | {
      type: "question_requested";
      payload: QuestionSnapshot;
    }
  | {
      type: "question_answered";
      payload: { clientSessionId: string; questionId: string; answer: string };
    }
  | {
      type: "error";
      payload: {
        message: string;
        fatal: boolean;
        clientSessionId?: string;
      };
    };

type PersistedState = {
  sessions: PersistedSession[];
};

type ManagedSession = {
  snapshot: SessionSnapshot;
  cliSession: ClaudeCliSession | null;
  cliExitExpected: boolean;
  acpSession: ClaudeAcpSession | null;
  acpFullTimeline: TimelineItem[];
  outputBuffer: string;
  switchInProgress: boolean;
};

type SessionManagerOptions = {
  allowedRoots: string[];
  claudeBin?: string;
  agentBinPath?: string;
  allowSkipPermissions?: boolean;
};

export class SessionManager {
  private static readonly INITIAL_TIMELINE_WINDOW = 120;
  private static readonly HISTORY_PAGE_SIZE = 120;
  private static readonly OUTPUT_BUFFER_MAX = 256 * 1024;
  private static readonly DISCOVERY_POLL_MS = 1000;
  private static readonly DISCOVERY_MAX_POLLS = 60;
  private static readonly HISTORY_DEBOUNCE_MS = 200;
  private static readonly HISTORY_POLL_MS = 3000;

  private readonly allowedRoots: string[];
  private readonly claudeBin: string | undefined;
  private readonly agentBinPath: string | undefined;
  private readonly allowSkipPermissions: boolean;
  private readonly stateFilePath: string;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly listeners = new Set<(event: SocketEvent) => void>();
  private readonly activityMonitor: ActivityMonitor;
  private readonly sessionIdIndex = new Map<string, string>();
  private readonly askUserQuestionMap = new Map<string, { clientSessionId: string; requestId: string }>();
  private readonly discoveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly historyFilePath: string;
  private historyWatcher: FSWatcher | null = null;
  private historyPollTimer: NodeJS.Timeout | null = null;
  private historyDebounceTimer: NodeJS.Timeout | null = null;
  private lastHistorySize = 0;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(options: SessionManagerOptions) {
    this.allowedRoots = options.allowedRoots;
    this.claudeBin = options.claudeBin;
    this.agentBinPath = options.agentBinPath;
    this.allowSkipPermissions = options.allowSkipPermissions ?? false;
    this.stateFilePath = path.join(os.homedir(), ".leduo-patrol", "state.json");
    this.historyFilePath = path.join(
      process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
      "history.jsonl",
    );
    this.activityMonitor = new ActivityMonitor((sessionId, activityState) => {
      const clientSessionId = this.sessionIdIndex.get(sessionId);
      if (!clientSessionId) return;
      const entry = this.sessions.get(clientSessionId);
      if (!entry) return;
      entry.snapshot.activityState = activityState;
      entry.snapshot.updatedAt = new Date().toISOString();
      this.schedulePersist();
      this.emit({
        type: "session_activity",
        payload: { clientSessionId, activityState },
      });
    });
    this.activityMonitor.onPlanSessionDetected = (newSessionId, promptId, workspacePath) => {
      this.handlePlanSessionDetected(newSessionId, promptId, workspacePath);
    };
  }

  async initialize() {
    const persistedState = await this.readPersistedState();
    let skippedPersistedSessions = false;

    for (const persisted of persistedState.sessions) {
      if (!(await this.isRestorableWorkspace(persisted.workspacePath))) {
        skippedPersistedSessions = true;
        continue;
      }

      const snapshot: SessionSnapshot = {
        clientSessionId: persisted.clientSessionId,
        title: persisted.title,
        workspacePath: persisted.workspacePath,
        connectionState: "connecting",
        activityState: "idle",
        sessionId: persisted.sessionId,
        engine: persisted.engine === "acp" ? "acp" : "cli",
        switchable: true,
        updatedAt: persisted.updatedAt,
        allowSkipPermissions: persisted.allowSkipPermissions,
        acp: persisted.engine === "acp"
          ? createEmptyAcpState(persisted.acpDefaultModeId, persisted.acpCurrentModeId)
          : undefined,
      };

      const entry: ManagedSession = {
        snapshot,
        cliSession: null,
        cliExitExpected: false,
        acpSession: null,
        acpFullTimeline: [],
        outputBuffer: "",
        switchInProgress: false,
      };

      this.sessions.set(snapshot.clientSessionId, entry);
      if (snapshot.sessionId) {
        this.sessionIdIndex.set(snapshot.sessionId, snapshot.clientSessionId);
        this.activityMonitor.watch(snapshot.sessionId, snapshot.workspacePath);
      }
    }

    if (skippedPersistedSessions) {
      await this.writePersistedState().catch(() => undefined);
    }

    for (const entry of this.sessions.values()) {
      this.startEngine(entry, Boolean(entry.snapshot.sessionId)).catch((error) => {
        this.handleManagerError(entry.snapshot.clientSessionId, error);
      });
    }

    await this.startHistoryMonitor();
  }

  subscribe(listener: (event: SocketEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStateSnapshot() {
    return {
      sessions: [...this.sessions.values()]
        .map((entry) => this.snapshotForEvent(entry))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
  }

  getAvailableEngines(): SessionEngine[] {
    return this.agentBinPath ? ["cli", "acp"] : ["cli"];
  }

  getSessionHistory(clientSessionId: string, before: number, limit = SessionManager.HISTORY_PAGE_SIZE) {
    const entry = this.getEntry(clientSessionId);
    if (!entry.snapshot.acp) {
      throw new Error("Session history is only available for ACP sessions.");
    }
    const fullTimeline = this.ensureFullTimeline(entry);
    const normalizedLimit = Number.isFinite(limit) ? limit : SessionManager.HISTORY_PAGE_SIZE;
    const normalizedBefore = Number.isFinite(before) ? before : fullTimeline.length;
    const safeLimit = Math.max(1, Math.min(normalizedLimit, SessionManager.HISTORY_PAGE_SIZE));
    const safeBefore = Math.max(0, Math.min(normalizedBefore, fullTimeline.length));
    const start = Math.max(0, safeBefore - safeLimit);

    return {
      items: fullTimeline.slice(start, safeBefore),
      start,
      total: fullTimeline.length,
    };
  }

  getSessionWorkspacePath(clientSessionId: string) {
    return this.getEntry(clientSessionId).snapshot.workspacePath;
  }

  async createSession(
    requestedWorkspacePath: string,
    requestedTitle?: string,
    allowSkipPermissions?: boolean,
    engine: SessionEngine = "cli",
  ) {
    if (engine === "acp" && !this.agentBinPath) {
      throw new Error("ACP engine is unavailable. Check LEDUO_PATROL_AGENT_BIN or bundled claude-code-acp.");
    }

    const resolvedWorkspacePath = await this.resolveRequestedWorkspace(requestedWorkspacePath);
    const existingEntry = [...this.sessions.values()].find(
      (entry) => entry.snapshot.workspacePath === resolvedWorkspacePath,
    );
    if (existingEntry) {
      this.emit({
        type: "session_registered",
        payload: this.snapshotForEvent(existingEntry),
      });
      return existingEntry.snapshot;
    }

    const effectiveAllowSkipPermissions = allowSkipPermissions ?? this.allowSkipPermissions;
    const snapshot: SessionSnapshot = {
      clientSessionId: randomUUID(),
      title: requestedTitle?.trim() || path.basename(resolvedWorkspacePath) || resolvedWorkspacePath,
      workspacePath: resolvedWorkspacePath,
      connectionState: "connecting",
      activityState: "idle",
      sessionId: engine === "cli" ? randomUUID() : "",
      engine,
      switchable: true,
      updatedAt: new Date().toISOString(),
      allowSkipPermissions: effectiveAllowSkipPermissions,
      acp: engine === "acp" ? createEmptyAcpState() : undefined,
    };

    const entry: ManagedSession = {
      snapshot,
      cliSession: null,
      cliExitExpected: false,
      acpSession: null,
      acpFullTimeline: [],
      outputBuffer: "",
      switchInProgress: false,
    };
    this.sessions.set(snapshot.clientSessionId, entry);

    if (snapshot.sessionId) {
      this.sessionIdIndex.set(snapshot.sessionId, snapshot.clientSessionId);
      this.activityMonitor.watch(snapshot.sessionId, resolvedWorkspacePath);
    }

    this.schedulePersist();
    this.emit({
      type: "session_registered",
      payload: this.snapshotForEvent(entry),
    });

    try {
      await this.startEngine(entry, false);
    } catch (error) {
      entry.snapshot.updatedAt = new Date().toISOString();
      this.schedulePersist();
      this.emit({
        type: "session_updated",
        payload: this.snapshotForEvent(entry),
      });
      throw error;
    }

    this.emit({
      type: "session_updated",
      payload: this.snapshotForEvent(entry),
    });
    return snapshot;
  }

  async switchEngine(clientSessionId: string, engine: SessionEngine) {
    const entry = this.getEntry(clientSessionId);
    if (entry.snapshot.engine === engine) {
      return entry.snapshot;
    }
    if (engine === "acp" && !this.agentBinPath) {
      throw new Error("ACP engine is unavailable. Check LEDUO_PATROL_AGENT_BIN or bundled claude-code-acp.");
    }
    const blockedReason = this.getSwitchBlockedReason(entry);
    if (blockedReason) {
      throw new Error(`Session is not switchable: ${blockedReason}`);
    }

    const previousEngine = entry.snapshot.engine;
    entry.switchInProgress = true;

    try {
      await this.stopEngine(entry, "switch");
      entry.snapshot.engine = engine;
      if (engine === "acp" && !entry.snapshot.acp) {
        entry.snapshot.acp = createEmptyAcpState();
      }
      entry.snapshot.connectionState = "connecting";
      entry.snapshot.updatedAt = new Date().toISOString();
      this.schedulePersist();

      await this.startEngine(entry, Boolean(entry.snapshot.sessionId));

      entry.switchInProgress = false;
      this.emit({
        type: "session_updated",
        payload: this.snapshotForEvent(entry),
      });
      return entry.snapshot;
    } catch (error) {
      entry.snapshot.engine = previousEngine;
      entry.snapshot.connectionState = "connecting";
      try {
        await this.startEngine(entry, Boolean(entry.snapshot.sessionId));
      } catch (rollbackError) {
        entry.switchInProgress = false;
        this.handleManagerError(clientSessionId, rollbackError);
        throw error;
      }
      entry.switchInProgress = false;
      this.emit({
        type: "session_updated",
        payload: this.snapshotForEvent(entry),
      });
      throw error;
    }
  }

  writeToSession(clientSessionId: string, data: string) {
    const entry = this.getEntry(clientSessionId);
    if (entry.snapshot.engine !== "cli") {
      throw new Error("CLI input is only available for CLI sessions.");
    }
    entry.cliSession?.write(data);
  }

  resizeCliSession(clientSessionId: string, cols: number, rows: number) {
    const entry = this.getEntry(clientSessionId);
    if (entry.snapshot.engine !== "cli") {
      return;
    }
    entry.cliSession?.resize(cols, rows);
  }

  getSessionOutputBuffer(clientSessionId: string) {
    const entry = this.getEntry(clientSessionId);
    return entry.outputBuffer;
  }

  async prompt(clientSessionId: string, text: string, modeId?: string, images?: Array<{ data: string; mimeType: string }>) {
    const entry = this.getEntry(clientSessionId);
    if (entry.snapshot.engine !== "acp") {
      throw new Error("Prompting is only available in ACP mode.");
    }
    if (!entry.acpSession) {
      await this.startEngine(entry, Boolean(entry.snapshot.sessionId));
    }
    const acpState = this.ensureAcpState(entry);
    const effectiveModeId = modeId || acpState.defaultModeId;
    if (effectiveModeId) {
      await entry.acpSession?.setMode(effectiveModeId);
      acpState.currentModeId = effectiveModeId;
    }
    entry.snapshot.updatedAt = new Date().toISOString();
    this.schedulePersist();
    await entry.acpSession?.prompt(text, images);
  }

  async setSessionMode(clientSessionId: string, modeId: string) {
    const entry = this.getEntry(clientSessionId);
    if (entry.snapshot.engine !== "acp") {
      throw new Error("Session modes are only available in ACP mode.");
    }
    if (!modeId) {
      return;
    }
    if (!entry.acpSession) {
      await this.startEngine(entry, Boolean(entry.snapshot.sessionId));
    }
    const acpState = this.ensureAcpState(entry);
    await entry.acpSession?.setMode(modeId);
    acpState.defaultModeId = modeId;
    acpState.currentModeId = modeId;
    entry.snapshot.updatedAt = new Date().toISOString();
    this.schedulePersist();
    this.emit({
      type: "session_mode_changed",
      payload: {
        clientSessionId,
        defaultModeId: acpState.defaultModeId,
        currentModeId: acpState.currentModeId,
      },
    });
  }

  async cancel(clientSessionId: string) {
    const entry = this.getEntry(clientSessionId);
    if (entry.snapshot.engine !== "acp") {
      return;
    }
    await entry.acpSession?.cancel();
  }

  async resolvePermission(clientSessionId: string, requestId: string, optionId: string, note?: string) {
    const entry = this.getEntry(clientSessionId);
    if (entry.snapshot.engine !== "acp") {
      throw new Error("Permissions are only available in ACP mode.");
    }
    await entry.acpSession?.resolvePermission(requestId, optionId, note);
  }

  async answerQuestion(clientSessionId: string, questionId: string, answer: string) {
    const entry = this.getEntry(clientSessionId);
    if (entry.snapshot.engine !== "acp") {
      throw new Error("Questions are only available in ACP mode.");
    }

    const mappedPermission = this.askUserQuestionMap.get(questionId);
    if (mappedPermission) {
      const siblingIds: string[] = [];
      for (const [qId, mapping] of this.askUserQuestionMap.entries()) {
        if (mapping.requestId === mappedPermission.requestId) {
          siblingIds.push(qId);
        }
      }
      for (const qId of siblingIds) {
        this.askUserQuestionMap.delete(qId);
      }
      await entry.acpSession?.resolvePermission(
        mappedPermission.requestId,
        "deny",
        answer,
      );
      return;
    }

    await entry.acpSession?.answerQuestion(questionId, answer);
  }

  async closeSession(clientSessionId: string) {
    const entry = this.sessions.get(clientSessionId);
    if (!entry) {
      return;
    }
    this.clearDiscoveryTimer(clientSessionId);
    await this.stopEngine(entry, "close");
    this.activityMonitor.unwatch(entry.snapshot.sessionId);
    this.sessionIdIndex.delete(entry.snapshot.sessionId);
    this.sessions.delete(clientSessionId);
    this.schedulePersist();
    this.emit({
      type: "session_closed",
      payload: { clientSessionId },
    });
  }

  private async startEngine(entry: ManagedSession, resume: boolean) {
    entry.snapshot.connectionState = "connecting";
    entry.snapshot.updatedAt = new Date().toISOString();
    this.schedulePersist();

    if (entry.snapshot.engine === "cli") {
      await this.startCliSession(entry, resume);
      return;
    }

    await this.startAcpSession(entry, resume);
  }

  private async stopEngine(entry: ManagedSession, reason: "switch" | "close") {
    if (reason === "switch") {
      entry.outputBuffer = "";
    }
    if (entry.cliSession) {
      entry.cliExitExpected = true;
      entry.cliSession.kill();
      entry.cliSession = null;
    }
    if (entry.acpSession) {
      await entry.acpSession.dispose();
      entry.acpSession = null;
    }
  }

  private async startCliSession(entry: ManagedSession, resume: boolean) {
    const { snapshot } = entry;
    if (!snapshot.sessionId) {
      snapshot.sessionId = randomUUID();
      this.bindSessionId(snapshot.clientSessionId, "", snapshot.sessionId, snapshot.workspacePath, false);
    }

    try {
      const cliSession = new ClaudeCliSession({
        workspacePath: snapshot.workspacePath,
        sessionId: snapshot.sessionId,
        resume,
        claudeBin: this.claudeBin,
        allowSkipPermissions: snapshot.allowSkipPermissions,
      });
      entry.cliSession = cliSession;
      entry.cliExitExpected = false;

      cliSession.on("output", (data: string) => {
        entry.outputBuffer += data;
        if (entry.outputBuffer.length > SessionManager.OUTPUT_BUFFER_MAX) {
          entry.outputBuffer = entry.outputBuffer.slice(-SessionManager.OUTPUT_BUFFER_MAX);
        }
        this.emit({
          type: "cli_output",
          payload: { clientSessionId: snapshot.clientSessionId, data },
        });
      });

      cliSession.on("exit", (exitCode: number) => {
        const expected = entry.cliExitExpected;
        entry.cliExitExpected = false;
        entry.cliSession = null;
        if (expected) {
          return;
        }
        this.clearDiscoveryTimer(snapshot.clientSessionId);
        snapshot.connectionState = "error";
        snapshot.updatedAt = new Date().toISOString();
        this.schedulePersist();
        this.emit({
          type: "cli_exited",
          payload: { clientSessionId: snapshot.clientSessionId, exitCode },
        });
      });

      snapshot.connectionState = "connected";
      snapshot.updatedAt = new Date().toISOString();
      this.schedulePersist();
    } catch (error) {
      snapshot.connectionState = "error";
      throw error;
    }
  }

  private async startAcpSession(entry: ManagedSession, resume: boolean) {
    if (!this.agentBinPath) {
      throw new Error("ACP engine is unavailable.");
    }

    const acpSession = new ClaudeAcpSession({
      workspacePath: entry.snapshot.workspacePath,
      agentBinPath: this.agentBinPath,
      claudeBin: this.claudeBin,
      onEvent: (event) => this.handleAcpSessionEvent(entry.snapshot.clientSessionId, event),
    });
    entry.acpSession = acpSession;

    await acpSession.connect();

    if (resume && entry.snapshot.sessionId) {
      entry.acpFullTimeline = [];
      this.syncVisibleTimeline(entry);
      const restorableSessionId = await acpSession.findRestorableSession(entry.snapshot.sessionId);
      if (restorableSessionId) {
        if (restorableSessionId !== entry.snapshot.sessionId) {
          this.bindSessionId(entry.snapshot.clientSessionId, entry.snapshot.sessionId, restorableSessionId, entry.snapshot.workspacePath, true);
        }
        await acpSession.loadSession(restorableSessionId);
      } else {
        await acpSession.ensureSession();
      }
    } else {
      await acpSession.ensureSession();
    }

    const acpState = this.ensureAcpState(entry);
    if (acpState.defaultModeId && acpState.currentModeId !== acpState.defaultModeId) {
      await acpSession.setMode(acpState.defaultModeId);
      acpState.currentModeId = acpState.defaultModeId;
    }

    entry.snapshot.connectionState = "connected";
    entry.snapshot.updatedAt = new Date().toISOString();
    this.schedulePersist();
  }

  private handleAcpSessionEvent(clientSessionId: string, event: AcpServerEvent) {
    const entry = this.sessions.get(clientSessionId);
    if (!entry) {
      return;
    }

    const acpState = this.ensureAcpState(entry);
    let shouldEmitFullSnapshot = false;
    switch (event.type) {
      case "ready":
        entry.snapshot.connectionState = "connected";
        entry.snapshot.workspacePath = event.payload.workspacePath;
        this.appendTimeline(entry, {
          id: randomUUID(),
          kind: "system",
          title: "Claude ACP 已连接",
          body: event.payload.workspacePath,
        });
        shouldEmitFullSnapshot = true;
        break;
      case "session_created":
        this.bindSessionId(clientSessionId, entry.snapshot.sessionId, event.payload.sessionId, entry.snapshot.workspacePath, false);
        entry.snapshot.connectionState = "connected";
        acpState.modes = event.payload.modes;
        acpState.currentModeId = acpState.currentModeId || acpState.defaultModeId || "default";
        this.appendTimeline(entry, {
          id: randomUUID(),
          kind: "system",
          title: "会话已创建",
          body: event.payload.sessionId,
          meta: labelForMode(acpState.currentModeId || acpState.defaultModeId),
        });
        shouldEmitFullSnapshot = true;
        break;
      case "session_restored":
        this.bindSessionId(clientSessionId, entry.snapshot.sessionId, event.payload.sessionId, entry.snapshot.workspacePath, false);
        entry.snapshot.connectionState = "connected";
        acpState.modes = event.payload.modes;
        this.appendTimeline(entry, {
          id: randomUUID(),
          kind: "system",
          title: "会话已恢复",
          body: event.payload.sessionId,
          meta: labelForMode(acpState.currentModeId || acpState.defaultModeId),
        });
        shouldEmitFullSnapshot = true;
        break;
      case "prompt_started":
        acpState.busy = true;
        this.appendTimeline(entry, {
          id: event.payload.promptId,
          kind: "user",
          title: "你",
          body: event.payload.text,
        });
        break;
      case "prompt_finished":
        acpState.busy = false;
        this.appendTimeline(entry, {
          id: randomUUID(),
          kind: "system",
          title: "本轮完成",
          body: event.payload.stopReason,
        });
        break;
      case "session_update":
        this.consumeSessionUpdate(entry, event.payload as Record<string, unknown> & { sessionUpdate: string });
        break;
      case "permission_requested": {
        const normalizedTitle = normalizeAcpToolTitle(event.payload.toolCall.title) || undefined;

        if (isAskUserQuestionTitle(normalizedTitle)) {
          const rawInput = asRecord(event.payload.toolCall.rawInput);
          const rawQuestions = Array.isArray(rawInput?.questions) ? rawInput.questions : [];
          const parsedQuestions: Array<{
            question: string;
            header?: string;
            options: Array<{ id: string; label: string; description?: string }>;
            allowCustomAnswer: boolean;
          }> = [];

          if (rawQuestions.length > 0) {
            for (const rawQ of rawQuestions) {
              const q = asRecord(rawQ);
              if (!q) continue;
              const questionStr = typeof q.question === "string" ? q.question : "";
              const headerStr = typeof q.header === "string" ? q.header : undefined;
              const rawOpts = Array.isArray(q.options) ? q.options : [];
              const options = rawOpts
                .map((opt) => {
                  const o = asRecord(opt);
                  if (!o) return null;
                  const label = typeof o.label === "string" ? o.label : "";
                  const description = typeof o.description === "string" ? o.description : undefined;
                  return label ? { id: label, label, description } : null;
                })
                .filter((o): o is NonNullable<typeof o> => o !== null);
              parsedQuestions.push({
                question: questionStr,
                header: headerStr,
                options,
                allowCustomAnswer: true,
              });
            }
          } else {
            const questionText = typeof rawInput?.question === "string" ? rawInput.question : "";
            parsedQuestions.push({
              question: questionText,
              header: undefined,
              options: [],
              allowCustomAnswer: true,
            });
          }

          const groupId = randomUUID();
          const questionIds: string[] = [];
          for (const pq of parsedQuestions) {
            const questionId = randomUUID();
            questionIds.push(questionId);
            const questionSnapshot: QuestionSnapshot = {
              clientSessionId,
              questionId,
              groupId,
              question: pq.question,
              header: pq.header,
              options: pq.options,
              allowCustomAnswer: true,
            };
            acpState.questions.push(questionSnapshot);
            this.appendTimeline(entry, {
              id: questionId,
              kind: "system",
              title: "提问",
              body: pq.header ? `【${pq.header}】${pq.question}` : pq.question,
              meta: "pending",
            });
            this.askUserQuestionMap.set(questionId, {
              clientSessionId,
              requestId: event.payload.requestId,
            });
          }

          entry.snapshot.updatedAt = new Date().toISOString();
          this.schedulePersist();
          for (let i = 0; i < parsedQuestions.length; i += 1) {
            const pq = parsedQuestions[i];
            this.emit({
              type: "question_requested",
              payload: {
                clientSessionId,
                questionId: questionIds[i],
                groupId,
                question: pq.question,
                header: pq.header,
                options: pq.options,
                allowCustomAnswer: true,
              },
            });
          }
          return;
        }

        const permission: PermissionSnapshot = {
          clientSessionId,
          requestId: event.payload.requestId,
          toolCall: {
            toolCallId: event.payload.toolCall.toolCallId,
            title: normalizedTitle,
            status: event.payload.toolCall.status ?? undefined,
            rawInput: event.payload.toolCall.rawInput,
          },
          options: event.payload.options.map((option) => ({
            optionId: option.optionId,
            name: option.name,
            kind: option.kind,
          })),
        };
        acpState.permissions.push(permission);
        this.appendTimeline(entry, {
          id: event.payload.requestId,
          kind: "tool",
          title: summarizeToolTitle(
            normalizedTitle,
            event.payload.toolCall.rawInput,
            event.payload.toolCall.toolCallId,
          ),
          body: formatToolDetails({
            toolCallId: event.payload.toolCall.toolCallId,
            title: normalizedTitle,
            status: event.payload.toolCall.status,
            rawInput: event.payload.toolCall.rawInput,
          }),
          meta: event.payload.toolCall.status ?? "pending",
        });
        break;
      }
      case "permission_resolved":
        acpState.permissions = acpState.permissions.filter(
          (permission) => permission.requestId !== event.payload.requestId,
        );
        entry.snapshot.acp = { ...acpState };
        break;
      case "question_requested": {
        const questionSnapshot: QuestionSnapshot = {
          clientSessionId,
          questionId: event.payload.questionId,
          question: event.payload.question,
          options: event.payload.options.map((opt) => ({
            id: opt.id,
            label: opt.label,
          })),
          allowCustomAnswer: event.payload.allowCustomAnswer,
        };
        acpState.questions.push(questionSnapshot);
        this.appendTimeline(entry, {
          id: event.payload.questionId,
          kind: "system",
          title: "提问",
          body: event.payload.question,
          meta: "pending",
        });
        break;
      }
      case "question_answered":
        acpState.questions = acpState.questions.filter(
          (question) => question.questionId !== event.payload.questionId,
        );
        entry.snapshot.acp = { ...acpState };
        break;
      case "error": {
        const editChangeMessage = formatEditToolChangeMessage(event.payload.message);
        if (editChangeMessage) {
          this.appendTimeline(entry, {
            id: randomUUID(),
            kind: "tool",
            title: editChangeMessage.title,
            body: editChangeMessage.body,
            meta: "completed",
          });
          break;
        }

        if (event.payload.fatal) {
          acpState.busy = false;
          entry.snapshot.connectionState = "error";
          shouldEmitFullSnapshot = true;
        }
        this.appendTimeline(entry, {
          id: randomUUID(),
          kind: "error",
          title: event.payload.fatal ? "错误" : "警告",
          body: event.payload.message,
        });
        break;
      }
    }

    entry.snapshot.updatedAt = new Date().toISOString();
    this.schedulePersist();
    if (shouldEmitFullSnapshot) {
      this.emitSessionUpdated(entry);
    }

    switch (event.type) {
      case "prompt_started":
        this.emit({
          type: "prompt_started",
          payload: {
            clientSessionId,
            promptId: event.payload.promptId,
            text: event.payload.text,
          },
        });
        break;
      case "prompt_finished":
        this.emit({
          type: "prompt_finished",
          payload: {
            clientSessionId,
            promptId: event.payload.promptId,
            stopReason: event.payload.stopReason,
          },
        });
        break;
      case "session_update":
        this.emit({
          type: "session_update",
          payload: {
            clientSessionId,
            ...(event.payload as Record<string, unknown>),
            sessionUpdate: event.payload.sessionUpdate,
          },
        });
        break;
      case "permission_requested":
        this.emit({
          type: "permission_requested",
          payload: {
            clientSessionId,
            requestId: event.payload.requestId,
            toolCall: {
              toolCallId: event.payload.toolCall.toolCallId,
              title: event.payload.toolCall.title ?? undefined,
              status: event.payload.toolCall.status ?? undefined,
              rawInput: event.payload.toolCall.rawInput,
            },
            options: event.payload.options.map((option) => ({
              optionId: option.optionId,
              name: option.name,
              kind: option.kind,
            })),
          },
        });
        break;
      case "permission_resolved":
        this.emit({
          type: "permission_resolved",
          payload: {
            clientSessionId,
            requestId: event.payload.requestId,
            optionId: event.payload.optionId,
          },
        });
        break;
      case "question_requested":
        this.emit({
          type: "question_requested",
          payload: {
            clientSessionId,
            questionId: event.payload.questionId,
            question: event.payload.question,
            options: event.payload.options.map((option) => ({
              id: option.id,
              label: option.label,
            })),
            allowCustomAnswer: event.payload.allowCustomAnswer,
          },
        });
        break;
      case "question_answered":
        this.emit({
          type: "question_answered",
          payload: {
            clientSessionId,
            questionId: event.payload.questionId,
            answer: event.payload.answer,
          },
        });
        break;
      case "error":
        this.emit({
          type: "error",
          payload: {
            clientSessionId,
            message: event.payload.message,
            fatal: event.payload.fatal,
          },
        });
        break;
      default:
        break;
    }
  }

  private consumeSessionUpdate(
    entry: ManagedSession,
    update: Record<string, unknown> & { sessionUpdate: string },
  ) {
    const acpState = this.ensureAcpState(entry);
    switch (update.sessionUpdate) {
      case "available_commands_update":
        acpState.availableCommands = normalizeAvailableCommandsSnapshot(
          update.availableCommands ?? update.supportedCommands ?? update.commands,
        );
        entry.snapshot.acp = { ...acpState };
        break;
      case "agent_message_chunk": {
        const chunkText = extractChunkText(update.content);
        if (chunkText) {
          const parentId = extractParentToolCallId(update);
          this.appendTextChunk(entry, "agent", "Claude", chunkText, parentId);
        }
        break;
      }
      case "agent_thought_chunk": {
        const chunkText = extractChunkText(update.content);
        if (chunkText) {
          const parentId = extractParentToolCallId(update);
          this.appendTextChunk(entry, "thought", "思路", chunkText, parentId);
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const claudeCodeMeta = asRecord(asRecord(update._meta)?.claudeCode);
        const metaToolName = typeof claudeCodeMeta?.toolName === "string" ? claudeCodeMeta.toolName : undefined;
        const normalizedTitle = normalizeAcpToolTitle(update.title) || normalizeAcpToolTitle(metaToolName) || undefined;
        const parentToolCallId = extractParentToolCallId(update);
        const effectiveStatus =
          isAskUserQuestionTitle(normalizedTitle) && update.status === "failed"
            ? "completed"
            : update.status;

        this.appendTimeline(entry, {
          id: randomUUID(),
          kind: "tool",
          title: summarizeToolTitle(normalizedTitle, update.rawInput, update.toolCallId),
          body: formatToolDetails({
            toolCallId: update.toolCallId,
            title: normalizedTitle,
            status: effectiveStatus,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
            parentToolCallId,
          }),
          meta: String(effectiveStatus ?? update.sessionUpdate),
        });
        break;
      }
      case "plan": {
        const parentToolCallId = extractParentToolCallId(update);
        this.appendTimeline(entry, {
          id: randomUUID(),
          kind: "system",
          title: "执行计划",
          body: stringifyMaybe(update.entries ?? update),
          parentToolCallId,
        });
        break;
      }
      case "current_mode_update":
        acpState.currentModeId = String(update.currentModeId ?? acpState.currentModeId ?? "default");
        this.appendTimeline(entry, {
          id: randomUUID(),
          kind: "system",
          title: "模式切换",
          body: String(update.currentModeId ?? "unknown"),
        });
        break;
      default:
        break;
    }
  }

  private ensureAcpState(entry: ManagedSession) {
    if (!entry.snapshot.acp) {
      entry.snapshot.acp = createEmptyAcpState();
    }
    return entry.snapshot.acp;
  }

  private appendTextChunk(
    entry: ManagedSession,
    kind: TimelineItem["kind"],
    title: string,
    text: string,
    parentToolCallId?: string,
  ) {
    const fullTimeline = this.ensureFullTimeline(entry);
    const lastItem = fullTimeline.at(-1);
    if (
      lastItem &&
      lastItem.kind === kind &&
      lastItem.title === title &&
      !lastItem.meta &&
      (lastItem.parentToolCallId ?? undefined) === parentToolCallId
    ) {
      lastItem.body += text;
      this.syncVisibleTimeline(entry);
      return;
    }
    this.appendTimeline(entry, {
      id: randomUUID(),
      kind,
      title,
      body: text,
      parentToolCallId,
    });
  }

  private appendTimeline(entry: ManagedSession, item: TimelineItem) {
    this.ensureFullTimeline(entry).push(item);
    this.syncVisibleTimeline(entry);
  }

  private syncVisibleTimeline(entry: ManagedSession) {
    const acpState = this.ensureAcpState(entry);
    const fullTimeline = this.ensureFullTimeline(entry);
    const total = fullTimeline.length;
    const start = Math.max(0, total - SessionManager.INITIAL_TIMELINE_WINDOW);
    acpState.timeline = fullTimeline.slice(start);
    acpState.historyTotal = total;
    acpState.historyStart = start;
  }

  private ensureFullTimeline(entry: ManagedSession) {
    if (!Array.isArray(entry.acpFullTimeline)) {
      entry.acpFullTimeline = [];
    }
    return entry.acpFullTimeline;
  }

  private emit(event: SocketEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private emitSessionUpdated(entry: ManagedSession) {
    this.emit({
      type: "session_updated",
      payload: this.snapshotForEvent(entry),
    });
  }

  private snapshotForEvent(entry: ManagedSession): SessionSnapshot {
    const blockedReason = this.getSwitchBlockedReason(entry);
    const snapshot: SessionSnapshot = structuredClone(entry.snapshot);
    snapshot.switchable = !blockedReason;
    snapshot.switchBlockedReason = blockedReason ?? undefined;
    return snapshot;
  }

  private getSwitchBlockedReason(entry: ManagedSession): string | null {
    if (entry.switchInProgress) {
      return "切换中";
    }
    if (entry.snapshot.connectionState === "connecting") {
      return "连接中";
    }
    if (entry.snapshot.engine === "cli") {
      if (entry.snapshot.activityState === "running") return "运行中";
      if (entry.snapshot.activityState === "pending") return "待处理";
      return null;
    }
    const acpState = entry.snapshot.acp;
    if (!acpState) {
      return null;
    }
    if (acpState.permissions.length > 0) return "待审批";
    if (acpState.questions.length > 0) return "待提问";
    if (this.isAcpBusy(acpState)) return "运行中";
    return null;
  }

  private isAcpBusy(acpState: AcpSessionState) {
    if (!acpState.busy) {
      return false;
    }
    const latestItem = acpState.timeline.at(-1);
    if (latestItem?.kind === "system" && latestItem.title === "本轮完成") {
      return false;
    }
    return true;
  }

  private schedulePersist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.writePersistedState().catch(() => undefined);
    }, 200);
  }

  private async writePersistedState() {
    const persistedSessions: PersistedSession[] = this.getStateSnapshot().sessions.map((session) => ({
      clientSessionId: session.clientSessionId,
      title: session.title,
      workspacePath: session.workspacePath,
      sessionId: session.sessionId,
      engine: session.engine,
      updatedAt: session.updatedAt,
      allowSkipPermissions: session.allowSkipPermissions,
      acpDefaultModeId: session.acp?.defaultModeId,
      acpCurrentModeId: session.acp?.currentModeId,
    }));
    await mkdir(path.dirname(this.stateFilePath), { recursive: true });
    await writeFile(this.stateFilePath, JSON.stringify({ sessions: persistedSessions }, null, 2), "utf8");
  }

  private async readPersistedState(): Promise<PersistedState> {
    try {
      const content = await readFile(this.stateFilePath, "utf8");
      const parsed = JSON.parse(content) as PersistedState;
      if (!Array.isArray(parsed.sessions)) {
        return { sessions: [] };
      }
      return parsed;
    } catch {
      return { sessions: [] };
    }
  }

  private getEntry(clientSessionId: string) {
    const entry = this.sessions.get(clientSessionId);
    if (!entry) {
      throw new Error(`Session not found: ${clientSessionId}`);
    }
    return entry;
  }

  private async resolveRequestedWorkspace(requestedWorkspacePath: string) {
    const trimmedPath = requestedWorkspacePath.trim();
    if (!trimmedPath) {
      throw new Error("Workspace path is required.");
    }

    const resolvedWorkspacePath = path.resolve(trimmedPath);
    const isAllowed = this.allowedRoots.some((rootPath) => {
      const relativePath = path.relative(rootPath, resolvedWorkspacePath);
      return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
    });

    if (!isAllowed) {
      throw new Error(`Workspace path is outside allowed roots: ${resolvedWorkspacePath}`);
    }

    await access(resolvedWorkspacePath);
    return resolvedWorkspacePath;
  }

  private async isRestorableWorkspace(workspacePath: string) {
    try {
      const workspaceStats = await stat(workspacePath);
      return workspaceStats.isDirectory();
    } catch {
      return false;
    }
  }

  private bindSessionId(
    clientSessionId: string,
    oldSessionId: string,
    newSessionId: string,
    workspacePath: string,
    emitChangeEvent: boolean,
  ) {
    if (!newSessionId || oldSessionId === newSessionId) {
      if (newSessionId) {
        this.sessionIdIndex.set(newSessionId, clientSessionId);
      }
      return;
    }

    if (oldSessionId) {
      this.sessionIdIndex.delete(oldSessionId);
      this.activityMonitor.switchWatch(oldSessionId, newSessionId, workspacePath);
    } else {
      this.activityMonitor.watch(newSessionId, workspacePath);
    }

    this.sessionIdIndex.set(newSessionId, clientSessionId);
    const entry = this.sessions.get(clientSessionId);
    if (entry) {
      entry.snapshot.sessionId = newSessionId;
      entry.snapshot.updatedAt = new Date().toISOString();
      this.schedulePersist();
    }

    if (emitChangeEvent) {
      this.emit({
        type: "session_id_updated",
        payload: { clientSessionId, newSessionId },
      });
    }
  }

  private handlePlanSessionDetected(newSessionId: string, promptId: string, workspacePath: string) {
    const oldSessionId = this.activityMonitor.getSessionIdByPromptId(promptId);
    if (!oldSessionId) {
      return;
    }

    const clientSessionId = this.sessionIdIndex.get(oldSessionId);
    if (!clientSessionId) {
      return;
    }

    this.completeSessionSwitch(clientSessionId, oldSessionId, newSessionId, workspacePath);
  }

  private handleSessionClear(oldSessionId: string, workspacePath: string) {
    const clientSessionId = this.sessionIdIndex.get(oldSessionId);
    if (!clientSessionId) {
      return;
    }
    const entry = this.sessions.get(clientSessionId);
    if (!entry) {
      return;
    }

    entry.snapshot.activityState = "idle";
    this.emit({
      type: "session_activity",
      payload: { clientSessionId, activityState: "idle" },
    });

    const delayTimer = setTimeout(() => {
      this.startNewSessionDiscovery(clientSessionId, oldSessionId, workspacePath);
    }, 500);
    this.discoveryTimers.set(clientSessionId, delayTimer as unknown as NodeJS.Timeout);
  }

  private startNewSessionDiscovery(clientSessionId: string, oldSessionId: string, workspacePath: string) {
    const dirPath = projectDirPath(workspacePath);
    let pollCount = 0;

    const tryFind = async (): Promise<boolean> => {
      try {
        const files = (await readdir(dirPath)).filter((file) => file.endsWith(".jsonl"));
        const candidates: { name: string; mtimeMs: number }[] = [];
        for (const file of files) {
          const sid = file.replace(/\.jsonl$/, "");
          if (sid === oldSessionId) continue;
          try {
            const fileStat = await stat(path.join(dirPath, file));
            candidates.push({ name: file, mtimeMs: fileStat.mtimeMs });
          } catch {
            // ignore unreadable candidate
          }
        }
        candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

        for (const candidate of candidates.slice(0, 3)) {
          const filePath = path.join(dirPath, candidate.name);
          let fd;
          try {
            fd = await open(filePath, "r");
            const buffer = Buffer.alloc(4096);
            const { bytesRead } = await fd.read(buffer, 0, 4096, 0);
            const head = buffer.toString("utf8", 0, bytesRead);
            if (head.includes("<command-name>/clear</command-name>")) {
              const newSessionId = candidate.name.replace(/\.jsonl$/, "");
              this.clearDiscoveryTimer(clientSessionId);
              this.completeSessionSwitch(clientSessionId, oldSessionId, newSessionId, workspacePath);
              return true;
            }
          } catch {
            // ignore
          } finally {
            await fd?.close();
          }
        }
      } catch {
        // ignore
      }
      return false;
    };

    tryFind().then((found) => {
      if (found) return;

      const timer = setInterval(async () => {
        pollCount += 1;
        if (pollCount > SessionManager.DISCOVERY_MAX_POLLS) {
          this.clearDiscoveryTimer(clientSessionId);
          return;
        }
        await tryFind();
      }, SessionManager.DISCOVERY_POLL_MS);

      this.discoveryTimers.set(clientSessionId, timer);
    });
  }

  private completeSessionSwitch(
    clientSessionId: string,
    oldSessionId: string,
    newSessionId: string,
    workspacePath: string,
  ) {
    const entry = this.sessions.get(clientSessionId);
    if (!entry) return;

    this.bindSessionId(clientSessionId, oldSessionId, newSessionId, workspacePath, true);
    entry.snapshot.updatedAt = new Date().toISOString();
    this.schedulePersist();
  }

  private clearDiscoveryTimer(clientSessionId: string) {
    const timer = this.discoveryTimers.get(clientSessionId);
    if (timer) {
      clearInterval(timer);
      this.discoveryTimers.delete(clientSessionId);
    }
  }

  private async startHistoryMonitor() {
    try {
      const historyStats = await stat(this.historyFilePath);
      this.lastHistorySize = historyStats.size;
    } catch {
      this.lastHistorySize = 0;
    }

    try {
      this.historyWatcher = watch(this.historyFilePath, () => {
        this.scheduleHistoryCheck();
      });
      this.historyWatcher.on("error", () => {
        this.historyWatcher?.close();
        this.historyWatcher = null;
        if (!this.historyPollTimer) {
          this.historyPollTimer = setInterval(() => {
            this.checkHistoryUpdates().catch(() => undefined);
          }, SessionManager.HISTORY_POLL_MS);
        }
      });
    } catch {
      this.historyPollTimer = setInterval(() => {
        this.checkHistoryUpdates().catch(() => undefined);
      }, SessionManager.HISTORY_POLL_MS);
    }
  }

  private scheduleHistoryCheck() {
    if (this.historyDebounceTimer) clearTimeout(this.historyDebounceTimer);
    this.historyDebounceTimer = setTimeout(() => {
      this.historyDebounceTimer = null;
      this.checkHistoryUpdates().catch(() => undefined);
    }, SessionManager.HISTORY_DEBOUNCE_MS);
  }

  private async checkHistoryUpdates() {
    let fd;
    try {
      const historyStats = await stat(this.historyFilePath);

      if (historyStats.size < this.lastHistorySize) {
        this.lastHistorySize = historyStats.size;
        return;
      }

      if (historyStats.size === this.lastHistorySize) return;

      const readSize = historyStats.size - this.lastHistorySize;
      fd = await open(this.historyFilePath, "r");
      const buffer = Buffer.alloc(readSize);
      await fd.read(buffer, 0, readSize, this.lastHistorySize);
      this.lastHistorySize = historyStats.size;

      const newText = buffer.toString("utf8");
      const lines = newText.split("\n").filter((line) => line.trim().length > 0);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { display?: string; sessionId?: string };
          if (entry.display === "/clear" && entry.sessionId) {
            const clientSessionId = this.sessionIdIndex.get(entry.sessionId);
            if (clientSessionId) {
              const managed = this.sessions.get(clientSessionId);
              if (managed) {
                this.handleSessionClear(entry.sessionId, managed.snapshot.workspacePath);
              }
            }
          }
        } catch {
          // ignore malformed line
        }
      }
    } catch {
      // ignore
    } finally {
      await fd?.close();
    }
  }

  private handleManagerError(clientSessionId: string, error: unknown) {
    const entry = this.sessions.get(clientSessionId);
    if (!entry) {
      return;
    }
    const acpState = entry.snapshot.acp;
    if (acpState) {
      acpState.busy = false;
    }
    entry.snapshot.connectionState = "error";
    entry.snapshot.updatedAt = new Date().toISOString();
    this.schedulePersist();
    this.emit({
      type: "error",
      payload: {
        clientSessionId,
        message: formatError(error),
        fatal: true,
      },
    });
  }
}

function createEmptyAcpState(defaultModeId = "default", currentModeId = defaultModeId): AcpSessionState {
  return {
    modes: [],
    defaultModeId,
    currentModeId,
    busy: false,
    timeline: [],
    historyTotal: 0,
    historyStart: 0,
    permissions: [],
    questions: [],
    availableCommands: [],
  };
}

function stringifyMaybe(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function formatToolDetails(details: {
  toolCallId?: unknown;
  title?: unknown;
  status?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  parentToolCallId?: string;
}) {
  return stringifyMaybe({
    toolCallId: details.toolCallId,
    title: details.title,
    status: details.status,
    rawInput: details.rawInput,
    rawOutput: details.rawOutput,
    ...(details.parentToolCallId ? { parentToolCallId: details.parentToolCallId } : undefined),
  });
}

function normalizeAcpToolTitle(rawTitle: unknown): string {
  if (typeof rawTitle !== "string") return "";
  return rawTitle.replace(/^mcp__acp__/i, "");
}

function summarizeToolTitle(rawTitle: unknown, rawInput: unknown, rawToolCallId: unknown) {
  const title = normalizeAcpToolTitle(rawTitle).trim();
  const record = asRecord(rawInput) ?? asRecord(tryParseJson(rawInput));
  const normalizedTitle = title.toLowerCase();
  const isSubagent = normalizedTitle.includes("subagent") || normalizedTitle === "task" || normalizedTitle.includes(" task");
  if (isSubagent) {
    const summary = readSubagentSummary(record);
    if (summary) {
      return `${title || "Task"} · ${summary}`;
    }
  }

  if (title && !/^工具\s+tool_/.test(title) && !/^tool_/.test(title)) {
    return title;
  }

  const command =
    typeof record?.command === "string"
      ? record.command
      : Array.isArray(record?.cmd)
        ? record.cmd.filter((part): part is string => typeof part === "string").join(" ")
        : null;
  const pathValue =
    typeof record?.path === "string"
      ? record.path
      : typeof record?.filePath === "string"
        ? record.filePath
        : typeof record?.cwd === "string"
          ? record.cwd
          : null;
  const description = typeof record?.description === "string" ? record.description : null;
  const args = Array.isArray(record?.args) ? record.args.filter((part): part is string => typeof part === "string").join(" ") : null;
  const summary = [command, pathValue, description, args].filter(Boolean).join(" · ");

  if (summary) {
    return summary;
  }
  if (title) {
    return title;
  }
  return typeof rawToolCallId === "string" ? `工具 ${rawToolCallId}` : "工具调用";
}

function readSubagentSummary(record: Record<string, unknown> | null): string | null {
  if (!record) {
    return null;
  }

  for (const key of ["title", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  for (const key of ["rawInput", "input", "args", "payload", "params"]) {
    if (!(key in record)) {
      continue;
    }
    const nestedRecord = asRecord(record[key]) ?? asRecord(tryParseJson(record[key]));
    const nested = readSubagentSummary(nestedRecord);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function tryParseJson(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function extractParentToolCallId(update: Record<string, unknown>): string | undefined {
  const meta = asRecord(update._meta);
  const claudeCode = asRecord(meta?.claudeCode);
  const parentId = claudeCode?.parentToolUseId;
  return typeof parentId === "string" && parentId ? parentId : undefined;
}

function formatEditToolChangeMessage(message: string) {
  const parsed = tryParseJson(message);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }

  const files = parsed
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => {
      const filePath =
        typeof entry.newFileName === "string"
          ? entry.newFileName
          : typeof entry.oldFileName === "string"
            ? entry.oldFileName
            : typeof entry.index === "string"
              ? entry.index
              : "";
      const hunks = Array.isArray(entry.hunks) ? entry.hunks.length : 0;
      return { filePath, hunks };
    })
    .filter((entry) => entry.filePath);

  if (files.length === 0) {
    return null;
  }

  const lines = files.map((entry) => `- ${entry.filePath}${entry.hunks > 0 ? `（${entry.hunks} 处修改）` : ""}`);
  return {
    title: `Edit 已修改 ${files.length} 个文件`,
    body: `Edit 工具已更新以下文件：\n${lines.join("\n")}`,
  };
}

function labelForMode(modeId?: string) {
  switch (modeId) {
    case "default":
      return "Default";
    case "acceptEdits":
      return "Accept Edits";
    case "plan":
      return "Plan";
    case "dontAsk":
      return "Don't Ask";
    case "bypassPermissions":
      return "Bypass Permissions";
    default:
      return modeId || "默认模式";
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function extractChunkText(content: unknown): string | null {
  if (!content) {
    return null;
  }

  if (Array.isArray(content)) {
    const joined = content.map((item) => extractChunkText(item)).filter((item): item is string => Boolean(item)).join("\n");
    return joined || null;
  }

  const record = asRecord(content);
  if (!record) {
    return null;
  }

  if (typeof record.text === "string" && record.text.trim()) {
    return record.text;
  }

  if (record.type === "resource") {
    const resource = asRecord(record.resource);
    if (typeof resource?.text === "string" && resource.text.trim()) {
      return resource.text;
    }
  }

  if (record.type === "resource_link") {
    const uri = typeof record.uri === "string" ? record.uri : "";
    return uri ? `[resource] ${uri}` : "[resource]";
  }

  return null;
}

function normalizeAvailableCommandsSnapshot(rawValue: unknown): AvailableCommandSnapshot[] {
  if (!Array.isArray(rawValue)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: AvailableCommandSnapshot[] = [];

  for (const item of rawValue) {
    if (typeof item === "string") {
      const name = normalizeCommandName(item);
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      normalized.push({ name, description: "", inputType: "unstructured" });
      continue;
    }

    const record = asRecord(item);
    const rawName =
      typeof record?.name === "string"
        ? record.name
        : typeof record?.command === "string"
          ? record.command
          : "";
    const name = normalizeCommandName(rawName);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    normalized.push({
      name,
      description:
        typeof record?.description === "string"
          ? record.description.trim()
          : typeof record?.title === "string"
            ? record.title.trim()
            : "",
      inputType: "unstructured",
    });
  }

  return normalized.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
}

function normalizeCommandName(rawName: string) {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function isAskUserQuestionTitle(title: string | undefined): boolean {
  if (!title) return false;
  const lower = title.toLowerCase();
  return lower === "askuserquestion" || lower.startsWith("askuserquestion ");
}

export const sessionManagerTestables = {
  stringifyMaybe,
  formatToolDetails,
  summarizeToolTitle,
  normalizeAcpToolTitle,
  isAskUserQuestionTitle,
  asRecord,
  extractChunkText,
  normalizeAvailableCommandsSnapshot,
  formatEditToolChangeMessage,
  labelForMode,
  formatError,
};
