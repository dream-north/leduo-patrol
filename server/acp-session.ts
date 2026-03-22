import { randomUUID } from "node:crypto";
import * as childProcess from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk/dist/schema/types.gen.js";
import { buildSpawnFailureMessage } from "./server-helpers.js";

export const acpSessionTestables = {
  spawnAgent(
    agentBinPath: string,
    options: childProcess.SpawnOptionsWithoutStdio,
  ) {
    return childProcess.spawn(agentBinPath, [], options);
  },
};

export type AskQuestionOption = {
  id: string;
  label: string;
};

export type AskQuestionParams = {
  question: string;
  options: AskQuestionOption[];
  allowCustomAnswer: boolean;
};

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
  | {
      type: "question_requested";
      payload: {
        questionId: string;
        question: string;
        options: AskQuestionOption[];
        allowCustomAnswer: boolean;
      };
    }
  | {
      type: "question_answered";
      payload: { questionId: string; answer: string };
    }
  | { type: "error"; payload: { message: string; fatal: boolean } };

type PendingPermission = {
  resolve: (value: schema.RequestPermissionResponse) => void;
  reject: (reason?: unknown) => void;
};

type PendingQuestion = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason?: unknown) => void;
};

type SessionOptions = {
  workspacePath: string;
  agentBinPath: string;
  claudeBin?: string;
  onEvent: (event: ServerEvent) => void;
};

export class ClaudeAcpSession {
  private readonly workspacePath: string;
  private readonly agentBinPath: string;
  private readonly claudeBin: string | undefined;
  private readonly onEvent: (event: ServerEvent) => void;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();

  private agentProcess: childProcess.ChildProcessWithoutNullStreams | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private activePrompt = false;
  private disposing = false;
  private connectPromise: Promise<void> | null = null;
  private sessionPromise: Promise<string | null> | null = null;
  private currentModeId: string | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private drainResolve: (() => void) | null = null;
  private static readonly DRAIN_QUIET_MS = 200;

  constructor(options: SessionOptions) {
    this.workspacePath = options.workspacePath;
    this.agentBinPath = options.agentBinPath;
    this.claudeBin = options.claudeBin;
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

      const agentEnv = {
        ...process.env,
        ...(this.claudeBin ? { CLAUDE_CODE_EXECUTABLE: this.claudeBin } : undefined),
      };

      try {
        this.agentProcess = acpSessionTestables.spawnAgent(this.agentBinPath, {
          cwd: this.workspacePath,
          env: agentEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        throw new Error(this.buildAgentSpawnFailureMessage(error));
      }

      let startupComplete = false;
      let processHandled = false;
      let rejectStartup: ((error: Error) => void) | null = null;
      const startupFailure = new Promise<never>((_, reject) => {
        rejectStartup = reject;
      });

      const handleAgentFailure = (error: Error) => {
        if (processHandled) {
          return;
        }
        processHandled = true;
        this.connection = null;
        this.sessionId = null;
        this.sessionPromise = null;
        this.connectPromise = null;
        this.currentModeId = null;
        this.activePrompt = false;
        this.clearDrain();
        this.rejectPendingPermissions(new Error("Permission request cancelled because ACP agent stopped."));
        this.rejectPendingQuestions(new Error("Question cancelled because ACP agent stopped."));
        this.agentProcess = null;

        if (this.disposing) {
          this.disposing = false;
          if (!startupComplete) {
            rejectStartup?.(error);
            rejectStartup = null;
          }
          return;
        }
        if (!startupComplete) {
          rejectStartup?.(error);
          rejectStartup = null;
          return;
        }
        this.onEvent({
          type: "error",
          payload: { message: error.message, fatal: true },
        });
      };

      this.agentProcess.stderr.on("data", (chunk) => {
        const message = chunk.toString().trim();
        if (!message || this.shouldIgnoreAgentStderr(message) || this.shouldIgnoreToolOutputLog(message)) {
          return;
        }
        this.onEvent({ type: "error", payload: { message, fatal: false } });
      });

      this.agentProcess.on("error", (error) => {
        handleAgentFailure(new Error(this.buildAgentSpawnFailureMessage(error)));
      });

      this.agentProcess.on("exit", (code, signal) => {
        handleAgentFailure(new Error(`Claude ACP agent exited (${code ?? "null"} / ${signal ?? "null"}).`));
      });

      const input = Writable.toWeb(this.agentProcess.stdin) as WritableStream<Uint8Array>;
      const output = Readable.toWeb(this.agentProcess.stdout) as ReadableStream<Uint8Array>;
      const stream = acp.ndJsonStream(input, output);
      const client: acp.Client = {
        requestPermission: async (params) => this.handlePermissionRequest(params),
        sessionUpdate: async (params) => {
          const update = params.update as Record<string, unknown>;
          if (update.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string") {
            this.currentModeId = update.currentModeId;
          }
          this.onEvent({ type: "session_update", payload: params.update });
          this.resetDrainTimer();
        },
        readTextFile: async (params) => this.handleReadTextFile(params),
        writeTextFile: async (params) => this.handleWriteTextFile(params),
        extMethod: async (method, params) => this.handleExtMethod(method, params),
      };

      this.connection = new acp.ClientSideConnection(() => client, stream);

      await Promise.race([
        this.connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            _meta: {
              extensions: [
                {
                  method: "leduo/ask_question",
                  description:
                    "Ask the user a question with optional multiple-choice options. " +
                    "Params: { question: string, options?: Array<{ id: string, label: string }>, allowCustomAnswer?: boolean }. " +
                    "Returns: { answer: string }.",
                },
              ],
            },
          },
        }),
        startupFailure,
      ]);

