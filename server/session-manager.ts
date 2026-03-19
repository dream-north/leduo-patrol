import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ClaudeCliSession } from "./claude-cli-session.js";
import { ActivityMonitor, type ActivityState } from "./activity-monitor.js";

export type { ActivityState } from "./activity-monitor.js";

export type SessionSnapshot = {
  clientSessionId: string;
  title: string;
  workspacePath: string;
  connectionState: "connecting" | "connected" | "error";
  activityState: ActivityState;
  sessionId: string;
  updatedAt: string;
};

type PersistedSession = {
  clientSessionId: string;
  title: string;
  workspacePath: string;
  sessionId: string;
  updatedAt: string;
};

export type SocketEvent =
  | {
      type: "ready";
      payload: {
        sessions: SessionSnapshot[];
      };
    }
  | {
      type: "error";
      payload: {
        message: string;
        fatal: boolean;
        clientSessionId?: string;
      };
    }
  | {
      type: "session_registered";
      payload: {
        clientSessionId: string;
        title: string;
        workspacePath: string;
        sessionId: string;
      };
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
    };

type PersistedState = {
  sessions: PersistedSession[];
};

type ManagedSession = {
  snapshot: SessionSnapshot;
  cliSession: ClaudeCliSession | null;
  /** Ring buffer of recent PTY output so clients can replay after reconnect. */
  outputBuffer: string;
};

type SessionManagerOptions = {
  allowedRoots: string[];
  claudeBin?: string;
};

export class SessionManager {
  private readonly allowedRoots: string[];
  private readonly claudeBin: string | undefined;
  private readonly stateFilePath: string;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly listeners = new Set<(event: SocketEvent) => void>();
  private readonly activityMonitor: ActivityMonitor;
  /** Reverse index: Claude sessionId → clientSessionId */
  private readonly sessionIdIndex = new Map<string, string>();
  private persistTimer: NodeJS.Timeout | null = null;
  /** Maximum bytes of PTY output to keep per session for replay on reconnect. */
  private static readonly OUTPUT_BUFFER_MAX = 256 * 1024;

  constructor(options: SessionManagerOptions) {
    this.allowedRoots = options.allowedRoots;
    this.claudeBin = options.claudeBin;
    this.stateFilePath = path.join(os.homedir(), ".leduo-patrol", "state.json");
    this.activityMonitor = new ActivityMonitor((sessionId, activityState) => {
      const clientSessionId = this.sessionIdIndex.get(sessionId);
      if (!clientSessionId) return;
      const entry = this.sessions.get(clientSessionId);
      if (!entry) return;
      entry.snapshot.activityState = activityState;
      this.emit({
        type: "session_activity",
        payload: { clientSessionId, activityState },
      });
    });
  }

  async initialize() {
    const persistedState = await this.readPersistedState();
    for (const persisted of persistedState.sessions) {
      const snapshot: SessionSnapshot = {
        clientSessionId: persisted.clientSessionId,
        title: persisted.title,
        workspacePath: persisted.workspacePath,
        connectionState: "connecting",
        activityState: "idle",
        sessionId: persisted.sessionId,
        updatedAt: persisted.updatedAt,
      };
      this.sessions.set(snapshot.clientSessionId, {
        snapshot,
        cliSession: null,
        outputBuffer: "",
      });
      this.sessionIdIndex.set(snapshot.sessionId, snapshot.clientSessionId);
      this.activityMonitor.watch(snapshot.sessionId, snapshot.workspacePath);
    }

    for (const entry of this.sessions.values()) {
      this.startCliSession(entry, true).catch((error) => {
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

  getSessionWorkspacePath(clientSessionId: string) {
    return this.getEntry(clientSessionId).snapshot.workspacePath;
  }

  async createSession(requestedWorkspacePath: string, requestedTitle?: string) {
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
          sessionId: existingEntry.snapshot.sessionId,
        },
      });
      return existingEntry.snapshot;
    }

    const sessionId = randomUUID();
    const snapshot: SessionSnapshot = {
      clientSessionId: randomUUID(),
      title: requestedTitle?.trim() || path.basename(resolvedWorkspacePath) || resolvedWorkspacePath,
      workspacePath: resolvedWorkspacePath,
      connectionState: "connecting",
      activityState: "idle",
      sessionId,
      updatedAt: new Date().toISOString(),
    };

    const entry: ManagedSession = {
      snapshot,
      cliSession: null,
      outputBuffer: "",
    };
    this.sessions.set(snapshot.clientSessionId, entry);
    this.sessionIdIndex.set(sessionId, snapshot.clientSessionId);
    this.activityMonitor.watch(sessionId, resolvedWorkspacePath);
    this.schedulePersist();
    this.emit({
      type: "session_registered",
      payload: {
        clientSessionId: snapshot.clientSessionId,
        title: snapshot.title,
        workspacePath: snapshot.workspacePath,
        sessionId: snapshot.sessionId,
      },
    });

    await this.startCliSession(entry, false);
    return snapshot;
  }

  writeToSession(clientSessionId: string, data: string) {
    const entry = this.getEntry(clientSessionId);
    entry.cliSession?.write(data);
  }

  resizeCliSession(clientSessionId: string, cols: number, rows: number) {
    const entry = this.getEntry(clientSessionId);
    entry.cliSession?.resize(cols, rows);
  }

  /** Return buffered PTY output so a reconnecting client can replay history. */
  getSessionOutputBuffer(clientSessionId: string): string {
    const entry = this.getEntry(clientSessionId);
    return entry.outputBuffer;
  }

  async closeSession(clientSessionId: string) {
    const entry = this.sessions.get(clientSessionId);
    if (!entry) {
      return;
    }
    entry.cliSession?.kill();
    this.activityMonitor.unwatch(entry.snapshot.sessionId);
    this.sessionIdIndex.delete(entry.snapshot.sessionId);
    this.sessions.delete(clientSessionId);
    this.schedulePersist();
    this.emit({
      type: "session_closed",
      payload: { clientSessionId },
    });
  }

  private async startCliSession(entry: ManagedSession, resume: boolean) {
    const { snapshot } = entry;

    try {
      const cliSession = new ClaudeCliSession({
        workspacePath: snapshot.workspacePath,
        sessionId: snapshot.sessionId,
        resume,
        claudeBin: this.claudeBin,
      });
      entry.cliSession = cliSession;

      cliSession.on("output", (data: string) => {
        // Append to ring buffer so reconnecting clients can replay history
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
    const persistedSessions: PersistedSession[] = this.getStateSnapshot().sessions.map((session) => ({
      clientSessionId: session.clientSessionId,
      title: session.title,
      workspacePath: session.workspacePath,
      sessionId: session.sessionId,
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

  async resolveRequestedWorkspace(requestedWorkspacePath: string) {
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

export const sessionManagerTestables = {
  formatError,
};
