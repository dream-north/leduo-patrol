import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ClaudeAcpSession, type ServerEvent } from "./acp-session.js";

export type TimelineItem = {
  id: string;
  kind: "system" | "user" | "agent" | "thought" | "tool" | "error";
  title: string;
  body: string;
  meta?: string;
};

export type PermissionSnapshot = {
  clientSessionId: string;
  requestId: string;
  toolCall: { toolCallId: string; title?: string; status?: string; rawInput?: unknown };
  options: Array<{ optionId: string; name: string; kind: string }>;
};

export type SessionSnapshot = {
  clientSessionId: string;
  title: string;
  workspacePath: string;
  connectionState: "connecting" | "connected" | "error";
  sessionId: string;
  modes: string[];
  defaultModeId: string;
  currentModeId: string;
  busy: boolean;
  timeline: TimelineItem[];
  historyTotal: number;
  historyStart: number;
  permissions: PermissionSnapshot[];
  updatedAt: string;
};

type PersistedSession = Pick<
  SessionSnapshot,
  "clientSessionId" | "title" | "workspacePath" | "sessionId" | "defaultModeId" | "currentModeId" | "updatedAt"
>;

export type SocketEvent =
  | ServerEvent
  | {
      type: "error";
      payload: {
        message: string;
        clientSessionId?: string;
      };
    }
  | {
      type: "session_registered";
      payload: {
        clientSessionId: string;
        title: string;
        workspacePath: string;
      };
    }
  | {
      type: "session_closed";
      payload: {
        clientSessionId: string;
      };
    };

type PersistedState = {
  sessions: PersistedSession[];
};

type ManagedSession = {
  snapshot: SessionSnapshot;
  acpSession: ClaudeAcpSession | null;
  connectPromise: Promise<void> | null;
  fullTimeline: TimelineItem[];
};

type SessionManagerOptions = {
  allowedRoots: string[];
  agentBinPath: string;
};

export class SessionManager {
  private static readonly INITIAL_TIMELINE_WINDOW = 120;
  private static readonly HISTORY_PAGE_SIZE = 120;
  private readonly allowedRoots: string[];
  private readonly agentBinPath: string;
  private readonly stateFilePath: string;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly listeners = new Set<(event: SocketEvent) => void>();
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(options: SessionManagerOptions) {
    this.allowedRoots = options.allowedRoots;
    this.agentBinPath = options.agentBinPath;
    this.stateFilePath = path.join(os.homedir(), ".leduo-patrol", "state.json");
  }

  async initialize() {
    const persistedState = await this.readPersistedState();
    for (const snapshot of persistedState.sessions) {
      const restoredSnapshot: SessionSnapshot = {
        ...snapshot,
        defaultModeId: snapshot.defaultModeId ?? "default",
        currentModeId: snapshot.currentModeId ?? snapshot.defaultModeId ?? "default",
        connectionState: "connecting",
        modes: [],
        busy: false,
        timeline: [],
        historyTotal: 0,
        historyStart: 0,
        permissions: [],
      };
      this.sessions.set(restoredSnapshot.clientSessionId, {
        snapshot: restoredSnapshot,
        acpSession: null,
        connectPromise: null,
        fullTimeline: [],
      });
    }

    for (const entry of this.sessions.values()) {
      this.connectSession(entry).catch((error) => {
        this.handleManagerError(entry.snapshot.clientSessionId, error);
      });
    }
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
        .map((entry) => entry.snapshot)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
  }

