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
  kind: "system" | "user" | "agent" | "thought" | "tool" | "error";
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
  permissions: PermissionPayload[];
  updatedAt: string;
};

type StateResponse = {
  sessions: SessionRecord[];
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
  const [promptModeId, setPromptModeId] = useState("inherit");
  const [connectionState, setConnectionState] = useState("connecting");
  const [promptText, setPromptText] = useState("");
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [globalTimeline, setGlobalTimeline] = useState<TimelineItem[]>([]);
  const socketRef = useRef<WebSocket | null>(null);

  const activeSession = sessions.find((session) => session.clientSessionId === activeSessionId) ?? null;

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
    Promise.all([fetch("/api/config"), fetch("/api/state")])
      .then(async ([configResponse, stateResponse]) => {
        const configData = (await configResponse.json()) as AppConfig;
        const stateData = (await stateResponse.json()) as StateResponse;
        setConfig(configData);
        setWorkspacePath(configData.workspacePath);
        setSessions(stateData.sessions);
      })
      .catch((error) => {
        appendGlobalTimeline({
          id: crypto.randomUUID(),
          kind: "error",
          title: "初始化失败",
          body: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

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
          ? { ...session, timeline: [...session.timeline, item], updatedAt: new Date().toISOString() }
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
              id: crypto.randomUUID(),
              kind,
              title,
              body: text,
            },
          ],
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
            id: crypto.randomUUID(),
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
          id: crypto.randomUUID(),
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
            {
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
              permissions: [],
              updatedAt: new Date().toISOString(),
            },
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
          id: crypto.randomUUID(),
          kind: "system",
          title: "会话已创建",
          body: message.payload.sessionId,
          meta: message.payload.modes.join(", ") || "默认模式",
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
          id: crypto.randomUUID(),
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
          title: message.payload.toolCall.title ?? "等待权限确认",
          body: stringifyMaybe(message.payload.toolCall.rawInput ?? {}),
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
            id: crypto.randomUUID(),
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
          id: crypto.randomUUID(),
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
      case "agent_thought_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) {
          appendSessionTextChunk(clientSessionId, "thought", "思路", content.text);
        }
        break;
      }
      case "tool_call":
      case "tool_call_update":
        appendSessionTimeline(clientSessionId, {
          id: crypto.randomUUID(),
          kind: "tool",
          title: String(update.title ?? `工具 ${String(update.toolCallId ?? "")}`),
          body: stringifyMaybe(update.rawInput ?? update.rawOutput ?? ""),
          meta: String(update.status ?? update.sessionUpdate),
        });
        break;
      case "plan":
        appendSessionTimeline(clientSessionId, {
          id: crypto.randomUUID(),
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
          id: crypto.randomUUID(),
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
    sendCommand({
      type: "create_session",
      payload: {
        workspacePath: nextWorkspacePath,
        title: newSessionTitle.trim() || undefined,
        modeId: newSessionModeId,
      },
    });
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
        id: crypto.randomUUID(),
        kind: "error",
        title: "连接不可用",
        body: "WebSocket 尚未连接，命令没有发出。",
      });
      return false;
    }
    socket.send(JSON.stringify(command));
    return true;
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
          <StatusCard label="连接" value={connectionState} />
          <StatusCard label="会话数" value={String(sessions.length)} />
          <StatusCard label="当前会话" value={activeSession?.title ?? "未选择"} />
        </div>

        <div className="details">
          <p>新建目录</p>
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
          <p>允许根目录</p>
          <code>{config?.allowedRoots.join("\n") ?? "加载中..."}</code>
        </div>

        <div className="actions">
          <button className="primary" onClick={createSession} disabled={!workspacePath.trim()}>
            新建目录会话
          </button>
          <button className="secondary" onClick={openVscodeRemote} disabled={!config?.vscodeRemoteUri}>
            打开 VS Code Remote SSH
          </button>
        </div>

        <div className="session-list">
          {sessions.length === 0 ? (
            <div className="empty">还没有会话。先输入目录并创建一个。</div>
          ) : (
            sessions.map((session) => (
              <button
                key={session.clientSessionId}
                className={`session-chip ${session.clientSessionId === activeSessionId ? "active" : ""}`}
                onClick={() => setActiveSessionId(session.clientSessionId)}
              >
                <strong>{session.title}</strong>
                <span>{session.workspacePath}</span>
                <span>
                  {session.permissions.length > 0 ? `${session.permissions.length} 待确认` : session.connectionState}
                </span>
                <span>模式: {labelForMode(session.currentModeId || session.defaultModeId)}</span>
              </button>
            ))
          )}
        </div>
      </aside>

      <main className="panel transcript">
        <div className="transcript-header">
          <h2>{activeSession?.title ?? "任务流"}</h2>
          <p>{activeSession?.workspacePath ?? "选择左侧会话后，这里展示该目录的完整执行流。"}</p>
        </div>
        <div className="timeline">
          {(activeSession?.timeline ?? EMPTY_TIMELINE).length === 0 ? (
            <div className="empty">
              {activeSession
                ? "这个会话还没有执行记录。发送第一条指令后开始滚动展示。"
                : "先在左侧创建一个目录会话。"}
            </div>
          ) : (
            (activeSession?.timeline ?? EMPTY_TIMELINE).map((item) => <TimelineCard key={item.id} item={item} />)
          )}
          {globalTimeline.length > 0 ? (
            <section className="global-feed">
              <h3>全局消息</h3>
              {globalTimeline.map((item) => (
                <TimelineCard key={item.id} item={item} />
              ))}
            </section>
          ) : null}
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
            <div className="details session-meta">
              <p>目录</p>
              <code>{activeSession.workspacePath}</code>
              <p>Claude 会话 ID</p>
              <code>{activeSession.sessionId || "创建中..."}</code>
              <p>默认模式</p>
              <code>{labelForMode(activeSession.defaultModeId)}</code>
              <p>当前模式</p>
              <code>{labelForMode(activeSession.currentModeId)}</code>
            </div>
            <div className="actions compact">
              <button className="secondary" onClick={() => closeSession(activeSession.clientSessionId)}>
                关闭当前会话
              </button>
            </div>
            {activeSession.permissions.length === 0 ? (
              <div className="empty">当前会话没有待处理确认。</div>
            ) : (
              activeSession.permissions.map((permission) => (
                <section className="approval-card" key={permission.requestId}>
                  <h3>{permission.toolCall.title ?? "工具调用"}</h3>
                  <pre>{stringifyMaybe(permission.toolCall.rawInput ?? {})}</pre>
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
              ))
            )}
          </>
        ) : (
          <div className="empty">选择一个会话后再处理确认或关闭会话。</div>
        )}
      </aside>
    </div>
  );
}

function StatusCard(props: { label: string; value: string }) {
  return (
    <div className="status-card">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function TimelineCard(props: { item: TimelineItem }) {
  const lineCount = props.item.body.split("\n").length;
  const shouldCollapseByDefault =
    props.item.kind === "thought" || props.item.kind === "tool" || props.item.body.length > 260 || lineCount > 6;
  const [collapsed, setCollapsed] = useState(shouldCollapseByDefault);

  return (
    <article className={`bubble ${props.item.kind}`}>
      <header>
        <strong>{props.item.title}</strong>
        {props.item.meta ? <span>{props.item.meta}</span> : null}
      </header>
      <pre className={collapsed ? "collapsed" : ""}>{props.item.body}</pre>
      {shouldCollapseByDefault ? (
        <button className="toggle-link" onClick={() => setCollapsed((current) => !current)}>
          {collapsed ? "展开" : "收起"}
        </button>
      ) : null}
    </article>
  );
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
