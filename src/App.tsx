import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  Fragment,
} from "react";

type ActivityState = "running" | "completed" | "pending" | "idle";
type ConnectionState = "connecting" | "connected" | "closed";
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
  updatedAt: string;
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
  | { type: "session_closed"; payload: { clientSessionId: string } }
  | { type: "cli_output"; payload: { clientSessionId: string; data: string } }
  | { type: "cli_exited"; payload: { clientSessionId: string; exitCode: number } }
  | { type: "session_activity"; payload: { clientSessionId: string; activityState: ActivityState } }
  | { type: "session_id_updated"; payload: { clientSessionId: string; newSessionId: string } }
  | { type: "shell_output"; payload: { data: string } }
  | { type: "shell_exited"; payload: { exitCode: number } }
  | { type: "error"; payload: { message: string; fatal: boolean; clientSessionId?: string } };

const VSCODE_LAUNCH_CONFIG_STORAGE_KEY = "leduo_vscode_launch_config";
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
  const [allowSkipPermissions, setAllowSkipPermissions] = useState(false);
  const [directoryBrowserPath, setDirectoryBrowserPath] = useState("");
  const [directoryOptions, setDirectoryOptions] = useState<Array<{ name: string; path: string }>>([]);
  const [directoryError, setDirectoryError] = useState("");
  const [showAllWorkspaceSuggestions, setShowAllWorkspaceSuggestions] = useState(false);

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
  const [sessionFileDiffCache, setSessionFileDiffCache] = useState<Record<string, SessionFileDiffResponse>>({});

  // Bottom shell drawer
  const [terminalOpen, setTerminalOpen] = useState(false);
  const desktopTerminalContainerRef = useRef<HTMLDivElement | null>(null);
  const mobileTerminalContainerRef = useRef<HTMLDivElement | null>(null);

  // Main CLI terminal
  const cliTerminalContainerRef = useRef<HTMLDivElement | null>(null);
  const cliTerminalsRef = useRef<Map<string, { terminal: unknown; fitAddon: unknown; element: HTMLDivElement }>>(new Map());

  const socketRef = useRef<WebSocket | null>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.clientSessionId === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const mobileTerminalFullscreenVisible = mobileTerminalInputDetected && Boolean(activeSession);
  const mobileTerminalInputDisabled = shouldDisableMobileTerminalInput(
    activeSessionId,
    connectionState,
    activeSession?.connectionState,
  );
  const shellPanelVisible = Boolean(
    config?.enableShell && (mobileTerminalFullscreenVisible || terminalOpen),
  );
  const mobileTerminalInputVisible = mobileTerminalInputDetected && !mobileTerminalInputDismissed && Boolean(activeSession);
  const shouldRenderMainContentPanel = !mobileTerminalInputDetected;
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

  function handleEvent(message: EventMessage) {
    switch (message.type) {
      case "ready":
        setSessions(message.payload.sessions);
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
        setSessions((prev) => {
          const exists = prev.some((s) => s.clientSessionId === message.payload.clientSessionId);
          if (exists) {
            return prev.map((s) =>
              s.clientSessionId === message.payload.clientSessionId
                ? { ...s, ...message.payload }
                : s,
            );
          }
          return [...prev, message.payload as SessionRecord];
        });
        setActiveSessionId(message.payload.clientSessionId);
        break;

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
              ? { ...s, activityState: message.payload.activityState }
              : s,
          ),
        );
        break;

      case "session_id_updated":
        setSessions((prev) =>
          prev.map((s) =>
            s.clientSessionId === message.payload.clientSessionId
              ? { ...s, sessionId: message.payload.newSessionId }
              : s,
          ),
        );
        break;

      case "shell_output": {
        // Handled by the bottom shell terminal xterm instance directly
        break;
      }

      case "shell_exited":
        break;

      case "error":
        if (message.payload.clientSessionId) {
          setSessions((prev) =>
            prev.map((s) =>
              s.clientSessionId === message.payload.clientSessionId
                ? { ...s, connectionState: "error", updatedAt: new Date().toISOString() }
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
    if (!data) {
      return false;
    }

    return sendCommand({
      type: "shell_input",
      payload: { data },
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
    if (!activeSessionId || connectionState !== "connected") return;

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
  }, [activeSessionId, connectionState, mobileTerminalInputDetected, mobileTerminalSurface]);

  useLayoutEffect(() => {
    if (!activeSessionId || connectionState !== "connected") {
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

    let disposed = false;
    let cleanupResizeObserver: (() => void) | null = null;

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
      containerEl.innerHTML = "";
      term.open(containerEl);
      fitAddon.fit();

      sendCommand({
        type: "shell_start",
        payload: {
          clientSessionId: activeSession.clientSessionId,
          cols: term.cols,
          rows: term.rows,
        },
      });

      term.onData((data) => {
        sendCommand({ type: "shell_input", payload: { data } });
      });

      term.onResize(({ cols, rows }) => {
        sendCommand({ type: "shell_resize", payload: { cols, rows } });
      });

      // Listen for shell_output events
      const shellHandler = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(String(event.data)) as EventMessage;
          if (msg.type === "shell_output") {
            term.write(msg.payload.data);
          } else if (msg.type === "shell_exited") {
            term.write(`\r\n[Shell exited with code ${msg.payload.exitCode}]\r\n`);
          }
        } catch {
          /* ignore */
        }
      };
      socketRef.current?.addEventListener("message", shellHandler);

      const resizeObserver = new ResizeObserver(() => {
        if (!disposed) fitAddon.fit();
      });
      resizeObserver.observe(containerEl);

      cleanupResizeObserver = () => {
        resizeObserver.disconnect();
        socketRef.current?.removeEventListener("message", shellHandler);
        sendCommand({ type: "shell_stop" });
        term.dispose();
      };
    })();

    return () => {
      disposed = true;
      cleanupResizeObserver?.();
    };
  }, [shellPanelVisible, activeSession?.clientSessionId, config?.enableShell, mobileTerminalInputDetected, mobileTerminalFullscreenVisible]);

  // --- Session actions ---
  function createSession() {
    if (!workspacePath.trim()) return;
    sendCommand({
      type: "create_session",
      payload: {
        workspacePath: workspacePath.trim(),
        title: newSessionTitle.trim() || undefined,
        allowSkipPermissions,
      },
    });
    setCreateSessionModalOpen(false);
    setNewSessionTitle("");
    setAllowSkipPermissions(config?.allowSkipPermissions ?? false);
  }

  function closeSession(clientSessionId: string) {
    sendCommand({ type: "close_session", payload: { clientSessionId } });
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
                  <span className="session-chip-title" title={session.title}>
                    {formatSessionTitleForDisplay(session.title)}
                  </span>
                  <span className="session-chip-meta">
                    {session.connectionState === "connected" ? (
                      <SessionActivityTag activityState={session.activityState} />
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
            <div className="cli-stage">
              <div className="cli-terminal-container" ref={cliTerminalContainerRef} />
            </div>
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

function SessionActivityTag(props: { activityState?: ActivityState }) {
  switch (props.activityState) {
    case "running":
      return <span className="session-chip-tag session-chip-tag-running">运行中</span>;
    case "completed":
      return <span className="session-chip-tag session-chip-tag-completed">已完成</span>;
    case "pending":
      return <span className="session-chip-tag session-chip-tag-pending">待处理</span>;
    default:
      return <span className="session-chip-tag session-chip-tag-completed">已连接</span>;
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

export const appTestables = {
  buildMobileTerminalDraftPayload,
  buildLocationWithAccessKey,
  formatRelativeUpdatedAt,
  getAccessKeyFromSearch,
  normalizePath,
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
