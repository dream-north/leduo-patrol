import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile, access, readdir, open, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import { ClaudeCliSession } from "./claude-cli-session.js";
import { ActivityMonitor, projectDirPath, type ActivityState } from "./activity-monitor.js";

export type { ActivityState } from "./activity-monitor.js";

export type SessionSnapshot = {
  clientSessionId: string;
  title: string;
  workspacePath: string;
  connectionState: "connecting" | "connected" | "error";
  activityState: ActivityState;
  sessionId: string;
  updatedAt: string;
  allowSkipPermissions?: boolean;
};

type PersistedSession = {
  clientSessionId: string;
  title: string;
  workspacePath: string;
  sessionId: string;
  updatedAt: string;
  allowSkipPermissions?: boolean;
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
    }
  | {
      type: "session_id_updated";
      payload: {
        clientSessionId: string;
        newSessionId: string;
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
  allowSkipPermissions?: boolean;
};

export class SessionManager {
  private readonly allowedRoots: string[];
  private readonly claudeBin: string | undefined;
  private readonly allowSkipPermissions: boolean;
  private readonly stateFilePath: string;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly listeners = new Set<(event: SocketEvent) => void>();
  private readonly activityMonitor: ActivityMonitor;
  /** Reverse index: Claude sessionId → clientSessionId */
  private readonly sessionIdIndex = new Map<string, string>();
  /** Timers for discovering new session IDs after /clear */
  private readonly discoveryTimers = new Map<string, NodeJS.Timeout>();
  private persistTimer: NodeJS.Timeout | null = null;
  /** Maximum bytes of PTY output to keep per session for replay on reconnect. */
  private static readonly OUTPUT_BUFFER_MAX = 256 * 1024;
  private static readonly DISCOVERY_POLL_MS = 1000;
  private static readonly DISCOVERY_MAX_POLLS = 60; // ~1 minute

  // history.jsonl monitoring for /clear detection
  private readonly historyFilePath: string;
  private historyWatcher: FSWatcher | null = null;
  private historyPollTimer: NodeJS.Timeout | null = null;
  private historyDebounceTimer: NodeJS.Timeout | null = null;
  private lastHistorySize = 0;
  private static readonly HISTORY_DEBOUNCE_MS = 200;
  private static readonly HISTORY_POLL_MS = 3000;

  constructor(options: SessionManagerOptions) {
    this.allowedRoots = options.allowedRoots;
    this.claudeBin = options.claudeBin;
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
        allowSkipPermissions: persisted.allowSkipPermissions,
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

    // Start monitoring ~/.claude/history.jsonl for /clear commands
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
        .map((entry) => entry.snapshot)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
  }

  getSessionWorkspacePath(clientSessionId: string) {
    return this.getEntry(clientSessionId).snapshot.workspacePath;
  }

  async createSession(requestedWorkspacePath: string, requestedTitle?: string, allowSkipPermissions?: boolean) {
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
    const effectiveAllowSkipPermissions = allowSkipPermissions ?? this.allowSkipPermissions;
    const snapshot: SessionSnapshot = {
      clientSessionId: randomUUID(),
      title: requestedTitle?.trim() || path.basename(resolvedWorkspacePath) || resolvedWorkspacePath,
      workspacePath: resolvedWorkspacePath,
      connectionState: "connecting",
      activityState: "idle",
      sessionId,
      updatedAt: new Date().toISOString(),
      allowSkipPermissions: effectiveAllowSkipPermissions,
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
    this.clearDiscoveryTimer(clientSessionId);
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
        allowSkipPermissions: snapshot.allowSkipPermissions,
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
      allowSkipPermissions: session.allowSkipPermissions,
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

  // ---------------------------------------------------------------------------
  // /clear detection → session ID discovery
  // ---------------------------------------------------------------------------

  private handleSessionClear(oldSessionId: string, workspacePath: string) {
    const clientSessionId = this.sessionIdIndex.get(oldSessionId);
    if (!clientSessionId) {
      console.log(`[SessionManager] handleSessionClear: no clientSessionId found for ${oldSessionId}`);
      return;
    }
    const entry = this.sessions.get(clientSessionId);
    if (!entry) {
      console.log(`[SessionManager] handleSessionClear: no entry found for clientSessionId ${clientSessionId}`);
      return;
    }

    console.log(`[SessionManager] handleSessionClear: oldSessionId=${oldSessionId}, clientSessionId=${clientSessionId}, workspace=${workspacePath}`);

    // Immediately mark as idle — the old session is done
    entry.snapshot.activityState = "idle";
    this.emit({
      type: "session_activity",
      payload: { clientSessionId, activityState: "idle" },
    });

    // Delay 500ms before starting discovery — the new session file is created
    // almost simultaneously with /clear in history.jsonl.
    const delayTimer = setTimeout(() => {
      this.startNewSessionDiscovery(clientSessionId, oldSessionId, workspacePath);
    }, 500);
    this.discoveryTimers.set(clientSessionId, delayTimer as unknown as NodeJS.Timeout);
  }

  private startNewSessionDiscovery(clientSessionId: string, oldSessionId: string, workspacePath: string) {
    const dirPath = projectDirPath(workspacePath);
    let pollCount = 0;

    console.log(`[SessionManager] startNewSessionDiscovery: dir=${dirPath}, oldSession=${oldSessionId}`);

    const tryFind = async (): Promise<boolean> => {
      try {
        const files = (await readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));

        // Stat each file (except old session) to find the most recently modified ones
        const candidates: { name: string; mtimeMs: number }[] = [];
        for (const f of files) {
          const sid = f.replace(/\.jsonl$/, "");
          if (sid === oldSessionId) continue;
          try {
            const s = await stat(path.join(dirPath, f));
            candidates.push({ name: f, mtimeMs: s.mtimeMs });
          } catch {
            // skip unreadable
          }
        }
        candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

        // Check the top 3 newest files for /clear content
        for (const candidate of candidates.slice(0, 3)) {
          const filePath = path.join(dirPath, candidate.name);
          let fd;
          try {
            fd = await open(filePath, "r");
            const buf = Buffer.alloc(4096);
            const { bytesRead } = await fd.read(buf, 0, 4096, 0);
            const head = buf.toString("utf8", 0, bytesRead);
            if (head.includes("<command-name>/clear</command-name>")) {
              const newSessionId = candidate.name.replace(/\.jsonl$/, "");
              console.log(`[SessionManager] discovery confirmed new session: ${candidate.name} (contains /clear)`);
              this.clearDiscoveryTimer(clientSessionId);
              this.completeSessionSwitch(clientSessionId, oldSessionId, newSessionId, workspacePath);
              return true;
            }
          } catch {
            // skip
          } finally {
            await fd?.close();
          }
        }
      } catch {
        // Directory may not exist yet
      }
      return false;
    };

    // Immediate first attempt, then retry every 1s up to ~1 minute
    tryFind().then((found) => {
      if (found) return;

      const timer = setInterval(async () => {
        pollCount++;
        if (pollCount > SessionManager.DISCOVERY_MAX_POLLS) {
          console.log(`[SessionManager] discovery timed out for ${oldSessionId}`);
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

    console.log(`[SessionManager] completeSessionSwitch: ${oldSessionId} → ${newSessionId} (client=${clientSessionId})`);

    // Update reverse index
    this.sessionIdIndex.delete(oldSessionId);
    this.sessionIdIndex.set(newSessionId, clientSessionId);

    // Update snapshot
    entry.snapshot.sessionId = newSessionId;
    entry.snapshot.updatedAt = new Date().toISOString();

    // Switch activity monitor to watch the new JSONL file
    this.activityMonitor.switchWatch(oldSessionId, newSessionId, workspacePath);

    // Persist so --resume uses the new session ID
    this.schedulePersist();

    // Notify frontend
    this.emit({
      type: "session_id_updated",
      payload: { clientSessionId, newSessionId },
    });
  }

  private clearDiscoveryTimer(clientSessionId: string) {
    const timer = this.discoveryTimers.get(clientSessionId);
    if (timer) {
      clearInterval(timer);
      this.discoveryTimers.delete(clientSessionId);
    }
  }

  // ---------------------------------------------------------------------------
  // history.jsonl monitoring — detect /clear commands globally
  // ---------------------------------------------------------------------------

  private async startHistoryMonitor() {
    // Get initial file size so we only process new lines
    try {
      const stats = await stat(this.historyFilePath);
      this.lastHistorySize = stats.size;
    } catch {
      this.lastHistorySize = 0;
    }

    console.log(`[SessionManager] Watching ${this.historyFilePath} for /clear commands (initial size=${this.lastHistorySize})`);

    try {
      this.historyWatcher = watch(this.historyFilePath, () => {
        this.scheduleHistoryCheck();
      });
      this.historyWatcher.on("error", () => {
        // Fall back to polling if the watcher fails
        this.historyWatcher?.close();
        this.historyWatcher = null;
        if (!this.historyPollTimer) {
          this.historyPollTimer = setInterval(() => {
            this.checkHistoryUpdates().catch(() => undefined);
          }, SessionManager.HISTORY_POLL_MS);
        }
      });
    } catch {
      // Watcher unavailable — use polling
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
      const stats = await stat(this.historyFilePath);

      // File was truncated or rotated — reset
      if (stats.size < this.lastHistorySize) {
        this.lastHistorySize = stats.size;
        return;
      }

      // No new content
      if (stats.size === this.lastHistorySize) return;

      const readSize = stats.size - this.lastHistorySize;
      fd = await open(this.historyFilePath, "r");
      const buffer = Buffer.alloc(readSize);
      await fd.read(buffer, 0, readSize, this.lastHistorySize);
      this.lastHistorySize = stats.size;

      const newText = buffer.toString("utf8");
      const lines = newText.split("\n").filter((l) => l.trim().length > 0);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { display?: string; sessionId?: string; project?: string };
          if (entry.display === "/clear" && entry.sessionId) {
            // Check if we're tracking this session
            const clientSessionId = this.sessionIdIndex.get(entry.sessionId);
            if (clientSessionId) {
              const managed = this.sessions.get(clientSessionId);
              if (managed) {
                console.log(`[SessionManager] /clear detected in history.jsonl for session ${entry.sessionId} (client=${clientSessionId})`);
                this.handleSessionClear(entry.sessionId, managed.snapshot.workspacePath);
              }
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File doesn't exist or unreadable — will retry on next trigger
    } finally {
      await fd?.close();
    }
  }

  private stopHistoryMonitor() {
    if (this.historyWatcher) {
      this.historyWatcher.close();
      this.historyWatcher = null;
    }
    if (this.historyPollTimer) {
      clearInterval(this.historyPollTimer);
      this.historyPollTimer = null;
    }
    if (this.historyDebounceTimer) {
      clearTimeout(this.historyDebounceTimer);
      this.historyDebounceTimer = null;
    }
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