  getSessionHistory(clientSessionId: string, before: number, limit = SessionManager.HISTORY_PAGE_SIZE) {
    const entry = this.getEntry(clientSessionId);
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

  async createSession(requestedWorkspacePath: string, requestedTitle?: string, modeId?: string) {
    const resolvedWorkspacePath = await this.resolveRequestedWorkspace(requestedWorkspacePath);
    const existingEntry = [...this.sessions.values()].find(
      (entry) => entry.snapshot.workspacePath === resolvedWorkspacePath,
    );
    if (existingEntry) {
      this.emit({
        type: "session_registered",
        payload: {
          clientSessionId: existingEntry.snapshot.clientSessionId,
          title: existingEntry.snapshot.title,
          workspacePath: existingEntry.snapshot.workspacePath,
        },
      });
      return existingEntry.snapshot;
    }

    const snapshot: SessionSnapshot = {
      clientSessionId: randomUUID(),
      title: requestedTitle?.trim() || path.basename(resolvedWorkspacePath) || resolvedWorkspacePath,
      workspacePath: resolvedWorkspacePath,
      connectionState: "connecting",
      sessionId: "",
      modes: [],
      defaultModeId: modeId ?? "default",
      currentModeId: modeId ?? "default",
      busy: false,
      timeline: [],
      historyTotal: 0,
      historyStart: 0,
      permissions: [],
      updatedAt: new Date().toISOString(),
    };

    const entry: ManagedSession = {
      snapshot,
      acpSession: null,
      connectPromise: null,
      fullTimeline: [],
    };
    this.sessions.set(snapshot.clientSessionId, entry);
    this.schedulePersist();
    this.emit({
      type: "session_registered",
      payload: {
        clientSessionId: snapshot.clientSessionId,
        title: snapshot.title,
        workspacePath: snapshot.workspacePath,
      },
    });

    await this.connectSession(entry);
    return snapshot;
  }

  async prompt(clientSessionId: string, text: string, modeId?: string) {
    const entry = this.getEntry(clientSessionId);
    await this.connectSession(entry);
    const effectiveModeId = modeId || entry.snapshot.defaultModeId;
    if (effectiveModeId) {
      await entry.acpSession?.setMode(effectiveModeId);
      entry.snapshot.currentModeId = effectiveModeId;
    }
    entry.snapshot.updatedAt = new Date().toISOString();
    this.schedulePersist();
    await entry.acpSession?.prompt(text);
  }

  async cancel(clientSessionId: string) {
    await this.getEntry(clientSessionId).acpSession?.cancel();
  }

  async resolvePermission(clientSessionId: string, requestId: string, optionId: string) {
    await this.getEntry(clientSessionId).acpSession?.resolvePermission(requestId, optionId);
  }

  async closeSession(clientSessionId: string) {
    const entry = this.sessions.get(clientSessionId);
    if (!entry) {
      return;
    }
    await entry.acpSession?.dispose();
    this.sessions.delete(clientSessionId);
    this.schedulePersist();
    this.emit({
      type: "session_closed",
      payload: { clientSessionId },
    });
  }

  private async connectSession(entry: ManagedSession) {
    if (entry.connectPromise) {
      await entry.connectPromise;
      return;
    }
    if (entry.acpSession) {
      return;
    }

    entry.snapshot.connectionState = "connecting";
    entry.snapshot.updatedAt = new Date().toISOString();
    this.schedulePersist();

    entry.connectPromise = (async () => {
      const acpSession = new ClaudeAcpSession({
        workspacePath: entry.snapshot.workspacePath,
        agentBinPath: this.agentBinPath,
        onEvent: (event) => this.handleSessionEvent(entry.snapshot.clientSessionId, event),
      });
      entry.acpSession = acpSession;
      await acpSession.connect();
      if (entry.snapshot.sessionId) {
        entry.fullTimeline = [];
        this.syncVisibleTimeline(entry);
        const restorableSessionId = await acpSession.findRestorableSession(entry.snapshot.sessionId);
        if (restorableSessionId) {
          entry.snapshot.sessionId = restorableSessionId;
          await acpSession.loadSession(restorableSessionId);
        } else {
          throw new Error(`No Claude session found for ${entry.snapshot.workspacePath}`);
        }
      } else {
        await acpSession.ensureSession();
      }
      if (entry.snapshot.defaultModeId && entry.snapshot.currentModeId !== entry.snapshot.defaultModeId) {
        await acpSession.setMode(entry.snapshot.defaultModeId);
        entry.snapshot.currentModeId = entry.snapshot.defaultModeId;
      }
    })();

    try {
      await entry.connectPromise;
    } catch (error) {
      entry.acpSession = null;
      entry.snapshot.connectionState = "error";
      this.handleManagerError(entry.snapshot.clientSessionId, error);
    } finally {
      entry.connectPromise = null;
    }
  }

  private handleSessionEvent(clientSessionId: string, event: ServerEvent) {
    const entry = this.sessions.get(clientSessionId);
    if (!entry) {
      return;
    }

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
        break;
      case "session_created":
        entry.snapshot.sessionId = event.payload.sessionId;
        entry.snapshot.modes = event.payload.modes;
        entry.snapshot.currentModeId = entry.snapshot.currentModeId || entry.snapshot.defaultModeId || "default";
        entry.snapshot.connectionState = "connected";
        this.appendTimeline(entry, {
          id: randomUUID(),
          kind: "system",
          title: "会话已创建",
          body: event.payload.sessionId,
          meta: labelForMode(entry.snapshot.currentModeId || entry.snapshot.defaultModeId),
        });
        break;
      case "session_restored":
        entry.snapshot.sessionId = event.payload.sessionId;
        entry.snapshot.modes = event.payload.modes;
        entry.snapshot.connectionState = "connected";
        this.appendTimeline(entry, {
          id: randomUUID(),
          kind: "system",
          title: "会话已恢复",
          body: event.payload.sessionId,
          meta: labelForMode(entry.snapshot.currentModeId || entry.snapshot.defaultModeId),
        });
        break;
      case "prompt_started":
        entry.snapshot.busy = true;
        this.appendTimeline(entry, {
          id: event.payload.promptId,
          kind: "user",
          title: "你",
          body: event.payload.text,
        });
        break;
      case "prompt_finished":
        entry.snapshot.busy = false;
        this.appendTimeline(entry, {
          id: randomUUID(),
          kind: "system",
          title: "本轮完成",
          body: event.payload.stopReason,
        });
        break;
      case "session_update":
        this.consumeSessionUpdate(entry, event.payload);
        break;
      case "permission_requested": {
        const permission: PermissionSnapshot = {
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
        };
        entry.snapshot.permissions.push(permission);
        this.appendTimeline(entry, {
          id: event.payload.requestId,
          kind: "tool",
          title: summarizeToolTitle(
            event.payload.toolCall.title,
            event.payload.toolCall.rawInput,
            event.payload.toolCall.toolCallId,
          ),
          body: formatToolDetails({
            toolCallId: event.payload.toolCall.toolCallId,
            title: event.payload.toolCall.title,
            status: event.payload.toolCall.status,
            rawInput: event.payload.toolCall.rawInput,
          }),
          meta: event.payload.toolCall.status ?? "pending",
        });
        break;
      }
      case "permission_resolved":
        entry.snapshot.permissions = entry.snapshot.permissions.filter(
          (permission) => permission.requestId !== event.payload.requestId,
        );
        break;
      case "error":
        entry.snapshot.busy = false;
        entry.snapshot.connectionState = "error";
        this.appendTimeline(entry, {
          id: randomUUID(),
          kind: "error",
          title: "错误",
          body: event.payload.message,
        });
        break;
    }

    entry.snapshot.updatedAt = new Date().toISOString();
    this.schedulePersist();
    this.emit({
      ...event,
      payload: {
        clientSessionId,
        ...event.payload,
      },
    } as unknown as SocketEvent);
  }

