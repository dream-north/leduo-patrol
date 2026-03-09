import { useEffect, useRef, useState } from "react";

type AppConfig = {
  appName: string;
  workspacePath: string;
  allowedRoots: string[];
  sshHost: string;
  sshPath: string;
  vscodeRemoteUri: string;
};

type SessionUpdate = {
  sessionUpdate: string;
  [key: string]: unknown;
};

type TimelineItem = {
  id: string;
  kind: "system" | "user" | "agent" | "thought" | "tool" | "plan" | "error";
  title: string;
  body: string;
  meta?: string;
};

type PermissionPayload = {
  clientSessionId: string;
  requestId: string;
  toolCall: { toolCallId: string; title?: string; status?: string; rawInput?: unknown };
  options: Array<{ optionId: string; name: string; kind: string }>;
};

type SessionRecord = {
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
  permissions: PermissionPayload[];
  updatedAt: string;
};

type StateResponse = {
  sessions: SessionRecord[];
};

type DirectoryResponse = {
  rootPath: string;
  directories: Array<{ name: string; path: string }>;
};

type SessionHistoryResponse = {
  items: TimelineItem[];
  start: number;
  total: number;
};

type EventMessage =
  | { type: "ready"; payload: { workspacePath: string; agentConnected: boolean; clientSessionId?: string } }
  | {
      type: "session_registered";
      payload: { clientSessionId: string; title: string; workspacePath: string };
    }
  | {
      type: "session_created";
      payload: { clientSessionId: string; sessionId: string; modes: string[]; configOptions: unknown[] };
    }
  | {
      type: "session_restored";
      payload: { clientSessionId: string; sessionId: string; modes: string[]; configOptions: unknown[] };
    }
  | { type: "prompt_started"; payload: { clientSessionId: string; promptId: string; text: string } }
  | { type: "prompt_finished"; payload: { clientSessionId: string; promptId: string; stopReason: string } }
  | { type: "session_update"; payload: SessionUpdate & { clientSessionId: string } }
  | { type: "permission_requested"; payload: PermissionPayload }
  | { type: "permission_resolved"; payload: { clientSessionId: string; requestId: string; optionId: string } }
  | { type: "session_closed"; payload: { clientSessionId: string } }
  | { type: "error"; payload: { message: string; clientSessionId?: string } };

const MODE_OPTIONS = [
  { id: "default", label: "Default" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "plan", label: "Plan" },
  { id: "dontAsk", label: "Don't Ask" },
  { id: "bypassPermissions", label: "Bypass Permissions" },
] as const;

