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
  questions: QuestionSnapshot[];
  availableCommands: AvailableCommandSnapshot[];
  updatedAt: string;
};

type PersistedSession = Pick<
  SessionSnapshot,
  "clientSessionId" | "title" | "workspacePath" | "sessionId" | "defaultModeId" | "currentModeId" | "availableCommands" | "updatedAt"
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
        defaultModeId: string;
        currentModeId: string;
      };
    }
  | {
      type: "session_closed";
      payload: {
        clientSessionId: string;
      };
    }
  | {
      type: "session_mode_changed";
      payload: {
        clientSessionId: string;
        defaultModeId: string;
        currentModeId: string;
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
  // Maps a synthetic questionId to the original permission requestId so that
  // answering an AskUserQuestion-originated question resolves the permission.
  private readonly askUserQuestionMap = new Map<string, { clientSessionId: string; requestId: string }>();
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
        questions: [],
        availableCommands: normalizeAvailableCommandsSnapshot(snapshot.availableCommands),
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
          defaultModeId: existingEntry.snapshot.defaultModeId,
          currentModeId: existingEntry.snapshot.currentModeId,
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
      questions: [],
      availableCommands: [],
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
        defaultModeId: snapshot.defaultModeId,
        currentModeId: snapshot.currentModeId,
      },
    });

    await this.connectSession(entry);
    return snapshot;
  }

  async prompt(clientSessionId: string, text: string, modeId?: string, images?: Array<{ data: string; mimeType: string }>) {
    const entry = this.getEntry(clientSessionId);
    await this.connectSession(entry);
    const effectiveModeId = modeId || entry.snapshot.defaultModeId;
    if (effectiveModeId) {
      await entry.acpSession?.setMode(effectiveModeId);
      entry.snapshot.currentModeId = effectiveModeId;
    }
    entry.snapshot.updatedAt = new Date().toISOString();
    this.schedulePersist();
    await entry.acpSession?.prompt(text, images);
  }

  async setSessionMode(clientSessionId: string, modeId: string) {
    const entry = this.getEntry(clientSessionId);
    await this.connectSession(entry);
    if (!modeId) {
      return;
    }

    await entry.acpSession?.setMode(modeId);
    entry.snapshot.defaultModeId = modeId;
    entry.snapshot.currentModeId = modeId;
    entry.snapshot.updatedAt = new Date().toISOString();
    this.schedulePersist();
    this.emit({
      type: "session_mode_changed",
      payload: {
        clientSessionId,
        defaultModeId: entry.snapshot.defaultModeId,
        currentModeId: entry.snapshot.currentModeId,
      },
    });
  }

  async cancel(clientSessionId: string) {
    await this.getEntry(clientSessionId).acpSession?.cancel();
  }

  async resolvePermission(clientSessionId: string, requestId: string, optionId: string, note?: string) {
    await this.getEntry(clientSessionId).acpSession?.resolvePermission(requestId, optionId, note);
  }

  async answerQuestion(clientSessionId: string, questionId: string, answer: string) {
    // If this question was synthesised from an AskUserQuestion permission
    // request, resolve the underlying permission instead of routing through
    // the question channel.
    const mappedPermission = this.askUserQuestionMap.get(questionId);
    if (mappedPermission) {
      // Collect all questionIds that share the same requestId (multi-question)
      const siblingIds: string[] = [];
      for (const [qId, mapping] of this.askUserQuestionMap.entries()) {
        if (mapping.requestId === mappedPermission.requestId) {
          siblingIds.push(qId);
        }
      }
      for (const qId of siblingIds) {
        this.askUserQuestionMap.delete(qId);
      }
      await this.getEntry(clientSessionId).acpSession?.resolvePermission(
        mappedPermission.requestId,
        "allow",
        answer,
      );
      // Remove all sibling question snapshots from the session so the UI clears them.
      const entry = this.getEntry(clientSessionId);
      const siblingSet = new Set(siblingIds);
      entry.snapshot.questions = entry.snapshot.questions.filter(
        (q) => !siblingSet.has(q.questionId),
      );
      // Emit question_answered for each sibling so the frontend clears all panels.
      for (const qId of siblingIds) {
        this.emit({
          type: "question_answered",
          payload: { clientSessionId, questionId: qId, answer },
        } as unknown as SocketEvent);
      }
      return;
    }
    await this.getEntry(clientSessionId).acpSession?.answerQuestion(questionId, answer);
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
        const normalizedTitle = normalizeAcpToolTitle(event.payload.toolCall.title) || undefined;

        // When the ACP agent sends a permission request for AskUserQuestion
        // (which means AskUserQuestion is no longer fully disallowed in this
        // ACP version), convert it to a question flow so the user sees the
        // proper question panel instead of a raw permission dialog.
        if (isAskUserQuestionTitle(normalizedTitle)) {
          const rawInput = asRecord(event.payload.toolCall.rawInput);

          // Parse the questions from rawInput.  Claude may send either:
          //   { question: "single question text" }
          //   { questions: [ { question, header?, options?, multiSelect? }, ... ] }
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
            // Fallback: single question string
            const questionText = typeof rawInput?.question === "string" ? rawInput.question : "";
            parsedQuestions.push({
              question: questionText,
              header: undefined,
              options: [],
              allowCustomAnswer: true,
            });
          }

          // Create one question snapshot per parsed question, all mapped to
          // the same underlying permission request.  We store them all and
          // use the *first* questionId as the primary key for the permission
          // mapping.  The frontend groups questions by groupId and presents
          // them in a single form; the user must answer ALL before submitting.
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
            entry.snapshot.questions.push(questionSnapshot);
            this.appendTimeline(entry, {
              id: questionId,
              kind: "system",
              title: "提问",
              body: pq.header ? `【${pq.header}】${pq.question}` : pq.question,
              meta: "pending",
            });
            // Map every question to the permission request so that answering
            // any one of them resolves the permission.
            this.askUserQuestionMap.set(questionId, {
              clientSessionId,
              requestId: event.payload.requestId,
            });
          }

          // Emit question_requested for each parsed question so the frontend
          // shows the proper question panel.  Return early to skip the
          // default re-emission of the original permission_requested event.
          entry.snapshot.updatedAt = new Date().toISOString();
          this.schedulePersist();
          for (let i = 0; i < parsedQuestions.length; i++) {
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
            } as unknown as SocketEvent);
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
        entry.snapshot.permissions.push(permission);
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
        entry.snapshot.permissions = entry.snapshot.permissions.filter(
          (permission) => permission.requestId !== event.payload.requestId,
        );
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
        entry.snapshot.questions.push(questionSnapshot);
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
        entry.snapshot.questions = entry.snapshot.questions.filter(
          (q) => q.questionId !== event.payload.questionId,
        );
        break;
      case "error":
        entry.snapshot.busy = false;
        {
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
        }
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
      case "available_commands_update":
        snapshot.availableCommands = normalizeAvailableCommandsSnapshot(
          update.availableCommands ?? (update as Record<string, unknown>).supportedCommands ?? (update as Record<string, unknown>).commands,
        );
        break;
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
      case "tool_call_update": {
        const normalizedTitle = normalizeAcpToolTitle(update.title) || undefined;

        // AskUserQuestion tool_call notifications arrive as stream events
        // BEFORE the corresponding permission_requested event from
        // canUseTool().  The vendored ACP agent patch
        // (vendor/claude-code-acp/dist/acp-agent.js, canUseTool method)
        // ensures that canUseTool() always fires a requestPermission for
        // AskUserQuestion, which the permission_requested handler below
        // converts into a proper question flow.  We therefore skip
        // creating a question here to avoid duplicates — just display
        // the tool call in the timeline like any other tool.
        //
        // Because the native AskUserQuestion handler can't run in ACP
        // (it uses stdin), the patched canUseTool returns "deny" with
        // the user's answer.  The SDK marks this as "failed", but from
        // the user's perspective the question was answered successfully.
        // Override the status to "completed" so the timeline shows it
        // seamlessly — identical to any other successful tool call.
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
          }),
          meta: String(effectiveStatus ?? update.sessionUpdate),
        });
        break;
      }
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
      availableCommands: normalizeAvailableCommandsSnapshot(session.availableCommands),
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

/**
 * Strip the `mcp__acp__` prefix that the ACP agent adds when it re-publishes
 * Claude Code built-in tools as MCP tools.  The prefix leaks into tool titles
 * when `toolInfoFromToolUse()` doesn't recognise the tool name (default branch)
 * and simply uses the raw name as the title.
 *
 * Examples:
 *   "mcp__acp__Read"           → "Read"
 *   "mcp__acp__CustomTool"     → "CustomTool"
 *   "Read /path/file"          → "Read /path/file"  (no prefix – unchanged)
 */
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

/**
 * Returns `true` when the tool title (already normalised by
 * `normalizeAcpToolTitle`) matches the Claude-native AskUserQuestion tool.
 *
 * We detect this so that a `permission_requested` event for AskUserQuestion
 * can be silently converted to a question-flow instead of a raw permission
 * dialog the user wouldn't know how to answer.
 */
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