  private consumeSessionUpdate(
    entry: ManagedSession,
    update: Extract<ServerEvent, { type: "session_update" }>["payload"],
  ) {
    const snapshot = entry.snapshot;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const chunkText = extractChunkText(update.content);
        if (chunkText) {
          this.appendTextChunk(entry, "agent", "Claude", chunkText);
        }
        break;
      }
      case "agent_thought_chunk": {
        const chunkText = extractChunkText(update.content);
        if (chunkText) {
          this.appendTextChunk(entry, "thought", "思路", chunkText);
        }
        break;
      }
      case "tool_call":
      case "tool_call_update":
        this.appendTimeline(entry, {
          id: randomUUID(),
          kind: "tool",
          title: summarizeToolTitle(update.title, update.rawInput, update.toolCallId),
          body: formatToolDetails({
            toolCallId: update.toolCallId,
            title: update.title,
            status: update.status,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
          }),
          meta: String(update.status ?? update.sessionUpdate),
        });
        break;
      case "plan":
        this.appendTimeline(entry, {
          id: randomUUID(),
          kind: "system",
          title: "执行计划",
          body: stringifyMaybe(update.entries ?? update),
        });
        break;
      case "current_mode_update":
        snapshot.currentModeId = String(update.currentModeId ?? snapshot.currentModeId ?? "default");
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