const EMPTY_TIMELINE: TimelineItem[] = [];

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const [newSessionModeId, setNewSessionModeId] = useState("default");
  const [sidebarTab, setSidebarTab] = useState<"sessions" | "create">("sessions");
  const [promptModeId, setPromptModeId] = useState("inherit");
  const [connectionState, setConnectionState] = useState("connecting");
  const [promptText, setPromptText] = useState("");
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [directoryBrowserPath, setDirectoryBrowserPath] = useState("");
  const [directoryRootPath, setDirectoryRootPath] = useState("");
  const [directoryOptions, setDirectoryOptions] = useState<Array<{ name: string; path: string }>>([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [globalTimeline, setGlobalTimeline] = useState<TimelineItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<{ sessionTitle: string; item: TimelineItem } | null>(null);
  const [showSystemFeed, setShowSystemFeed] = useState(false);
  const [historyLoadingSessionId, setHistoryLoadingSessionId] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const timelineViewportRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  const activeSession = sessions.find((session) => session.clientSessionId === activeSessionId) ?? null;
  const visibleTimeline = activeSession?.timeline ?? EMPTY_TIMELINE;
  const browseRootPath = directoryBrowserPath || activeSession?.workspacePath || config?.workspacePath || "";
  const currentBrowsePath = directoryRootPath || browseRootPath;
  const canBrowseUp = canNavigateUp(currentBrowsePath, config?.allowedRoots ?? []);

  useEffect(() => {
    if (sessions.length === 0) {
      setActiveSessionId("");
      return;
    }
    if (!sessions.some((session) => session.clientSessionId === activeSessionId)) {
      setActiveSessionId(sessions[0].clientSessionId);
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    if (sessions.length === 0) {
      setSidebarTab("create");
    }
  }, [sessions.length]);

  useEffect(() => {
    if (sessions.length > 0 && activeSessionId) {
      setSidebarTab("sessions");
    }
  }, [activeSessionId, sessions.length]);

  useEffect(() => {
    setDirectoryBrowserPath(activeSession?.workspacePath ?? config?.workspacePath ?? "");
  }, [activeSession?.workspacePath, config?.workspacePath]);

  useEffect(() => {
    Promise.all([fetch("/api/config"), fetch("/api/state")])
      .then(async ([configResponse, stateResponse]) => {
        const configData = (await configResponse.json()) as AppConfig;
        const stateData = (await stateResponse.json()) as StateResponse;
        setConfig(configData);
        setWorkspacePath(configData.workspacePath);
        setSessions(stateData.sessions.map(normalizeSessionRecord));
      })
      .catch((error) => {
        appendGlobalTimeline({
          id: makeId(),
          kind: "error",
          title: "初始化失败",
          body: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  useEffect(() => {
    if (!browseRootPath) {
      setDirectoryRootPath("");
      setDirectoryOptions([]);
      setDirectoryError("");
      return;
    }

    const controller = new AbortController();
    setDirectoryLoading(true);
    setDirectoryError("");

    fetch(`/api/directories?root=${encodeURIComponent(browseRootPath)}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          const errorPayload = payload as { message?: string };
          throw new Error(errorPayload.message || "目录读取失败");
        }
        const directoryPayload = payload as DirectoryResponse;
        setDirectoryRootPath(directoryPayload.rootPath);
        setDirectoryOptions(directoryPayload.directories);
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        setDirectoryRootPath(browseRootPath);
        setDirectoryOptions([]);
        setDirectoryError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setDirectoryLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [browseRootPath]);

  useEffect(() => {
    const viewport = timelineViewportRef.current;
    if (!viewport || !shouldStickToBottomRef.current) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, [activeSessionId, visibleTimeline.length]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnectionState("connected");
      socket.send(JSON.stringify({ type: "hello" }));
    });

    socket.addEventListener("close", () => {
      setConnectionState("closed");
      setSessions((current) =>
        current.map((session) => ({
          ...session,
          connectionState: "error",
          busy: false,
        })),
      );
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as EventMessage;
      handleEvent(message);
    });

    socket.addEventListener("error", () => {
      setConnectionState("error");
    });

    return () => {
      socket.close();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, []);

  function appendGlobalTimeline(item: TimelineItem) {
    setGlobalTimeline((current) => [...current, item]);
  }

  function appendSessionTimeline(clientSessionId: string, item: TimelineItem) {
    setSessions((current) =>
      current.map((session) =>
        session.clientSessionId === clientSessionId
          ? {
              ...session,
              timeline: [...session.timeline, normalizeTimelineItem(item)],
              historyTotal: session.historyTotal + 1,
              updatedAt: new Date().toISOString(),
            }
          : session,
      ),
    );
  }

  function appendSessionTextChunk(clientSessionId: string, kind: TimelineItem["kind"], title: string, text: string) {
    setSessions((current) =>
      current.map((session) => {
        if (session.clientSessionId !== clientSessionId) {
          return session;
        }
        const lastItem = session.timeline.at(-1);
        if (lastItem && lastItem.kind === kind && lastItem.title === title && !lastItem.meta) {
          return {
            ...session,
            timeline: [
              ...session.timeline.slice(0, -1),
              {
                ...lastItem,
                body: lastItem.body + text,
              },
            ],
            updatedAt: new Date().toISOString(),
          };
        }
        return {
          ...session,
          timeline: [
            ...session.timeline,
            {
              id: makeId(),
              kind,
              title,
              body: text,
              },
            ],
            historyTotal: session.historyTotal + 1,
            updatedAt: new Date().toISOString(),
          };
      }),
    );
  }

  function updateSession(clientSessionId: string, updater: (session: SessionRecord) => SessionRecord) {
    setSessions((current) =>
      current.map((session) =>
        session.clientSessionId === clientSessionId
          ? { ...updater(session), updatedAt: new Date().toISOString() }
          : session,
      ),
    );
  }

  function ensureActiveSession(clientSessionId: string) {
    setActiveSessionId((current) => current || clientSessionId);
  }

  function handleEvent(message: EventMessage) {
    switch (message.type) {
      case "ready":
        if (!message.payload.clientSessionId) {
          appendGlobalTimeline({
            id: makeId(),
            kind: "system",
            title: "WebSocket 已连接",
            body: message.payload.workspacePath,
          });
          break;
        }
        updateSession(message.payload.clientSessionId, (session) => ({
          ...session,
          workspacePath: message.payload.workspacePath,
          connectionState: "connected",
        }));
        appendSessionTimeline(message.payload.clientSessionId, {
          id: makeId(),
          kind: "system",
          title: "Claude ACP 已连接",
          body: message.payload.workspacePath,
        });
        break;
      case "session_registered":
        setSessions((current) => {
          const existing = current.find((session) => session.clientSessionId === message.payload.clientSessionId);
          if (existing) {
            return current.map((session) =>
              session.clientSessionId === message.payload.clientSessionId
                ? {
                    ...session,
                    title: message.payload.title,
                    workspacePath: message.payload.workspacePath,
                  }
                : session,
            );
          }
          return [
            ...current,
            normalizeSessionRecord({
              clientSessionId: message.payload.clientSessionId,
              title: message.payload.title,
              workspacePath: message.payload.workspacePath,
              connectionState: "connecting",
              sessionId: "",
              modes: [],
              defaultModeId: newSessionModeId,
              currentModeId: newSessionModeId,
              busy: false,
              timeline: [],
              historyTotal: 0,
              historyStart: 0,
              permissions: [],
              updatedAt: new Date().toISOString(),
            }),
          ];
        });
        ensureActiveSession(message.payload.clientSessionId);
        break;
      case "session_created":
        updateSession(message.payload.clientSessionId, (session) => ({
          ...session,
          sessionId: message.payload.sessionId,
          modes: message.payload.modes,
          connectionState: "connected",
        }));
        appendSessionTimeline(message.payload.clientSessionId, {
          id: makeId(),
          kind: "system",
          title: "会话已创建",
          body: message.payload.sessionId,
        });
        break;
      case "session_restored":
        updateSession(message.payload.clientSessionId, (session) => ({
          ...session,
          sessionId: message.payload.sessionId,
          modes: message.payload.modes,
          connectionState: "connected",
        }));
        appendSessionTimeline(message.payload.clientSessionId, {
          id: makeId(),
          kind: "system",
          title: "会话已恢复",
          body: message.payload.sessionId,
        });
        break;
      case "prompt_started":
        updateSession(message.payload.clientSessionId, (session) => ({ ...session, busy: true }));
        appendSessionTimeline(message.payload.clientSessionId, {
          id: message.payload.promptId,
          kind: "user",
          title: "你",
          body: message.payload.text,
        });
        break;
      case "prompt_finished":
        updateSession(message.payload.clientSessionId, (session) => ({ ...session, busy: false }));
        appendSessionTimeline(message.payload.clientSessionId, {
          id: makeId(),
          kind: "system",
          title: "本轮完成",
          body: message.payload.stopReason,
        });
        break;
      case "session_update":
        consumeSessionUpdate(message.payload.clientSessionId, message.payload);
        break;
      case "permission_requested":
        updateSession(message.payload.clientSessionId, (session) => ({
          ...session,
          permissions: [...session.permissions, message.payload],
        }));
        appendSessionTimeline(message.payload.clientSessionId, {
          id: message.payload.requestId,
          kind: "tool",
          title: summarizeToolTitle(
            message.payload.toolCall.title,
            message.payload.toolCall.rawInput,
            message.payload.toolCall.toolCallId,
          ),
          body: formatToolBody({
            toolCallId: message.payload.toolCall.toolCallId,
            title: message.payload.toolCall.title,
            status: message.payload.toolCall.status,
            rawInput: message.payload.toolCall.rawInput,
          }),
          meta: message.payload.toolCall.status ?? "pending",
        });
        break;
      case "permission_resolved":
        updateSession(message.payload.clientSessionId, (session) => ({
          ...session,
          permissions: session.permissions.filter((permission) => permission.requestId !== message.payload.requestId),
        }));
        break;
      case "session_closed":
        setSessions((current) => current.filter((session) => session.clientSessionId !== message.payload.clientSessionId));
        break;
      case "error":
        if (!message.payload.clientSessionId) {
          appendGlobalTimeline({
            id: makeId(),
            kind: "error",
            title: "错误",
            body: message.payload.message,
          });
          break;
        }
        updateSession(message.payload.clientSessionId, (session) => ({
          ...session,
          busy: false,
          connectionState: "error",
        }));
        appendSessionTimeline(message.payload.clientSessionId, {
          id: makeId(),
          kind: "error",
          title: "错误",
          body: message.payload.message,
        });
        break;
    }
  }

  function consumeSessionUpdate(clientSessionId: string, update: SessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) {
          appendSessionTextChunk(clientSessionId, "agent", "Claude", content.text);
        }
        break;
      }
      case "user_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) {
          appendSessionTextChunk(clientSessionId, "user", "你", content.text);
        }
        break;
      }
      case "agent_thought_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) {
          appendSessionTextChunk(clientSessionId, "thought", "思路", content.text);
        }
        break;
      }
      case "tool_call":
      case "tool_call_update":
        appendSessionTimeline(clientSessionId, buildToolTimelineItem(update));
        break;
      case "plan":
        appendSessionTimeline(clientSessionId, {
          id: makeId(),
          kind: "system",
          title: "执行计划",
          body: stringifyMaybe(update.entries ?? update),
        });
        break;
      case "current_mode_update":
        updateSession(clientSessionId, (session) => ({
          ...session,
          currentModeId: String(update.currentModeId ?? session.currentModeId ?? "default"),
        }));
        appendSessionTimeline(clientSessionId, {
          id: makeId(),
          kind: "system",
          title: "模式切换",
          body: String(update.currentModeId ?? "unknown"),
        });
        break;
      default:
        break;
    }
  }

  function createSession() {
    const nextWorkspacePath = workspacePath.trim();
    if (!nextWorkspacePath) {
      return;
    }
    const didSend = sendCommand({
      type: "create_session",
      payload: {
        workspacePath: nextWorkspacePath,
        title: newSessionTitle.trim() || undefined,
        modeId: newSessionModeId,
      },
    });
    if (didSend) {
      setSidebarTab("sessions");
    }
  }

  function submitPrompt() {
    const text = promptText.trim();
    if (!text || !activeSession) {
      return;
    }
    if (
      !sendCommand({
        type: "prompt",
        payload: {
          clientSessionId: activeSession.clientSessionId,
          text,
          modeId: promptModeId === "inherit" ? undefined : promptModeId,
        },
      })
    ) {
      return;
    }
    setPromptText("");
  }

  function cancelActiveSession() {
    if (!activeSession) {
      return;
    }
    sendCommand({
      type: "cancel",
      payload: { clientSessionId: activeSession.clientSessionId },
    });
  }

  function closeSession(clientSessionId: string) {
    sendCommand({
      type: "close_session",
      payload: { clientSessionId },
    });
  }

  function resolvePermission(permission: PermissionPayload, optionId: string) {
    sendCommand({
      type: "permission",
      payload: {
        clientSessionId: permission.clientSessionId,
        requestId: permission.requestId,
        optionId,
      },
    });
  }

  function openVscodeRemote() {
    if (config?.vscodeRemoteUri) {
      window.location.href = config.vscodeRemoteUri;
    }
  }

  function sendCommand(command: unknown) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendGlobalTimeline({
        id: makeId(),
        kind: "error",
        title: "连接不可用",
        body: "WebSocket 尚未连接，命令没有发出。",
      });
      return false;
    }
    socket.send(JSON.stringify(command));
    return true;
  }

  function handleTimelineScroll() {
    const viewport = timelineViewportRef.current;
    if (!viewport) {
      return;
    }
    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    shouldStickToBottomRef.current = distanceToBottom < 40;
  }

  function loadMoreHistory() {
    if (!activeSession || activeSession.historyStart <= 0 || historyLoadingSessionId === activeSession.clientSessionId) {
      return;
    }

    setHistoryLoadingSessionId(activeSession.clientSessionId);
    fetch(
      `/api/session-history?clientSessionId=${encodeURIComponent(activeSession.clientSessionId)}&before=${activeSession.historyStart}&limit=120`,
    )
      .then(async (response) => {
        const payload = (await response.json()) as SessionHistoryResponse | { message?: string };
        if (!response.ok) {
          throw new Error("message" in payload ? payload.message || "历史加载失败" : "历史加载失败");
        }
        const history = payload as SessionHistoryResponse;
        setSessions((current) =>
          current.map((session) =>
            session.clientSessionId === activeSession.clientSessionId
              ? {
                  ...session,
                  timeline: [...history.items.map(normalizeTimelineItem), ...session.timeline],
                  historyStart: history.start,
                  historyTotal: history.total,
                }
              : session,
          ),
        );
      })
      .catch((error) => {
        appendGlobalTimeline({
          id: makeId(),
          kind: "error",
          title: "历史加载失败",
          body: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        setHistoryLoadingSessionId("");
      });
  }

  return (
    <div className="shell multi-session">
      <aside className="panel masthead">
        <div>
          <p className="eyebrow">leduo-patrol</p>
          <h1>{config?.appName ?? "乐汪队"}</h1>
          <p className="lede">同一页面内管理多个服务器目录会话，输出会自动合并并支持折叠。</p>
        </div>

        <div className="status-grid">
          <StatusCard label="连接" value={connectionState} tone={toneForConnectionState(connectionState)} />
          <StatusCard label="会话数" value={String(sessions.length)} />
        </div>

        {globalTimeline.length > 0 ? (
          <button className="system-trigger secondary" type="button" onClick={() => setShowSystemFeed(true)}>
            系统消息 {globalTimeline.length}
          </button>
        ) : null}

        <div className="sidebar-tabs" role="tablist" aria-label="会话面板">
          <button
            className={`sidebar-tab ${sidebarTab === "sessions" ? "active" : ""}`}
            onClick={() => setSidebarTab("sessions")}
            type="button"
          >
            当前会话
          </button>
          <button
            className={`sidebar-tab ${sidebarTab === "create" ? "active" : ""}`}
            onClick={() => setSidebarTab("create")}
            type="button"
          >
            新建会话
          </button>
        </div>

        <div className="sidebar-body">
          {sidebarTab === "create" ? (
            <div className="tab-panel create-panel">
              <div className="details">
                <p>会话目录</p>
                <input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} />
                <p>会话名</p>
                <input
                  value={newSessionTitle}
                  placeholder="可选，例如 leduo-api"
                  onChange={(event) => setNewSessionTitle(event.target.value)}
                />
                <p>默认模式</p>
                <select value={newSessionModeId} onChange={(event) => setNewSessionModeId(event.target.value)}>
                  {MODE_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p>当前目录的子目录</p>
                <select
                  value=""
                  disabled={directoryLoading || directoryOptions.length === 0}
                  onChange={(event) => {
                    if (event.target.value) {
                      setDirectoryBrowserPath(event.target.value);
                      setWorkspacePath(event.target.value);
                    }
                  }}
                >
                  <option value="">
                    {directoryLoading
                      ? "正在读取子目录..."
                      : directoryOptions.length > 0
                        ? "选择一个子目录"
                        : "当前目录下没有可选子目录"}
                  </option>
                  {directoryOptions.map((option) => (
                    <option key={option.path} value={option.path}>
                      {option.name}
                    </option>
                  ))}
                </select>
                <div className="inline-actions">
                  <button
                    className="secondary"
                    type="button"
                    disabled={!currentBrowsePath || !canBrowseUp}
                    onClick={() => setDirectoryBrowserPath(parentDirectory(currentBrowsePath))}
                  >
                    返回上一级
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    disabled={!currentBrowsePath}
                    onClick={() => setWorkspacePath(currentBrowsePath)}
                  >
                    使用当前目录
                  </button>
                </div>
                <p>当前浏览目录</p>
                <code>{currentBrowsePath || "加载中..."}</code>
                {directoryError ? <p>{directoryError}</p> : null}
                <p>允许根目录</p>
                <code>{config?.allowedRoots.join("\n") ?? "加载中..."}</code>
              </div>
              <div className="actions">
                <button className="primary" onClick={createSession} disabled={!workspacePath.trim()}>
                  新建目录会话
                </button>
              </div>
            </div>
          ) : (
            <div className="tab-panel fill">
              <div className="actions compact">
                <button className="secondary" onClick={openVscodeRemote} disabled={!config?.vscodeRemoteUri}>
                  打开 VS Code Remote SSH
                </button>
              </div>
              <div className="session-list">
                {sessions.length === 0 ? (
                  <div className="empty">还没有会话。切到“新建会话”创建一个。</div>
                ) : (
                  sessions.map((session) => (
                    <button
                      key={session.clientSessionId}
                      className={`session-chip ${session.clientSessionId === activeSessionId ? "active" : ""}`}
                      onClick={() => setActiveSessionId(session.clientSessionId)}
                    >
                      <span className="session-chip-header">
                        <strong>{session.title}</strong>
                        {session.permissions.length > 0 ? (
                          <span className="session-chip-badge">{session.permissions.length} 待处理</span>
                        ) : null}
                      </span>
                      <span>{session.workspacePath}</span>
                      <span>
                        {session.permissions.length > 0 ? `${session.permissions.length} 待确认` : session.connectionState}
                      </span>
                      <span>模式: {labelForMode(session.currentModeId || session.defaultModeId)}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

      </aside>

      <main className="panel transcript">
        <div className="transcript-header">
          <h2>{activeSession?.title ?? "任务流"}</h2>
          <p>{activeSession?.workspacePath ?? "选择左侧会话后，这里展示该目录的完整执行流。"}</p>
        </div>
        <div className="timeline" ref={timelineViewportRef} onScroll={handleTimelineScroll}>
          {activeSession && activeSession.historyStart > 0 ? (
            <button
              className="history-loader secondary"
              type="button"
              onClick={loadMoreHistory}
              disabled={historyLoadingSessionId === activeSession.clientSessionId}
            >
              {historyLoadingSessionId === activeSession.clientSessionId
                ? "正在加载更早历史..."
                : `加载更多历史 (${activeSession.historyStart} 条更早记录)`}
            </button>
          ) : null}
          {visibleTimeline.length === 0 ? (
            <div className="empty">
              {activeSession
                ? "这个会话还没有执行记录。发送第一条指令后开始滚动展示。"
                : "先在左侧创建一个目录会话。"}
            </div>
          ) : (
            visibleTimeline.map((item) => (
              <TimelineRow
                key={item.id}
                item={item}
                onOpen={() => setSelectedItem({ sessionTitle: activeSession?.title ?? "当前会话", item })}
              />
            ))
          )}
        </div>
        <div className="composer">
          <select value={promptModeId} onChange={(event) => setPromptModeId(event.target.value)}>
            <option value="inherit">沿用当前会话模式</option>
            {MODE_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                本次消息使用 {option.label}
              </option>
            ))}
          </select>
          <textarea
            placeholder="例如：分析这个目录的仓库结构，然后给我一个重构计划。"
            value={promptText}
            onChange={(event) => setPromptText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                submitPrompt();
              }
            }}
          />
          <button className="primary" onClick={submitPrompt} disabled={!promptText.trim() || !activeSession || activeSession.busy}>
            发送到当前会话
          </button>
          <button className="secondary" onClick={cancelActiveSession} disabled={!activeSession?.busy}>
            取消当前会话任务
          </button>
        </div>
      </main>

      <aside className="panel approvals">
        <div className="transcript-header">
          <h2>会话详情</h2>
          <p>当前会话会持久化到服务器用户目录，浏览器刷新后会自动恢复。</p>
        </div>
        {activeSession ? (
          <>
            {activeSession.permissions.length === 0 ? (
              <div className="empty">当前会话没有待处理确认。</div>
            ) : (
              <div className="approval-stack">
                {activeSession.permissions.map((permission) => (
                  <section className="approval-card approval-card-active" key={permission.requestId}>
                    <p className="approval-label">待处理确认</p>
                    <h3>
                      {summarizeToolTitle(
                        permission.toolCall.title,
                        permission.toolCall.rawInput,
                        permission.toolCall.toolCallId,
                      )}
                    </h3>
                    <p className="approval-hint">
                      {extractPlanText(permission.toolCall.rawInput)
                        ? "计划详情已经显示在中间会话里，点击对应条目可查看完整 Markdown。"
                        : "右侧只保留确认动作，详细内容请在中间会话中查看。"}
                    </p>
                    <div className="approval-actions">
                      {permission.options.map((option) => (
                        <button
                          key={option.optionId}
                          className="secondary"
                          onClick={() => resolvePermission(permission, option.optionId)}
                        >
                          {option.name}
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
            <section className="details session-meta session-meta-card">
              <div className="session-meta-header">
                <div>
                  <p className="approval-label">会话详情</p>
                  <h3>{activeSession.title}</h3>
                </div>
                <button className="secondary session-close" onClick={() => closeSession(activeSession.clientSessionId)}>
                  关闭当前会话
                </button>
              </div>
              <div className="session-meta-grid">
                <div className="session-meta-item session-meta-item-wide">
                  <span>目录</span>
                  <code>{activeSession.workspacePath}</code>
                </div>
                <div className="session-meta-item session-meta-item-wide">
                  <span>Claude 会话 ID</span>
                  <code>{activeSession.sessionId || "创建中..."}</code>
                </div>
                <div className="session-meta-item">
                  <span>默认模式</span>
                  <code>{labelForMode(activeSession.defaultModeId)}</code>
                </div>
                <div className="session-meta-item">
                  <span>当前模式</span>
                  <code>{labelForMode(activeSession.currentModeId)}</code>
                </div>
              </div>
            </section>
          </>
        ) : (
          <div className="empty">选择一个会话后再处理确认或关闭会话。</div>
        )}
      </aside>

      {selectedItem ? (
        <MessageModal
          sessionTitle={selectedItem.sessionTitle}
          item={selectedItem.item}
          onClose={() => setSelectedItem(null)}
        />
      ) : null}

      {showSystemFeed ? (
        <SystemFeedModal
          items={globalTimeline}
          onClose={() => setShowSystemFeed(false)}
          onOpenItem={(item) => {
            setShowSystemFeed(false);
            setSelectedItem({ sessionTitle: "系统消息", item });
          }}
        />
      ) : null}
    </div>
  );
}

function StatusCard(props: { label: string; value: string; tone?: "positive" | "negative" | "neutral" }) {
  return (
    <div className={`status-card ${props.tone ? `status-card-${props.tone}` : ""}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function TimelineRow(props: { item: TimelineItem; onOpen: () => void }) {
  const kindLabel = labelForKind(props.item.kind, props.item.title);
  const expandedPreview = shouldUseExpandedPreview(props.item);
  const summary = summarizeTimelineItem(props.item, expandedPreview);
  return (
    <button className={`timeline-row ${props.item.kind} ${expandedPreview ? "timeline-row-multiline" : ""}`} onClick={props.onOpen}>
      <span className="timeline-kind">{kindLabel}</span>
      <span className={`timeline-body ${expandedPreview ? "multiline" : ""}`}>{summary}</span>
      <span className="timeline-meta">{props.item.meta ?? "查看"}</span>
    </button>
  );
}

function buildToolTimelineItem(update: SessionUpdate): TimelineItem {
  return {
    id: makeId(),
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
  };
}

function labelForKind(kind: TimelineItem["kind"], fallbackTitle: string) {
  switch (kind) {
    case "user":
      return "你";
    case "agent":
      return "Claude";
    case "thought":
      return "思路";
    case "tool":
      return "工具";
    case "plan":
      return "计划";
    case "error":
      return "错误";
    case "system":
      return fallbackTitle;
    default:
      return fallbackTitle;
  }
}

function summarizeTimelineItem(item: TimelineItem, expandedPreview: boolean) {
  if (expandedPreview) {
    return toPreviewText(item.body);
  }
  if (item.kind === "tool") {
    return toSingleLine(item.title);
  }
  return toSingleLine(item.body);
}

function shouldUseExpandedPreview(item: TimelineItem) {
  return item.kind === "agent" || item.kind === "plan";
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

function formatToolBody(details: {
  toolCallId?: unknown;
  title?: unknown;
  status?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
}) {
  return formatToolDetails(details);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function extractPlanText(value: unknown) {
  return extractPlanPreview(value)?.body ?? null;
}

function stringifyMaybe(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function labelForMode(modeId: string) {
  return MODE_OPTIONS.find((option) => option.id === modeId)?.label ?? modeId;
}

function toneForConnectionState(connectionState: string): "positive" | "negative" | "neutral" {
  if (connectionState === "connected") {
    return "positive";
  }
  if (connectionState === "closed" || connectionState === "error") {
    return "negative";
  }
  return "neutral";
}

function canNavigateUp(currentPath: string, allowedRoots: string[]) {
  const normalizedCurrent = normalizePath(currentPath);
  if (!normalizedCurrent) {
    return false;
  }

  return allowedRoots.some((rootPath) => {
    const normalizedRoot = normalizePath(rootPath);
    return normalizedCurrent !== normalizedRoot && isWithinRoot(normalizedRoot, normalizedCurrent);
  });
}

function parentDirectory(pathValue: string) {
  const trimmed = pathValue.replace(/[\\/]+$/, "");
  const lastSeparatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));

  if (lastSeparatorIndex <= 0) {
    return trimmed.slice(0, 1) || trimmed;
  }

  return trimmed.slice(0, lastSeparatorIndex);
}

function isWithinRoot(rootPath: string, targetPath: string) {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}/`);
}

function normalizePath(pathValue: string) {
  const normalized = pathValue.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function toSingleLine(value: string) {
  return value.replace(/\s+/g, " ").trim() || "(空)";
}

function toPreviewText(value: string) {
  return value.trim() || "(空)";
}

function normalizeSessionRecord(session: SessionRecord): SessionRecord {
  const total = session.historyTotal ?? session.timeline.length;
  const start = session.historyStart ?? Math.max(0, total - session.timeline.length);

  return {
    ...session,
    timeline: session.timeline.map(normalizeTimelineItem),
    historyTotal: total,
    historyStart: start,
  };
}

function normalizeTimelineItem(item: TimelineItem): TimelineItem {
  if (item.kind !== "tool") {
    return item;
  }

  const planPreview = extractPlanPreview(item.body);
  if (!planPreview) {
    return item;
  }

  return {
    ...item,
    kind: "plan",
    title: planPreview.title,
    body: planPreview.body,
  };
}

function extractPlanPreview(value: unknown): { title: string; body: string } | null {
  const parsed = tryParseJson(value);
  if (parsed !== null) {
    return extractPlanPreview(parsed);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const preview = extractPlanPreview(entry);
      if (preview) {
        return preview;
      }
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  if (typeof record.plan === "string") {
    return {
      title: "计划确认",
      body: record.plan,
    };
  }

  const filePath =
    typeof record.file_path === "string"
      ? record.file_path
      : typeof record.path === "string"
        ? record.path
        : null;
  const content =
    typeof record.content === "string"
      ? record.content
      : typeof record.text === "string"
        ? record.text
        : null;

  if (filePath?.includes("/.claude/plans/") && content) {
    return {
      title: "计划",
      body: content,
    };
  }

  for (const nestedKey of ["rawInput", "rawOutput", "input", "output", "content"]) {
    if (nestedKey in record) {
      const preview = extractPlanPreview(record[nestedKey]);
      if (preview) {
        return preview;
      }
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

function makeId() {
  const cryptoObject = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof cryptoObject?.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  return `lp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function MessageModal(props: {
  sessionTitle: string;
  item: TimelineItem;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">{props.sessionTitle}</p>
            <h3>{props.item.title}</h3>
          </div>
          <button className="secondary" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <p className="modal-meta">{props.item.meta ?? "详细内容"}</p>
        <pre className="modal-body">{props.item.body}</pre>
      </div>
    </div>
  );
}

function SystemFeedModal(props: {
  items: TimelineItem[];
  onClose: () => void;
  onOpenItem: (item: TimelineItem) => void;
}) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal-card system-modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">系统消息</p>
            <h3>应用级状态与错误</h3>
          </div>
          <button className="secondary" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="system-modal-list">
          {props.items.map((item) => (
            <TimelineRow key={item.id} item={item} onOpen={() => props.onOpenItem(item)} />
          ))}
        </div>
      </div>
    </div>
  );
}
