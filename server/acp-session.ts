import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk/dist/schema/types.gen.js";

export type ServerEvent =
  | { type: "ready"; payload: { workspacePath: string; agentConnected: boolean } }
  | {
      type: "session_created";
      payload: { sessionId: string; modes: string[]; configOptions: schema.SessionConfigOption[] };
    }
  | {
      type: "session_restored";
      payload: { sessionId: string; modes: string[]; configOptions: schema.SessionConfigOption[] };
    }
  | { type: "prompt_started"; payload: { promptId: string; text: string } }
  | { type: "prompt_finished"; payload: { promptId: string; stopReason: string } }
  | { type: "session_update"; payload: schema.SessionNotification["update"] }
  | {
      type: "permission_requested";
      payload: {
        requestId: string;
        toolCall: schema.ToolCallUpdate;
        options: schema.PermissionOption[];
      };
    }
  | { type: "permission_resolved"; payload: { requestId: string; optionId: string } }
  | { type: "error"; payload: { message: string } };

type PendingPermission = {
  resolve: (value: schema.RequestPermissionResponse) => void;
  reject: (reason?: unknown) => void;
};

type SessionOptions = {
  workspacePath: string;
  agentBinPath: string;
  onEvent: (event: ServerEvent) => void;
};

export class ClaudeAcpSession {
  private readonly workspacePath: string;
  private readonly agentBinPath: string;
  private readonly onEvent: (event: ServerEvent) => void;
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  private agentProcess: ChildProcessWithoutNullStreams | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private activePrompt = false;
  private connectPromise: Promise<void> | null = null;
  private sessionPromise: Promise<string | null> | null = null;
  private currentModeId: string | null = null;

  constructor(options: SessionOptions) {
    this.workspacePath = options.workspacePath;
    this.agentBinPath = options.agentBinPath;
    this.onEvent = options.onEvent;
  }

  async connect() {
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    if (this.connection) {
      this.emitReady();
      return;
    }

    this.connectPromise = (async () => {
      await mkdir(this.workspacePath, { recursive: true });

      this.agentProcess = spawn(this.agentBinPath, [], {
        cwd: this.workspacePath,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.agentProcess.stderr.on("data", (chunk) => {
        const message = chunk.toString().trim();
        if (!message || this.shouldIgnoreAgentStderr(message) || this.shouldIgnoreToolOutputLog(message)) {
          return;
        }
        this.onEvent({ type: "error", payload: { message } });
      });

      this.agentProcess.on("exit", (code, signal) => {
        this.connection = null;
        this.sessionId = null;
        this.sessionPromise = null;
        this.connectPromise = null;
        this.activePrompt = false;
        this.rejectPendingPermissions(new Error("Permission request cancelled because ACP agent exited."));
        this.onEvent({
          type: "error",
          payload: { message: `Claude ACP agent exited (${code ?? "null"} / ${signal ?? "null"}).` },
        });
      });

      const input = Writable.toWeb(this.agentProcess.stdin) as WritableStream<Uint8Array>;
      const output = Readable.toWeb(this.agentProcess.stdout) as ReadableStream<Uint8Array>;
      const stream = acp.ndJsonStream(input, output);
      const client: acp.Client = {
        requestPermission: async (params) => this.handlePermissionRequest(params),
        sessionUpdate: async (params) => {
          this.onEvent({ type: "session_update", payload: params.update });
        },
        readTextFile: async (params) => {
          const filePath = this.resolveWorkspacePath(params.path);
          const content = await readFile(filePath, "utf8");
          return { content };
        },
        writeTextFile: async (params) => {
          const filePath = this.resolveWorkspacePath(params.path);
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(filePath, params.content, "utf8");
          return {};
        },
      };

      this.connection = new acp.ClientSideConnection(() => client, stream);

      await this.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      });

      this.emitReady();
    })();

    try {
      await this.connectPromise;
    } catch (error) {
      this.connectPromise = null;
      throw error;
    }
  }

  async ensureSession() {
    if (this.sessionPromise) {
      return await this.sessionPromise;
    }
    if (!this.connection) {
      await this.connect();
    }

    if (this.sessionId || !this.connection) {
      return this.sessionId;
    }

    this.sessionPromise = (async () => {
      const response = await this.connection!.newSession({
        cwd: this.workspacePath,
        mcpServers: [],
      });

      this.sessionId = response.sessionId;
      this.currentModeId = null;
      this.onEvent({
        type: "session_created",
        payload: {
          sessionId: response.sessionId,
          modes: response.modes?.availableModes.map((mode: schema.SessionMode) => mode.id) ?? [],
          configOptions: response.configOptions ?? [],
        },
      });

      return this.sessionId;
    })();

    try {
      return await this.sessionPromise;
    } catch (error) {
      this.sessionPromise = null;
      throw error;
    }
  }