  private appendTextChunk(
    entry: ManagedSession,
    kind: TimelineItem["kind"],
    title: string,
    text: string,
  ) {
    const fullTimeline = this.ensureFullTimeline(entry);
    const lastItem = fullTimeline.at(-1);
    if (lastItem && lastItem.kind === kind && lastItem.title === title && !lastItem.meta) {
      lastItem.body += text;
      this.syncVisibleTimeline(entry);
      return;
    }
    this.appendTimeline(entry, {
      id: randomUUID(),
      kind,
      title,
      body: text,
    });
  }

  private appendTimeline(entry: ManagedSession, item: TimelineItem) {
    this.ensureFullTimeline(entry).push(item);
    this.syncVisibleTimeline(entry);
  }

  private syncVisibleTimeline(entry: ManagedSession) {
    const fullTimeline = this.ensureFullTimeline(entry);
    const total = fullTimeline.length;
    const start = Math.max(0, total - SessionManager.INITIAL_TIMELINE_WINDOW);
    entry.snapshot.timeline = fullTimeline.slice(start);
    entry.snapshot.historyTotal = total;
    entry.snapshot.historyStart = start;
  }

  private ensureFullTimeline(entry: ManagedSession) {
    if (!Array.isArray(entry.fullTimeline)) {
      entry.fullTimeline = [];
    }
    return entry.fullTimeline;
  }

  private emit(event: SocketEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
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
    const payload: PersistedState = {
      sessions: this.getStateSnapshot().sessions,
    };
    const persistedSessions: PersistedSession[] = payload.sessions.map((session) => ({
      clientSessionId: session.clientSessionId,
      title: session.title,
      workspacePath: session.workspacePath,
      sessionId: session.sessionId,
      defaultModeId: session.defaultModeId,
      currentModeId: session.currentModeId,
      updatedAt: session.updatedAt,
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

  private handleManagerError(clientSessionId: string, error: unknown) {
    const entry = this.sessions.get(clientSessionId);
    if (!entry) {
      return;
    }
    entry.snapshot.busy = false;
    entry.snapshot.connectionState = "error";
    this.appendTimeline(entry, {
      id: randomUUID(),
      kind: "error",
      title: "错误",
      body: formatError(error),
    });
    entry.snapshot.updatedAt = new Date().toISOString();
    this.schedulePersist();
    this.emit({
      type: "error",
      payload: {
        clientSessionId,
        message: formatError(error),
      },
    });
  }
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
}) {
  return stringifyMaybe({
    toolCallId: details.toolCallId,
    title: details.title,
    status: details.status,
    rawInput: details.rawInput,
    rawOutput: details.rawOutput,
  });
}

function summarizeToolTitle(rawTitle: unknown, rawInput: unknown, rawToolCallId: unknown) {
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
  if (title && !/^工具\s+tool_/.test(title) && !/^tool_/.test(title)) {
    return title;
  }

  const record = asRecord(rawInput);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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


export const sessionManagerTestables = {
  stringifyMaybe,
  formatToolDetails,
  summarizeToolTitle,
  asRecord,
  extractChunkText,
  labelForMode,
  formatError,
};