      startupComplete = true;
      rejectStartup = null;
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
      await this.waitForDrain();
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

  async answerQuestion(questionId: string, answer: string) {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      throw new Error("Question was not found or already answered.");
    }

    pending.resolve({ answer });
    this.pendingQuestions.delete(questionId);
    this.onEvent({ type: "question_answered", payload: { questionId, answer } });
  }

  async dispose() {
    this.disposing = true;
    this.clearDrain();
    this.rejectPendingPermissions(new Error("Client disconnected."));
    this.rejectPendingQuestions(new Error("Client disconnected."));
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

  private buildAgentSpawnFailureMessage(error: unknown) {
    const hint = (
      error instanceof Error
      && "code" in error
      && (error as Error & { code?: string }).code === "EAGAIN"
    )
      ? "The OS temporarily refused to start a new process (EAGAIN). Try again and check system process/thread limits or other running agent processes."
      : "Check that LEDUO_PATROL_AGENT_BIN points to a valid ACP agent, or that the bundled claude-code-acp agent is executable.";
    return buildSpawnFailureMessage("Claude ACP agent", this.agentBinPath, this.workspacePath, error, hint);
  }

  private waitForDrain(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.drainResolve = resolve;
      this.drainTimer = setTimeout(() => {
        this.drainResolve = null;
        this.drainTimer = null;
        resolve();
      }, ClaudeAcpSession.DRAIN_QUIET_MS);
    });
  }

  private resetDrainTimer() {
    if (this.drainTimer && this.drainResolve) {
      clearTimeout(this.drainTimer);
      const resolve = this.drainResolve;
      this.drainTimer = setTimeout(() => {
        this.drainResolve = null;
        this.drainTimer = null;
        resolve();
      }, ClaudeAcpSession.DRAIN_QUIET_MS);
    }
  }

  private clearDrain() {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.drainResolve) {
      this.drainResolve();
      this.drainResolve = null;
    }
  }

  private shouldIgnoreAgentStderr(message: string) {
    return (
      message.includes("Error handling notification") &&
      message.includes("method: 'session/update'") &&
      message.includes("message: 'Invalid params'")
    ) || isMissingPostToolHookMessage(message) || message.includes("<local-command-stdout>");
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

  private rejectPendingQuestions(reason: Error) {
    for (const pending of this.pendingQuestions.values()) {
      pending.reject(reason);
    }
    this.pendingQuestions.clear();
  }

  private async handleExtMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method === "leduo/ask_question") {
      return await this.handleAskQuestion(params);
    }
    throw new Error(`Unknown extension method: ${method}`);
  }

  private async handleAskQuestion(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const questionId = randomUUID();
    const question = typeof params.question === "string" ? params.question : "";
    const rawOptions = Array.isArray(params.options) ? params.options : [];
    const options: AskQuestionOption[] = rawOptions
      .map((opt) => {
        if (opt && typeof opt === "object" && !Array.isArray(opt)) {
          const record = opt as Record<string, unknown>;
          return {
            id: typeof record.id === "string" ? record.id : "",
            label: typeof record.label === "string" ? record.label : "",
          };
        }
        return null;
      })
      .filter((opt): opt is AskQuestionOption => opt !== null && opt.id !== "" && opt.label !== "");
    const allowCustomAnswer = params.allowCustomAnswer === true;

    this.onEvent({
      type: "question_requested",
      payload: { questionId, question, options, allowCustomAnswer },
    });

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pendingQuestions.set(questionId, { resolve, reject });
    });
  }

  private resolveWorkspacePath(targetPath: string) {
    const absolutePath = path.resolve(this.workspacePath, targetPath);
    const relativePath = path.relative(this.workspacePath, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Refusing to access file outside workspace: ${targetPath}`);
    }
    return absolutePath;
  }

  private async handleReadTextFile(
    params: schema.ReadTextFileRequest,
  ): Promise<schema.ReadTextFileResponse> {
    const filePath = path.isAbsolute(params.path)
      ? params.path
      : this.resolveWorkspacePath(params.path);
    const content = await readFile(filePath, "utf8");

    if (params.line != null || params.limit != null) {
      const lines = content.split("\n");
      const offset = (params.line ?? 1) - 1;
      const limit = params.limit ?? lines.length;
      const start = Math.max(0, offset);
      const end = Math.min(lines.length, start + limit);
      return { content: lines.slice(start, end).join("\n") };
    }
    return { content };
  }

  private async handleWriteTextFile(
    params: schema.WriteTextFileRequest,
  ): Promise<schema.WriteTextFileResponse> {
    const filePath = path.isAbsolute(params.path)
      ? params.path
      : this.resolveWorkspacePath(params.path);
    const dirName = path.dirname(filePath);
    await mkdir(dirName, { recursive: true });
    await writeFile(filePath, params.content, "utf8");
    return {};
  }
}

function isMissingPostToolHookMessage(message: string) {
  return message.includes("No onPostToolUseHook found for tool use ID:");
}
