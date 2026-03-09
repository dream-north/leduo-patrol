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
  permissions: PermissionSnapshot[];
  updatedAt: string;
};

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
  sessions: SessionSnapshot[];
};

type ManagedSession = {
  snapshot: SessionSnapshot;
  acpSession: ClaudeAcpSession | null;
  connectPromise: Promise<void> | null;
};

type SessionManagerOptions = {
  allowedRoots: string[];
  agentBinPath: string;
};

export class SessionManager {
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
        busy: false,
        permissions: [],
      };
      this.sessions.set(restoredSnapshot.clientSessionId, {
        snapshot: restoredSnapshot,
        acpSession: null,
        connectPromise: null,
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
      permissions: [],
      updatedAt: new Date().toISOString(),
    };

    const entry: ManagedSession = {
      snapshot,
      acpSession: null,
      connectPromise: null,
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
      await acpSession.ensureSession();
      if (entry.snapshot.defaultModeId) {
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
        this.appendTimeline(entry.snapshot, {
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
        this.appendTimeline(entry.snapshot, {
          id: randomUUID(),
          kind: "system",
          title: "会话已创建",
          body: event.payload.sessionId,
          meta: event.payload.modes.join(", ") || "默认模式",
        });
        break;
      case "prompt_started":
        entry.snapshot.busy = true;
        this.appendTimeline(entry.snapshot, {
          id: event.payload.promptId,
          kind: "user",
          title: "你",
          body: event.payload.text,
        });
        break;
      case "prompt_finished":
        entry.snapshot.busy = false;
        this.appendTimeline(entry.snapshot, {
          id: randomUUID(),
          kind: "system",
          title: "本轮完成",
          body: event.payload.stopReason,
        });
        break;
      case "session_update":
        this.consumeSessionUpdate(entry.snapshot, event.payload);
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
        this.appendTimeline(entry.snapshot, {
          id: event.payload.requestId,
          kind: "tool",
          title: event.payload.toolCall.title ?? "等待权限确认",
          body: stringifyMaybe(event.payload.toolCall.rawInput ?? {}),
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
        this.appendTimeline(entry.snapshot, {
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
    snapshot: SessionSnapshot,
    update: Extract<ServerEvent, { type: "session_update" }>["payload"],
  ) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) {
          this.appendTextChunk(snapshot, "agent", "Claude", content.text);
        }
        break;
      }
      case "agent_thought_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) {
          this.appendTextChunk(snapshot, "thought", "思路", content.text);
        }
        break;
      }
      case "tool_call":
      case "tool_call_update":
        this.appendTimeline(snapshot, {
          id: randomUUID(),
          kind: "tool",
          title: String(update.title ?? `工具 ${String(update.toolCallId ?? "")}`),
          body: stringifyMaybe(update.rawInput ?? update.rawOutput ?? ""),
          meta: String(update.status ?? update.sessionUpdate),
        });
        break;
      case "plan":
        this.appendTimeline(snapshot, {
          id: randomUUID(),
          kind: "system",
          title: "执行计划",
          body: stringifyMaybe(update.entries ?? update),
        });
        break;
      case "current_mode_update":
        snapshot.currentModeId = String(update.currentModeId ?? snapshot.currentModeId ?? "default");
        this.appendTimeline(snapshot, {
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
    snapshot: SessionSnapshot,
    kind: TimelineItem["kind"],
    title: string,
    text: string,
  ) {
    const lastItem = snapshot.timeline.at(-1);
    if (lastItem && lastItem.kind === kind && lastItem.title === title && !lastItem.meta) {
      lastItem.body += text;
      return;
    }
    this.appendTimeline(snapshot, {
      id: randomUUID(),
      kind,
      title,
      body: text,
    });
  }

  private appendTimeline(snapshot: SessionSnapshot, item: TimelineItem) {
    snapshot.timeline.push(item);
    if (snapshot.timeline.length > 240) {
      snapshot.timeline = snapshot.timeline.slice(-240);
    }
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
    await mkdir(path.dirname(this.stateFilePath), { recursive: true });
    await writeFile(this.stateFilePath, JSON.stringify(payload, null, 2), "utf8");
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
    this.appendTimeline(entry.snapshot, {
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