  async loadSession(existingSessionId: string) {
    if (!this.connection) {
      await this.connect();
    }
    if (!this.connection) {
      throw new Error("ACP connection is not available.");
    }

    this.sessionId = existingSessionId;
    this.sessionPromise = Promise.resolve(existingSessionId);

    const response = await this.connection.loadSession({
      sessionId: existingSessionId,
      cwd: this.workspacePath,
      mcpServers: [],
    });

    this.currentModeId = response.modes?.currentModeId ?? null;
    this.onEvent({
      type: "session_restored",
      payload: {
        sessionId: existingSessionId,
        modes: response.modes?.availableModes.map((mode: schema.SessionMode) => mode.id) ?? [],
        configOptions: response.configOptions ?? [],
      },
    });

    return existingSessionId;
  }

  async findRestorableSession(preferredSessionId?: string) {
    if (!this.connection) {
      await this.connect();
    }
    if (!this.connection) {
      throw new Error("ACP connection is not available.");
    }

    const response = await this.connection.unstable_listSessions({
      cwd: this.workspacePath,
    });

    if (preferredSessionId) {
      const exactMatch = response.sessions.find((session: schema.SessionInfo) => session.sessionId === preferredSessionId);
      if (exactMatch) {
        return exactMatch.sessionId;
      }
    }

    return response.sessions[0]?.sessionId ?? null;
  }

  async prompt(text: string, images?: Array<{ data: string; mimeType: string }>) {
    const sessionId = await this.ensureSession();
    if (!this.connection || !sessionId) {
      throw new Error("ACP session is not available.");
    }
    if (this.activePrompt) {
      throw new Error("Another Claude prompt is still running.");
    }

    this.activePrompt = true;
    const promptId = randomUUID();
    this.onEvent({ type: "prompt_started", payload: { promptId, text } });

    try {
      // Images first, then text — mirrors the convention used by Claude's own clients
      // (vision context before the instruction yields better results).
      const promptContent: schema.ContentBlock[] = [];
      if (images && images.length > 0) {
        for (const img of images) {
          promptContent.push({ type: "image", data: img.data, mimeType: img.mimeType });
        }
      }
      promptContent.push({ type: "text", text });
      const response = await this.connection.prompt({
        sessionId,
        messageId: randomUUID(),
        prompt: promptContent,
      });
      this.onEvent({
        type: "prompt_finished",
        payload: { promptId, stopReason: response.stopReason },
      });
    } finally {
      this.activePrompt = false;
    }
  }

  async setMode(modeId: string) {
    const sessionId = await this.ensureSession();
    if (!this.connection || !sessionId || !modeId || this.currentModeId === modeId) {
      return;
    }
    await this.connection.setSessionMode({
      sessionId,
      modeId,
    });
    this.currentModeId = modeId;
  }

  async cancel() {
    if (!this.connection || !this.sessionId || !this.activePrompt) {
      return;
    }
    await this.connection.cancel({ sessionId: this.sessionId });
  }

  async resolvePermission(requestId: string, optionId: string, note?: string) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error("Permission request was not found or already resolved.");
    }

    pending.resolve({
      outcome: {
        outcome: "selected",
        optionId,
        _meta: note && note.trim() ? { note: note.trim() } : undefined,
      },
    });
    this.pendingPermissions.delete(requestId);
    this.onEvent({ type: "permission_resolved", payload: { requestId, optionId } });
  }

  async dispose() {
    this.rejectPendingPermissions(new Error("Client disconnected."));
    if (this.agentProcess && !this.agentProcess.killed) {
      this.agentProcess.kill();
    }
    this.agentProcess = null;
    this.connection = null;
    this.sessionId = null;
    this.sessionPromise = null;
    this.connectPromise = null;
    this.currentModeId = null;
    this.activePrompt = false;
  }

  private emitReady() {
    this.onEvent({
      type: "ready",
      payload: { workspacePath: this.workspacePath, agentConnected: true },
    });
  }

  private shouldIgnoreAgentStderr(message: string) {
    return (
      message.includes("Error handling notification") &&
      message.includes("method: 'session/update'") &&
      message.includes("message: 'Invalid params'")
    );
  }

  private shouldIgnoreToolOutputLog(message: string) {
    const normalized = message.trim();
    return normalized.startsWith('[{"index":') || normalized.startsWith("[{\"index\":");
  }

  private async handlePermissionRequest(
    params: schema.RequestPermissionRequest,
  ): Promise<schema.RequestPermissionResponse> {
    const requestId = randomUUID();

    this.onEvent({
      type: "permission_requested",
      payload: {
        requestId,
        toolCall: params.toolCall,
        options: params.options,
      },
    });

    return await new Promise<schema.RequestPermissionResponse>((resolve, reject) => {
      this.pendingPermissions.set(requestId, { resolve, reject });
    });
  }

  private rejectPendingPermissions(reason: Error) {
    for (const pending of this.pendingPermissions.values()) {
      pending.reject(reason);
    }
    this.pendingPermissions.clear();
  }

  private resolveWorkspacePath(targetPath: string) {
    const absolutePath = path.resolve(this.workspacePath, targetPath);
    const relativePath = path.relative(this.workspacePath, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Refusing to access file outside workspace: ${targetPath}`);
    }
    return absolutePath;
  }
}
