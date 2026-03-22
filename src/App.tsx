import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  Fragment,
} from "react";

type ActivityState = "running" | "completed" | "pending" | "idle";
type ConnectionState = "connecting" | "connected" | "closed";
type SessionEngine = "cli" | "acp";
type MobileTerminalActionKey =
  | "shiftTab"
  | "backspace"
  | "tab"
  | "escape"
  | "arrowUp"
  | "arrowDown"
  | "arrowLeft"
  | "arrowRight"
  | "ctrlC";
type MobileTerminalEnvironment = {
  viewportWidth: number;
  coarsePointer: boolean;
  touchPoints: number;
};
type MobileTerminalSurface = "cli" | "shell";

type SessionRecord = {
  clientSessionId: string;
  title: string;
  workspacePath: string;
  connectionState: "connecting" | "connected" | "error";
  activityState?: ActivityState;
  sessionId: string;
  engine: SessionEngine;
  switchable?: boolean;
  switchBlockedReason?: string;
  updatedAt: string;
  allowSkipPermissions?: boolean;
  acp?: {
    modes: string[];
    defaultModeId: string;
    currentModeId: string;
    busy: boolean;
    timeline: TimelineItem[];
    historyTotal: number;
    historyStart: number;
    permissions: PermissionPayload[];
    questions: QuestionPayload[];
    availableCommands: AvailableCommand[];
    lastContentEventAt?: number;
    completedAt?: number;
  };
};

type AppConfig = {
  appName: string;
  workspacePath: string;
  allowedRoots: string[];
  sshHost: string;
  sshPath: string;
  vscodeRemoteUri: string;
  enableShell: boolean;
  launchMode: string;
  launchHost: string;
  launchUser: string;
  allowSkipPermissions?: boolean;
  availableSessionEngines?: SessionEngine[];
  defaultSessionEngine?: SessionEngine;
};

type AvailableCommand = {
  name: string;
  description: string;
  inputType: "unstructured";
};

type TimelineItem = {
  id: string;
  kind: "system" | "user" | "agent" | "thought" | "tool" | "plan" | "error";
  title: string;
  body: string;
  meta?: string;
  images?: Array<{ data: string; mimeType: string }>;
  parentToolCallId?: string;
};

type TimelineTreeRow = {
  item: TimelineItem;
  depth: number;
  rootId: string | null;
  displayTitle?: string;
};

type ExecutionPlanStepStatus = "completed" | "in_progress" | "pending" | "unknown";

type ExecutionPlanStep = {
  content: string;
  status: ExecutionPlanStepStatus;
};

type PermissionPayload = {
  clientSessionId: string;
  requestId: string;
  toolCall: { toolCallId: string; title?: string; status?: string; rawInput?: unknown };
  options: Array<{ optionId: string; name: string; kind: string }>;
};

type QuestionPayload = {
  clientSessionId: string;
  questionId: string;
  groupId?: string;
  question: string;
  header?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  allowCustomAnswer: boolean;
};

type SessionDiffFileEntry = { filePath: string; changeType: string };

type SessionDiffResponse = {
  workspacePath: string;
  workspaceReadonly: boolean;
  repositoryRoot: string;
  workingTree: SessionDiffFileEntry[];
  staged: SessionDiffFileEntry[];
  untracked: SessionDiffFileEntry[];
};

type DiffCategory = "workingTree" | "staged" | "untracked";

type SessionFileDiffResponse = {
  category: string;
  filePath: string;
  omitted: boolean;
  diff: string;
  reason?: string;
};

type VscodeLaunchConfig = {
  mode: "remote" | "local";
  sshHost: string;
};

type ToastNotification = {
  id: string;
  kind: "info" | "warning" | "error";
  title: string;
  body: string;
  sessionId?: string;
};

type EventMessage =
  | { type: "ready"; payload: { sessions: SessionRecord[] } }
  | { type: "session_registered"; payload: SessionRecord }
  | { type: "session_updated"; payload: SessionRecord }
  | { type: "session_closed"; payload: { clientSessionId: string } }
  | { type: "prompt_started"; payload: { clientSessionId: string; promptId: string; text: string } }
  | { type: "prompt_finished"; payload: { clientSessionId: string; promptId: string; stopReason: string } }
  | { type: "session_update"; payload: { clientSessionId: string; sessionUpdate: string; [key: string]: unknown } }
  | { type: "session_mode_changed"; payload: { clientSessionId: string; defaultModeId: string; currentModeId: string } }
  | { type: "permission_requested"; payload: PermissionPayload }
  | { type: "permission_resolved"; payload: { clientSessionId: string; requestId: string; optionId: string } }
  | { type: "question_requested"; payload: QuestionPayload }
  | { type: "question_answered"; payload: { clientSessionId: string; questionId: string; answer: string } }
  | { type: "cli_output"; payload: { clientSessionId: string; data: string } }
  | { type: "cli_exited"; payload: { clientSessionId: string; exitCode: number } }
  | { type: "session_activity"; payload: { clientSessionId: string; activityState: ActivityState } }
  | { type: "session_id_updated"; payload: { clientSessionId: string; newSessionId: string } }
  | { type: "shell_output"; payload: { clientSessionId: string; data: string } }
  | { type: "shell_exited"; payload: { clientSessionId: string; exitCode: number } }
  | { type: "error"; payload: { message: string; fatal: boolean; clientSessionId?: string } };

type CachedShellTerminal = {
  clientSessionId: string;
  terminal: unknown;
  fitAddon: unknown;
  wrapper: HTMLDivElement;
  resizeObserver: ResizeObserver;
  touchCleanup: () => void;
  blurReadonlyHandler: () => void;
  alive: boolean;
};

type PendingImage = {
  id: string;
  dataUrl: string;
  data: string;
  mimeType: string;
};

const VSCODE_LAUNCH_CONFIG_STORAGE_KEY = "leduo_vscode_launch_config";
const SESSION_ENGINE_STORAGE_KEY = "leduo_session_engine";
const WORKSPACE_SUGGESTION_INITIAL_LIMIT = 6;
const MOBILE_TERMINAL_BREAKPOINT = 960;
const MOBILE_TERMINAL_FONT_SIZE = 12;
const DEFAULT_TERMINAL_FONT_SIZE = 13;
const MOBILE_TERMINAL_ACTIONS: Array<{ key: MobileTerminalActionKey; label: string; accent?: boolean }> = [
  { key: "escape", label: "Esc" },
  { key: "backspace", label: "Backspace" },
  { key: "tab", label: "Tab" },
  { key: "shiftTab", label: "Shift+Tab" },
  { key: "arrowUp", label: "↑" },
  { key: "arrowDown", label: "↓" },
  { key: "arrowLeft", label: "←" },
  { key: "arrowRight", label: "→" },
];

