import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

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

type TimelineTreeRow = {
  item: TimelineItem;
  depth: number;
  rootId: string | null;
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

type DiffCategory = "workingTree" | "staged" | "untracked";

type SessionDiffFileEntry = {
  filePath: string;
  changeType: "新增" | "修改";
};

type SessionDiffResponse = {
  workspacePath: string;
  workspaceReadonly: boolean;
  repositoryRoot: string;
  workingTree: SessionDiffFileEntry[];
  staged: SessionDiffFileEntry[];
  untracked: SessionDiffFileEntry[];
};

type SessionFileDiffResponse = {
  category: DiffCategory;
  filePath: string;
  omitted: boolean;
  diff: string;
  reason?: string;
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

type DemoPreset = "subagent-tree" | null;

function readAccessKeyFromUrl() {
  if (typeof window === "undefined") {
    return "";
  }
  return new URLSearchParams(window.location.search).get("key")?.trim() ?? "";
}

function readDemoPresetFromUrl(): DemoPreset {
  if (typeof window === "undefined") {
    return null;
  }
  const value = new URLSearchParams(window.location.search).get("demo")?.trim().toLowerCase();
  if (value === "subagent-tree") {
    return "subagent-tree";
  }
  return null;
}

function withAccessKey(path: string, keyOverride?: string) {
  if (typeof window === "undefined") {
    return path;
  }
  const url = new URL(path, window.location.origin);
  const key = (keyOverride ?? readAccessKeyFromUrl()).trim();
  if (key) {
    url.searchParams.set("key", key);
  }
  return `${url.pathname}${url.search}`;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [accessKey, setAccessKey] = useState(() => readAccessKeyFromUrl());
  const [accessKeyInput, setAccessKeyInput] = useState(() => readAccessKeyFromUrl());
  const [authPrompt, setAuthPrompt] = useState("");
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
  const [sessionDiff, setSessionDiff] = useState<SessionDiffResponse | null>(null);
  const [sessionDiffError, setSessionDiffError] = useState("");
  const [sessionDiffOpen, setSessionDiffOpen] = useState(false);
  const [sessionDiffLoading, setSessionDiffLoading] = useState(false);
  const [sessionFileDiffCache, setSessionFileDiffCache] = useState<Record<string, SessionFileDiffResponse>>({});
  const [showSystemFeed, setShowSystemFeed] = useState(false);
  const [historyLoadingSessionId, setHistoryLoadingSessionId] = useState("");
  const [collapsedSubagentRoots, setCollapsedSubagentRoots] = useState<Record<string, true>>({});
  const demoPreset = useMemo(() => readDemoPresetFromUrl(), []);
  const socketRef = useRef<WebSocket | null>(null);
  const timelineViewportRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  const activeSession = sessions.find((session) => session.clientSessionId === activeSessionId) ?? null;
  const visibleTimeline = activeSession?.timeline ?? EMPTY_TIMELINE;
  const timelineRows = useMemo(() => buildTimelineTreeRows(visibleTimeline), [visibleTimeline]);
  const rootChildCount = useMemo(() => countChildrenByRoot(timelineRows), [timelineRows]);
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
    if (!accessKey) {
      setAuthPrompt("访问需要 key，请先输入后再进入控制台。");
      return;
    }

    Promise.all([fetch(withAccessKey("/api/config", accessKey)), fetch(withAccessKey("/api/state", accessKey))])
      .then(async ([configResponse, stateResponse]) => {
        if (configResponse.status === 401 || stateResponse.status === 401) {
          throw new Error("key 无效或已过期，请重新输入。");
        }
        if (!configResponse.ok || !stateResponse.ok) {
          throw new Error("初始化失败：配置或状态请求异常。");
        }
        const configData = (await configResponse.json()) as AppConfig;
        const stateData = (await stateResponse.json()) as StateResponse;
        setConfig(configData);
        setWorkspacePath(configData.workspacePath);
        const normalizedSessions = stateData.sessions.map(normalizeSessionRecord);
        setSessions(applyDemoPreset(normalizedSessions, configData.workspacePath, demoPreset));
        setAuthPrompt("");
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("key")) {
          setAuthPrompt(message);
          return;
        }
        appendGlobalTimeline({
          id: makeId(),
          kind: "error",
          title: "初始化失败",
          body: message,
        });
      });
  }, [accessKey]);

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

    fetch(withAccessKey(`/api/directories?root=${encodeURIComponent(browseRootPath)}`), { signal: controller.signal })
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
    if (!accessKey) {
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}${withAccessKey("/ws", accessKey)}`);
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
  }, [accessKey]);

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
        const chunkText = extractChunkText(update.content);
        if (chunkText) {
          appendSessionTextChunk(clientSessionId, "agent", "Claude", chunkText);
        }
        break;
      }
      case "user_message_chunk": {
        const chunkText = extractChunkText(update.content);
        if (chunkText) {
          appendSessionTextChunk(clientSessionId, "user", "你", chunkText);
        }
        break;
      }
      case "agent_thought_chunk": {
        const chunkText = extractChunkText(update.content);
        if (chunkText) {
          appendSessionTextChunk(clientSessionId, "thought", "思路", chunkText);
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

  async function openSessionDiff() {
    if (!activeSession) {
      return;
    }
    setSessionDiffOpen(true);
    setSessionDiffLoading(true);
    setSessionDiffError("");

    try {
      const response = await fetch(withAccessKey(`/api/session-diff/files?clientSessionId=${encodeURIComponent(activeSession.clientSessionId)}`));
      const payload = await response.json();
      if (!response.ok) {
        const errorPayload = payload as { message?: string };
        throw new Error(errorPayload.message || "读取目录 Diff 失败");
      }
      setSessionDiff(payload as SessionDiffResponse);
      setSessionFileDiffCache({});
    } catch (error) {
      setSessionDiff(null);
      setSessionDiffError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionDiffLoading(false);
    }
  }

  async function loadSessionFileDiff(category: DiffCategory, filePath: string) {
    if (!activeSession) {
      throw new Error("当前没有可用会话");
    }
    const cacheKey = `${category}:${filePath}`;
    const cached = sessionFileDiffCache[cacheKey];
    if (cached) {
      return cached;
    }

    const response = await fetch(
      withAccessKey(
        `/api/session-diff/file?clientSessionId=${encodeURIComponent(activeSession.clientSessionId)}&category=${encodeURIComponent(category)}&filePath=${encodeURIComponent(filePath)}`,
      ),
    );
    const payload = (await response.json()) as SessionFileDiffResponse | { message?: string };
    if (!response.ok) {
      throw new Error("message" in payload ? payload.message || "加载文件 Diff 失败" : "加载文件 Diff 失败");
    }
    const diffPayload = payload as SessionFileDiffResponse;
    setSessionFileDiffCache((current) => ({ ...current, [cacheKey]: diffPayload }));
    return diffPayload;
  }

  function loadMoreHistory() {
    if (!activeSession || activeSession.historyStart <= 0 || historyLoadingSessionId === activeSession.clientSessionId) {
      return;
    }

    setHistoryLoadingSessionId(activeSession.clientSessionId);
    fetch(
      withAccessKey(`/api/session-history?clientSessionId=${encodeURIComponent(activeSession.clientSessionId)}&before=${activeSession.historyStart}&limit=120`),
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


  function applyAccessKey() {
    const normalizedKey = accessKeyInput.trim();
    if (!normalizedKey) {
      setAuthPrompt("请输入有效 key。");
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("key", normalizedKey);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setAccessKey(normalizedKey);
    setAuthPrompt("");
  }

  if (!accessKey || (authPrompt && !config)) {
    return (
      <div className="access-gate">
        <div className="panel access-card">
          <p className="eyebrow">leduo-patrol</p>
          <h1>请输入访问 Key</h1>
          <p className="lede">{authPrompt || "当前链接未携带 key，无法访问 API 与 WebSocket。"}</p>
          <input
            value={accessKeyInput}
            placeholder="粘贴服务启动时输出的 key"
            onChange={(event) => setAccessKeyInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                applyAccessKey();
              }
            }}
          />
          <button className="primary" type="button" onClick={applyAccessKey}>
            进入控制台
          </button>
        </div>
      </div>
    );
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
                <code>{config?.allowedRoots?.join("\n") ?? "加载中..."}</code>
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
            timelineRows.map((row) => {
              const collapsed = row.rootId ? Boolean(collapsedSubagentRoots[row.rootId]) : false;
              if (row.depth > 0 && collapsed) {
                return null;
              }
              const childCount = rootChildCount[row.item.id] ?? 0;
              return (
                <TimelineRow
                  key={row.item.id}
                  item={row.item}
                  depth={row.depth}
                  childCount={childCount}
                  collapsed={Boolean(collapsedSubagentRoots[row.item.id])}
                  onToggleCollapse={
                    childCount > 0
                      ? () =>
                          setCollapsedSubagentRoots((current) => {
                            if (current[row.item.id]) {
                              const next = { ...current };
                              delete next[row.item.id];
                              return next;
                            }
                            return { ...current, [row.item.id]: true };
                          })
                      : undefined
                  }
                  onOpen={() => setSelectedItem({ sessionTitle: activeSession?.title ?? "当前会话", item: row.item })}
                />
              );
            })
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
              <div className="session-meta-actions">
                <button className="secondary session-diff-trigger" onClick={openSessionDiff}>
                  查看diff
                </button>
                <button className="secondary session-close" onClick={() => closeSession(activeSession.clientSessionId)}>
                  关闭会话
                </button>
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

      {sessionDiffOpen ? (
        <SessionDiffModal
          sessionTitle={activeSession?.title ?? "当前会话"}
          loading={sessionDiffLoading}
          error={sessionDiffError}
          snapshot={sessionDiff}
          fileDiffCache={sessionFileDiffCache}
          onLoadFileDiff={loadSessionFileDiff}
          onClose={() => setSessionDiffOpen(false)}
          onRefresh={openSessionDiff}
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

function TimelineRow(props: {
  item: TimelineItem;
  depth?: number;
  childCount?: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onOpen: () => void;
}) {
  const kindLabel = labelForKind(props.item.kind, props.item.title);
  const expandedPreview = shouldUseExpandedPreview(props.item);
  const summary = summarizeTimelineItem(props.item, expandedPreview);
  return (
    <button
      className={`timeline-row ${props.item.kind} ${expandedPreview ? "timeline-row-multiline" : ""}`}
      onClick={props.onOpen}
      style={{ "--timeline-depth": `${Math.max(0, props.depth ?? 0)}` } as CSSProperties}
    >
      <span className="timeline-kind">
        {kindLabel}
        {props.childCount ? (
          <span
            className="timeline-fold"
            role="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleCollapse?.();
            }}
          >
            {props.collapsed ? "▸" : "▾"} 子项 {props.childCount}
          </span>
        ) : null}
      </span>
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

function buildTimelineTreeRows(items: TimelineItem[]): TimelineTreeRow[] {
  const rows: TimelineTreeRow[] = [];
  const activeRoots: Array<{ rootId: string; toolCallId: string | null }> = [];

  for (const item of items) {
    const toolMeta = readToolMeta(item);
    const activeRootId = activeRoots.at(-1)?.rootId ?? null;

    rows.push({
      item,
      depth: activeRootId ? activeRoots.length : 0,
      rootId: activeRootId,
    });

    if (!toolMeta || !isSubagentToolTitle(toolMeta.title)) {
      continue;
    }

    if (!isTerminalToolStatus(toolMeta.status)) {
      activeRoots.push({ rootId: item.id, toolCallId: toolMeta.toolCallId });
      continue;
    }

    if (toolMeta.toolCallId) {
      let index = -1;
      for (let i = activeRoots.length - 1; i >= 0; i -= 1) {
        if (activeRoots[i]?.toolCallId === toolMeta.toolCallId) {
          index = i;
          break;
        }
      }
      if (index >= 0) {
        activeRoots.splice(index, 1);
        continue;
      }
    }

    if (activeRoots.length > 0) {
      activeRoots.pop();
    }
  }

  return rows;
}

function countChildrenByRoot(rows: TimelineTreeRow[]) {
  const count: Record<string, number> = {};
  for (const row of rows) {
    if (!row.rootId) {
      continue;
    }
    count[row.rootId] = (count[row.rootId] ?? 0) + 1;
  }
  return count;
}

function readToolMeta(item: TimelineItem): { title: string | null; status: string | null; toolCallId: string | null } | null {
  if (item.kind !== "tool") {
    return null;
  }
  const parsed = tryParseJson(item.body);
  const record = asRecord(parsed);
  const title = typeof record?.title === "string" ? record.title : item.title;
  const status = typeof record?.status === "string" ? record.status : item.meta ?? null;
  const toolCallId = typeof record?.toolCallId === "string" ? record.toolCallId : null;
  return { title, status, toolCallId };
}

function isSubagentToolTitle(title: string | null) {
  const normalized = (title ?? "").toLowerCase();
  return normalized.includes("subagent") || normalized === "task" || normalized.includes(" task");
}

function isTerminalToolStatus(status: string | null) {
  const normalized = (status ?? "").toLowerCase();
  return normalized === "completed" || normalized === "failed" || normalized === "canceled" || normalized === "cancelled";
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

function applyDemoPreset(sessions: SessionRecord[], workspacePath: string, demoPreset: DemoPreset): SessionRecord[] {
  if (demoPreset !== "subagent-tree") {
    return sessions;
  }

  const demoSession: SessionRecord = normalizeSessionRecord({
    clientSessionId: "demo-subagent-tree",
    title: "Demo · SubAgent 树状折叠",
    workspacePath,
    connectionState: "connected",
    sessionId: "demo-session",
    modes: ["default", "plan"],
    defaultModeId: "default",
    currentModeId: "default",
    busy: false,
    timeline: [
      {
        id: "demo-user-1",
        kind: "user",
        title: "你",
        body: "请把仓库结构分析一下，并把复杂任务交给 subagent。",
      },
      {
        id: "demo-tool-task-start",
        kind: "tool",
        title: "Task",
        body: JSON.stringify({ toolCallId: "demo-task-1", title: "Task", status: "running" }, null, 2),
        meta: "running",
      },
      {
        id: "demo-agent-sub-1",
        kind: "agent",
        title: "Claude",
        body: "subagent 正在扫描目录并归类模块边界。",
      },
      {
        id: "demo-tool-sub-search",
        kind: "tool",
        title: "ripgrep",
        body: JSON.stringify({ toolCallId: "demo-rg-1", title: "ripgrep", status: "completed" }, null, 2),
        meta: "completed",
      },
      {
        id: "demo-agent-sub-2",
        kind: "agent",
        title: "Claude",
        body: "subagent 完成了初步分析，准备回传主 agent。",
      },
      {
        id: "demo-tool-task-end",
        kind: "tool",
        title: "Task",
        body: JSON.stringify({ toolCallId: "demo-task-1", title: "Task", status: "completed" }, null, 2),
        meta: "completed",
      },
      {
        id: "demo-agent-main",
        kind: "agent",
        title: "Claude",
        body: "已汇总 subagent 结果：你可以点击 `Task` 行右侧子项按钮折叠/展开内部输出。",
      },
    ],
    historyTotal: 7,
    historyStart: 0,
    permissions: [],
    updatedAt: new Date().toISOString(),
  });

  const rest = sessions.filter((session) => session.clientSessionId !== demoSession.clientSessionId);
  return [demoSession, ...rest];
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

function makeId() {
  const cryptoObject = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof cryptoObject?.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  return `lp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function renderMarkdownBlocks(source: string) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Array<
    | { kind: "heading" | "paragraph" | "list" | "code"; level?: number; lines: string[] }
    | { kind: "table"; headers: string[]; rows: string[][] }
  > = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] = [];
  let inCode = false;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", lines: paragraph });
      paragraph = [];
    }
  };

  const flushList = () => {
    if (list.length > 0) {
      blocks.push({ kind: "list", lines: list });
      list = [];
    }
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      if (inCode) {
        blocks.push({ kind: "code", lines: code });
        code = [];
        inCode = false;
      } else {
        inCode = true;
      }
      index += 1;
      continue;
    }

    if (inCode) {
      code.push(line);
      index += 1;
      continue;
    }

    const nextLine = lines[index + 1] ?? "";
    if (isMarkdownTableRow(line) && isMarkdownTableSeparator(nextLine)) {
      flushParagraph();
      flushList();

      const headers = parseMarkdownTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const rowLine = lines[index] ?? "";
        if (!isMarkdownTableRow(rowLine) || !rowLine.trim()) {
          break;
        }
        rows.push(parseMarkdownTableRow(rowLine));
        index += 1;
      }

      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", level: heading[1].length, lines: [heading[2]] });
      index += 1;
      continue;
    }

    const listMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      list.push(listMatch[1]);
      index += 1;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      index += 1;
      continue;
    }

    flushList();
    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  flushList();
  if (code.length > 0) {
    blocks.push({ kind: "code", lines: code });
  }

  return blocks.map((block, index) => {
    if (block.kind === "heading") {
      const headingContent = renderMarkdownInline(block.lines[0] ?? "");
      switch (Math.min(block.level ?? 3, 6)) {
        case 1:
          return <h1 key={`md-heading-${index}`}>{headingContent}</h1>;
        case 2:
          return <h2 key={`md-heading-${index}`}>{headingContent}</h2>;
        case 3:
          return <h3 key={`md-heading-${index}`}>{headingContent}</h3>;
        case 4:
          return <h4 key={`md-heading-${index}`}>{headingContent}</h4>;
        case 5:
          return <h5 key={`md-heading-${index}`}>{headingContent}</h5>;
        default:
          return <h6 key={`md-heading-${index}`}>{headingContent}</h6>;
      }
    }
    if (block.kind === "list") {
      return (
        <ul key={`md-list-${index}`}>
          {block.lines.map((item, itemIndex) => (
            <li key={`md-list-${index}-${itemIndex}`}>{renderMarkdownInline(item)}</li>
          ))}
        </ul>
      );
    }
    if (block.kind === "code") {
      return (
        <pre key={`md-code-${index}`}>
          <code>{block.lines.join("\n")}</code>
        </pre>
      );
    }
    if (block.kind === "table") {
      return (
        <table key={`md-table-${index}`}>
          <thead>
            <tr>
              {block.headers.map((header, cellIndex) => (
                <th key={`md-table-${index}-h-${cellIndex}`}>{renderMarkdownInline(header)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`md-table-${index}-r-${rowIndex}`}>
                {block.headers.map((_, cellIndex) => (
                  <td key={`md-table-${index}-r-${rowIndex}-c-${cellIndex}`}>
                    {renderMarkdownInline(row[cellIndex] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    return <p key={`md-paragraph-${index}`}>{renderMarkdownInline(block.lines.join(" "))}</p>;
  });
}

function isMarkdownTableRow(line: string) {
  return line.includes("|") && parseMarkdownTableRow(line).length > 0;
}

function isMarkdownTableSeparator(line: string) {
  const cells = parseMarkdownTableRow(line);
  if (cells.length === 0) {
    return false;
  }
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderMarkdownInline(text: string) {
  const parts = text.split(/(\[[^\]]+\]\([^\)]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^\)]+)\)$/);
    if (linkMatch) {
      return (
        <a key={`md-link-${index}`} href={linkMatch[2]} target="_blank" rel="noreferrer">
          {linkMatch[1]}
        </a>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={`md-bold-${index}`}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={`md-italic-${index}`}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={`md-inline-${index}`}>{part.slice(1, -1)}</code>;
    }
    return <Fragment key={`md-text-${index}`}>{part}</Fragment>;
  });
}

function shouldRenderMarkdown(item: TimelineItem) {
  return item.kind === "agent" || item.kind === "plan";
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
        {shouldRenderMarkdown(props.item) ? (
          <div className="modal-body markdown-body">{renderMarkdownBlocks(props.item.body)}</div>
        ) : (
          <pre className="modal-body">{props.item.body}</pre>
        )}
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

function SessionDiffModal(props: {
  sessionTitle: string;
  loading: boolean;
  error: string;
  snapshot: SessionDiffResponse | null;
  fileDiffCache: Record<string, SessionFileDiffResponse>;
  onLoadFileDiff: (category: DiffCategory, filePath: string) => Promise<SessionFileDiffResponse>;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [viewMode, setViewMode] = useState<"flat" | "byFile">("flat");
  const [categoryTab, setCategoryTab] = useState<DiffCategory>("workingTree");
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [selectedFileLoading, setSelectedFileLoading] = useState(false);
  const [selectedFileError, setSelectedFileError] = useState("");

  const currentCategoryFiles = useMemo(() => {
    if (!props.snapshot) {
      return [] as SessionDiffFileEntry[];
    }
    return props.snapshot[categoryTab];
  }, [categoryTab, props.snapshot]);

  useEffect(() => {
    if (currentCategoryFiles.length === 0) {
      setSelectedFilePath("");
      return;
    }
    if (!currentCategoryFiles.some((item) => item.filePath === selectedFilePath)) {
      setSelectedFilePath(currentCategoryFiles[0].filePath);
    }
  }, [currentCategoryFiles, selectedFilePath]);

  useEffect(() => {
    if (viewMode !== "byFile" || !selectedFilePath) {
      return;
    }
    const cacheKey = `${categoryTab}:${selectedFilePath}`;
    if (props.fileDiffCache[cacheKey]) {
      return;
    }

    setSelectedFileLoading(true);
    setSelectedFileError("");
    props.onLoadFileDiff(categoryTab, selectedFilePath)
      .catch((error) => {
        setSelectedFileError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setSelectedFileLoading(false);
      });
  }, [categoryTab, props, selectedFilePath, viewMode]);

  const selectedDiff = selectedFilePath ? props.fileDiffCache[`${categoryTab}:${selectedFilePath}`] : null;

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div className="diff-title-wrap">
            <p className="eyebrow">{props.sessionTitle}</p>
            <h3>
              当前目录累计代码 Diff
              {props.snapshot?.workspaceReadonly ? <span className="readonly-badge">只读目录</span> : null}
            </h3>
            {props.snapshot ? <code className="diff-title-path">{props.snapshot.workspacePath}</code> : null}
            {props.snapshot && props.snapshot.repositoryRoot !== props.snapshot.workspacePath ? (
              <p className="modal-meta">仓库根目录: {props.snapshot.repositoryRoot}</p>
            ) : null}
          </div>
          <div className="modal-actions-inline">
            <button className="secondary modal-btn-refresh" onClick={props.onRefresh} disabled={props.loading}>
              刷新
            </button>
            <button className="secondary modal-btn-close" onClick={props.onClose}>
              关闭
            </button>
          </div>
        </div>
        {props.loading ? <p className="modal-meta">正在读取 Git Diff...</p> : null}
        {props.error ? <p className="modal-meta">{props.error}</p> : null}
        {props.snapshot ? (
          <div className="modal-body markdown-body">
            <div className="diff-toolbar-tabs" role="tablist" aria-label="Diff 查看模式">
              <button className={`diff-tab ${viewMode === "flat" ? "active" : ""}`} onClick={() => setViewMode("flat")} role="tab" aria-selected={viewMode === "flat"} type="button">平铺查看</button>
              <button className={`diff-tab ${viewMode === "byFile" ? "active" : ""}`} onClick={() => setViewMode("byFile")} role="tab" aria-selected={viewMode === "byFile"} type="button">按文件查看</button>
              {viewMode === "byFile" ? (
                <select value={selectedFilePath} onChange={(event) => setSelectedFilePath(event.target.value)}>
                  {currentCategoryFiles.length === 0 ? <option value="">当前没有文件变更</option> : null}
                  {currentCategoryFiles.map((item) => (
                    <option key={item.filePath} value={item.filePath}>[{item.changeType}] {item.filePath}</option>
                  ))}
                </select>
              ) : null}
            </div>

            <div className="diff-toolbar-tabs" role="tablist" aria-label="Diff 分类">
              <button className={`diff-tab ${categoryTab === "workingTree" ? "active" : ""}`} onClick={() => setCategoryTab("workingTree")} role="tab" aria-selected={categoryTab === "workingTree"} type="button">未暂存修改 ({props.snapshot.workingTree.length})</button>
              <button className={`diff-tab ${categoryTab === "staged" ? "active" : ""}`} onClick={() => setCategoryTab("staged")} role="tab" aria-selected={categoryTab === "staged"} type="button">已暂存修改 ({props.snapshot.staged.length})</button>
              <button className={`diff-tab ${categoryTab === "untracked" ? "active" : ""}`} onClick={() => setCategoryTab("untracked")} role="tab" aria-selected={categoryTab === "untracked"} type="button">未跟踪文件 ({props.snapshot.untracked.length})</button>
            </div>

            {viewMode === "flat" ? (
              <>
                <h4>{categoryLabel(categoryTab)}</h4>
                {currentCategoryFiles.length === 0 ? (
                  <p>(空)</p>
                ) : (
                  currentCategoryFiles.map((item) => (
                    <p key={`${categoryTab}:${item.filePath}`}>
                      <code>[{item.changeType}] {item.filePath}</code>
                    </p>
                  ))
                )}
                <p className="modal-meta">按文件查看模式会按需加载单个文件 Diff，避免一次性读取整个仓库差异。</p>
              </>
            ) : (
              <>
                <h4>文件 Diff</h4>
                {!selectedFilePath ? <p>(空)</p> : null}
                {selectedFileLoading ? <p>正在加载文件 Diff...</p> : null}
                {selectedFileError ? <p className="modal-meta">{selectedFileError}</p> : null}
                {selectedDiff?.omitted ? <p className="modal-meta">{selectedDiff.reason ?? "该文件 Diff 过大，已省略显示。"}</p> : null}
                {selectedDiff && !selectedDiff.omitted ? <DiffBlock diff={selectedDiff.diff} /> : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function categoryLabel(category: DiffCategory) {
  if (category === "workingTree") {
    return "未暂存修改 (working tree)";
  }
  if (category === "staged") {
    return "已暂存修改 (staged)";
  }
  return "未跟踪文件";
}

function DiffBlock(props: { diff: string }) {
  const trimmed = props.diff.trim();
  if (!trimmed) {
    return <p>(空)</p>;
  }

  const lines = props.diff.replace(/\r\n/g, "\n").split("\n");
  return (
    <pre className="diff-block">
      <code>
        {lines.map((line, index) => (
          <span key={`${index}-${line}`} className={`diff-line ${classNameForDiffLine(line)}`}>
            {line || " "}
          </span>
        ))}
      </code>
    </pre>
  );
}

function classNameForDiffLine(line: string) {
  if (line.startsWith("+++ ") || line.startsWith("--- ")) {
    return "diff-line-file";
  }
  if (line.startsWith("@@ ")) {
    return "diff-line-hunk";
  }
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("new file mode") || line.startsWith("deleted file mode")) {
    return "diff-line-header";
  }
  if (line.startsWith("+")) {
    return "diff-line-add";
  }
  if (line.startsWith("-")) {
    return "diff-line-remove";
  }
  return "";
}

export const appTestables = {
  summarizeToolTitle,
  formatToolDetails,
  formatToolBody,
  asRecord,
  extractPlanText,
  stringifyMaybe,
  labelForMode,
  toneForConnectionState,
  canNavigateUp,
  parentDirectory,
  isWithinRoot,
  normalizePath,
  toSingleLine,
  toPreviewText,
  normalizeTimelineItem,
  extractPlanPreview,
  extractChunkText,
  tryParseJson,
  buildTimelineTreeRows,
  countChildrenByRoot,
  isSubagentToolTitle,
  applyDemoPreset,
  shouldUseExpandedPreview,
  shouldRenderMarkdown,
  parseMarkdownTableRow,
  isMarkdownTableSeparator,
  isMarkdownTableRow,
};
