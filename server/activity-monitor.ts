import os from "node:os";
import path from "node:path";
import { open, stat, type FileHandle } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";

export type ActivityState = "running" | "completed" | "pending" | "idle";

const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
const TAIL_BUFFER_SIZE = 16384; // 16 KB – enough for the last few JSONL lines
const DEBOUNCE_MS = 150;
const POLL_INTERVAL_MS = 2000;

/** Types we care about when scanning backwards in the JSONL file. */
const ACTIVITY_TYPES = new Set(["assistant", "user", "progress"]);

/** Types to skip when scanning for the last meaningful entry. */
const SKIP_TYPES = new Set(["last-prompt", "system", "file-history-snapshot", "queue-operation"]);

// ---------------------------------------------------------------------------
// Pure state-determination function (exported for testing)
// ---------------------------------------------------------------------------

type JsonlEntry = {
  type: string;
  subtype?: string;
  message?: {
    stop_reason?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/**
 * Detect if a user entry represents a local CLI command (not a real user message to Claude).
 * Local commands have content containing `<command-name>`, `<local-command-stdout>`, or `<local-command-caveat>`.
 */
function isLocalCommand(entry: JsonlEntry): boolean {
  const content = entry.message?.content;
  if (typeof content === "string") {
    return content.includes("<command-name>") || content.includes("<local-command-");
  }
  if (Array.isArray(content)) {
    return (content as { text?: string }[]).some(
      (block) =>
        typeof block.text === "string" &&
        (block.text.includes("<command-name>") || block.text.includes("<local-command-")),
    );
  }
  return false;
}

/**
 * Detect if a JSONL entry is a `/clear` command.
 */
export function detectClearCommand(entry: JsonlEntry): boolean {
  if (entry.type !== "user") return false;
  const content = entry.message?.content;
  if (typeof content === "string") {
    return content.includes("<command-name>/clear</command-name>");
  }
  if (Array.isArray(content)) {
    return (content as { text?: string }[]).some(
      (block) =>
        typeof block.text === "string" && block.text.includes("<command-name>/clear</command-name>"),
    );
  }
  return false;
}

/**
 * Given a parsed JSONL entry, return the activity state.
 *
 * Rules:
 *   assistant + no stop_reason (null / undefined)     → running
 *   assistant + stop_reason "tool_use"                → pending
 *   assistant + stop_reason "end_turn"|"stop_sequence" → completed
 *   user (local command / meta)                       → completed
 *   user (real message)                               → running
 *   system + subtype "local_command"                  → completed
 *   progress (hookEvent !== "Stop")                   → running
 *   progress (hookEvent === "Stop")                   → completed
 */
export function determineActivityState(entry: JsonlEntry): ActivityState {
  const { type } = entry;

  if (type === "assistant") {
    const stopReason = entry.message?.stop_reason;
    if (stopReason == null) return "running";
    if (stopReason === "tool_use") return "pending";
    // end_turn, stop_sequence, max_tokens, etc. – treat as completed
    return "completed";
  }

  if (type === "user") {
    // Local CLI commands (/mcp, /status, /clear, etc.) are already finished
    if (isLocalCommand(entry)) return "completed";
    return "running";
  }

  if (type === "system") {
    // system + local_command entries indicate a finished local CLI command
    if (entry.subtype === "local_command") return "completed";
    return "idle";
  }

  if (type === "progress") {
    // Stop hooks fire after Claude finishes its turn – don't treat as running
    const hookEvent = (entry.data as { hookEvent?: string } | undefined)?.hookEvent;
    if (hookEvent === "Stop") return "completed";
    return "running";
  }

  // Shouldn't reach here if caller filters correctly, but be safe.
  return "idle";
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function jsonlFilePath(workspacePath: string, sessionId: string): string {
  return path.join(CLAUDE_CONFIG_DIR, "projects", encodeProjectPath(workspacePath), `${sessionId}.jsonl`);
}

export function projectDirPath(workspacePath: string): string {
  return path.join(CLAUDE_CONFIG_DIR, "projects", encodeProjectPath(workspacePath));
}

// ---------------------------------------------------------------------------
// Tail-read helper
// ---------------------------------------------------------------------------

/**
 * Read the last `TAIL_BUFFER_SIZE` bytes of a file, split into lines,
 * and return the last entry whose `type` is in ACTIVITY_TYPES (scanning
 * up to 5 lines backwards).
 */
async function readLastRelevantEntry(filePath: string): Promise<JsonlEntry | null> {
  let fd;
  try {
    fd = await open(filePath, "r");
    const fileStat = await fd.stat();
    if (fileStat.size === 0) return null;

    const readSize = Math.min(fileStat.size, TAIL_BUFFER_SIZE);
    const offset = Math.max(0, fileStat.size - readSize);
    const buffer = Buffer.alloc(readSize);
    await fd.read(buffer, 0, readSize, offset);

    const text = buffer.toString("utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);

    // Scan backwards, up to 5 lines
    const scanLimit = Math.min(lines.length, 5);
    for (let i = lines.length - 1; i >= lines.length - scanLimit; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as JsonlEntry;

        if (ACTIVITY_TYPES.has(parsed.type)) {
          return parsed;
        } else if (parsed.type === "system" && parsed.subtype === "local_command") {
          return parsed;
        } else if (SKIP_TYPES.has(parsed.type)) {
          // skip
        }
      } catch {
        // Malformed line (e.g. partial write) – skip
      }
    }
    return null;
  } catch {
    // File doesn't exist or unreadable
    return null;
  } finally {
    await fd?.close();
  }
}

// ---------------------------------------------------------------------------
// ActivityMonitor class
// ---------------------------------------------------------------------------

type MonitorEntry = {
  sessionId: string;
  workspacePath: string;
  jsonlPath: string;
  currentState: ActivityState;
  fileWatcher: FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** promptId extracted from session file (for plan session detection) */
  promptId?: string;
};

export class ActivityMonitor {
  private readonly monitors = new Map<string, MonitorEntry>();
  private readonly onChange: (sessionId: string, state: ActivityState) => void;
  /** Map from promptId to sessionId for plan session detection */
  private readonly promptIdToSessionId = new Map<string, string>();
  /** Watchers for project directories (to detect new plan sessions) */
  private readonly projectDirWatchers = new Map<string, FSWatcher>();
  /** Callback when a new plan session is detected */
  onPlanSessionDetected?: (newSessionId: string, promptId: string, workspacePath: string) => void;

  constructor(onChange: (sessionId: string, state: ActivityState) => void) {
    this.onChange = onChange;
  }

  watch(sessionId: string, workspacePath: string): void {
    // Prevent duplicate watchers
    if (this.monitors.has(sessionId)) return;

    const jsonlPath = jsonlFilePath(workspacePath, sessionId);
    const entry: MonitorEntry = {
      sessionId,
      workspacePath,
      jsonlPath,
      currentState: "idle",
      fileWatcher: null,
      pollTimer: null,
      debounceTimer: null,
    };
    this.monitors.set(sessionId, entry);
    this.tryStartWatching(entry);
    // Also watch project directory for plan session detection
    this.watchProjectDirectory(workspacePath);
  }

  unwatch(sessionId: string): void {
    const entry = this.monitors.get(sessionId);
    if (!entry) return;
    this.cleanupEntry(entry);
    this.monitors.delete(sessionId);
  }

  unwatchAll(): void {
    for (const entry of this.monitors.values()) {
      this.cleanupEntry(entry);
    }
    this.monitors.clear();
  }

  getState(sessionId: string): ActivityState {
    return this.monitors.get(sessionId)?.currentState ?? "idle";
  }

  /** Stop watching oldSessionId and start watching newSessionId for the same workspace. */
  switchWatch(oldSessionId: string, newSessionId: string, workspacePath: string): void {
    this.unwatch(oldSessionId);
    this.watch(newSessionId, workspacePath);
  }

  /** Get sessionId by promptId */
  getSessionIdByPromptId(promptId: string): string | undefined {
    return this.promptIdToSessionId.get(promptId);
  }

  /** Watch project directory for new session files (plan session detection) */
  watchProjectDirectory(workspacePath: string): void {
    const dirPath = projectDirPath(workspacePath);
    if (this.projectDirWatchers.has(dirPath)) return;

    try {
      const watcher = watch(dirPath, (eventType, filename) => {
        if (filename?.endsWith(".jsonl")) {
          this.checkNewSessionFile(path.join(dirPath, filename), workspacePath);
        }
      });
      watcher.on("error", () => {
        // Ignore errors - directory may not exist yet
      });
      this.projectDirWatchers.set(dirPath, watcher);
    } catch {
      // Directory may not exist yet - that's OK
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async tryStartWatching(entry: MonitorEntry): Promise<void> {
    const exists = await fileExists(entry.jsonlPath);
    if (exists) {
      // File exists – read initial state and start watching
      await this.readAndEmit(entry);
      this.setupFileWatcher(entry);
    } else {
      // File doesn't exist yet – poll until it appears
      entry.pollTimer = setInterval(() => {
        this.checkFileAppeared(entry);
      }, POLL_INTERVAL_MS);
    }
  }

  private async checkFileAppeared(entry: MonitorEntry): Promise<void> {
    const exists = await fileExists(entry.jsonlPath);
    if (exists) {
      if (entry.pollTimer) {
        clearInterval(entry.pollTimer);
        entry.pollTimer = null;
      }
      await this.readAndEmit(entry);
      this.setupFileWatcher(entry);
    }
  }

  private setupFileWatcher(entry: MonitorEntry): void {
    try {
      entry.fileWatcher = watch(entry.jsonlPath, () => {
        this.scheduleRead(entry);
      });
      entry.fileWatcher.on("error", () => {
        // File may have been deleted – fall back to polling
        if (entry.fileWatcher) {
          entry.fileWatcher.close();
          entry.fileWatcher = null;
        }
        if (!entry.pollTimer) {
          entry.pollTimer = setInterval(() => {
            this.checkFileAppeared(entry);
          }, POLL_INTERVAL_MS);
        }
      });
    } catch {
      // watch() can throw on some systems
      if (!entry.pollTimer) {
        entry.pollTimer = setInterval(() => {
          this.checkFileAppeared(entry);
        }, POLL_INTERVAL_MS);
      }
    }
  }

  private scheduleRead(entry: MonitorEntry): void {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      this.readAndEmit(entry).catch(() => undefined);
    }, DEBOUNCE_MS);
  }

  private async readAndEmit(entry: MonitorEntry): Promise<void> {
    const parsed = await readLastRelevantEntry(entry.jsonlPath);
    if (!parsed) return;

    // Extract promptId from session file for plan session detection
    await this.extractPromptId(entry);

    const newState = determineActivityState(parsed);
    if (newState !== entry.currentState) {
      entry.currentState = newState;
      this.onChange(entry.sessionId, newState);
    }
  }

  /** Extract promptId from the beginning of the session file. */
  private async extractPromptId(entry: MonitorEntry): Promise<void> {
    if (entry.promptId) return; // Already extracted

    let fd: FileHandle | undefined;
    try {
      fd = await open(entry.jsonlPath, "r");
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fd.read(buf, 0, 4096, 0);
      const head = buf.toString("utf8", 0, bytesRead);
      const match = head.match(/"promptId":"([^"]+)"/);
      if (match) {
        entry.promptId = match[1];
        this.promptIdToSessionId.set(entry.promptId, entry.sessionId);
      }
    } catch {
      // File may not exist or be readable
    } finally {
      await fd?.close();
    }
  }

  /** Check if a new session file is a plan execution session. */
  private async checkNewSessionFile(filePath: string, workspacePath: string): Promise<void> {
    let fd: FileHandle | undefined;
    try {
      fd = await open(filePath, "r");
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fd.read(buf, 0, 4096, 0);
      const head = buf.toString("utf8", 0, bytesRead);

      // Check for planContent field - indicates plan execution session
      if (!head.includes('"planContent"')) return;

      // Extract promptId
      const promptIdMatch = head.match(/"promptId":"([^"]+)"/);
      if (!promptIdMatch) return;

      const newSessionId = path.basename(filePath, ".jsonl");
      const promptId = promptIdMatch[1];

      // Check if we're tracking a session with this promptId
      const oldSessionId = this.promptIdToSessionId.get(promptId);
      if (oldSessionId && oldSessionId !== newSessionId) {
        console.log(`[ActivityMonitor] Plan session detected: ${oldSessionId} → ${newSessionId} (promptId=${promptId})`);
        this.onPlanSessionDetected?.(newSessionId, promptId, workspacePath);
      }
    } catch {
      // File may not exist or be readable yet
    } finally {
      await fd?.close();
    }
  }

  private cleanupEntry(entry: MonitorEntry): void {
    if (entry.fileWatcher) {
      entry.fileWatcher.close();
      entry.fileWatcher = null;
    }
    if (entry.pollTimer) {
      clearInterval(entry.pollTimer);
      entry.pollTimer = null;
    }
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export const activityMonitorTestables = {
  encodeProjectPath,
  jsonlFilePath,
  readLastRelevantEntry,
};