function withAccessKey(path: string, accessKey: string) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}key=${encodeURIComponent(accessKey)}`;
}

function getAccessKeyFromSearch(search: string) {
  const urlParams = new URLSearchParams(search);
  return urlParams.get("key") ?? "";
}

function getAccessKeyFromUrl() {
  return getAccessKeyFromSearch(window.location.search);
}

function buildLocationWithAccessKey(href: string, accessKey: string) {
  const url = new URL(href, "http://localhost");
  const normalizedAccessKey = accessKey.trim();
  if (normalizedAccessKey) {
    url.searchParams.set("key", normalizedAccessKey);
  } else {
    url.searchParams.delete("key");
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function syncAccessKeyToUrl(accessKey: string) {
  window.history.replaceState(null, "", buildLocationWithAccessKey(window.location.href, accessKey));
}

function loadVscodeLaunchConfig(sshHost: string): VscodeLaunchConfig {
  try {
    const raw = localStorage.getItem(VSCODE_LAUNCH_CONFIG_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as VscodeLaunchConfig;
      if (parsed.mode === "remote" || parsed.mode === "local") {
        return parsed;
      }
    }
  } catch {
    /* ignore */
  }
  return { mode: sshHost ? "remote" : "local", sshHost: sshHost || "" };
}

function loadPreferredSessionEngine(fallback: SessionEngine = "cli"): SessionEngine {
  try {
    const raw = localStorage.getItem(SESSION_ENGINE_STORAGE_KEY);
    if (raw === "cli" || raw === "acp") {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function savePreferredSessionEngine(engine: SessionEngine) {
  try {
    localStorage.setItem(SESSION_ENGINE_STORAGE_KEY, engine);
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [accessKey, setAccessKey] = useState(() => getAccessKeyFromUrl());
  const [accessKeyInput, setAccessKeyInput] = useState(() => getAccessKeyFromUrl());
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const [mobileTerminalDraft, setMobileTerminalDraft] = useState("");
  const [mobileTerminalInputDetected, setMobileTerminalInputDetected] = useState(false);
  const [mobileTerminalInputDismissed, setMobileTerminalInputDismissed] = useState(false);
  const [mobileTerminalSurface, setMobileTerminalSurface] = useState<MobileTerminalSurface>("cli");
  const [mobileTerminalKeyboardInset, setMobileTerminalKeyboardInset] = useState(0);
  const [mobileTerminalViewportHeight, setMobileTerminalViewportHeight] = useState<number | null>(null);
  const [mobileTerminalViewportOffsetTop, setMobileTerminalViewportOffsetTop] = useState(0);

  // Create session modal
  const [createSessionModalOpen, setCreateSessionModalOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const [newSessionEngine, setNewSessionEngine] = useState<SessionEngine>(() => loadPreferredSessionEngine("cli"));
  const [allowSkipPermissions, setAllowSkipPermissions] = useState(false);
  const [directoryBrowserPath, setDirectoryBrowserPath] = useState("");
  const [directoryOptions, setDirectoryOptions] = useState<Array<{ name: string; path: string }>>([]);
  const [directoryError, setDirectoryError] = useState("");
  const [showAllWorkspaceSuggestions, setShowAllWorkspaceSuggestions] = useState(false);
  const [acpComposer, setAcpComposer] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [permissionDetail, setPermissionDetail] = useState<PermissionPayload | null>(null);
  const [selectedTimelineItem, setSelectedTimelineItem] = useState<{ sessionTitle: string; item: TimelineItem } | null>(null);

  // VSCode
  const [vscodeLaunchConfig, setVscodeLaunchConfig] = useState<VscodeLaunchConfig>({ mode: "local", sshHost: "" });
  const [vscodeSettingsOpen, setVscodeSettingsOpen] = useState(false);
  const [vscodeLaunchError, setVscodeLaunchError] = useState("");
  const [vscodeLaunchNotice, setVscodeLaunchNotice] = useState("");

  // Diff modal
  const [sessionDiffOpen, setSessionDiffOpen] = useState(false);
  const [sessionDiffLoading, setSessionDiffLoading] = useState(false);
  const [sessionDiffError, setSessionDiffError] = useState("");
  const [sessionDiff, setSessionDiff] = useState<SessionDiffResponse | null>(null);

  // Close session confirmation
  const [sessionToClose, setSessionToClose] = useState<string | null>(null);
  const [sessionFileDiffCache, setSessionFileDiffCache] = useState<Record<string, SessionFileDiffResponse>>({});

  // Bottom shell drawer
  const [terminalOpen, setTerminalOpen] = useState(false);
  const desktopTerminalContainerRef = useRef<HTMLDivElement | null>(null);
  const mobileTerminalContainerRef = useRef<HTMLDivElement | null>(null);
  const shellTerminalsRef = useRef<Map<string, CachedShellTerminal>>(new Map());

  // Main CLI terminal
  const cliTerminalContainerRef = useRef<HTMLDivElement | null>(null);
  const cliTerminalsRef = useRef<Map<string, { terminal: unknown; fitAddon: unknown; element: HTMLDivElement }>>(new Map());

  const socketRef = useRef<WebSocket | null>(null);
  const pendingPromptImagesRef = useRef<Map<string, Array<{ data: string; mimeType: string }>>>(new Map());

  const activeSession = useMemo(
    () => sessions.find((s) => s.clientSessionId === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const mobileTerminalFullscreenVisible =
    mobileTerminalInputDetected && Boolean(activeSession) && activeSession?.engine === "cli";
  const mobileTerminalInputDisabled = shouldDisableMobileTerminalInput(
    activeSessionId,
    connectionState,
    activeSession?.connectionState,
  );
  const shellPanelVisible = Boolean(
    config?.enableShell && (mobileTerminalFullscreenVisible || terminalOpen),
  );
  const mobileTerminalInputVisible = mobileTerminalInputDetected && !mobileTerminalInputDismissed && Boolean(activeSession);
  const shouldRenderMainContentPanel = !mobileTerminalInputDetected || activeSession?.engine === "acp";
  const shellClassName = [
    "shell",
    config?.enableShell && terminalOpen && !mobileTerminalFullscreenVisible ? "shell-has-terminal-drawer" : "",
  ].filter(Boolean).join(" ");
  const mobileTerminalFullscreenStyle = useMemo(
    () =>
      ({
        top: mobileTerminalViewportOffsetTop ? `${mobileTerminalViewportOffsetTop}px` : undefined,
        height: mobileTerminalViewportHeight != null ? `${mobileTerminalViewportHeight}px` : undefined,
      }) as CSSProperties,
    [mobileTerminalViewportHeight, mobileTerminalViewportOffsetTop],
  );

  // --- Derived workspace creation state ---
  const createWorkspaceRoot = useMemo(() => {
    if (!config) return "";
    return splitWorkspacePathByAllowedRoots(config.workspacePath, config.allowedRoots).root;
  }, [config]);

  const [createWorkspaceSuffix, setCreateWorkspaceSuffix] = useState("");

  const workspaceSuffixSuggestions = useMemo(() => {
    if (!createWorkspaceRoot || directoryOptions.length === 0) return [];
    return directoryOptions
      .map((d) => relativePathFromRoot(createWorkspaceRoot, d.path))
      .filter(Boolean);
  }, [createWorkspaceRoot, directoryOptions]);

  const visibleWorkspaceSuffixSuggestions = showAllWorkspaceSuggestions
    ? workspaceSuffixSuggestions
    : workspaceSuffixSuggestions.slice(0, WORKSPACE_SUGGESTION_INITIAL_LIMIT);
  const hasMoreWorkspaceSuggestions = workspaceSuffixSuggestions.length > WORKSPACE_SUGGESTION_INITIAL_LIMIT;

  const workspaceForLaunch = activeSession?.workspacePath ?? config?.workspacePath ?? "";
  const canOpenWorkspaceInVscode = Boolean(workspaceForLaunch);

  useEffect(() => {
    function handlePopstate() {
      const nextAccessKey = getAccessKeyFromUrl();
      setAccessKey(nextAccessKey);
      setAccessKeyInput(nextAccessKey);
    }

    window.addEventListener("popstate", handlePopstate);
    return () => {
      window.removeEventListener("popstate", handlePopstate);
    };
  }, []);

  // --- Fetch config ---
  useEffect(() => {
    if (!accessKey) return;
    fetch(withAccessKey("/api/config", accessKey))
      .then((res) => res.json())
      .then((data: AppConfig) => {
        setConfig(data);
        setVscodeLaunchConfig(loadVscodeLaunchConfig(data.sshHost));
        const split = splitWorkspacePathByAllowedRoots(data.workspacePath, data.allowedRoots);
        setWorkspacePath(data.workspacePath);
        setDirectoryBrowserPath(split.root);
        setCreateWorkspaceSuffix(split.suffix);
        setAllowSkipPermissions(data.allowSkipPermissions ?? false);
        setNewSessionEngine(loadPreferredSessionEngine(data.defaultSessionEngine ?? "cli"));
      })
      .catch(() => undefined);
  }, [accessKey]);

  // --- Fetch directories for workspace browser ---
  useEffect(() => {
    if (!accessKey || !directoryBrowserPath) return;
    fetch(withAccessKey(`/api/directories?root=${encodeURIComponent(directoryBrowserPath)}`, accessKey))
      .then((res) => res.json())
      .then((data: { rootPath: string; directories: Array<{ name: string; path: string }> }) => {
        setDirectoryOptions(data.directories);
        setDirectoryError("");
      })
      .catch((error) => {
        setDirectoryError(error instanceof Error ? error.message : String(error));
      });
  }, [accessKey, directoryBrowserPath]);

  useEffect(() => {
    const updateMobileTerminalCapability = () => {
      const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
      const touchPoints = navigator.maxTouchPoints ?? 0;
      setMobileTerminalInputDetected(
        shouldEnableMobileTerminalInput({
          viewportWidth: window.innerWidth,
          coarsePointer,
          touchPoints,
        }),
      );
    };

    updateMobileTerminalCapability();
    window.addEventListener("resize", updateMobileTerminalCapability);
    window.addEventListener("orientationchange", updateMobileTerminalCapability);
    return () => {
      window.removeEventListener("resize", updateMobileTerminalCapability);
      window.removeEventListener("orientationchange", updateMobileTerminalCapability);
    };
  }, []);

  useEffect(() => {
    if (!mobileTerminalInputDetected) {
      setMobileTerminalInputDismissed(false);
      setMobileTerminalKeyboardInset(0);
      setMobileTerminalViewportHeight(null);
      setMobileTerminalViewportOffsetTop(0);
    }
  }, [mobileTerminalInputDetected]);

  useEffect(() => {
    setMobileTerminalDraft("");
    setMobileTerminalSurface("cli");
    setAcpComposer("");
    setPendingImages([]);
    if (mobileTerminalInputDetected && activeSessionId) {
      setMobileTerminalInputDismissed(false);
    }
  }, [activeSessionId, mobileTerminalInputDetected]);

  useEffect(() => {
    if (!mobileTerminalFullscreenVisible) {
      setMobileTerminalKeyboardInset(0);
      setMobileTerminalViewportHeight(null);
      setMobileTerminalViewportOffsetTop(0);
      return;
    }

    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return;
    }

    const updateViewportInset = () => {
      const nextInset = Math.max(0, window.innerHeight - visualViewport.height - visualViewport.offsetTop);
      setMobileTerminalKeyboardInset(nextInset);
      if (mobileTerminalFullscreenVisible) {
        setMobileTerminalViewportHeight(visualViewport.height);
        setMobileTerminalViewportOffsetTop(visualViewport.offsetTop);
      }
    };

    updateViewportInset();
    visualViewport.addEventListener("resize", updateViewportInset);
    visualViewport.addEventListener("scroll", updateViewportInset);
    window.addEventListener("orientationchange", updateViewportInset);
    return () => {
      visualViewport.removeEventListener("resize", updateViewportInset);
      visualViewport.removeEventListener("scroll", updateViewportInset);
      window.removeEventListener("orientationchange", updateViewportInset);
    };
  }, [mobileTerminalFullscreenVisible]);

  useEffect(() => {
    if (!mobileTerminalFullscreenVisible) {
      return;
    }

    const scrollY = window.scrollY;
    const body = document.body;
    const documentElement = document.documentElement;
    const previousBodyPosition = body.style.position;
    const previousBodyTop = body.style.top;
    const previousBodyLeft = body.style.left;
    const previousBodyRight = body.style.right;
    const previousBodyWidth = body.style.width;
    const previousBodyOverflow = body.style.overflow;
    const previousHtmlOverflow = documentElement.style.overflow;
    const previousHtmlOverscrollBehavior = documentElement.style.overscrollBehavior;

    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    body.style.overflow = "hidden";
    documentElement.style.overflow = "hidden";
    documentElement.style.overscrollBehavior = "none";

    return () => {
      body.style.position = previousBodyPosition;
      body.style.top = previousBodyTop;
      body.style.left = previousBodyLeft;
      body.style.right = previousBodyRight;
      body.style.width = previousBodyWidth;
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousHtmlOverflow;
      documentElement.style.overscrollBehavior = previousHtmlOverscrollBehavior;
      window.scrollTo(0, scrollY);
    };
  }, [mobileTerminalFullscreenVisible]);

  // --- WebSocket connection ---
  useEffect(() => {
    if (!accessKey) return;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}${withAccessKey("/ws", accessKey)}`);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnectionState("connected");
      socket.send(JSON.stringify({ type: "hello" }));
    });

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as EventMessage;
        handleEvent(message);
      } catch {
        /* ignore malformed messages */
      }
    });

    socket.addEventListener("close", () => {
      setConnectionState("closed");
    });

    socket.addEventListener("error", () => {
      setConnectionState("closed");
    });

    return () => {
      socketRef.current = null;
      socket.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessKey]);

  function resetCachedCliTerminal(clientSessionId: string) {
    const cached = cliTerminalsRef.current.get(clientSessionId);
    if (!cached) {
      return;
    }
    const terminal = cached.terminal as { reset?: () => void; clear?: () => void };
    if (typeof terminal.reset === "function") {
      terminal.reset();
      return;
    }
    terminal.clear?.();
  }

  function handleEvent(message: EventMessage) {
    switch (message.type) {
      case "ready":
        setSessions(message.payload.sessions.map(normalizeSessionRecord));
        if (
          message.payload.sessions.length > 0
          && !activeSessionId
          && !shouldEnableMobileTerminalInput({
            viewportWidth: window.innerWidth,
            coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
            touchPoints: navigator.maxTouchPoints ?? 0,
          })
        ) {
          setActiveSessionId(message.payload.sessions[0].clientSessionId);
        }
        break;

      case "session_registered":
      case "session_updated": {
        const nextSession = normalizeSessionRecord(message.payload);
        setSessions((prev) => {
          const previousSession = prev.find((s) => s.clientSessionId === nextSession.clientSessionId);
          if (
            previousSession
            && previousSession.engine === "acp"
            && nextSession.engine === "cli"
          ) {
            resetCachedCliTerminal(nextSession.clientSessionId);
          }
          const exists = Boolean(previousSession);
          if (exists) {
            return prev.map((s) =>
              s.clientSessionId === nextSession.clientSessionId
                ? nextSession
                : s,
            );
          }
          return [...prev, nextSession];
        });
        if (message.type === "session_registered") {
          setActiveSessionId(nextSession.clientSessionId);
        }
        break;
      }

      case "session_closed":
        setSessions((prev) => prev.filter((s) => s.clientSessionId !== message.payload.clientSessionId));
        setActiveSessionId((prev) =>
          prev === message.payload.clientSessionId ? null : prev,
        );
        break;

      case "cli_output": {
        const cached = cliTerminalsRef.current.get(message.payload.clientSessionId);
        if (cached) {
          (cached.terminal as { write: (data: string) => void }).write(message.payload.data);
        }
        // Update connectionState to connected when we receive output
        setSessions((prev) =>
          prev.map((s) =>
            s.clientSessionId === message.payload.clientSessionId && s.connectionState !== "connected"
              ? { ...s, connectionState: "connected", updatedAt: new Date().toISOString() }
              : s,
          ),
        );
        break;
      }

      case "cli_exited":
        setSessions((prev) =>
          prev.map((s) =>
            s.clientSessionId === message.payload.clientSessionId
              ? { ...s, connectionState: "error", updatedAt: new Date().toISOString() }
              : s,
          ),
        );
        addToast("warning", "CLI 已退出", `退出码: ${message.payload.exitCode}`, message.payload.clientSessionId);
        break;

      case "session_activity":
        setSessions((prev) =>
          prev.map((s) =>
            s.clientSessionId === message.payload.clientSessionId
              ? normalizeSessionRecord({ ...s, activityState: message.payload.activityState })
              : s,
          ),
        );
        break;

      case "session_id_updated":
        setSessions((prev) =>
          prev.map((s) =>
            s.clientSessionId === message.payload.clientSessionId
              ? normalizeSessionRecord({ ...s, sessionId: message.payload.newSessionId })
              : s,
          ),
        );
        break;

      case "prompt_started":
        setSessions((prev) =>
          prev.map((session) =>
            session.clientSessionId === message.payload.clientSessionId
              ? applyAcpPromptStarted(
                  session,
                  message.payload,
                  pendingPromptImagesRef.current.get(message.payload.clientSessionId),
                )
              : session,
          ),
        );
        pendingPromptImagesRef.current.delete(message.payload.clientSessionId);
        break;

      case "prompt_finished":
        setSessions((prev) =>
          prev.map((session) =>
            session.clientSessionId === message.payload.clientSessionId
              ? applyAcpPromptFinished(session, message.payload)
              : session,
          ),
        );
        break;

      case "session_update":
        setSessions((prev) =>
          prev.map((session) =>
            session.clientSessionId === message.payload.clientSessionId
              ? applyAcpSessionUpdate(session, message.payload)
              : session,
          ),
        );
        break;

      case "session_mode_changed":
        setSessions((prev) =>
          prev.map((session) =>
            session.clientSessionId === message.payload.clientSessionId
              ? normalizeSessionRecord({
                  ...session,
                  acp: session.acp
                    ? {
                        ...session.acp,
                        defaultModeId: message.payload.defaultModeId,
                        currentModeId: message.payload.currentModeId,
                      }
                    : session.acp,
                })
              : session,
          ),
        );
        break;

      case "permission_requested":
        setSessions((prev) =>
          prev.map((session) =>
            session.clientSessionId === message.payload.clientSessionId
              ? applyAcpPermissionRequested(session, message.payload)
              : session,
          ),
        );
        break;

      case "permission_resolved":
        setSessions((prev) =>
          prev.map((session) =>
            session.clientSessionId === message.payload.clientSessionId
              ? applyAcpPermissionResolved(session, message.payload)
              : session,
          ),
        );
        break;

      case "question_requested":
        setSessions((prev) =>
          prev.map((session) =>
            session.clientSessionId === message.payload.clientSessionId
              ? applyAcpQuestionRequested(session, message.payload)
              : session,
          ),
        );
        break;

      case "question_answered":
        setSessions((prev) =>
          prev.map((session) =>
            session.clientSessionId === message.payload.clientSessionId
              ? applyAcpQuestionAnswered(session, message.payload)
              : session,
          ),
        );
        break;

      case "shell_output": {
        const cached = shellTerminalsRef.current.get(message.payload.clientSessionId);
        if (cached) {
          (cached.terminal as { write: (data: string) => void }).write(message.payload.data);
        }
        break;
      }

      case "shell_exited": {
        const cached = shellTerminalsRef.current.get(message.payload.clientSessionId);
        if (cached) {
          cached.alive = false;
          (cached.terminal as { write: (data: string) => void }).write(
            `\r\n[Shell exited with code ${message.payload.exitCode}]\r\n`,
          );
        }
        break;
      }

      case "error":
        if (message.payload.clientSessionId) {
          setSessions((prev) =>
            prev.map((s) =>
              s.clientSessionId === message.payload.clientSessionId
                ? applyAcpError(s, message.payload)
                : s,
            ),
          );
        }
        addToast("error", "错误", message.payload.message, message.payload.clientSessionId);
        break;
    }
  }

  function sendCommand(command: unknown) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(command));
    return true;
  }

  function addToast(kind: ToastNotification["kind"], title: string, body: string, sessionId?: string) {
    const id = makeId();
    setToasts((prev) => [...prev.slice(-9), { id, kind, title, body, sessionId }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 8000);
  }

  function sendCliInput(data: string) {
    if (!activeSessionId || !data) {
      return false;
    }

    return sendCommand({
      type: "cli_input",
      payload: { clientSessionId: activeSessionId, data },
    });
  }

  function sendShellInput(data: string) {
    if (!activeSessionId || !data) {
      return false;
    }

    return sendCommand({
      type: "shell_input",
      payload: { clientSessionId: activeSessionId, data },
    });
  }

  function commitMobileTerminalDraft(submit: boolean) {
    if (mobileTerminalInputDisabled) {
      return;
    }

    const payload = buildMobileTerminalDraftPayload(mobileTerminalDraft, submit);
    if (!payload) {
      return;
    }

    const didSend = mobileTerminalSurface === "shell"
      ? sendShellInput(payload)
      : sendCliInput(payload);
    if (didSend) {
      setMobileTerminalDraft("");
    }
  }

  function sendMobileTerminalDraft() {
    commitMobileTerminalDraft(true);
  }

  function typeMobileTerminalDraft() {
    commitMobileTerminalDraft(false);
  }

  function sendMobileTerminalAction(key: MobileTerminalActionKey) {
    if (mobileTerminalInputDisabled) {
      return;
    }

    const sequence = mapMobileTerminalActionToSequence(key);
    if (mobileTerminalSurface === "shell") {
      sendShellInput(sequence);
      return;
    }
    sendCliInput(sequence);
  }

  function toggleMobileTerminalInput() {
    if (!mobileTerminalInputDetected) {
      return;
    }

    setMobileTerminalInputDismissed((current) => !current);
  }

  function toggleTerminalPanel() {
    if (!config?.enableShell) {
      return;
    }
    setTerminalOpen((current) => !current);
  }

  function toggleMobileTerminalSurface() {
    if (!config?.enableShell) {
      return;
    }
    setMobileTerminalSurface((current) => (current === "cli" ? "shell" : "cli"));
  }

  function disposeShellTerminal(clientSessionId: string) {
    const cached = shellTerminalsRef.current.get(clientSessionId);
    if (!cached) {
      return;
    }

    cached.resizeObserver.disconnect();
    cached.touchCleanup();
    cached.wrapper.removeEventListener("focusin", cached.blurReadonlyHandler, true);
    cached.wrapper.removeEventListener("touchend", cached.blurReadonlyHandler, true);
    sendCommand({ type: "shell_stop", payload: { clientSessionId } });
    (cached.terminal as { dispose: () => void }).dispose();
    shellTerminalsRef.current.delete(clientSessionId);
  }

  function disposeAllShellTerminals() {
    for (const clientSessionId of Array.from(shellTerminalsRef.current.keys())) {
      disposeShellTerminal(clientSessionId);
    }
  }

  function dismissToast(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  function syncTerminalMobileReadonly(wrapper: HTMLDivElement) {
    wrapper.dataset.mobileReadonly = mobileTerminalInputDetected ? "true" : "false";

    const helper = wrapper.querySelector(".xterm-helper-textarea");
    if (!(helper instanceof HTMLTextAreaElement)) {
      return;
    }

    helper.readOnly = mobileTerminalInputDetected;
    helper.tabIndex = mobileTerminalInputDetected ? -1 : 0;
    helper.inputMode = mobileTerminalInputDetected ? "none" : "text";

    if (mobileTerminalInputDetected) {
      requestAnimationFrame(() => {
        helper.blur();
      });
    }
  }

  function setupTerminalTouchScroll(wrapper: HTMLDivElement) {
    const viewport = wrapper.querySelector(".xterm-viewport");
    if (!(viewport instanceof HTMLElement)) {
      return () => undefined;
    }

    const touchState = {
      active: false,
      startY: 0,
      startScrollTop: 0,
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (wrapper.dataset.mobileReadonly !== "true" || event.touches.length !== 1) {
        touchState.active = false;
        return;
      }

      const touch = event.touches[0];
      touchState.active = true;
      touchState.startY = touch.clientY;
      touchState.startScrollTop = viewport.scrollTop;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!touchState.active || wrapper.dataset.mobileReadonly !== "true" || event.touches.length !== 1) {
        return;
      }

      const touch = event.touches[0];
      const deltaY = touch.clientY - touchState.startY;
      viewport.scrollTop = touchState.startScrollTop - deltaY;
      event.preventDefault();
    };

    const handleTouchEnd = () => {
      touchState.active = false;
    };

    wrapper.addEventListener("touchstart", handleTouchStart, { passive: true, capture: true });
    wrapper.addEventListener("touchmove", handleTouchMove, { passive: false, capture: true });
    wrapper.addEventListener("touchend", handleTouchEnd, { capture: true });
    wrapper.addEventListener("touchcancel", handleTouchEnd, { capture: true });

    return () => {
      wrapper.removeEventListener("touchstart", handleTouchStart, { capture: true } as EventListenerOptions);
      wrapper.removeEventListener("touchmove", handleTouchMove, { capture: true } as EventListenerOptions);
      wrapper.removeEventListener("touchend", handleTouchEnd, { capture: true } as EventListenerOptions);
      wrapper.removeEventListener("touchcancel", handleTouchEnd, { capture: true } as EventListenerOptions);
    };
  }

  function refitActiveCliTerminal(forceBottom = false) {
    if (!activeSessionId) {
      return;
    }

    const cached = cliTerminalsRef.current.get(activeSessionId);
    if (!cached) {
      return;
    }

    const fit = cached.fitAddon as { fit: () => void };
    const term = cached.terminal as {
      cols: number;
      rows: number;
      refresh: (start: number, end: number) => void;
      scrollToBottom?: () => void;
    };
    const viewport = cached.element.querySelector(".xterm-viewport");
    const keepBottomPinned = viewport instanceof HTMLElement
      ? viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 32
      : false;

    if (forceBottom && viewport instanceof HTMLElement) {
      viewport.scrollTop = viewport.scrollHeight;
    }

    fit.fit();
    term.refresh(0, Math.max(0, term.rows - 1));

    if (forceBottom && viewport instanceof HTMLElement) {
      viewport.scrollTop = viewport.scrollHeight;
    }

    if ((forceBottom || keepBottomPinned) && typeof term.scrollToBottom === "function") {
      term.scrollToBottom();
    }

    sendCommand({
      type: "cli_resize",
      payload: { clientSessionId: activeSessionId, cols: term.cols, rows: term.rows },
    });
  }

  // --- Main CLI Terminal (xterm.js) ---
  useEffect(() => {
    if (!activeSessionId || connectionState !== "connected" || activeSession?.engine !== "cli") return;

    const containerEl = cliTerminalContainerRef.current;
    if (!containerEl) return;

    // If already have a cached terminal for this session, reattach its wrapper element
    const cached = cliTerminalsRef.current.get(activeSessionId);
    if (cached) {
      const fit = cached.fitAddon as { fit: () => void };
      const term = cached.terminal as {
        focus: () => void;
        refresh: (start: number, end: number) => void;
        cols: number;
        rows: number;
        options?: { fontSize?: number };
      };
      if (term.options) {
        term.options.fontSize = getTerminalFontSize(mobileTerminalInputDetected);
      }
      syncTerminalMobileReadonly(cached.element);
      // Move the cached wrapper back into the visible container (never re-call open())
      containerEl.innerHTML = "";
      containerEl.appendChild(cached.element);
      // Wait for DOM layout, then fit + force full redraw (canvas loses context when detached)
      requestAnimationFrame(() => {
        fit.fit();
        term.refresh(0, term.rows - 1);
        if (!mobileTerminalInputDetected) {
          term.focus();
        }
      });

      // Notify server of current size (no replay — cached terminal already has output)
      sendCommand({
        type: "cli_resize",
        payload: { clientSessionId: activeSessionId, cols: term.cols, rows: term.rows },
      });
      return;
    }

    let disposed = false;
    const sessionId = activeSessionId;

    (async () => {
      const [xtermModule, fitModule] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      if (disposed) return;

      const Terminal = xtermModule.Terminal;
      const FitAddon = fitModule.FitAddon;

      const fitAddon = new FitAddon();
      const term = new Terminal({
        scrollback: 5000,
        cursorBlink: false,
        cursorInactiveStyle: "none",
        fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace',
        fontSize: getTerminalFontSize(mobileTerminalInputDetected),
        theme: {
          background: "#1a1a1a",
          foreground: "#e8e8e8",
          cursor: "#1a1a1a",
          cursorAccent: "#1a1a1a",
          selectionBackground: "rgba(216, 91, 52, 0.3)",
        },
      });
      term.loadAddon(fitAddon);

      // Create a dedicated wrapper div for this terminal instance.
      // open() is only called once; on switch we just move this wrapper element.
      const wrapper = document.createElement("div");
      wrapper.style.width = "100%";
      wrapper.style.height = "100%";

      containerEl.innerHTML = "";
      containerEl.appendChild(wrapper);
      term.open(wrapper);
      fitAddon.fit();
      syncTerminalMobileReadonly(wrapper);
      const cleanupTouchScroll = setupTerminalTouchScroll(wrapper);

      // Prevent ESC from blurring the terminal.
      // Strategy: intercept keydown on the wrapper (capture phase) to preventDefault,
      // then add a focusout safety-net that re-focuses if ESC caused the blur.
      let lastKeyWasEscape = false;
      wrapper.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          lastKeyWasEscape = true;
          e.preventDefault();
        } else {
          lastKeyWasEscape = false;
        }
      }, true);
      wrapper.addEventListener("focusout", () => {
        if (lastKeyWasEscape) {
          lastKeyWasEscape = false;
          requestAnimationFrame(() => {
            if (!disposed && !mobileTerminalInputDetected) term.focus();
          });
        }
      }, true);
      wrapper.addEventListener("focusin", () => {
        if (wrapper.dataset.mobileReadonly === "true") {
          requestAnimationFrame(() => {
            const helper = wrapper.querySelector(".xterm-helper-textarea");
            if (helper instanceof HTMLTextAreaElement) {
              helper.blur();
            }
          });
        }
      }, true);
      wrapper.addEventListener("touchend", () => {
        if (wrapper.dataset.mobileReadonly === "true") {
          requestAnimationFrame(() => {
            const helper = wrapper.querySelector(".xterm-helper-textarea");
            if (helper instanceof HTMLTextAreaElement) {
              helper.blur();
            }
          });
        }
      }, true);

      cliTerminalsRef.current.set(sessionId, { terminal: term, fitAddon, element: wrapper });

      // Notify server
      sendCommand({
        type: "cli_start",
        payload: { clientSessionId: sessionId, cols: term.cols, rows: term.rows },
      });

      // Forward input
      term.onData((data) => {
        sendCommand({
          type: "cli_input",
          payload: { clientSessionId: sessionId, data },
        });
      });

      // Forward resize
      term.onResize(({ cols, rows }) => {
        sendCommand({
          type: "cli_resize",
          payload: { clientSessionId: sessionId, cols, rows },
        });
      });

      // ResizeObserver for container
      const resizeObserver = new ResizeObserver(() => {
        if (!disposed) {
          fitAddon.fit();
        }
      });
      resizeObserver.observe(containerEl);

      // Store cleanup fn
      (term as unknown as Record<string, unknown>).__resizeObserver = resizeObserver;
      (term as unknown as Record<string, unknown>).__touchScrollCleanup = cleanupTouchScroll;
    })();

    return () => {
      disposed = true;
      // Don't destroy the terminal instance — keep it cached.
      // Just detach the wrapper from the visible container.
      if (containerEl) {
        containerEl.innerHTML = "";
      }
    };
  }, [activeSessionId, activeSession?.engine, connectionState, mobileTerminalInputDetected, mobileTerminalSurface]);

  useLayoutEffect(() => {
    if (!activeSessionId || connectionState !== "connected" || activeSession?.engine !== "cli") {
      return;
    }

    refitActiveCliTerminal(mobileTerminalFullscreenVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeSessionId,
    connectionState,
    mobileTerminalFullscreenVisible,
    mobileTerminalInputVisible,
    mobileTerminalKeyboardInset,
    mobileTerminalViewportHeight,
    mobileTerminalSurface,
    activeSession?.engine,
  ]);

  // Cleanup cached terminals when sessions are removed
  useEffect(() => {
    const activeIds = new Set(sessions.map((s) => s.clientSessionId));
    for (const [id, cached] of cliTerminalsRef.current.entries()) {
      if (!activeIds.has(id)) {
        const term = cached.terminal as { dispose: () => void };
        const obs = (cached.terminal as Record<string, unknown>).__resizeObserver as ResizeObserver | undefined;
        const touchCleanup = (cached.terminal as Record<string, unknown>).__touchScrollCleanup as (() => void) | undefined;
        obs?.disconnect();
        touchCleanup?.();
        term.dispose();
        cliTerminalsRef.current.delete(id);
      }
    }
  }, [sessions]);

  // --- Shell terminal (xterm.js) ---
  useEffect(() => {
    if (!shellPanelVisible || !activeSession || !config?.enableShell) return;
    const containerEl = mobileTerminalFullscreenVisible
      ? mobileTerminalContainerRef.current
      : desktopTerminalContainerRef.current;
    if (!containerEl) return;

    const cached = shellTerminalsRef.current.get(activeSession.clientSessionId);
    if (cached?.alive) {
      syncTerminalMobileReadonly(cached.wrapper);
      containerEl.innerHTML = "";
      containerEl.appendChild(cached.wrapper);

      requestAnimationFrame(() => {
        const fit = cached.fitAddon as { fit: () => void };
        const term = cached.terminal as { cols: number; rows: number; refresh?: (start: number, end: number) => void };
        fit.fit();
        term.refresh?.(0, Math.max(0, term.rows - 1));
        sendCommand({
          type: "shell_resize",
          payload: { clientSessionId: cached.clientSessionId, cols: term.cols, rows: term.rows },
        });
      });

      return () => {
        if (containerEl) {
          containerEl.innerHTML = "";
        }
      };
    }

    if (cached && !cached.alive) {
      disposeShellTerminal(activeSession.clientSessionId);
    }

    let disposed = false;

    (async () => {
      const [xtermModule, fitModule] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;

      const Terminal = xtermModule.Terminal;
      const FitAddon = fitModule.FitAddon;

      const fitAddon = new FitAddon();
      const term = new Terminal({
        scrollback: 1000,
        cursorBlink: true,
        fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace',
        fontSize: getTerminalFontSize(mobileTerminalInputDetected),
        theme: {
          background: "#1a1a1a",
          foreground: "#e8e8e8",
          cursor: "#d85b34",
          selectionBackground: "rgba(216, 91, 52, 0.3)",
        },
      });
      term.loadAddon(fitAddon);
      const wrapper = document.createElement("div");
      wrapper.style.width = "100%";
      wrapper.style.height = "100%";

      containerEl.innerHTML = "";
      containerEl.appendChild(wrapper);
      term.open(wrapper);
      fitAddon.fit();
      syncTerminalMobileReadonly(wrapper);
      const cleanupTouchScroll = setupTerminalTouchScroll(wrapper);
      const blurShellHelperIfReadonly = () => {
        if (wrapper.dataset.mobileReadonly === "true") {
          requestAnimationFrame(() => {
            const helper = wrapper.querySelector(".xterm-helper-textarea");
            if (helper instanceof HTMLTextAreaElement) {
              helper.blur();
            }
          });
        }
      };
      wrapper.addEventListener("focusin", blurShellHelperIfReadonly, true);
      wrapper.addEventListener("touchend", blurShellHelperIfReadonly, true);

      const resizeObserver = new ResizeObserver(() => {
        if (!disposed) fitAddon.fit();
      });
      resizeObserver.observe(wrapper);

      shellTerminalsRef.current.set(activeSession.clientSessionId, {
        clientSessionId: activeSession.clientSessionId,
        terminal: term,
        fitAddon,
        wrapper,
        resizeObserver,
        touchCleanup: cleanupTouchScroll,
        blurReadonlyHandler: blurShellHelperIfReadonly,
        alive: true,
      });

      sendCommand({
        type: "shell_start",
        payload: {
          clientSessionId: activeSession.clientSessionId,
          cols: term.cols,
          rows: term.rows,
        },
      });

      term.onData((data) => {
        sendCommand({ type: "shell_input", payload: { clientSessionId: activeSession.clientSessionId, data } });
      });

      term.onResize(({ cols, rows }) => {
        sendCommand({
          type: "shell_resize",
          payload: { clientSessionId: activeSession.clientSessionId, cols, rows },
        });
      });
    })();

    return () => {
      disposed = true;
      if (containerEl) {
        containerEl.innerHTML = "";
      }
    };
  }, [shellPanelVisible, activeSession?.clientSessionId, config?.enableShell, mobileTerminalInputDetected, mobileTerminalFullscreenVisible]);

  useEffect(() => {
    return () => {
      disposeAllShellTerminals();
    };
  }, []);

  useEffect(() => {
    const activeIds = new Set(sessions.map((s) => s.clientSessionId));
    for (const clientSessionId of Array.from(shellTerminalsRef.current.keys())) {
      if (!activeIds.has(clientSessionId)) {
        disposeShellTerminal(clientSessionId);
      }
    }
  }, [sessions]);

  // --- Session actions ---
  function createSession() {
    if (!workspacePath.trim()) return;
    savePreferredSessionEngine(newSessionEngine);
    sendCommand({
      type: "create_session",
      payload: {
        workspacePath: workspacePath.trim(),
        title: newSessionTitle.trim() || undefined,
        allowSkipPermissions,
        engine: newSessionEngine,
      },
    });
    setCreateSessionModalOpen(false);
    setNewSessionTitle("");
    setAllowSkipPermissions(config?.allowSkipPermissions ?? false);
  }

  function closeSession(clientSessionId: string) {
    sendCommand({ type: "close_session", payload: { clientSessionId } });
  }

  function switchSessionEngine(engine: SessionEngine) {
    if (!activeSession || activeSession.engine === engine) {
      return;
    }
    savePreferredSessionEngine(engine);
    sendCommand({
      type: "switch_engine",
      payload: { clientSessionId: activeSession.clientSessionId, engine },
    });
  }

  function changeAcpMode(modeId: string) {
    if (!activeSession || activeSession.engine !== "acp") {
      return;
    }
    sendCommand({
      type: "set_mode",
      payload: { clientSessionId: activeSession.clientSessionId, modeId },
    });
  }

  function sendAcpPrompt() {
    if (!activeSession || activeSession.engine !== "acp") {
      return;
    }
    const trimmed = acpComposer.trim();
    if (!trimmed && pendingImages.length === 0) {
      return;
    }
    const images = pendingImages.map((image) => ({ data: image.data, mimeType: image.mimeType }));
    if (images.length > 0) {
      pendingPromptImagesRef.current.set(activeSession.clientSessionId, images);
    }
    sendCommand({
      type: "prompt",
      payload: {
        clientSessionId: activeSession.clientSessionId,
        text: trimmed,
        images,
      },
    });
    setAcpComposer("");
    setPendingImages([]);
  }

  function cancelAcpPrompt() {
    if (!activeSession || activeSession.engine !== "acp") {
      return;
    }
    sendCommand({
      type: "cancel",
      payload: { clientSessionId: activeSession.clientSessionId },
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

  function answerQuestion(questionId: string, answer: string) {
    if (!activeSession || activeSession.engine !== "acp") {
      return;
    }
    sendCommand({
      type: "answer_question",
      payload: {
        clientSessionId: activeSession.clientSessionId,
        questionId,
        answer,
      },
    });
  }

  async function loadMoreAcpHistory(clientSessionId: string) {
    const session = sessions.find((entry) => entry.clientSessionId === clientSessionId);
    const acp = session?.acp;
    if (!session || session.engine !== "acp" || !acp || acp.historyStart <= 0) {
      return;
    }

    const response = await fetch(
      withAccessKey(
        `/api/session-history?clientSessionId=${encodeURIComponent(clientSessionId)}&before=${acp.historyStart}&limit=120`,
        accessKey,
      ),
    );
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error((body as { message?: string })?.message ?? `请求失败 (${response.status})`);
    }

    const payload = await response.json() as { items: TimelineItem[]; start: number; total: number };
    setSessions((prev) =>
      prev.map((entry) => {
        if (entry.clientSessionId !== clientSessionId || entry.engine !== "acp" || !entry.acp) {
          return entry;
        }
        return normalizeSessionRecord({
          ...entry,
          acp: {
            ...entry.acp,
            timeline: [...payload.items.map(normalizeTimelineItem), ...entry.acp.timeline],
            historyStart: payload.start,
            historyTotal: payload.total,
          },
        });
      }),
    );
  }

  function handleSessionCloseClick(e: React.MouseEvent, clientSessionId: string) {
    e.stopPropagation();
    setSessionToClose(clientSessionId);
  }

  function confirmCloseSession() {
    if (sessionToClose) {
      closeSession(sessionToClose);
      setSessionToClose(null);
    }
  }

  function cancelCloseSession() {
    setSessionToClose(null);
  }

  // --- VSCode ---
  function createVscodeOpenUri(launchConfig: VscodeLaunchConfig, targetWorkspacePath: string) {
    const normalizedWorkspacePath = targetWorkspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalizedWorkspacePath) return null;
    if (launchConfig.mode === "local") {
      return `vscode://file${normalizedWorkspacePath}`;
    }
    const host = launchConfig.sshHost.trim();
    if (!host) return null;
    const remoteAuthority = `ssh-remote+${encodeURIComponent(host)}`;
    return `vscode://vscode-remote/${remoteAuthority}${normalizedWorkspacePath}`;
  }

  function openWorkspaceInVscode(targetWorkspacePath: string) {
    const uri = createVscodeOpenUri(vscodeLaunchConfig, targetWorkspacePath);
    if (!uri) {
      setVscodeLaunchError("请先配置 VSCode 打开参数。");
      setVscodeSettingsOpen(true);
      return;
    }
    window.open(uri, "_self");
  }

  function saveVscodeLaunchConfig() {
    localStorage.setItem(VSCODE_LAUNCH_CONFIG_STORAGE_KEY, JSON.stringify(vscodeLaunchConfig));
    setVscodeLaunchNotice("已保存。");
  }

  // --- Diff ---
  async function openSessionDiff() {
    if (!activeSession) return;
    setSessionDiffOpen(true);
    setSessionDiffLoading(true);
    setSessionDiffError("");
    try {
      const res = await fetch(
        withAccessKey(`/api/session-diff/files?clientSessionId=${activeSession.clientSessionId}`, accessKey),
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body as { message?: string })?.message ?? `请求失败 (${res.status})`);
      }
      const data = (await res.json()) as SessionDiffResponse;
      setSessionDiff(data);
      setSessionFileDiffCache({});
    } catch (error) {
      setSessionDiffError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionDiffLoading(false);
    }
  }

  async function loadSessionFileDiff(category: DiffCategory, filePath: string) {
    const cacheKey = `${category}:${filePath}`;
    const cached = sessionFileDiffCache[cacheKey];
    if (cached) return cached;
    const res = await fetch(
      withAccessKey(
        `/api/session-diff/file?clientSessionId=${activeSession?.clientSessionId}&category=${category}&filePath=${encodeURIComponent(filePath)}`,
        accessKey,
      ),
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error((body as { message?: string })?.message ?? `请求失败 (${res.status})`);
    }
    const data = (await res.json()) as SessionFileDiffResponse;
    setSessionFileDiffCache((prev) => ({ ...prev, [cacheKey]: data }));
    return data;
  }

  function handleAccessKeySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedAccessKey = accessKeyInput.trim();
    if (!normalizedAccessKey) return;
    syncAccessKeyToUrl(normalizedAccessKey);
    setAccessKey(normalizedAccessKey);
    setAccessKeyInput(normalizedAccessKey);
    setConnectionState("connecting");
  }

  // --- Access key check ---
  if (!accessKey) {
    return (
      <div className="access-gate">
        <div className="panel access-gate-card">
          <h2>{config?.appName ?? "乐多汪汪队"}</h2>
          <p>请输入访问 key。提交后会自动写回当前 URL，后续刷新页面也能继续使用。</p>
          <form className="access-gate-form" onSubmit={handleAccessKeySubmit}>
            <label className="access-gate-label" htmlFor="access-key-input">
              访问 key
            </label>
            <input
              id="access-key-input"
              type="password"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={accessKeyInput}
              onChange={(event) => setAccessKeyInput(event.target.value)}
              placeholder="请输入访问 key"
            />
            <button className="primary" type="submit" disabled={!accessKeyInput.trim()}>
              进入控制台
            </button>
          </form>
          <p className="access-gate-hint">
            也可以继续使用 URL 参数方式，例如 <code>?key=YOUR_KEY</code>。
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className={shellClassName}>
      <aside className="panel masthead">
        <div className="brand-stack">
          <div className="brand-lockup">
            <img className="brand-icon" src="/assets/brand-icon.png" alt="" aria-hidden="true" />
            <div className="brand-copy">
              <p className="eyebrow">leduo-patrol</p>
              <h1>{config?.appName ?? "乐多汪汪队"}</h1>
            </div>
          </div>
          <p className="lede masthead-lede">在一个控制台里并行查看多会话进展、差异和执行结果。</p>
        </div>
        <div className="status-grid">
          <StatusCard label="连接" value={connectionState === "connected" ? "已连接" : connectionState === "closed" ? "断开" : "连接中"} tone={toneForConnectionState(connectionState)} />
          <StatusCard label="会话数" value={String(sessions.length)} />
        </div>
        <div className="masthead-actions">
          <button className="primary masthead-action-btn" onClick={() => setCreateSessionModalOpen(true)}>
            + 新建会话
          </button>
          <button className="secondary masthead-action-btn" onClick={() => setVscodeSettingsOpen(true)}>
            VSCode 配置
          </button>
        </div>
        {sessions.length === 0 ? (
          <div className="empty">暂无会话。点击上方按钮新建。</div>
        ) : (
          <ul className="session-list">
            {sessions.map((session) => (
              <li key={session.clientSessionId}>
                <button
                  className={`session-chip ${session.clientSessionId === activeSessionId ? "active" : ""}`}
                  onClick={() => setActiveSessionId(session.clientSessionId)}
                >
                  <button
                    className="session-chip-close"
                    onClick={(e) => handleSessionCloseClick(e, session.clientSessionId)}
                    title="关闭会话"
                    type="button"
                  >
                    ×
                  </button>
                  <span className="session-chip-title" title={session.title}>
                    {formatSessionTitleForDisplay(session.title)}
                  </span>
                  <span className="session-chip-meta">
                    {session.connectionState === "connected" ? (
                      <SessionStateTag session={session} />
                    ) : session.connectionState === "connecting" ? (
                      <span className="session-chip-tag session-chip-tag-connecting">连接中</span>
                    ) : (
                      <span className="session-chip-tag session-chip-tag-error">异常</span>
                    )}
                    <span className="session-chip-updated">{formatRelativeUpdatedAt(session.updatedAt)}</span>
                  </span>
                  <span className="session-chip-workspace" title={session.workspacePath}>
                    {config ? formatWorkspacePathForSidebar(session.workspacePath, config.allowedRoots) : session.workspacePath}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {mobileTerminalInputDetected && sessions.length > 0 && !activeSession ? (
          <div className="session-mobile-hint">请选择会话开始交互。</div>
        ) : null}
      </aside>

      {shouldRenderMainContentPanel ? (
      <main className="panel main-content">
        {activeSession && !mobileTerminalFullscreenVisible ? (
          <>
            <div className="cli-toolbar">
              <div className="cli-toolbar-info">
                <div className="cli-toolbar-title-group">
                  <h3 className="cli-toolbar-title" title={activeSession.title}>
                    {formatSessionTitleForDisplay(activeSession.title)}
                  </h3>
                  <code className="cli-toolbar-session-id" title={activeSession.sessionId}>session: {activeSession.sessionId}</code>
                </div>
                <code className="cli-toolbar-path" title={activeSession.workspacePath}>{activeSession.workspacePath}</code>
              </div>
              <div className="cli-toolbar-actions">
                <div className="engine-switch-group" role="group" aria-label="会话引擎切换">
                  <button
                    className={`secondary engine-switch-button ${activeSession.engine === "cli" ? "active" : ""}`}
                    type="button"
                    onClick={() => switchSessionEngine("cli")}
                    disabled={!canSwitchSessionEngine(activeSession, "cli")}
                    title={engineSwitchTitle(activeSession, "cli")}
                  >
                    CLI
                  </button>
                  <button
                    className={`secondary engine-switch-button ${activeSession.engine === "acp" ? "active" : ""}`}
                    type="button"
                    onClick={() => switchSessionEngine("acp")}
                    disabled={!canSwitchSessionEngine(activeSession, "acp")}
                    title={engineSwitchTitle(activeSession, "acp")}
                  >
                    ACP
                  </button>
                </div>
                <button className="secondary session-open-vscode" onClick={() => openWorkspaceInVscode(activeSession.workspacePath)}>
                  VSCode
                </button>
                {config?.enableShell ? (
                  <button
                    className={`secondary toolbar-icon-button session-terminal-trigger ${terminalOpen ? "active" : ""}`}
                    type="button"
                    onClick={toggleTerminalPanel}
                    aria-pressed={terminalOpen}
                    title={terminalOpen ? "收起终端" : "展开终端"}
                  >
                    <span aria-hidden="true">&gt;_</span>
                    <span className="sr-only">{terminalOpen ? "收起终端" : "展开终端"}</span>
                  </button>
                ) : null}
                <button className="secondary session-diff-trigger" onClick={openSessionDiff}>
                  查看 Diff
                </button>
                <button className="secondary session-close" onClick={() => closeSession(activeSession.clientSessionId)}>
                  关闭会话
                </button>
              </div>
            </div>
            {activeSession.engine === "cli" ? (
              <div className="cli-stage">
                <div className="cli-terminal-container" ref={cliTerminalContainerRef} />
              </div>
            ) : (
              <AcpSessionView
                session={activeSession}
                composer={acpComposer}
                pendingImages={pendingImages}
                onComposerChange={setAcpComposer}
                onComposerPaste={(images) => setPendingImages((current) => [...current, ...images])}
                onRemoveImage={(imageId) => setPendingImages((current) => current.filter((image) => image.id !== imageId))}
                onSendPrompt={sendAcpPrompt}
                onCancelPrompt={cancelAcpPrompt}
                onResolvePermission={resolvePermission}
                onAnswerQuestion={answerQuestion}
                onLoadMoreHistory={loadMoreAcpHistory}
                onOpenTimelineItem={setSelectedTimelineItem}
                onOpenPermissionDetail={setPermissionDetail}
                onChangeMode={changeAcpMode}
              />
            )}
          </>
        ) : (
          <div className="empty main-empty">
            {sessions.length > 0
              ? "选择左侧的会话开始交互。"
              : "暂无会话。请先新建一个会话。"}
          </div>
        )}
      </main>
      ) : null}

      {/* VSCode settings modal */}
      {vscodeSettingsOpen ? (
        <div className="modal-backdrop" onClick={() => setVscodeSettingsOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3>VSCode 打开配置</h3>
                <p className="modal-meta">远程模式需要 SSH 用户与主机（如 <code>dev@10.0.0.8</code>）；本地模式会直接打开当前目录。</p>
              </div>
              <button className="secondary" onClick={() => setVscodeSettingsOpen(false)}>关闭</button>
            </div>
            <div className="modal-scroll-body">
              <div className="details">
                <label htmlFor="vscode-open-mode">打开模式</label>
                <select
                  id="vscode-open-mode"
                  value={vscodeLaunchConfig.mode}
                  onChange={(event) => {
                    const nextMode = event.target.value === "remote" ? "remote" : "local";
                    setVscodeLaunchConfig((current) => ({ ...current, mode: nextMode }));
                    setVscodeLaunchNotice("");
                  }}
                >
                  <option value="remote">远程 SSH</option>
                  <option value="local">本地目录</option>
                </select>
                {vscodeLaunchConfig.mode === "remote" ? (
                  <>
                    <label htmlFor="vscode-open-ssh-host">SSH 主机</label>
                    <input
                      id="vscode-open-ssh-host"
                      placeholder="如 user@server"
                      value={vscodeLaunchConfig.sshHost}
                      onChange={(event) => {
                        setVscodeLaunchConfig((current) => ({ ...current, sshHost: event.target.value }));
                        setVscodeLaunchNotice("");
                      }}
                    />
                  </>
                ) : null}
                <div className="session-meta-item session-meta-item-wide">
                  <span>当前一键打开目标</span>
                  <code>{workspaceForLaunch || "(未选择目录)"}</code>
                </div>
                {vscodeLaunchError ? <p className="modal-meta">{vscodeLaunchError}</p> : null}
                {vscodeLaunchNotice ? <p className="modal-meta">{vscodeLaunchNotice}</p> : null}
                <div className="session-meta-actions vscode-settings-actions">
                  <button className="secondary" onClick={() => openWorkspaceInVscode(workspaceForLaunch)} disabled={!canOpenWorkspaceInVscode}>
                    立即打开当前目录
                  </button>
                  <button className="secondary" onClick={saveVscodeLaunchConfig}>保存配置</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Create session modal */}
      {createSessionModalOpen ? (
        <div
          className="modal-backdrop"
          onClick={() => { setCreateSessionModalOpen(false); setShowAllWorkspaceSuggestions(false); setAllowSkipPermissions(config?.allowSkipPermissions ?? false); }}
        >
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div><h3>新建会话</h3></div>
              <button className="secondary" onClick={() => { setCreateSessionModalOpen(false); setShowAllWorkspaceSuggestions(false); setAllowSkipPermissions(config?.allowSkipPermissions ?? false); }}>关闭</button>
            </div>
            <div className="modal-scroll-body">
              <div className="details">
                <label htmlFor="create-workspace-suffix">会话目录</label>
                <div className="workspace-path-inline">
                  <code className="workspace-path-root">{createWorkspaceRoot || "(未配置允许根目录)"}</code>
                  <span className="workspace-path-sep" aria-hidden="true">/</span>
                  <input
                    id="create-workspace-suffix"
                    list="create-workspace-suffix-suggestions"
                    value={createWorkspaceSuffix}
                    placeholder="例如 demo/new-session-showcase"
                    onChange={(event) => {
                      const nextSuffix = sanitizeWorkspaceSuffix(event.target.value);
                      setCreateWorkspaceSuffix(nextSuffix);
                      const nextPath = composeWorkspacePath(createWorkspaceRoot, nextSuffix);
                      const nextLookupPath = resolveWorkspaceLookupPath(createWorkspaceRoot, nextSuffix, directoryOptions);
                      setWorkspacePath(nextPath);
                      setDirectoryBrowserPath(nextLookupPath);
                      setShowAllWorkspaceSuggestions(false);
                    }}
                  />
                </div>
                <datalist id="create-workspace-suffix-suggestions">
                  {workspaceSuffixSuggestions.map((pathValue) => (
                    <option key={pathValue} value={pathValue} />
                  ))}
                </datalist>
                {workspaceSuffixSuggestions.length > 0 ? (
                  <div className="workspace-suggestion-list" role="list" aria-label="目录候选">
                    {visibleWorkspaceSuffixSuggestions.map((pathValue) => (
                      <button
                        key={pathValue}
                        type="button"
                        className="workspace-suggestion-item"
                        onClick={() => {
                          setCreateWorkspaceSuffix(pathValue);
                          const nextPath = composeWorkspacePath(createWorkspaceRoot, pathValue);
                          const nextLookupPath = resolveWorkspaceLookupPath(createWorkspaceRoot, pathValue, directoryOptions);
                          setWorkspacePath(nextPath);
                          setDirectoryBrowserPath(nextLookupPath);
                          setShowAllWorkspaceSuggestions(false);
                        }}
                      >
                        {pathValue}
                      </button>
                    ))}
                    {hasMoreWorkspaceSuggestions ? (
                      <button
                        type="button"
                        className="workspace-suggestion-item"
                        onClick={() => setShowAllWorkspaceSuggestions((c) => !c)}
                      >
                        {showAllWorkspaceSuggestions ? "收起候选" : `展开更多（+${workspaceSuffixSuggestions.length - WORKSPACE_SUGGESTION_INITIAL_LIMIT}）`}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <label htmlFor="create-session-title">会话名</label>
                <input
                  id="create-session-title"
                  value={newSessionTitle}
                  placeholder="可选，例如 leduo-api"
                  onChange={(event) => setNewSessionTitle(event.target.value)}
                />
                <label htmlFor="create-session-engine">启动引擎</label>
                <select
                  id="create-session-engine"
                  value={newSessionEngine}
                  onChange={(event) => setNewSessionEngine(event.target.value === "acp" ? "acp" : "cli")}
                >
                  {(config?.availableSessionEngines ?? ["cli"]).map((engine) => (
                    <option key={engine} value={engine}>
                      {engine === "cli" ? "CLI 终端" : "ACP 结构化视图"}
                    </option>
                  ))}
                </select>
                <div className="checkbox-field">
                  <label className="checkbox-label warning">
                    <input
                      type="checkbox"
                      checked={allowSkipPermissions}
                      onChange={(event) => setAllowSkipPermissions(event.target.checked)}
                    />
                    <span>允许YOLO模式</span>
                  </label>
                  <p className="checkbox-hint warning">
                    启用后，可在会话中切换至YOLO模式，自动执行操作而无需确认。
                  </p>
                </div>
                {directoryError ? <p>{directoryError}</p> : null}
              </div>
            </div>
            <div className="modal-footer">
              <button className="primary" onClick={createSession} disabled={!workspacePath.trim()}>新建目录会话</button>
              <button className="secondary" type="button" onClick={() => { setCreateSessionModalOpen(false); setShowAllWorkspaceSuggestions(false); }}>取消</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Session Diff modal */}
      {sessionDiffOpen ? (
        <SessionDiffModal
          sessionTitle={activeSession ? formatSessionTitleForDisplay(activeSession.title) : "当前会话"}
          loading={sessionDiffLoading}
          error={sessionDiffError}
          snapshot={sessionDiff}
          fileDiffCache={sessionFileDiffCache}
          onLoadFileDiff={loadSessionFileDiff}
          onClose={() => setSessionDiffOpen(false)}
          onRefresh={openSessionDiff}
        />
      ) : null}

      {selectedTimelineItem ? (
        <MessageModal
          sessionTitle={selectedTimelineItem.sessionTitle}
          item={selectedTimelineItem.item}
          onClose={() => setSelectedTimelineItem(null)}
        />
      ) : null}

      {permissionDetail ? (
        <PermissionModal
          sessionTitle={activeSession ? formatSessionTitleForDisplay(activeSession.title) : "当前会话"}
          permission={permissionDetail}
          onClose={() => setPermissionDetail(null)}
          onResolve={(permission, optionId) => {
            resolvePermission(permission, optionId);
            setPermissionDetail(null);
          }}
        />
      ) : null}

      {/* Close session confirmation */}
      {sessionToClose ? (
        <div className="modal-backdrop" onClick={cancelCloseSession}>
          <div className="modal-card modal-card-small" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>确认关闭会话</h3>
            </div>
            <div className="modal-body">
              <p>确定要关闭此会话吗？关闭后无法恢复。</p>
            </div>
            <div className="modal-footer">
              <button className="primary" onClick={confirmCloseSession}>确认关闭</button>
              <button className="secondary" onClick={cancelCloseSession}>取消</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Bottom shell drawer */}
      {config?.enableShell && terminalOpen && !mobileTerminalFullscreenVisible ? (
        <div className="terminal-drawer terminal-drawer-open">
          <div className="terminal-drawer-header">
            <button
              className="terminal-drawer-toggle"
              type="button"
              onClick={() => setTerminalOpen((v) => !v)}
              aria-expanded={terminalOpen}
              title={terminalOpen ? "收起终端" : "展开终端"}
            >
              <span className="terminal-drawer-icon" aria-hidden="true">{terminalOpen ? "▼" : "▲"}</span>
              <span>终端</span>
            </button>
            <span className="terminal-drawer-note">
              工作目录：{activeSession?.workspacePath ?? config.workspacePath}
            </span>
          </div>
          {terminalOpen ? (
            <div className="terminal-viewport" ref={desktopTerminalContainerRef} />
          ) : null}
        </div>
      ) : null}
    </div>
    {mobileTerminalFullscreenVisible && activeSession ? (
      <div className="mobile-terminal-fullscreen" style={mobileTerminalFullscreenStyle}>
        <div className="mobile-terminal-fullscreen-header">
          <button className="secondary mobile-terminal-back" type="button" onClick={() => setActiveSessionId(null)}>
            返回
          </button>
          <div className="mobile-terminal-fullscreen-copy">
            <strong title={activeSession.title}>{formatSessionTitleForDisplay(activeSession.title)}</strong>
            <span title={activeSession.workspacePath}>{activeSession.workspacePath}</span>
          </div>
          <div className="mobile-terminal-fullscreen-actions">
            <button className="secondary session-diff-trigger mobile-terminal-diff-trigger" type="button" onClick={openSessionDiff}>
              Diff
            </button>
            {config?.enableShell ? (
              <button
                className="secondary toolbar-icon-button mobile-terminal-mode-button"
                type="button"
                onClick={toggleMobileTerminalSurface}
                title={mobileTerminalSurface === "cli" ? "切换到终端" : "切换到 Claude Code"}
              >
                <span aria-hidden="true">{mobileTerminalSurface === "cli" ? ">_" : "CC"}</span>
                <span className="sr-only">{mobileTerminalSurface === "cli" ? "切换到终端" : "切换到 Claude Code"}</span>
              </button>
            ) : null}
            <button
              className={`secondary mobile-terminal-toggle ${mobileTerminalInputVisible ? "active" : ""}`}
              type="button"
              onClick={toggleMobileTerminalInput}
              aria-pressed={mobileTerminalInputVisible}
            >
              <svg
                aria-hidden="true"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
                <path d="M6 9H7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M10 9H11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M14 9H15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M18 9H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M6 12H7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M10 12H11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M14 12H15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M18 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M9 15H15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="sr-only">{mobileTerminalInputVisible ? "收起输入" : "移动输入"}</span>
            </button>
          </div>
        </div>
        <div className="mobile-terminal-fullscreen-body">
          <div className="cli-stage cli-stage-fullscreen">
            <div className="mobile-terminal-stage-viewport">
              <div
                className={`cli-terminal-container cli-terminal-container-fullscreen mobile-terminal-surface ${
                  mobileTerminalSurface === "shell" ? "mobile-terminal-surface-hidden" : ""
                }`}
                ref={cliTerminalContainerRef}
              />
              {config?.enableShell ? (
                <div
                  className={`mobile-shell-stage mobile-terminal-surface ${
                    mobileTerminalSurface === "cli" ? "mobile-terminal-surface-hidden" : ""
                  }`}
                >
                  <div className="mobile-shell-panel-header">
                    <span className="mobile-shell-panel-title">
                      <span aria-hidden="true">&gt;_</span>
                      <span>终端</span>
                    </span>
                    <code className="mobile-shell-panel-path" title={activeSession.workspacePath}>
                      {activeSession.workspacePath}
                    </code>
                  </div>
                  <div className="terminal-viewport terminal-viewport-mobile terminal-viewport-mobile-fullscreen" ref={mobileTerminalContainerRef} />
                </div>
              ) : null}
            </div>
            {mobileTerminalInputVisible ? (
              <MobileTerminalInputBar
                draft={mobileTerminalDraft}
                disabled={mobileTerminalInputDisabled}
                keyboardInset={mobileTerminalKeyboardInset}
                fullscreen
                onChangeDraft={setMobileTerminalDraft}
                onTypeDraft={typeMobileTerminalDraft}
                onSendDraft={sendMobileTerminalDraft}
                onAction={sendMobileTerminalAction}
              />
            ) : null}
          </div>
        </div>
      </div>
    ) : null}
    <ToastContainer toasts={toasts} onDismiss={dismissToast} onNavigate={(sessionId) => setActiveSessionId(sessionId)} />
    </>
  );
}

// --- Helper components ---

function MobileTerminalInputBar(props: {
  draft: string;
  disabled: boolean;
  keyboardInset: number;
  fullscreen: boolean;
  onChangeDraft: (value: string) => void;
  onTypeDraft: () => void;
  onSendDraft: () => void;
  onAction: (key: MobileTerminalActionKey) => void;
}) {
  const mobileInputStyle = {
    "--mobile-terminal-input-offset": `${props.keyboardInset}px`,
  } as CSSProperties;
  const hasDraft = props.draft.length > 0;

  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      props.onSendDraft();
    }
  }

  return (
    <div
      className={`mobile-terminal-input-shell ${props.fullscreen ? "mobile-terminal-input-shell-fullscreen" : ""}`}
      style={mobileInputStyle}
    >
      <div className="mobile-terminal-input-compose">
        <label className="sr-only" htmlFor="mobile-terminal-input">
          终端输入
        </label>
        <textarea
          id="mobile-terminal-input"
          value={props.draft}
          onChange={(event) => props.onChangeDraft(event.target.value)}
          onKeyDown={handleDraftKeyDown}
          placeholder="在这里粘贴命令、确认文字或多行文本"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={2}
          disabled={props.disabled}
        />
        {hasDraft ? (
          <div className="mobile-terminal-send-stack">
            <button
              className="secondary mobile-terminal-send mobile-terminal-send-type"
              type="button"
              onClick={props.onTypeDraft}
              disabled={props.disabled}
            >
              键入文本
            </button>
            <button
              className="primary mobile-terminal-send"
              type="button"
              onClick={props.onSendDraft}
              disabled={props.disabled}
            >
              发送文本
            </button>
          </div>
        ) : (
          <button
            className="primary mobile-terminal-send"
            type="button"
            onClick={props.onSendDraft}
            disabled={props.disabled}
          >
            Enter
          </button>
        )}
      </div>
      <div className="mobile-terminal-action-grid" role="group" aria-label="终端快捷按键">
        {MOBILE_TERMINAL_ACTIONS.map((action) => (
          <button
            key={action.key}
            className={`secondary mobile-terminal-action ${action.accent ? "mobile-terminal-action-accent" : ""}`}
            type="button"
            onClick={() => props.onAction(action.key)}
            disabled={props.disabled}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AcpSessionView(props: {
  session: SessionRecord;
  composer: string;
  pendingImages: PendingImage[];
  onComposerChange: (value: string) => void;
  onComposerPaste: (images: PendingImage[]) => void;
  onRemoveImage: (imageId: string) => void;
  onSendPrompt: () => void;
  onCancelPrompt: () => void;
  onResolvePermission: (permission: PermissionPayload, optionId: string) => void;
  onAnswerQuestion: (questionId: string, answer: string) => void;
  onLoadMoreHistory: (clientSessionId: string) => Promise<void>;
  onOpenTimelineItem: (value: { sessionTitle: string; item: TimelineItem }) => void;
  onOpenPermissionDetail: (permission: PermissionPayload) => void;
  onChangeMode: (modeId: string) => void;
}) {
  const acp = props.session.acp ?? createEmptyAcpState();
  const sessionTitle = formatSessionTitleForDisplay(props.session.title);
  const groupedQuestions = groupQuestionsByGroup(acp.questions);
  const [collapsedSubagentRoots, setCollapsedSubagentRoots] = useState<Record<string, boolean>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [isCompletionOpen, setIsCompletionOpen] = useState(false);
  const [commandSuggestionIndex, setCommandSuggestionIndex] = useState(0);

  const visibleTimeline = acp.timeline;
  const timelineRows = useMemo(() => buildTimelineTreeRows(visibleTimeline), [visibleTimeline]);
  const rootChildCount = useMemo(() => countChildrenByRoot(timelineRows), [timelineRows]);
  const activeSessionIsRunning = isAcpSessionRunning(props.session);
  const latestExecutionPlan = useMemo(() => findLatestExecutionPlan(visibleTimeline), [visibleTimeline]);
  const latestExecutionPlanSteps = useMemo(
    () => parseExecutionPlanSteps(findLatestExecutionPlanBody(visibleTimeline)),
    [visibleTimeline],
  );
  const completionQuery = extractPromptCommandQuery(props.composer);
  const commandCompletions = useMemo(
    () => getPromptCommandCompletions(props.composer, acp.availableCommands),
    [props.composer, acp.availableCommands],
  );
  const completionSections = useMemo(
    () => buildCompletionSections(commandCompletions, completionQuery),
    [commandCompletions, completionQuery],
  );

  useEffect(() => {
    setCollapsedSubagentRoots({});
    setIsCompletionOpen(false);
    setCommandSuggestionIndex(0);
  }, [props.session.clientSessionId]);

  useEffect(() => {
    setCommandSuggestionIndex(0);
  }, [props.composer, commandCompletions.length, props.session.clientSessionId]);

  async function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const images = await extractClipboardImages(event);
    if (images.length > 0) {
      props.onComposerPaste(images);
    }
  }

  function applyCommandSuggestion(commandName: string) {
    props.onComposerChange(applyPromptCommandCompletion(props.composer, commandName));
  }

  async function handleLoadMoreHistory() {
    setHistoryLoading(true);
    try {
      await props.onLoadMoreHistory(props.session.clientSessionId);
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <div className={`acp-legacy-shell ${latestExecutionPlan ? "" : "acp-legacy-shell-no-sidebar"}`.trim()}>
      <main className="transcript acp-legacy-transcript">
        <div className="timeline">
          {acp.historyStart > 0 ? (
            <button className="history-loader secondary" type="button" onClick={() => void handleLoadMoreHistory()} disabled={historyLoading}>
              {historyLoading ? "正在加载更早历史..." : `加载更多历史 (${acp.historyStart} 条更早记录)`}
            </button>
          ) : null}
          {visibleTimeline.length === 0 ? (
            <div className="empty">这个会话还没有执行记录。发送第一条指令后开始滚动展示。</div>
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
                  item={row.displayTitle ? { ...row.item, title: row.displayTitle } : row.item}
                  depth={row.depth}
                  childCount={childCount}
                  collapsed={Boolean(collapsedSubagentRoots[row.item.id])}
                  onToggleCollapse={
                    childCount > 0
                      ? () => setCollapsedSubagentRoots((current) => ({ ...current, [row.item.id]: !current[row.item.id] }))
                      : undefined
                  }
                  statusHint={resolveCollapsedSubagentStatusHint(
                    row.item,
                    childCount,
                    Boolean(collapsedSubagentRoots[row.item.id]),
                    activeSessionIsRunning,
                  )}
                  onOpen={() => props.onOpenTimelineItem({ sessionTitle, item: row.item })}
                />
              );
            })
          )}
          {activeSessionIsRunning ? (
            <div className="timeline-running-indicator" aria-live="polite">
              <span className="timeline-running-dot" aria-hidden="true" />
              {acp.permissions.length > 0 || acp.questions.length > 0 ? "等待待处理中..." : "正在运行中..."}
            </div>
          ) : null}
        </div>
        {acp.permissions.length > 0 || groupedQuestions.length > 0 ? (
          <div className="composer composer-pending-placeholder">
            {acp.permissions.length > 0 ? (
              <>
                <p className="composer-pending-title">待处理确认</p>
                <div className="composer-pending-list">
                  {acp.permissions.map((permission) => (
                    <section className="composer-pending-item" key={permission.requestId}>
                      <p
                        className="composer-pending-tool"
                        title={summarizeToolTitle(
                          permission.toolCall.title,
                          permission.toolCall.rawInput,
                          permission.toolCall.toolCallId,
                        )}
                      >
                        {truncatePendingToolLabel(
                          summarizeToolTitle(
                            permission.toolCall.title,
                            permission.toolCall.rawInput,
                            permission.toolCall.toolCallId,
                          ),
                        )}
                      </p>
                      <div className="composer-pending-actions">
                        <button className="secondary" type="button" onClick={() => props.onOpenPermissionDetail(permission)}>
                          查看详情
                        </button>
                        {permission.options.map((option) => (
                          <button
                            key={option.optionId}
                            className="secondary"
                            type="button"
                            onClick={() => props.onResolvePermission(permission, option.optionId)}
                          >
                            {option.name}
                          </button>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </>
            ) : null}
            {groupedQuestions.length > 0 ? (
              <>
                <p className="composer-pending-title">待回答问题</p>
                <div className="composer-pending-list">
                  {groupedQuestions.map((group) => (
                    <MultiQuestionForm
                      key={group[0].groupId ?? group[0].questionId}
                      questions={group}
                      onSubmit={(answers) => submitQuestionGroup(group, answers, props.onAnswerQuestion)}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <div className="composer">
            <div className="composer-meta-row">
              {acp.modes.length > 0 ? (
                <select
                  className="acp-mode-select composer-mode-select"
                  value={acp.currentModeId}
                  onChange={(event) => props.onChangeMode(event.target.value)}
                >
                  {acp.modes.map((modeId) => (
                    <option key={modeId} value={modeId}>
                      {modeId}
                    </option>
                  ))}
                </select>
              ) : null}
              <p className="composer-capability-summary">ACP 能力：{acp.availableCommands.length}</p>
            </div>
            {isCompletionOpen && commandCompletions.length > 0 ? (
              <div className="composer-completions" role="listbox" aria-label="命令补全">
                {completionSections.map((section) => (
                  <div key={section.key} className="composer-completion-section">
                    {section.title ? <p className="composer-completion-section-title">{section.title}</p> : null}
                    {section.items.map(({ command, index }) => (
                      <button
                        key={command.name}
                        type="button"
                        className={`composer-completion-item ${index === commandSuggestionIndex ? "active" : ""}`}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          applyCommandSuggestion(command.name);
                          setIsCompletionOpen(false);
                        }}
                      >
                        <span>{renderCompletionLabel(command.name, completionQuery)}</span>
                        <small>{command.description || "命令"}</small>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="composer-input-shell">
              {props.pendingImages.length > 0 ? (
                <div className="composer-image-previews">
                  {props.pendingImages.map((image, index) => (
                    <div key={image.id} className="composer-image-preview">
                      <div className="composer-image-preview-thumb">
                        <img src={image.dataUrl} alt={`待发送图片 ${index + 1}`} />
                      </div>
                      <button
                        type="button"
                        className="composer-image-preview-remove"
                        title="移除图片"
                        onClick={() => props.onRemoveImage(image.id)}
                      >
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <textarea
                placeholder={activeSessionIsRunning ? "当前正在运行，可继续准备下一条指令…" : "例如：分析这个目录的仓库结构，然后给我一个重构计划。"}
                value={props.composer}
                onFocus={() => {
                  if (commandCompletions.length > 0) {
                    setIsCompletionOpen(true);
                  }
                }}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  props.onComposerChange(nextValue);
                  setIsCompletionOpen(Boolean(extractPromptCommandQuery(nextValue)));
                }}
                onPaste={(event) => { void handlePaste(event).catch(() => undefined); }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    isCompletionOpen &&
                    commandCompletions.length > 0 &&
                    Boolean(extractPromptCommandQuery(props.composer))
                  ) {
                    event.preventDefault();
                    const selected = commandCompletions[commandSuggestionIndex] ?? commandCompletions[0];
                    if (selected) {
                      applyCommandSuggestion(selected.name);
                      setIsCompletionOpen(false);
                    }
                    return;
                  }
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    props.onSendPrompt();
                    return;
                  }
                  if (event.key === "Escape") {
                    setIsCompletionOpen(false);
                    return;
                  }
                  if (commandCompletions.length < 1) {
                    return;
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setIsCompletionOpen(true);
                    setCommandSuggestionIndex((current) => (current + 1) % commandCompletions.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setIsCompletionOpen(true);
                    setCommandSuggestionIndex((current) => (current - 1 + commandCompletions.length) % commandCompletions.length);
                    return;
                  }
                  if (event.key === "Tab") {
                    event.preventDefault();
                    const selected = commandCompletions[commandSuggestionIndex] ?? commandCompletions[0];
                    if (selected) {
                      applyCommandSuggestion(selected.name);
                      setIsCompletionOpen(false);
                    }
                  }
                }}
              />
            </div>
            <div className="composer-actions">
              <button
                className="primary composer-send"
                type="button"
                onClick={props.onSendPrompt}
                disabled={!props.composer.trim() && props.pendingImages.length === 0}
              >
                发送
                <kbd className="composer-send-shortcut">⌘↩</kbd>
              </button>
              <button className="secondary composer-cancel" type="button" onClick={props.onCancelPrompt} disabled={!acp.busy}>
                <span aria-hidden="true">⏹</span>
                停止
              </button>
            </div>
          </div>
        )}
      </main>

      {latestExecutionPlan ? (
        <aside className="approvals acp-legacy-approvals">
          <section className="details session-meta session-meta-card">
            <p className="approval-label">执行计划</p>
            {latestExecutionPlanSteps.length > 0 ? (
              <ol className="session-plan-list">
                {latestExecutionPlanSteps.map((step, index) => (
                  <li key={`${index}-${step.content}`} className="session-plan-list-item">
                    <span className={`session-plan-status session-plan-status-${step.status}`} aria-hidden="true" />
                    <span className="session-plan-content">{step.content}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <pre className="session-plan-preview">{latestExecutionPlan}</pre>
            )}
          </section>
        </aside>
      ) : null}
    </div>
  );
}

function QuestionGroupCard(props: {
  questions: QuestionPayload[];
  onSubmit: (questionId: string, answer: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const allAnswered = props.questions.every((question) => Boolean(answers[question.questionId]?.trim()));

  return (
    <div className="acp-question-group">
      {props.questions.map((question) => (
        <div key={question.questionId} className="acp-question-card">
          {question.header ? <p className="acp-question-header">{question.header}</p> : null}
          <p className="acp-question-text">{question.question}</p>
          {question.options.length > 0 ? (
            <div className="acp-question-options">
              {question.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`secondary acp-question-option ${answers[question.questionId] === option.label ? "active" : ""}`}
                  onClick={() => setAnswers((current) => ({ ...current, [question.questionId]: option.label }))}
                  title={option.description}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          <input
            className="acp-question-input"
            value={answers[question.questionId] ?? ""}
            onChange={(event) => setAnswers((current) => ({ ...current, [question.questionId]: event.target.value }))}
            placeholder="输入回答"
          />
        </div>
      ))}
      <button
        className="primary"
        type="button"
        disabled={!allAnswered}
        onClick={() => {
          const lines = props.questions.map((question) => {
            const prefix = question.header ? `【${question.header}】` : "";
            return `${prefix}${question.question}\n→ ${answers[question.questionId]?.trim() ?? ""}`;
          });
          props.onSubmit(props.questions[0].questionId, lines.join("\n\n"));
        }}
      >
        提交回答
      </button>
    </div>
  );
}

function SimplePermissionModal(props: {
  permission: PermissionPayload;
  onClose: () => void;
  onResolve: (permission: PermissionPayload, optionId: string) => void;
}) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>{props.permission.toolCall.title ?? props.permission.toolCall.toolCallId}</h3>
            <p className="modal-meta">{props.permission.toolCall.status ?? "pending"}</p>
          </div>
          <button className="secondary" onClick={props.onClose}>关闭</button>
        </div>
        <div className="modal-scroll-body">
          <pre className="modal-body">{stringifyValue(props.permission.toolCall.rawInput)}</pre>
        </div>
        <div className="modal-footer">
          {props.permission.options.map((option) => (
            <button key={option.optionId} className="secondary" type="button" onClick={() => props.onResolve(props.permission, option.optionId)}>
              {option.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SessionStateTag(props: { session: SessionRecord }) {
  const state = getSessionStateSummary(props.session);
  return <span className={`session-chip-tag session-chip-tag-${state.tone}`}>{state.label}</span>;
}

function SessionActivityTag(props: { activityState?: ActivityState }) {
  switch (props.activityState) {
    case "running":
      return <span className="session-chip-tag session-chip-tag-running">运行中</span>;
    case "completed":
      return <span className="session-chip-tag session-chip-tag-completed">已完成</span>;
    case "pending":
      return <span className="session-chip-tag session-chip-tag-pending">待处理</span>;
    default:
      return <span className="session-chip-tag session-chip-tag-connected">已连接</span>;
  }
}

function StatusCard(props: { label: string; value: string; tone?: "positive" | "negative" | "neutral" }) {
  return (
    <div className={`status-card ${props.tone ? `status-card-${props.tone}` : ""}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function ToastContainer(props: {
  toasts: ToastNotification[];
  onDismiss: (id: string) => void;
  onNavigate: (sessionId: string) => void;
}) {
  if (props.toasts.length === 0) return null;
  return (
    <div className="toast-container" aria-live="polite" aria-atomic="false">
      {props.toasts.map((toast) => (
        <div key={toast.id} className={`toast-item toast-${toast.kind}`} role="alert">
          {toast.sessionId ? (
            <button
              className="toast-content toast-content-clickable"
              type="button"
              onClick={() => props.onNavigate(toast.sessionId!)}
              aria-label={`跳转到会话：${toast.body}`}
            >
              <strong className="toast-title">{toast.title}</strong>
              <span className="toast-body">{toast.body}</span>
            </button>
          ) : (
            <div className="toast-content">
              <strong className="toast-title">{toast.title}</strong>
              <span className="toast-body">{toast.body}</span>
            </div>
          )}
          <button className="toast-dismiss" onClick={() => props.onDismiss(toast.id)} aria-label="关闭通知" type="button">
            ×
          </button>
        </div>
      ))}
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
    if (!props.snapshot) return [] as SessionDiffFileEntry[];
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
    if (viewMode !== "byFile" || !selectedFilePath) return;
    const cacheKey = `${categoryTab}:${selectedFilePath}`;
    if (props.fileDiffCache[cacheKey]) return;
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
            <button className="secondary modal-btn-refresh" onClick={props.onRefresh} disabled={props.loading}>刷新</button>
            <button className="secondary modal-btn-close" onClick={props.onClose}>关闭</button>
          </div>
        </div>
        {props.loading ? <p className="modal-meta modal-meta-padded">正在读取 Git Diff...</p> : null}
        {props.error ? <p className="modal-meta modal-meta-padded">{props.error}</p> : null}
        {props.snapshot ? (
          <div className="modal-scroll-body">
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
          </div>
        ) : null}
      </div>
    </div>
  );
}

function categoryLabel(category: DiffCategory) {
  if (category === "workingTree") return "未暂存修改 (working tree)";
  if (category === "staged") return "已暂存修改 (staged)";
  return "未跟踪文件";
}

function DiffBlock(props: { diff: string }) {
  const trimmed = props.diff.trim();
  if (!trimmed) return <p>(空)</p>;
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
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "diff-line-file";
  if (line.startsWith("@@ ")) return "diff-line-hunk";
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("new file mode") || line.startsWith("deleted file mode")) return "diff-line-header";
  if (line.startsWith("+")) return "diff-line-add";
  if (line.startsWith("-")) return "diff-line-remove";
  return "";
}

// --- Utility functions ---

function makeId() {
  const cryptoObject = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof cryptoObject?.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  return `lp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatSessionTitleForDisplay(title: string) {
  return title.replace(/_/g, "_\u200b");
}

function formatRelativeUpdatedAt(updatedAt: string, now = Date.now()) {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return "刚刚";
  const elapsedMs = Math.max(0, now - timestamp);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) return "刚刚";
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} 小时前`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} 天前`;
}

function toneForConnectionState(connectionState: string): "positive" | "negative" | "neutral" {
  if (connectionState === "connected") return "positive";
  if (connectionState === "closed" || connectionState === "error") return "negative";
  return "neutral";
}

function formatWorkspacePathForSidebar(workspacePath: string, allowedRoots: string[]) {
  const normalizedPath = workspacePath.trim();
  if (!normalizedPath) return workspacePath;
  const matchingRoot = allowedRoots
    .map((root) => root.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find((root) => isWithinRoot(root, normalizedPath));
  if (!matchingRoot) return normalizedPath;
  if (normalizedPath === matchingRoot) return "…/";
  const suffix = normalizedPath.slice(matchingRoot.length).replace(/^\/+/, "");
  return suffix ? `…/${suffix}` : "…/";
}

function normalizePath(pathValue: string) {
  const normalized = pathValue.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function isWithinRoot(rootPath: string, targetPath: string) {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}/`);
}

function relativePathFromRoot(rootPath: string, targetPath: string) {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedTarget = normalizePath(targetPath);
  if (!isWithinRoot(normalizedRoot, normalizedTarget)) return "";
  if (normalizedTarget === normalizedRoot) return "";
  return normalizedTarget.slice(normalizedRoot.length).replace(/^\/+/, "");
}

function sanitizeWorkspaceSuffix(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function composeWorkspacePath(rootPath: string, suffixPath: string) {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedSuffix = sanitizeWorkspaceSuffix(suffixPath);
  if (!normalizedSuffix) return normalizedRoot;
  return normalizePath(`${normalizedRoot}/${normalizedSuffix}`);
}

function resolveWorkspaceLookupPath(
  rootPath: string,
  suffixPath: string,
  availableDirectories: Array<{ name: string; path: string }>,
) {
  const normalizedSuffix = sanitizeWorkspaceSuffix(suffixPath);
  const composedPath = composeWorkspacePath(rootPath, normalizedSuffix);
  if (!normalizedSuffix) return composedPath;
  const normalizedComposedPath = normalizePath(composedPath);
  const hasExactMatch = availableDirectories.some((entry) => normalizePath(entry.path) === normalizedComposedPath);
  if (hasExactMatch) return composedPath;
  return parentDirectory(composedPath);
}

function parentDirectory(pathValue: string) {
  const trimmed = pathValue.replace(/[\\/]+$/, "");
  const lastSeparatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (lastSeparatorIndex <= 0) return trimmed.slice(0, 1) || trimmed;
  return trimmed.slice(0, lastSeparatorIndex);
}

function splitWorkspacePathByAllowedRoots(pathValue: string, allowedRoots: string[]) {
  const normalizedPath = normalizePath(pathValue.trim() || "/");
  const normalizedRoots = allowedRoots
    .map((rootPath) => normalizePath(rootPath.trim()))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const matchedRoot = normalizedRoots.find((rootPath) => isWithinRoot(rootPath, normalizedPath));
  const fallbackRoot = normalizedRoots[0] ?? "/";
  const activeRoot = matchedRoot ?? fallbackRoot;
  const suffix = relativePathFromRoot(activeRoot, normalizedPath);
  return { root: activeRoot, suffix };
}

function getTerminalFontSize(useCompactMobileFont: boolean) {
  return useCompactMobileFont ? MOBILE_TERMINAL_FONT_SIZE : DEFAULT_TERMINAL_FONT_SIZE;
}

function shouldEnableMobileTerminalInput(environment: MobileTerminalEnvironment) {
  return environment.viewportWidth <= MOBILE_TERMINAL_BREAKPOINT
    && (environment.coarsePointer || environment.touchPoints > 0);
}

function mapMobileTerminalActionToSequence(key: MobileTerminalActionKey) {
  switch (key) {
    case "backspace":
      return "\u007f";
    case "tab":
      return "\t";
    case "shiftTab":
      return "\u001b[Z";
    case "escape":
      return "\u001b";
    case "arrowUp":
      return "\u001b[A";
    case "arrowDown":
      return "\u001b[B";
    case "arrowRight":
      return "\u001b[C";
    case "arrowLeft":
      return "\u001b[D";
    case "ctrlC":
      return "\u0003";
    default:
      return "";
  }
}

function buildMobileTerminalDraftPayload(draft: string, submit: boolean) {
  if (draft.length === 0) {
    return submit ? "\r" : "";
  }
  return `${draft}${submit ? "\r" : ""}`;
}

function shouldDisableMobileTerminalInput(
  activeSessionId: string | null,
  connectionState: ConnectionState,
  sessionConnectionState?: SessionRecord["connectionState"],
) {
  return !activeSessionId
    || connectionState !== "connected"
    || (sessionConnectionState != null && sessionConnectionState !== "connected");
}

function createEmptyAcpState(): NonNullable<SessionRecord["acp"]> {
  return {
    modes: [],
    defaultModeId: "default",
    currentModeId: "default",
    busy: false,
    timeline: [],
    historyTotal: 0,
    historyStart: 0,
    permissions: [],
    questions: [],
    availableCommands: [],
    lastContentEventAt: undefined,
    completedAt: undefined,
  };
}

function normalizeSessionRecord(session: SessionRecord): SessionRecord {
  const normalizedEngine: SessionEngine = session.engine === "acp" ? "acp" : "cli";
  const normalizedAcp = normalizedEngine === "acp"
    ? {
        ...createEmptyAcpState(),
        ...session.acp,
        modes: session.acp?.modes ?? [],
        timeline: session.acp?.timeline ?? [],
        permissions: session.acp?.permissions ?? [],
        questions: session.acp?.questions ?? [],
        availableCommands: session.acp?.availableCommands ?? [],
      }
    : undefined;

  return {
    ...session,
    engine: normalizedEngine,
    activityState: session.activityState ?? "idle",
    switchable: session.switchable ?? !getSwitchBlockedReasonFromSession({ ...session, engine: normalizedEngine, acp: normalizedAcp }),
    switchBlockedReason: session.switchBlockedReason ?? getSwitchBlockedReasonFromSession({ ...session, engine: normalizedEngine, acp: normalizedAcp }) ?? undefined,
    acp: normalizedAcp,
  };
}

function stringifyValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateText(value: string, maxLength: number) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "(空)";
  }
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}...`;
}

function normalizeAvailableCommands(rawValue: unknown): AvailableCommand[] {
  if (!Array.isArray(rawValue)) {
    return [];
  }
  return rawValue
    .map((item) => {
      if (typeof item === "string") {
        return { name: item, description: "", inputType: "unstructured" as const };
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        const name =
          typeof record.name === "string" ? record.name :
          typeof record.command === "string" ? record.command : "";
        return name
          ? {
              name,
              description: typeof record.description === "string" ? record.description : "",
              inputType: "unstructured" as const,
            }
          : null;
      }
      return null;
    })
    .filter((item): item is AvailableCommand => item !== null);
}

function extractChunkText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => extractChunkText(item)).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (record.type === "resource" && record.resource && typeof record.resource === "object") {
      const resource = record.resource as Record<string, unknown>;
      if (typeof resource.text === "string") {
        return resource.text;
      }
    }
  }
  return stringifyValue(content);
}

async function extractClipboardImages(event: ReactClipboardEvent<HTMLTextAreaElement>) {
  const imageFiles = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));

  if (imageFiles.length === 0) {
    return [] as PendingImage[];
  }

  event.preventDefault();
  return await Promise.all(imageFiles.map((file) => fileToPendingImage(file)));
}

function fileToPendingImage(file: File) {
  return new Promise<PendingImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = dataUrl.indexOf(",");
      resolve({
        id: makeId(),
        dataUrl,
        data: commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl,
        mimeType: file.type || "image/png",
      });
    };
    reader.readAsDataURL(file);
  });
}

function getSessionStateSummary(session: SessionRecord) {
  if (session.engine === "acp" && session.acp) {
    if (session.connectionState === "error") {
      return { label: "异常", tone: "error" as const };
    }
    if (session.acp.permissions.length > 0 || session.acp.questions.length > 0) {
      return { label: "待处理", tone: "pending" as const };
    }
    if (isAcpBusy(session.acp)) {
      return { label: "运行中", tone: "running" as const };
    }
    return { label: "空闲", tone: "connected" as const };
  }
  if (session.activityState === "running") {
    return { label: "运行中", tone: "running" as const };
  }
  if (session.activityState === "pending") {
    return { label: "待处理", tone: "pending" as const };
  }
  if (session.connectionState === "error") {
    return { label: "异常", tone: "error" as const };
  }
  return { label: "空闲", tone: "connected" as const };
}

function getSwitchBlockedReasonFromSession(session: SessionRecord) {
  if (session.connectionState === "connecting") {
    return "连接中";
  }
  if (session.engine === "acp" && session.acp) {
    if (session.acp.permissions.length > 0) return "待审批";
    if (session.acp.questions.length > 0) return "待提问";
    if (isAcpBusy(session.acp)) return "运行中";
    return null;
  }
  if (session.activityState === "running") return "运行中";
  if (session.activityState === "pending") return "待处理";
  return null;
}

function canSwitchSessionEngine(session: SessionRecord, target: SessionEngine) {
  return session.engine !== target && !getSwitchBlockedReasonFromSession(session);
}

function engineSwitchTitle(session: SessionRecord, target: SessionEngine) {
  if (session.engine === target) {
    return `当前已在 ${target.toUpperCase()} 引擎`;
  }
  const reason = getSwitchBlockedReasonFromSession(session);
  return reason ? `当前不可切换：${reason}` : `切换到 ${target.toUpperCase()}`;
}

const ACP_CONTENT_GRACE_MS = 2000;

function labelForMode(modeId: string) {
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
      return modeId;
  }
}

function isAcpSessionRunning(session: SessionRecord) {
  if (!session.acp) {
    return false;
  }
  return Boolean(
    session.acp.permissions.length > 0
    || session.acp.questions.length > 0
    || isAcpBusy(session.acp),
  );
}

function isAcpBusy(acp: NonNullable<SessionRecord["acp"]>) {
  if (!acp.busy) {
    return false;
  }
  const latestItem = acp.timeline.at(-1);
  if (latestItem?.kind === "system" && latestItem.title === "本轮完成") {
    return false;
  }
  return true;
}

function shouldKeepAcpSessionRunningAfterPromptFinished(stopReason: string) {
  const normalized = stopReason.trim().toLowerCase();
  return normalized === "pause_turn" || normalized === "pause-turn" || normalized.includes("permission");
}

function applyAcpPromptStarted(
  session: SessionRecord,
  payload: { promptId: string; text: string },
  images?: Array<{ data: string; mimeType: string }>,
) {
  if (session.engine !== "acp" || !session.acp) {
    return session;
  }

  return appendAcpTimelineItem(
    normalizeSessionRecord({
      ...session,
      acp: {
        ...session.acp,
        busy: true,
      },
    }),
    {
      id: payload.promptId,
      kind: "user",
      title: "你",
      body: payload.text,
      images,
    },
  );
}

function applyAcpPromptFinished(
  session: SessionRecord,
  payload: { stopReason: string },
) {
  if (session.engine !== "acp" || !session.acp) {
    return session;
  }

  const keepRunning = shouldKeepAcpSessionRunningAfterPromptFinished(payload.stopReason);
  return appendAcpTimelineItem(
    normalizeSessionRecord({
      ...session,
      acp: {
        ...session.acp,
        busy: keepRunning,
        completedAt: keepRunning ? session.acp.completedAt : Date.now(),
      },
    }),
    {
      id: makeId(),
      kind: "system",
      title: keepRunning ? "等待待处理中" : "本轮完成",
      body: payload.stopReason,
    },
  );
}

function applyAcpPermissionRequested(session: SessionRecord, payload: PermissionPayload) {
  if (session.engine !== "acp" || !session.acp) {
    return session;
  }

  const next = normalizeSessionRecord({
    ...session,
    acp: {
      ...session.acp,
      permissions: [...session.acp.permissions, payload],
    },
  });

  return upsertAcpToolTimelineItem(next, {
    sessionUpdate: "tool_call",
    toolCallId: payload.toolCall.toolCallId,
    title: payload.toolCall.title,
    status: payload.toolCall.status ?? "pending",
    rawInput: payload.toolCall.rawInput,
  });
}

function applyAcpPermissionResolved(
  session: SessionRecord,
  payload: { requestId: string },
) {
  if (session.engine !== "acp" || !session.acp) {
    return session;
  }

  return normalizeSessionRecord({
    ...session,
    acp: {
      ...session.acp,
      permissions: session.acp.permissions.filter((permission) => permission.requestId !== payload.requestId),
    },
  });
}

function applyAcpQuestionRequested(session: SessionRecord, payload: QuestionPayload) {
  if (session.engine !== "acp" || !session.acp) {
    return session;
  }

  return appendAcpTimelineItem(
    normalizeSessionRecord({
      ...session,
      acp: {
        ...session.acp,
        questions: [...session.acp.questions, payload],
      },
    }),
    {
      id: payload.questionId,
      kind: "system",
      title: "提问",
      body: payload.header ? `【${payload.header}】${payload.question}` : payload.question,
      meta: "pending",
    },
  );
}

function applyAcpQuestionAnswered(
  session: SessionRecord,
  payload: { questionId: string },
) {
  if (session.engine !== "acp" || !session.acp) {
    return session;
  }

  return normalizeSessionRecord({
    ...session,
    acp: {
      ...session.acp,
      questions: session.acp.questions.filter((question) => question.questionId !== payload.questionId),
    },
  });
}

function applyAcpError(
  session: SessionRecord,
  payload: { message: string; fatal: boolean },
) {
  if (session.engine !== "acp" || !session.acp) {
    return payload.fatal
      ? normalizeSessionRecord({ ...session, connectionState: "error", updatedAt: new Date().toISOString() })
      : session;
  }

  const next = normalizeSessionRecord({
    ...session,
    connectionState: payload.fatal ? "error" : session.connectionState,
    acp: {
      ...session.acp,
      busy: payload.fatal ? false : session.acp.busy,
    },
  });

  return appendAcpTimelineItem(next, {
    id: makeId(),
    kind: "error",
    title: payload.fatal ? "错误" : "警告",
    body: payload.message,
  });
}

function appendAcpTimelineItem(session: SessionRecord, item: TimelineItem): SessionRecord {
  if (session.engine !== "acp" || !session.acp) {
    return session;
  }

  return normalizeSessionRecord({
    ...session,
    acp: {
      ...session.acp,
      timeline: [...session.acp.timeline, normalizeTimelineItem(item)],
      historyTotal: Math.max(session.acp.historyTotal, session.acp.timeline.length + 1),
    },
  });
}

function appendAcpTextChunk(
  session: SessionRecord,
  kind: TimelineItem["kind"],
  title: string,
  text: string,
  parentToolCallId?: string,
) {
  if (session.engine !== "acp" || !session.acp) {
    return session;
  }

  const lastItem = session.acp.timeline.at(-1);
  if (
    lastItem &&
    lastItem.kind === kind &&
    lastItem.title === title &&
    !lastItem.meta &&
    (lastItem.parentToolCallId ?? undefined) === parentToolCallId
  ) {
    return normalizeSessionRecord({
      ...session,
      acp: {
        ...session.acp,
        timeline: [
          ...session.acp.timeline.slice(0, -1),
          {
            ...lastItem,
            body: lastItem.body + text,
          },
        ],
      },
    });
  }

  return appendAcpTimelineItem(session, {
    id: makeId(),
    kind,
    title,
    body: text,
    parentToolCallId,
  });
}

function upsertAcpToolTimelineItem(
  session: SessionRecord,
  update: { sessionUpdate: string; toolCallId?: unknown; title?: unknown; status?: unknown; rawInput?: unknown; rawOutput?: unknown; _meta?: unknown },
) {
  if (session.engine !== "acp" || !session.acp) {
    return session;
  }

  const nextItem = buildToolTimelineItem(update);
  const nextToolCallId = typeof update.toolCallId === "string" ? update.toolCallId : null;

  if (nextToolCallId) {
    let existingIndex = -1;
    for (let index = session.acp.timeline.length - 1; index >= 0; index -= 1) {
      const item = session.acp.timeline[index];
      if (item?.kind === "system" && item.title === "本轮完成") {
        break;
      }
      if (item?.kind !== "tool") {
        continue;
      }
      if (canMergeToolTimelineItem(item, nextItem, nextToolCallId)) {
        const itemMeta = readToolMeta(item);
        if (!isTerminalToolStatus(itemMeta?.status ?? null)) {
          existingIndex = index;
          break;
        }
        if (existingIndex < 0) {
          existingIndex = index;
        }
      }
    }

    if (existingIndex >= 0) {
      const updatedTimeline = [...session.acp.timeline];
      updatedTimeline[existingIndex] = mergeToolTimelineItems(updatedTimeline[existingIndex] ?? nextItem, nextItem);
      return normalizeSessionRecord({
        ...session,
        acp: {
          ...session.acp,
          timeline: updatedTimeline,
        },
      });
    }
  }

  return appendAcpTimelineItem(session, nextItem);
}

function applyAcpSessionUpdate(session: SessionRecord, payload: { clientSessionId: string; sessionUpdate: string; [key: string]: unknown }) {
  if (session.engine !== "acp" || !session.acp) {
    return session;
  }

  const isContentEvent =
    payload.sessionUpdate === "agent_message_chunk" ||
    payload.sessionUpdate === "agent_thought_chunk" ||
    payload.sessionUpdate === "tool_call" ||
    payload.sessionUpdate === "tool_call_update" ||
    payload.sessionUpdate === "plan";

  let nextSession = session;
  if (isContentEvent) {
    nextSession = normalizeSessionRecord({
      ...nextSession,
      acp: {
        ...nextSession.acp!,
        lastContentEventAt: Date.now(),
      },
    });
  }

  switch (payload.sessionUpdate) {
    case "available_commands_update":
      return normalizeSessionRecord({
        ...nextSession,
        acp: {
          ...nextSession.acp!,
          availableCommands: normalizeAvailableCommands(
            payload.availableCommands ?? payload.supportedCommands ?? payload.commands,
          ),
        },
      });
    case "agent_message_chunk": {
      const chunkText = extractChunkText(payload.content);
      if (!chunkText) {
        return nextSession;
      }
      return appendAcpTextChunk(nextSession, "agent", "Claude", chunkText, extractParentToolCallId(payload));
    }
    case "agent_thought_chunk": {
      const chunkText = extractChunkText(payload.content);
      if (!chunkText) {
        return nextSession;
      }
      return appendAcpTextChunk(nextSession, "thought", "思路", chunkText, extractParentToolCallId(payload));
    }
    case "tool_call":
    case "tool_call_update":
      return upsertAcpToolTimelineItem(nextSession, payload);
    case "plan":
      return appendAcpTimelineItem(nextSession, {
        id: makeId(),
        kind: "system",
        title: "执行计划",
        body: stringifyValue(payload.entries ?? payload),
        parentToolCallId: extractParentToolCallId(payload),
      });
    case "current_mode_update": {
      const nextModeId = String(payload.currentModeId ?? "").trim();
      return appendAcpTimelineItem(
        normalizeSessionRecord({
          ...nextSession,
          acp: {
            ...nextSession.acp!,
            currentModeId: nextModeId || nextSession.acp!.currentModeId || "default",
            defaultModeId: nextModeId || nextSession.acp!.defaultModeId,
          },
        }),
        {
          id: makeId(),
          kind: "system",
          title: "模式切换",
          body: nextModeId || "unknown",
        },
      );
    }
    default:
      return nextSession;
  }
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
    return { title: "计划确认", body: record.plan };
  }

  const filePath = typeof record.file_path === "string" ? record.file_path : typeof record.path === "string" ? record.path : null;
  const content = typeof record.content === "string" ? record.content : typeof record.text === "string" ? record.text : null;
  if (filePath?.includes("/.claude/plans/") && content) {
    return { title: "计划", body: content };
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function extractParentToolCallId(update: Record<string, unknown>): string | undefined {
  const meta = asRecord(update._meta);
  const claudeCode = asRecord(meta?.claudeCode);
  const parentId = claudeCode?.parentToolUseId;
  return typeof parentId === "string" && parentId ? parentId : undefined;
}

function normalizeAcpToolTitle(rawTitle: unknown): string {
  if (typeof rawTitle !== "string") {
    return "";
  }
  return rawTitle.replace(/^mcp__acp__/i, "");
}

function buildToolTimelineItem(update: {
  sessionUpdate: string;
  toolCallId?: unknown;
  title?: unknown;
  status?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: unknown;
}): TimelineItem {
  const normalizedTitle = normalizeAcpToolTitle(update.title) || undefined;
  const parentToolCallId = extractParentToolCallId(update as Record<string, unknown>);
  return {
    id: makeId(),
    kind: "tool",
    title: summarizeToolTitle(normalizedTitle, update.rawInput, update.toolCallId),
    body: formatToolDetails({
      toolCallId: update.toolCallId,
      title: normalizedTitle,
      status: update.status,
      rawInput: update.rawInput,
      rawOutput: update.rawOutput,
      parentToolCallId,
    }),
    meta: String(update.status ?? update.sessionUpdate),
    parentToolCallId,
  };
}

function canMergeToolTimelineItem(existingItem: TimelineItem, incomingItem: TimelineItem, toolCallId: string) {
  if (existingItem.kind !== "tool" || incomingItem.kind !== "tool") {
    return false;
  }
  const existingMeta = readToolMeta(existingItem);
  const incomingMeta = readToolMeta(incomingItem);
  if (existingMeta?.toolCallId !== toolCallId || incomingMeta?.toolCallId !== toolCallId) {
    return false;
  }
  const existingIsSubagent = isSubagentToolTitle(existingMeta.rawTitle ?? existingMeta.title);
  const incomingIsSubagent = isSubagentToolTitle(incomingMeta.rawTitle ?? incomingMeta.title);
  return existingIsSubagent === incomingIsSubagent;
}

function mergeToolTimelineItems(existingItem: TimelineItem, incomingItem: TimelineItem) {
  const existingEntries = parseToolTimelineEntries(existingItem.body);
  const incomingEntries = parseToolTimelineEntries(incomingItem.body);
  const mergedEntries = [...existingEntries, ...incomingEntries];
  const mergedParent = incomingItem.parentToolCallId ?? existingItem.parentToolCallId;
  return {
    ...incomingItem,
    id: existingItem.id,
    title: resolveToolDisplayTitle(mergedEntries, incomingItem.title),
    body: stringifyValue(mergedEntries),
    parentToolCallId: mergedParent,
  } satisfies TimelineItem;
}

function parseToolTimelineEntries(body: string) {
  const parsed = tryParseJson(body);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed !== null) {
    return [parsed];
  }
  return [body];
}

function resolveToolDisplayTitle(entries: unknown[], fallbackTitle: string) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const record = asRecord(entries[index]);
    if (!record) continue;
    const inputRecord = asRecord(record.rawInput) ?? asRecord(tryParseJson(record.rawInput));
    const description = typeof inputRecord?.description === "string" ? inputRecord.description.trim() : "";
    if (description && !isSubagentToolTitle(description)) {
      return description;
    }
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const record = asRecord(entries[index]);
    const title = typeof record?.title === "string" ? record.title.trim() : "";
    if (title) {
      return title;
    }
  }

  return fallbackTitle;
}

function summarizeToolTitle(rawTitle: unknown, rawInput: unknown, rawToolCallId: unknown) {
  const title = normalizeAcpToolTitle(rawTitle).trim();
  const record = asRecord(rawInput) ?? asRecord(tryParseJson(rawInput));
  const subagentTitle = summarizeSubagentToolTitle(title, record);
  if (subagentTitle) {
    return subagentTitle;
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

  if (description) {
    return description;
  }

  const summary = [command, pathValue, args].filter(Boolean).join(" · ");
  if (summary) {
    return summary;
  }
  if (title) {
    return title;
  }
  return typeof rawToolCallId === "string" ? `工具 ${rawToolCallId}` : "工具调用";
}

function summarizeSubagentToolTitle(title: string, record: Record<string, unknown> | null) {
  if (!isSubagentToolTitle(title)) {
    return null;
  }
  const preferred = readSubagentSummary(record);
  return preferred ? `${title || "Task"} · ${preferred}` : title || "Task";
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

function formatToolDetails(details: {
  toolCallId?: unknown;
  title?: unknown;
  status?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  parentToolCallId?: string;
}) {
  return stringifyValue({
    toolCallId: details.toolCallId,
    title: details.title,
    status: details.status,
    rawInput: details.rawInput,
    rawOutput: details.rawOutput,
    ...(details.parentToolCallId ? { parentToolCallId: details.parentToolCallId } : undefined),
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

function isSubagentToolTitle(title: string | null) {
  const normalized = (title ?? "").toLowerCase();
  return normalized.includes("subagent") || normalized === "task" || normalized.includes(" task");
}

function isTerminalToolStatus(status: string | null) {
  const normalized = (status ?? "").toLowerCase();
  return normalized === "completed" || normalized === "failed" || normalized === "canceled" || normalized === "cancelled";
}

function readToolMeta(item: TimelineItem): { title: string | null; rawTitle: string | null; status: string | null; toolCallId: string | null } | null {
  if (item.kind !== "tool") {
    return null;
  }
  const entries = parseToolTimelineEntries(item.body);
  const latestRecord = [...entries].reverse().map((entry) => asRecord(entry)).find((entry) => entry !== null) ?? null;
  const rawTitle = typeof latestRecord?.title === "string" ? latestRecord.title : null;
  const title = resolveToolDisplayTitle(entries, item.title) || item.title;
  const status = typeof latestRecord?.status === "string" ? latestRecord.status : item.meta ?? null;
  const toolCallId = typeof latestRecord?.toolCallId === "string" ? latestRecord.toolCallId : null;
  return { title, rawTitle, status, toolCallId };
}

function buildTimelineTreeRows(items: TimelineItem[]): TimelineTreeRow[] {
  const rows: TimelineTreeRow[] = [];
  const activeRoots: Array<{ rootId: string; toolCallId: string | null; rowIndex: number; depth: number }> = [];
  const allRootsByToolCallId = new Map<string, { rootId: string; toolCallId: string; rowIndex: number; depth: number }>();
  let lastMatchedRoot: { rootId: string; toolCallId: string | null; rowIndex: number; depth: number } | null = null;

  for (const item of items) {
    const toolMeta = readToolMeta(item);
    const shouldHandleAsSubagent = Boolean(toolMeta && isSubagentToolTitle(toolMeta.rawTitle ?? toolMeta.title));

    if (toolMeta?.toolCallId) {
      const candidateSummary = buildSubagentSummaryFromChild(toolMeta.title);
      if (candidateSummary) {
        let matchedRoot = findParentRoot(activeRoots, item.parentToolCallId, toolMeta.toolCallId);
        if (!matchedRoot && item.parentToolCallId) {
          matchedRoot = allRootsByToolCallId.get(item.parentToolCallId) ?? null;
        }
        if (matchedRoot) {
          const row = rows[matchedRoot.rowIndex];
          if (row && !row.displayTitle) {
            row.displayTitle = `${row.item.title || "Task"} · ${candidateSummary}`;
          }
        }
      }
    }

    const isTerminalByToolCall = Boolean(toolMeta?.toolCallId && isTerminalToolStatus(toolMeta.status));
    if (isTerminalByToolCall) {
      const closedRoot = closeSubagentRoot(activeRoots, toolMeta?.toolCallId ?? null, false);
      if (closedRoot) {
        const row = rows[closedRoot.rowIndex];
        if (row) {
          row.item = { ...item, id: row.item.id };
        }
        if (lastMatchedRoot?.rootId === closedRoot.rootId) {
          lastMatchedRoot = null;
        }
        continue;
      }
    }

    if (!shouldHandleAsSubagent) {
      let parentRoot = findParentRoot(activeRoots, item.parentToolCallId, toolMeta?.toolCallId);
      if (!parentRoot && item.parentToolCallId) {
        parentRoot = allRootsByToolCallId.get(item.parentToolCallId) ?? null;
      }
      if (!parentRoot && activeRoots.length > 1 && lastMatchedRoot) {
        const stillActive = activeRoots.some((root) => root.rootId === lastMatchedRoot?.rootId);
        if (stillActive) {
          parentRoot = lastMatchedRoot;
        }
      }
      if (parentRoot) {
        lastMatchedRoot = parentRoot;
      }
      rows.push({
        item,
        depth: parentRoot ? parentRoot.depth + 1 : 0,
        rootId: parentRoot?.rootId ?? null,
      });
      continue;
    }

    if (!toolMeta) {
      continue;
    }

    let parentRoot = findParentRoot(activeRoots, item.parentToolCallId, toolMeta.toolCallId, false);
    if (!parentRoot && item.parentToolCallId) {
      parentRoot = allRootsByToolCallId.get(item.parentToolCallId) ?? null;
    }
    const depth = parentRoot ? parentRoot.depth + 1 : 0;
    rows.push({
      item,
      depth,
      rootId: parentRoot?.rootId ?? null,
    });

    if (toolMeta.toolCallId) {
      allRootsByToolCallId.set(toolMeta.toolCallId, { rootId: item.id, toolCallId: toolMeta.toolCallId, rowIndex: rows.length - 1, depth });
    }
    if (!isTerminalToolStatus(toolMeta.status)) {
      activeRoots.push({ rootId: item.id, toolCallId: toolMeta.toolCallId, rowIndex: rows.length - 1, depth });
    }
  }

  return regroupTreeRows(rows);
}

function closeSubagentRoot(
  activeRoots: Array<{ rootId: string; toolCallId: string | null; rowIndex: number; depth: number }>,
  toolCallId: string | null,
  allowFallback = true,
) {
  if (toolCallId) {
    let closedRoot: { rootId: string; toolCallId: string | null; rowIndex: number; depth: number } | null = null;
    for (let index = activeRoots.length - 1; index >= 0; index -= 1) {
      if (activeRoots[index]?.toolCallId === toolCallId) {
        const [removed] = activeRoots.splice(index, 1);
        if (removed) {
          closedRoot = removed;
        }
      }
    }
    if (closedRoot) {
      return closedRoot;
    }
  }

  if (allowFallback && activeRoots.length === 1) {
    return activeRoots.pop() ?? null;
  }
  return null;
}

function regroupTreeRows(rows: TimelineTreeRow[]): TimelineTreeRow[] {
  const childrenByRoot = new Map<string, TimelineTreeRow[]>();
  const topLevel: TimelineTreeRow[] = [];

  for (const row of rows) {
    if (row.rootId) {
      const children = childrenByRoot.get(row.rootId) ?? [];
      children.push(row);
      childrenByRoot.set(row.rootId, children);
    } else {
      topLevel.push(row);
    }
  }

  const result: TimelineTreeRow[] = [];
  function insertWithChildren(row: TimelineTreeRow) {
    result.push(row);
    const children = childrenByRoot.get(row.item.id);
    if (children) {
      for (const child of children) {
        insertWithChildren(child);
      }
    }
  }

  for (const row of topLevel) {
    insertWithChildren(row);
  }

  if (result.length < rows.length) {
    const insertedIds = new Set(result.map((row) => row.item.id));
    for (const row of rows) {
      if (!insertedIds.has(row.item.id)) {
        result.push(row);
      }
    }
  }

  return result;
}

function findParentRoot(
  activeRoots: Array<{ rootId: string; toolCallId: string | null; rowIndex: number; depth: number }>,
  parentToolCallId: string | undefined,
  toolCallId: string | null | undefined,
  allowFallback = true,
) {
  if (parentToolCallId) {
    for (let index = activeRoots.length - 1; index >= 0; index -= 1) {
      if (activeRoots[index]?.toolCallId === parentToolCallId) {
        return activeRoots[index]!;
      }
    }
  }
  if (toolCallId) {
    for (let index = activeRoots.length - 1; index >= 0; index -= 1) {
      if (activeRoots[index]?.toolCallId === toolCallId) {
        return activeRoots[index]!;
      }
    }
  }
  if (allowFallback && activeRoots.length === 1) {
    return activeRoots[0]!;
  }
  return null;
}

function buildSubagentSummaryFromChild(title: string | null) {
  const normalized = (title ?? "").trim();
  if (!normalized || isSubagentToolTitle(normalized) || /^工具\s+tool_/.test(normalized) || /^tool_/.test(normalized)) {
    return null;
  }
  return normalized;
}

function resolveCollapsedSubagentStatusHint(
  item: TimelineItem,
  childCount: number,
  collapsed: boolean,
  sessionRunning: boolean,
): "running" | "completed" | null {
  if (item.kind !== "tool" || childCount < 1 || !collapsed) {
    return null;
  }
  const status = readToolMeta(item)?.status?.toLowerCase() ?? "";
  if (status === "completed") {
    return "completed";
  }
  if (status === "running" || sessionRunning) {
    return "running";
  }
  return null;
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

function toSingleLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function toPreviewText(value: string, maxLength = 280) {
  const normalized = value.trim();
  if (!normalized) {
    return "(空)";
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

function truncatePendingToolLabel(label: string, max = 220) {
  const normalized = toSingleLine(label);
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
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

  return blocks.map((block, blockIndex) => {
    if (block.kind === "heading") {
      const headingContent = renderMarkdownInline(block.lines[0] ?? "");
      switch (Math.min(block.level ?? 3, 6)) {
        case 1:
          return <h1 key={`md-heading-${blockIndex}`}>{headingContent}</h1>;
        case 2:
          return <h2 key={`md-heading-${blockIndex}`}>{headingContent}</h2>;
        case 3:
          return <h3 key={`md-heading-${blockIndex}`}>{headingContent}</h3>;
        case 4:
          return <h4 key={`md-heading-${blockIndex}`}>{headingContent}</h4>;
        case 5:
          return <h5 key={`md-heading-${blockIndex}`}>{headingContent}</h5>;
        default:
          return <h6 key={`md-heading-${blockIndex}`}>{headingContent}</h6>;
      }
    }
    if (block.kind === "list") {
      return (
        <ul key={`md-list-${blockIndex}`}>
          {block.lines.map((item, itemIndex) => (
            <li key={`md-list-${blockIndex}-${itemIndex}`}>{renderMarkdownInline(item)}</li>
          ))}
        </ul>
      );
    }
    if (block.kind === "code") {
      return (
        <pre key={`md-code-${blockIndex}`}>
          <code>{block.lines.join("\n")}</code>
        </pre>
      );
    }
    if (block.kind === "table") {
      return (
        <table key={`md-table-${blockIndex}`}>
          <thead>
            <tr>
              {block.headers.map((header, cellIndex) => (
                <th key={`md-table-${blockIndex}-h-${cellIndex}`}>{renderMarkdownInline(header)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`md-table-${blockIndex}-r-${rowIndex}`}>
                {block.headers.map((_, cellIndex) => (
                  <td key={`md-table-${blockIndex}-r-${rowIndex}-c-${cellIndex}`}>
                    {renderMarkdownInline(row[cellIndex] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    return <p key={`md-paragraph-${blockIndex}`}>{renderMarkdownInline(block.lines.join(" "))}</p>;
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
  return parts.map((part, partIndex) => {
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^\)]+)\)$/);
    if (linkMatch) {
      return (
        <a key={`md-link-${partIndex}`} href={linkMatch[2]} target="_blank" rel="noreferrer">
          {linkMatch[1]}
        </a>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={`md-bold-${partIndex}`}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={`md-italic-${partIndex}`}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={`md-inline-${partIndex}`}>{part.slice(1, -1)}</code>;
    }
    return <Fragment key={`md-text-${partIndex}`}>{part}</Fragment>;
  });
}

function shouldRenderMarkdown(item: TimelineItem) {
  return item.kind === "agent" || item.kind === "plan";
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
    default:
      return fallbackTitle;
  }
}

function getPromptCommandCompletions(prompt: string, commands: AvailableCommand[]) {
  const query = extractPromptCommandQuery(prompt);
  if (!query) {
    return [];
  }
  if (query === "/") {
    return commands;
  }
  const normalizedQuery = query.toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(normalizedQuery)).slice(0, 50);
}

function extractPromptCommandQuery(prompt: string) {
  const match = prompt.match(/(^|\s)(\/[^\s]*)$/);
  return match?.[2] ?? null;
}

function applyPromptCommandCompletion(prompt: string, commandName: string) {
  const trimmedName = commandName.trim();
  if (!trimmedName) {
    return prompt;
  }
  if (!prompt.trim()) {
    return `${trimmedName} `;
  }
  const replaced = prompt.replace(/(^|\s)\/[^\s]*$/, (_match, prefix: string) => `${prefix}${trimmedName} `);
  if (replaced !== prompt) {
    return replaced;
  }
  const suffix = prompt.endsWith(" ") || prompt.endsWith("\n") ? "" : " ";
  return `${prompt}${suffix}${trimmedName} `;
}

function buildCompletionSections(commands: AvailableCommand[], query: string | null) {
  if (!query || commands.length === 0) {
    return [];
  }
  return [{ key: "all", title: null, items: commands.map((command, index) => ({ command, index })) }];
}

function splitCompletionLabel(commandName: string, query: string | null) {
  const normalizedQuery = (query ?? "").trim();
  if (!normalizedQuery || !commandName.toLowerCase().startsWith(normalizedQuery.toLowerCase())) {
    return { matched: "", rest: commandName };
  }
  return {
    matched: commandName.slice(0, normalizedQuery.length),
    rest: commandName.slice(normalizedQuery.length),
  };
}

function renderCompletionLabel(commandName: string, query: string | null) {
  const parts = splitCompletionLabel(commandName, query);
  if (!parts.matched) {
    return commandName;
  }
  return (
    <>
      <strong className="composer-completion-match">{parts.matched}</strong>
      <span className="composer-completion-rest">{parts.rest}</span>
    </>
  );
}

function truncateUnknownText(value: unknown, maxLength = 500) {
  const raw = typeof value === "string" ? value : stringifyValue(value);
  const normalized = raw.trim();
  if (!normalized) {
    return "(空)";
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}...（已截断，原始 ${normalized.length} 字符）`;
}

function findLatestExecutionPlanBody(timeline: TimelineItem[]) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item?.kind === "system" && item.title === "执行计划") {
      return item.body;
    }
  }
  return null;
}

function findLatestExecutionPlan(timeline: TimelineItem[]) {
  const planBody = findLatestExecutionPlanBody(timeline);
  return planBody ? truncateUnknownText(planBody, 1800) : null;
}

function parseExecutionPlanSteps(planBody: string | null): ExecutionPlanStep[] {
  const parsed = tryParseJson(planBody);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map((entry): ExecutionPlanStep | null => {
      const record = asRecord(entry);
      if (!record) {
        return null;
      }
      const content = typeof record.content === "string" ? record.content.trim() : "";
      if (!content) {
        return null;
      }
      return {
        content,
        status: normalizeExecutionPlanStepStatus(record.status),
      };
    })
    .filter((step): step is ExecutionPlanStep => Boolean(step));
}

function normalizeExecutionPlanStepStatus(value: unknown): ExecutionPlanStepStatus {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (normalized === "completed") return "completed";
  if (normalized === "in_progress") return "in_progress";
  if (normalized === "pending") return "pending";
  return "unknown";
}

function groupQuestionsByGroup(questions: QuestionPayload[]) {
  const groups = new Map<string, QuestionPayload[]>();
  for (const question of questions) {
    const key = question.groupId ?? question.questionId;
    const group = groups.get(key) ?? [];
    group.push(question);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function submitQuestionGroup(
  questions: QuestionPayload[],
  answers: Record<string, string>,
  onSubmit: (questionId: string, answer: string) => void,
) {
  const lines = questions.map((question) => {
    const prefix = question.header ? `【${question.header}】` : "";
    const answer = answers[question.questionId] ?? "";
    return `${prefix}${question.question}\n→ ${answer}`;
  });
  onSubmit(questions[0].questionId, lines.join("\n\n"));
}

function isReadToolTitle(title: string | null) {
  const normalized = normalizeAcpToolTitle(title).trim().toLowerCase();
  const prefixes = ["read", "readfile", "read_file", "read file", "file_read", "fileread"];
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

function isWriteToolTitle(title: string | null) {
  const normalized = normalizeAcpToolTitle(title).trim().toLowerCase();
  const prefixes = ["write", "writefile", "write_file", "write file"];
  const exact = ["create", "createfile", "create_file", "create file"];
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `)) || exact.some((prefix) => normalized === prefix);
}

function extractPlanText(value: unknown) {
  return extractPlanPreview(value)?.body ?? null;
}

function extractPermissionRawCommand(rawInput: unknown): string {
  const candidates: unknown[] = [rawInput];
  const rootRecord = asRecord(rawInput) ?? asRecord(tryParseJson(rawInput));
  if (rootRecord) {
    candidates.push(rootRecord.command, rootRecord.cmd, rootRecord.text, rootRecord.script);
    for (const nestedKey of ["rawInput", "input", "args", "payload", "params"]) {
      const nested = asRecord(rootRecord[nestedKey]) ?? asRecord(tryParseJson(rootRecord[nestedKey]));
      if (nested) {
        candidates.push(nested.command, nested.cmd, nested.text, nested.script);
      }
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function TimelineRow(props: {
  item: TimelineItem;
  depth?: number;
  childCount?: number;
  collapsed?: boolean;
  statusHint?: "running" | "completed" | null;
  onToggleCollapse?: () => void;
  onOpen: () => void;
}) {
  const expandedPreview = shouldUseExpandedPreview(props.item);
  const bodyClassName = `timeline-body ${expandedPreview ? "multiline" : ""}`;

  return (
    <button
      className={`timeline-row ${props.item.kind} ${expandedPreview ? "timeline-row-multiline" : ""}`}
      style={{ "--timeline-depth": String(props.depth ?? 0) } as CSSProperties}
      type="button"
      onClick={props.onOpen}
    >
      <span className="timeline-kind">
        {labelForKind(props.item.kind, props.item.title)}
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
            {props.statusHint === "running" ? " · 运行中" : props.statusHint === "completed" ? " · 已完成" : ""}
          </span>
        ) : null}
      </span>
      <span className={bodyClassName}>
        {summarizeTimelineItem(props.item, expandedPreview)}
        {props.item.images && props.item.images.length > 0 ? (
          <span className="timeline-image-badge"> 🖼 {props.item.images.length}</span>
        ) : null}
      </span>
      <span className="timeline-meta">{props.item.meta ?? "查看"}</span>
    </button>
  );
}

function ToolCallDetailView(props: { body: string }) {
  const entries = parseToolTimelineEntries(props.body);
  let rawTitle: string | null = null;
  let status: string | null = null;
  let description: string | null = null;
  let command: string | null = null;
  let pathValue: string | null = null;
  let rawOutput: unknown = undefined;

  for (const entry of [...entries].reverse()) {
    const record = asRecord(entry);
    if (!record) continue;
    if (!rawTitle && typeof record.title === "string" && record.title.trim()) rawTitle = record.title.trim();
    if (!status && typeof record.status === "string" && record.status.trim()) status = record.status.trim();
    if (rawOutput === undefined && record.rawOutput !== undefined && record.rawOutput !== null) rawOutput = record.rawOutput;
    const inputRecord = asRecord(record.rawInput) ?? asRecord(tryParseJson(record.rawInput));
    if (inputRecord) {
      if (!description && typeof inputRecord.description === "string" && inputRecord.description.trim()) description = inputRecord.description.trim();
      if (!command) {
        if (typeof inputRecord.command === "string" && inputRecord.command.trim()) {
          command = inputRecord.command.trim();
        } else if (Array.isArray(inputRecord.cmd)) {
          const parts = inputRecord.cmd.filter((part): part is string => typeof part === "string");
          if (parts.length) command = parts.join(" ");
        }
      }
      if (!pathValue) {
        for (const key of ["path", "filePath", "file_path", "cwd"]) {
          const value = inputRecord[key];
          if (typeof value === "string" && value.trim()) {
            pathValue = value.trim();
            break;
          }
        }
      }
    }
  }

  const outputText = rawOutput !== undefined && rawOutput !== null ? (typeof rawOutput === "string" ? rawOutput : stringifyValue(rawOutput)) : null;

  return (
    <div className="tool-detail-view">
      <div className="tool-detail-fields">
        {status ? (
          <div className="tool-detail-row">
            <span className="tool-detail-key">状态</span>
            <span className={`tool-detail-status tool-detail-status-${status.toLowerCase()}`}>{status}</span>
          </div>
        ) : null}
        {description ? (
          <div className="tool-detail-row">
            <span className="tool-detail-key">描述</span>
            <span className="tool-detail-val">{description}</span>
          </div>
        ) : null}
        {command ? (
          <div className="tool-detail-row">
            <span className="tool-detail-key">命令</span>
            <code className="tool-detail-val tool-detail-code">{command}</code>
          </div>
        ) : null}
        {pathValue ? (
          <div className="tool-detail-row">
            <span className="tool-detail-key">路径</span>
            <code className="tool-detail-val tool-detail-code">{pathValue}</code>
          </div>
        ) : null}
      </div>
      {outputText !== null ? (
        <details className="tool-detail-section" open>
          <summary className="tool-detail-summary">输出</summary>
          <pre className="modal-body tool-detail-content">{outputText}</pre>
        </details>
      ) : null}
      <details className="tool-detail-section">
        <summary className="tool-detail-summary">原始数据</summary>
        <pre className="modal-body tool-detail-content">{props.body}</pre>
      </details>
    </div>
  );
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
          <button className="secondary" onClick={props.onClose}>关闭</button>
        </div>
        <div className="modal-scroll-body">
          <p className="modal-meta">{props.item.meta ?? "详细内容"}</p>
          {props.item.images && props.item.images.length > 0 ? (
            <div className="modal-attached-images">
              {props.item.images.map((image, index) => (
                <img
                  key={index}
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={`附件图片 ${index + 1}`}
                  className="modal-attached-image"
                />
              ))}
            </div>
          ) : null}
          {props.item.kind === "tool" ? (
            <ToolCallDetailView body={props.item.body} />
          ) : shouldRenderMarkdown(props.item) ? (
            <div className="modal-body markdown-body">{renderMarkdownBlocks(props.item.body)}</div>
          ) : (
            <pre className="modal-body">{props.item.body}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

function MultiQuestionForm(props: {
  questions: QuestionPayload[];
  onSubmit: (answers: Record<string, string>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [customMode, setCustomMode] = useState<Record<string, boolean>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  const allAnswered = props.questions.every((question) => {
    const answer = answers[question.questionId];
    return answer !== undefined && answer !== "";
  });

  function selectOption(questionId: string, label: string) {
    setAnswers((prev) => ({ ...prev, [questionId]: label }));
    setCustomMode((prev) => ({ ...prev, [questionId]: false }));
  }

  function toggleCustom(questionId: string) {
    setCustomMode((prev) => ({ ...prev, [questionId]: true }));
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
  }

  function setCustomText(questionId: string, text: string) {
    setCustomTexts((prev) => ({ ...prev, [questionId]: text }));
    if (text.trim()) {
      setAnswers((prev) => ({ ...prev, [questionId]: text.trim() }));
    } else {
      setAnswers((prev) => {
        const next = { ...prev };
        delete next[questionId];
        return next;
      });
    }
  }

  return (
    <section className="multi-question-form">
      {props.questions.map((question) => {
        const selectedAnswer = answers[question.questionId];
        const isCustom = customMode[question.questionId] ?? false;
        return (
          <div key={question.questionId} className="question-panel">
            {question.header ? <p className="question-header">{question.header}</p> : null}
            <p className="question-text">{question.question}</p>
            {question.options.length > 0 ? (
              <div className="question-options">
                {question.options.map((option) => (
                  <button
                    key={option.id}
                    className={`question-option-btn ${selectedAnswer === option.label && !isCustom ? "selected" : ""}`}
                    type="button"
                    onClick={() => selectOption(question.questionId, option.label)}
                    title={option.description}
                  >
                    <span className="question-option-label">{option.label}</span>
                    {option.description ? <span className="question-option-desc">{option.description}</span> : null}
                  </button>
                ))}
                <button
                  className={`question-option-btn question-custom-toggle ${isCustom ? "selected" : ""}`}
                  type="button"
                  onClick={() => toggleCustom(question.questionId)}
                >
                  <span className="question-option-label">自定义回答</span>
                </button>
              </div>
            ) : null}
            {isCustom || question.options.length === 0 ? (
              <div className="question-custom-answer">
                <input
                  type="text"
                  className="question-custom-input"
                  placeholder="输入自定义回答..."
                  value={customTexts[question.questionId] ?? ""}
                  onChange={(event) => setCustomText(question.questionId, event.target.value)}
                />
              </div>
            ) : null}
            {selectedAnswer && !isCustom ? <p className="question-selected-answer">已选：{selectedAnswer}</p> : null}
          </div>
        );
      })}
      <button className="question-submit-all" type="button" disabled={!allAnswered} onClick={() => props.onSubmit(answers)}>
        {allAnswered
          ? `提交全部 ${props.questions.length} 个回答`
          : `请回答所有问题 (${Object.keys(answers).filter((key) => answers[key]).length}/${props.questions.length})`}
      </button>
    </section>
  );
}

function PermissionModal(props: {
  sessionTitle: string;
  permission: PermissionPayload;
  onResolve: (permission: PermissionPayload, optionId: string) => void;
  onClose: () => void;
}) {
  const toolTitle = summarizeToolTitle(
    props.permission.toolCall.title,
    props.permission.toolCall.rawInput,
    props.permission.toolCall.toolCallId,
  );
  const body = formatToolBody({
    toolCallId: props.permission.toolCall.toolCallId,
    title: props.permission.toolCall.title,
    status: props.permission.toolCall.status ?? "pending",
    rawInput: props.permission.toolCall.rawInput,
  });
  const planText = extractPlanText(props.permission.toolCall.rawInput);
  const rawCommandText = extractPermissionRawCommand(props.permission.toolCall.rawInput);

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">{props.sessionTitle}</p>
            <h3 title={toolTitle}>{truncatePendingToolLabel(toolTitle, 100)}</h3>
          </div>
          <button className="secondary" onClick={props.onClose}>关闭</button>
        </div>
        <div className="modal-scroll-body">
          <p className="modal-meta">待处理确认</p>
          {planText ? <div className="modal-body markdown-body">{renderMarkdownBlocks(planText)}</div> : <ToolCallDetailView body={body} />}
          {rawCommandText ? (
            <>
              <label htmlFor="permission-raw-command">完整命令</label>
              <textarea id="permission-raw-command" className="permission-command-textarea" value={rawCommandText} readOnly />
            </>
          ) : null}
        </div>
        <div className="modal-footer">
          {props.permission.options.map((option) => (
            <button key={option.optionId} className="secondary" type="button" onClick={() => props.onResolve(props.permission, option.optionId)}>
              {option.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export const appTestables = {
  applyAcpSessionUpdate,
  buildMobileTerminalDraftPayload,
  buildLocationWithAccessKey,
  buildTimelineTreeRows,
  canMergeToolTimelineItem,
  createEmptyAcpState,
  engineSwitchTitle,
  findLatestExecutionPlanBody,
  formatRelativeUpdatedAt,
  groupQuestionsByGroup,
  getAccessKeyFromSearch,
  getSessionStateSummary,
  getSwitchBlockedReasonFromSession,
  normalizePath,
  normalizeTimelineItem,
  normalizeSessionRecord,
  normalizeAvailableCommands,
  parseExecutionPlanSteps,
  parseMarkdownTableRow,
  isMarkdownTableRow,
  isMarkdownTableSeparator,
  shouldRenderMarkdown,
  isWithinRoot,
  parentDirectory,
  formatSessionTitleForDisplay,
  formatWorkspacePathForSidebar,
  getTerminalFontSize,
  mapMobileTerminalActionToSequence,
  resolveWorkspaceLookupPath,
  shouldDisableMobileTerminalInput,
  shouldEnableMobileTerminalInput,
  splitWorkspacePathByAllowedRoots,
  toneForConnectionState,
};
