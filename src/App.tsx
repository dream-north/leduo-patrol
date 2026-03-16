import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

type AppConfig = {
  appName: string;
  workspacePath: string;
  allowedRoots: string[];
  sshHost: string;
  sshPath: string;
  vscodeRemoteUri: string;
  enableShell: boolean;
};

type SessionUpdate = {
  sessionUpdate: string;
  [key: string]: unknown;
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
};

type TimelineTreeRow = {
  item: TimelineItem;
  depth: number;
  rootId: string | null;
  displayTitle?: string;
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
  question: string;
  options: Array<{ id: string; label: string }>;
  allowCustomAnswer: boolean;
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
  questions: QuestionPayload[];
  availableCommands?: AvailableCommand[];
  updatedAt: string;
};

type PendingImage = {
  id: string;
  dataUrl: string;
  mimeType: string;
};

type SessionSidebarStatusTone = "pending" | "running" | "completed" | "error" | "connecting";

type SessionSidebarStatus = {
  label: string;
  tone: SessionSidebarStatusTone;
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

type DemoSessionFixture = {
  session: SessionRecord;
  sessionDiff: SessionDiffResponse;
  fileDiffs: Record<string, SessionFileDiffResponse>;
};

type DemoCreateSessionFixture = {
  workspacePath: string;
  title: string;
  modeId: string;
};

type DemoFixtures = {
  bySessionId: Record<string, DemoSessionFixture>;
  createSession: DemoCreateSessionFixture | null;
};

type ExecutionPlanStepStatus = "completed" | "in_progress" | "pending" | "unknown";

type ExecutionPlanStep = {
  content: string;
  status: ExecutionPlanStepStatus;
};

type EventMessage =
  | { type: "ready"; payload: { workspacePath: string; agentConnected: boolean; clientSessionId?: string } }
  | {
      type: "session_registered";
      payload: { clientSessionId: string; title: string; workspacePath: string; defaultModeId?: string; currentModeId?: string };
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
  | {
      type: "session_mode_changed";
      payload: { clientSessionId: string; defaultModeId: string; currentModeId: string };
    }
  | { type: "permission_requested"; payload: PermissionPayload }
  | { type: "permission_resolved"; payload: { clientSessionId: string; requestId: string; optionId: string } }
  | { type: "question_requested"; payload: QuestionPayload }
  | { type: "question_answered"; payload: { clientSessionId: string; questionId: string; answer: string } }
  | { type: "session_closed"; payload: { clientSessionId: string } }
  | { type: "error"; payload: { message: string; clientSessionId?: string } }
  | { type: "shell_output"; payload: { data: string } }
  | { type: "shell_exited"; payload: { exitCode: number } };

const MODE_OPTIONS = [
  { id: "default", label: "Default" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "plan", label: "Plan" },
  { id: "dontAsk", label: "Don't Ask" },
  { id: "bypassPermissions", label: "Bypass Permissions" },
] as const;

const EMPTY_TIMELINE: TimelineItem[] = [];

const FILE_VIEWER_MAX_LINES = 500;

const FILE_VIEWER_MODE_LABEL: Record<"read" | "write", string> = {
  read: "读取",
  write: "写入",
};

type DemoPreset = "subagent-tree" | null;

type ToastNotification = {
  id: string;
  title: string;
  body: string;
  sessionId?: string;
  kind: "permission" | "completion";
};

type VscodeOpenMode = "remote" | "local";

type VscodeLaunchConfig = {
  mode: VscodeOpenMode;
  sshHost: string;
  sshBasePath: string;
  localBasePath: string;
};

const VSCODE_LAUNCH_CONFIG_STORAGE_KEY = "leduo-patrol:vscode-launch-config";

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

function createDefaultVscodeLaunchConfig(config: AppConfig | null): VscodeLaunchConfig {
  return {
    mode: config?.sshHost ? "remote" : "local",
    sshHost: config?.sshHost ?? "",
    sshBasePath: config?.sshPath || config?.workspacePath || "",
    localBasePath: config?.workspacePath || "",
  };
}

function readStoredVscodeLaunchConfig(config: AppConfig | null): VscodeLaunchConfig {
  const fallback = createDefaultVscodeLaunchConfig(config);
  if (typeof window === "undefined") {
    return fallback;
  }
  const raw = window.localStorage.getItem(VSCODE_LAUNCH_CONFIG_STORAGE_KEY);
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<VscodeLaunchConfig>;
    const mode = parsed.mode === "remote" || parsed.mode === "local" ? parsed.mode : fallback.mode;
    return {
      mode,
      sshHost: typeof parsed.sshHost === "string" ? parsed.sshHost : fallback.sshHost,
      sshBasePath: typeof parsed.sshBasePath === "string" ? parsed.sshBasePath : fallback.sshBasePath,
      localBasePath: typeof parsed.localBasePath === "string" ? parsed.localBasePath : fallback.localBasePath,
    };
  } catch {
    return fallback;
  }
}

function createVscodeOpenUri(config: VscodeLaunchConfig, workspacePath: string) {
  const normalizedWorkspacePath = workspacePath.trim();
  if (!normalizedWorkspacePath) {
    return "";
  }
  if (config.mode === "local") {
    return `vscode://file${normalizedWorkspacePath}`;
  }
  const host = config.sshHost.trim();
  if (!host) {
    return "";
  }
  const remoteAuthority = `ssh-remote+${encodeURIComponent(host)}`;
  return `vscode://vscode-remote/${remoteAuthority}${normalizedWorkspacePath}`;
}

function trimTrailingSlash(value: string) {
  const normalized = value.trim();
  if (normalized.length <= 1) {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
}

function mapWorkspacePathForVscode(workspacePath: string, config: VscodeLaunchConfig) {
  const normalizedWorkspacePath = workspacePath.trim();
  if (config.mode !== "remote") {
    return normalizedWorkspacePath;
  }
  const localBase = trimTrailingSlash(config.localBasePath);
  const remoteBase = trimTrailingSlash(config.sshBasePath);
  if (!localBase || !remoteBase) {
    return normalizedWorkspacePath;
  }
  if (normalizedWorkspacePath === localBase) {
    return remoteBase;
  }
  if (normalizedWorkspacePath.startsWith(`${localBase}/`)) {
    return `${remoteBase}${normalizedWorkspacePath.slice(localBase.length)}`;
  }
  return normalizedWorkspacePath;
}

export default function App() {
  const WORKSPACE_SUGGESTION_INITIAL_LIMIT = 8;
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [accessKey, setAccessKey] = useState(() => readAccessKeyFromUrl());
  const [accessKeyInput, setAccessKeyInput] = useState(() => readAccessKeyFromUrl());
  const [authPrompt, setAuthPrompt] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const [newSessionModeId, setNewSessionModeId] = useState("default");
  const [createSessionModalOpen, setCreateSessionModalOpen] = useState(false);
  const [showAllWorkspaceSuggestions, setShowAllWorkspaceSuggestions] = useState(false);
  const [createWorkspaceRoot, setCreateWorkspaceRoot] = useState("");
  const [createWorkspaceSuffix, setCreateWorkspaceSuffix] = useState("");
  const [connectionState, setConnectionState] = useState("connecting");
  const [promptDraftBySessionId, setPromptDraftBySessionId] = useState<Record<string, string>>({});
  const [commandSuggestionIndex, setCommandSuggestionIndex] = useState(0);
  const [isCompletionOpen, setIsCompletionOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [directoryBrowserPath, setDirectoryBrowserPath] = useState("");
  const [directoryRootPath, setDirectoryRootPath] = useState("");
  const [directoryOptions, setDirectoryOptions] = useState<Array<{ name: string; path: string }>>([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [globalTimeline, setGlobalTimeline] = useState<TimelineItem[]>([]);
  const [showGlobalErrors, setShowGlobalErrors] = useState(false);
  const [vscodeSettingsOpen, setVscodeSettingsOpen] = useState(false);
  const [vscodeLaunchError, setVscodeLaunchError] = useState("");
  const [selectedItem, setSelectedItem] = useState<{ sessionTitle: string; item: TimelineItem } | null>(null);
  const [sessionDiff, setSessionDiff] = useState<SessionDiffResponse | null>(null);
  const [sessionDiffError, setSessionDiffError] = useState("");
  const [sessionDiffOpen, setSessionDiffOpen] = useState(false);
  const [sessionDiffLoading, setSessionDiffLoading] = useState(false);
  const [sessionFileDiffCache, setSessionFileDiffCache] = useState<Record<string, SessionFileDiffResponse>>({});
  const [historyLoadingSessionId, setHistoryLoadingSessionId] = useState("");
  const [collapsedSubagentRoots, setCollapsedSubagentRoots] = useState<Record<string, boolean>>({});
  const [demoFixtures, setDemoFixtures] = useState<DemoFixtures | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [pendingQueue, setPendingQueue] = useState<Array<{ id: string; text: string; images?: Array<{ data: string; mimeType: string }> }>>([]);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [permissionDetail, setPermissionDetail] = useState<PermissionPayload | null>(null);
  const [vscodeLaunchConfig, setVscodeLaunchConfig] = useState<VscodeLaunchConfig>(() => readStoredVscodeLaunchConfig(null));
  const shownPermissionRequestIdsRef = useRef(new Set<string>());
  const vscodeConfigHydratedRef = useRef(false);
  const demoPreset = useMemo(() => readDemoPresetFromUrl(), []);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingQueueRef = useRef(pendingQueue);
  const pendingPromptImagesRef = useRef<Map<string, Array<{ data: string; mimeType: string }>>>(new Map());
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const timelineViewportRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const notifiedPermissionRequestIdsRef = useRef<Record<string, true>>({});
  const notifiedCompletionIdsRef = useRef<Record<string, true>>({});
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const toastTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const fitAddonRef = useRef<FitAddon | null>(null);

  const activeSession = sessions.find((session) => session.clientSessionId === activeSessionId) ?? null;
  const promptText = activeSessionId ? (promptDraftBySessionId[activeSessionId] ?? "") : "";
  const setPromptText = (value: string | ((current: string) => string)) => {
    if (!activeSessionId) {
      return;
    }
    setPromptDraftBySessionId((current) => {
      const currentValue = current[activeSessionId] ?? "";
      const nextValue = typeof value === "function" ? value(currentValue) : value;
      if (nextValue === currentValue) {
        return current;
      }
      return { ...current, [activeSessionId]: nextValue };
    });
  };
  pendingQueueRef.current = pendingQueue;
  const activeAvailableCommands = activeSession?.availableCommands ?? [];
  const commandCompletions = useMemo(
    () => getPromptCommandCompletions(promptText, activeAvailableCommands),
    [activeAvailableCommands, promptText],
  );
  const completionQuery = useMemo(() => extractPromptCommandQuery(promptText), [promptText]);
  const completionSections = useMemo(
    () => buildCompletionSections(commandCompletions, completionQuery),
    [commandCompletions, completionQuery],
  );
  const activeSessionHasPendingPermission = Boolean(activeSession && activeSession.permissions.length > 0);
  const activeSessionHasPendingQuestion = Boolean(activeSession && activeSession.questions.length > 0);
  const activeSessionIsRunning = Boolean(activeSession && isSessionRunning(activeSession));
  const activeSessionModeOptions =
    activeSession?.modes.length && activeSession.modes.length > 0
      ? activeSession.modes.map((modeId) => ({ id: modeId, label: labelForMode(modeId) }))
      : MODE_OPTIONS.map((option) => ({ id: option.id, label: option.label }));
  const visibleTimeline = activeSession?.timeline ?? EMPTY_TIMELINE;
  const globalErrorItems = useMemo(() => globalTimeline.filter((item) => item.kind === "error"), [globalTimeline]);
  const timelineRows = useMemo(() => buildTimelineTreeRows(visibleTimeline), [visibleTimeline]);
  const rootChildCount = useMemo(() => countChildrenByRoot(timelineRows), [timelineRows]);
  const latestExecutionPlanBody = useMemo(() => findLatestExecutionPlanBody(visibleTimeline), [visibleTimeline]);
  const latestExecutionPlan = useMemo(() => findLatestExecutionPlan(visibleTimeline), [visibleTimeline]);
  const latestExecutionPlanSteps = useMemo(() => parseExecutionPlanSteps(latestExecutionPlanBody), [latestExecutionPlanBody]);
  const browseRootPath = directoryBrowserPath || activeSession?.workspacePath || config?.workspacePath || "";
  const currentBrowsePath = directoryRootPath || browseRootPath;
  const workspaceForLaunch = useMemo(
    () => mapWorkspacePathForVscode(activeSession?.workspacePath ?? config?.workspacePath ?? "", vscodeLaunchConfig),
    [activeSession?.workspacePath, config?.workspacePath, vscodeLaunchConfig],
  );
  const canOpenWorkspaceInVscode = Boolean(createVscodeOpenUri(vscodeLaunchConfig, workspaceForLaunch));
  const workspaceSuffixSuggestions = useMemo(() => {
    if (!createWorkspaceRoot) {
      return [];
    }
    const query = createWorkspaceSuffix.trim().toLowerCase();
    const candidates = new Set<string>();
    const currentRelative = relativePathFromRoot(createWorkspaceRoot, currentBrowsePath);
    if (currentRelative) {
      candidates.add(currentRelative);
    }
    for (const option of directoryOptions) {
      const relative = relativePathFromRoot(createWorkspaceRoot, option.path);
      if (relative) {
        candidates.add(relative);
      }
    }

    const sorted = Array.from(candidates).sort((a, b) => a.localeCompare(b));
    if (!query) {
      return sorted.slice(0, 30);
    }
    const startsWith = sorted.filter((pathValue) => pathValue.toLowerCase().startsWith(query));
    const includes = sorted.filter((pathValue) => !startsWith.includes(pathValue) && pathValue.toLowerCase().includes(query));
    return [...startsWith, ...includes].slice(0, 30);
  }, [createWorkspaceRoot, createWorkspaceSuffix, currentBrowsePath, directoryOptions]);
  const visibleWorkspaceSuffixSuggestions = showAllWorkspaceSuggestions
    ? workspaceSuffixSuggestions
    : workspaceSuffixSuggestions.slice(0, WORKSPACE_SUGGESTION_INITIAL_LIMIT);
  const hasMoreWorkspaceSuggestions = workspaceSuffixSuggestions.length > WORKSPACE_SUGGESTION_INITIAL_LIMIT;

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
    setPromptDraftBySessionId((current) => {
      if (Object.keys(current).length === 0) {
        return current;
      }
      const validSessionIds = new Set(sessions.map((session) => session.clientSessionId));
      let changed = false;
      const next: Record<string, string> = {};
      for (const [sessionId, draft] of Object.entries(current)) {
        if (validSessionIds.has(sessionId)) {
          next[sessionId] = draft;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [sessions]);

  useEffect(() => {
    setCommandSuggestionIndex(0);
  }, [activeSessionId, promptText, commandCompletions.length]);

  useEffect(() => {
    setPendingQueue([]);
    setPendingImages([]);
    shownPermissionRequestIdsRef.current.clear();
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSession?.permissions.length) {
      setPermissionDetail(null);
      return;
    }
    const first = activeSession.permissions[0];
    if (first && !shownPermissionRequestIdsRef.current.has(first.requestId)) {
      shownPermissionRequestIdsRef.current.add(first.requestId);
      setPermissionDetail(first);
    }
  }, [activeSession?.permissions.length, activeSession?.permissions[0]?.requestId]);

  useEffect(() => {
    if (!activeSessionIsRunning && pendingQueueRef.current.length > 0 && activeSession) {
      const [first, ...rest] = pendingQueueRef.current;
      if (first.images && first.images.length > 0) {
        pendingPromptImagesRef.current.set(activeSession.clientSessionId, first.images);
      }
      const sent = sendCommand({
        type: "prompt",
        payload: {
          clientSessionId: activeSession.clientSessionId,
          text: first.text,
          images: first.images,
        },
      });
      if (sent) {
        setPendingQueue(rest);
      } else {
        pendingPromptImagesRef.current.delete(activeSession.clientSessionId);
      }
    }
  }, [activeSessionIsRunning]);

  useEffect(() => {
    if (commandCompletions.length < 1) {
      setIsCompletionOpen(false);
    }
  }, [commandCompletions.length]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const root = composerContainerRef.current;
      if (!root) {
        return;
      }
      if (event.target instanceof Node && root.contains(event.target)) {
        return;
      }
      setIsCompletionOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, []);

  useEffect(() => {
    setCollapsedSubagentRoots((current) => {
      let changed = false;
      const next = { ...current };
      for (const row of timelineRows) {
        if (!row.item.id || row.item.kind !== "tool") {
          continue;
        }
        const childCount = rootChildCount[row.item.id] ?? 0;
        if (childCount < 1 || !isSubagentToolTitle(row.item.title) || row.item.id in next) {
          continue;
        }
        next[row.item.id] = true;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [rootChildCount, timelineRows]);

  useEffect(() => {
    setDirectoryBrowserPath(activeSession?.workspacePath ?? config?.workspacePath ?? "");
  }, [activeSession?.workspacePath, config?.workspacePath]);

  useEffect(() => {
    if (!config || vscodeConfigHydratedRef.current) {
      return;
    }
    setVscodeLaunchConfig(readStoredVscodeLaunchConfig(config));
    vscodeConfigHydratedRef.current = true;
  }, [config]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(VSCODE_LAUNCH_CONFIG_STORAGE_KEY, JSON.stringify(vscodeLaunchConfig));
  }, [vscodeLaunchConfig]);

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
        const normalizedSessions = stateData.sessions.map(normalizeSessionRecord);
        const fixtures = buildDemoFixtures(configData.workspacePath, demoPreset);
        const createSessionShowcase = fixtures?.createSession;
        const initialWorkspacePath = createSessionShowcase?.workspacePath ?? configData.workspacePath;
        setWorkspacePath(initialWorkspacePath);
        const initialWorkspaceSplit = splitWorkspacePathByAllowedRoots(initialWorkspacePath, configData.allowedRoots);
        setCreateWorkspaceRoot(initialWorkspaceSplit.root);
        setCreateWorkspaceSuffix(initialWorkspaceSplit.suffix);
        setNewSessionTitle(createSessionShowcase?.title ?? "");
        setNewSessionModeId(createSessionShowcase?.modeId ?? "default");
        setDirectoryBrowserPath(resolveWorkspaceLookupPath(initialWorkspaceSplit.root, initialWorkspaceSplit.suffix, []));
        setDemoFixtures(fixtures);
        setSessions(applyDemoPreset(normalizedSessions, fixtures));
        if (createSessionShowcase) {
          setCreateSessionModalOpen(true);
        }
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
    for (const session of sessions) {
      for (const permission of session.permissions) {
        if (notifiedPermissionRequestIdsRef.current[permission.requestId]) {
          continue;
        }
        notifiedPermissionRequestIdsRef.current[permission.requestId] = true;
        const title = "待处理确认";
        const body = `${formatSessionTitleForDisplay(session.title)}: ${summarizeToolTitle(permission.toolCall.title, permission.toolCall.rawInput, permission.toolCall.toolCallId)}`;
        pushInAppToast(permission.requestId, title, body, session.clientSessionId, "permission");
      }

      for (const item of session.timeline) {
        if (item.kind !== "system" || item.title !== "本轮完成") {
          continue;
        }
        if (notifiedCompletionIdsRef.current[item.id]) {
          continue;
        }
        notifiedCompletionIdsRef.current[item.id] = true;
        const title = "任务已完成";
        const body = `${formatSessionTitleForDisplay(session.title)}: ${item.body || "本轮执行完成"}`;
        pushInAppToast(item.id, title, body, session.clientSessionId, "completion");
      }
    }
  }, [sessions]);

  useEffect(() => {
    const pendingCount = sessions.reduce((sum, s) => sum + s.permissions.length + s.questions.length, 0);
    const appName = config?.appName ?? "乐汪队";
    document.title = pendingCount > 0 ? `[${pendingCount} 待确认] ${appName}` : appName;
  }, [sessions, config?.appName]);

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

  useEffect(() => {
    if (!terminalOpen || !config?.enableShell || !activeSessionId) {
      return;
    }
    const container = terminalContainerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let term: any = null;
    let resizeObserver: ResizeObserver | null = null;

    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed) return;

      term = new Terminal({
        theme: {
          background: "#1a1a1a",
          foreground: "#e8e8e8",
          cursor: "#d85b34",
          selectionBackground: "rgba(216, 91, 52, 0.3)",
        },
        fontFamily: '"IBM Plex Mono", "SFMono-Regular", monospace',
        fontSize: 13,
        cursorBlink: true,
        allowTransparency: false,
        scrollback: 1000,
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(container);
      fitAddon.fit();

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;

      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "shell_start", payload: { clientSessionId: activeSessionId, cols: term.cols, rows: term.rows } }));
      }

      term.onData((data: string) => {
        const sock = socketRef.current;
        if (sock && sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: "shell_input", payload: { data } }));
        }
      });

      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        const sock = socketRef.current;
        if (sock && sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: "shell_resize", payload: { cols, rows } }));
        }
      });

      resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
      });
      resizeObserver.observe(container);
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (term) {
        term.dispose();
      }
      xtermRef.current = null;
      fitAddonRef.current = null;
      const sock = socketRef.current;
      if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: "shell_stop" }));
      }
    };
  }, [terminalOpen, config?.enableShell, activeSessionId]);

  function appendGlobalTimeline(item: TimelineItem) {
    setGlobalTimeline((current) => [...current, item]);
  }

  function pushInAppToast(id: string, title: string, body: string, sessionId: string | undefined, kind: ToastNotification["kind"]) {
    setToasts((current) => {
      if (current.some((t) => t.id === id)) return current;
      return [...current, { id, title, body, sessionId, kind }];
    });
    toastTimeoutsRef.current[id] = setTimeout(() => {
      dismissToast(id);
    }, 6000);
  }

  function dismissToast(id: string) {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timeout = toastTimeoutsRef.current[id];
    if (timeout !== undefined) {
      clearTimeout(timeout);
      delete toastTimeoutsRef.current[id];
    }
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

  function upsertToolTimeline(clientSessionId: string, update: SessionUpdate) {
    const nextItem = buildToolTimelineItem(update);
    const nextToolCallId = typeof update.toolCallId === "string" ? update.toolCallId : null;
    setSessions((current) =>
      current.map((session) => {
        if (session.clientSessionId !== clientSessionId) {
          return session;
        }

        if (nextToolCallId) {
          let existingIndex = -1;
          for (let index = session.timeline.length - 1; index >= 0; index -= 1) {
            const item = session.timeline[index];
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
            const updatedTimeline = [...session.timeline];
            updatedTimeline[existingIndex] = mergeToolTimelineItems(updatedTimeline[existingIndex] ?? nextItem, nextItem);
            return {
              ...session,
              timeline: updatedTimeline,
              updatedAt: new Date().toISOString(),
            };
          }
        }

        return {
          ...session,
          timeline: [...session.timeline, normalizeTimelineItem(nextItem)],
          historyTotal: session.historyTotal + 1,
          updatedAt: new Date().toISOString(),
        };
      }),
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
                    title: normalizeSessionTitle(message.payload.title),
                    workspacePath: message.payload.workspacePath,
                  }
                : session,
            );
          }
          return [
            ...current,
            normalizeSessionRecord({
              clientSessionId: message.payload.clientSessionId,
              title: normalizeSessionTitle(message.payload.title),
              workspacePath: message.payload.workspacePath,
              connectionState: "connecting",
              sessionId: "",
              modes: [],
              defaultModeId: message.payload.defaultModeId ?? newSessionModeId,
              currentModeId: message.payload.currentModeId ?? message.payload.defaultModeId ?? newSessionModeId,
              busy: false,
              timeline: [],
              historyTotal: 0,
              historyStart: 0,
              permissions: [],
              questions: [],
              availableCommands: [],
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
      case "prompt_started": {
        const promptImages = pendingPromptImagesRef.current.get(message.payload.clientSessionId);
        pendingPromptImagesRef.current.delete(message.payload.clientSessionId);
        updateSession(message.payload.clientSessionId, (session) => ({ ...session, busy: true }));
        appendSessionTimeline(message.payload.clientSessionId, {
          id: message.payload.promptId,
          kind: "user",
          title: "你",
          body: message.payload.text,
          images: promptImages && promptImages.length > 0 ? promptImages : undefined,
        });
        break;
      }
      case "prompt_finished":
        {
          const keepRunning = shouldKeepSessionRunningAfterPromptFinished(message.payload.stopReason);
          updateSession(message.payload.clientSessionId, (session) => ({ ...session, busy: keepRunning }));
          appendSessionTimeline(message.payload.clientSessionId, {
            id: makeId(),
            kind: "system",
            title: keepRunning ? "等待待处理中" : "本轮完成",
            body: message.payload.stopReason,
          });
        }
        break;
      case "session_mode_changed":
        updateSession(message.payload.clientSessionId, (session) => ({
          ...session,
          defaultModeId: message.payload.defaultModeId,
          currentModeId: message.payload.currentModeId,
        }));
        break;
      case "session_update":
        consumeSessionUpdate(message.payload.clientSessionId, message.payload);
        break;
      case "permission_requested":
        updateSession(message.payload.clientSessionId, (session) => ({
          ...session,
          permissions: [...session.permissions, message.payload],
        }));
        upsertToolTimeline(message.payload.clientSessionId, {
          sessionUpdate: "tool_call",
          toolCallId: message.payload.toolCall.toolCallId,
          title: message.payload.toolCall.title,
          status: message.payload.toolCall.status ?? "pending",
          rawInput: message.payload.toolCall.rawInput,
        });
        break;
      case "permission_resolved":
        updateSession(message.payload.clientSessionId, (session) => ({
          ...session,
          permissions: session.permissions.filter((permission) => permission.requestId !== message.payload.requestId),
        }));
        break;
      case "question_requested":
        updateSession(message.payload.clientSessionId, (session) => ({
          ...session,
          questions: [...session.questions, message.payload],
        }));
        appendSessionTimeline(message.payload.clientSessionId, {
          id: message.payload.questionId,
          kind: "system",
          title: "提问",
          body: message.payload.question,
          meta: "pending",
        });
        break;
      case "question_answered":
        updateSession(message.payload.clientSessionId, (session) => ({
          ...session,
          questions: session.questions.filter((q) => q.questionId !== message.payload.questionId),
        }));
        break;
      case "session_closed":
        setSessions((current) => current.filter((session) => session.clientSessionId !== message.payload.clientSessionId));
        break;
      case "error":
        {
          const structured = parseStructuredLogMessage(message.payload.message);
          if (structured?.level === "warn") {
            if (!message.payload.clientSessionId) {
              appendGlobalTimeline({
                id: makeId(),
                kind: "system",
                title: "提示",
                body: structured.detail,
                meta: "warn",
              });
              break;
            }
            appendSessionTimeline(message.payload.clientSessionId, {
              id: makeId(),
              kind: "system",
              title: "提示",
              body: structured.detail,
              meta: "warn",
            });
            break;
          }
        }
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
      case "shell_output":
        xtermRef.current?.write(message.payload.data);
        break;
      case "shell_exited":
        xtermRef.current?.write(`\r\n\x1b[33m[终端已退出，退出码 ${message.payload.exitCode}]\x1b[0m\r\n`);
        break;
    }
  }

  function consumeSessionUpdate(clientSessionId: string, update: SessionUpdate) {
    switch (update.sessionUpdate) {
      case "available_commands_update": {
        const nextCommands = normalizeAvailableCommands(
          update.availableCommands ?? update.supportedCommands ?? update.commands,
        );
        updateSession(clientSessionId, (session) => ({
          ...session,
          availableCommands: nextCommands,
        }));
        break;
      }
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
        upsertToolTimeline(clientSessionId, update);
        break;
      case "plan":
        appendSessionTimeline(clientSessionId, {
          id: makeId(),
          kind: "system",
          title: "执行计划",
          body: stringifyMaybe(update.entries ?? update),
        });
        break;
      case "current_mode_update": {
        const nextModeId = String(update.currentModeId ?? "").trim();
        updateSession(clientSessionId, (session) => ({
          ...session,
          currentModeId: nextModeId || session.currentModeId || "default",
          defaultModeId: nextModeId || session.defaultModeId,
        }));
        appendSessionTimeline(clientSessionId, {
          id: makeId(),
          kind: "system",
          title: "模式切换",
          body: nextModeId || "unknown",
        });
        break;
      }
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
      setCreateSessionModalOpen(false);
      setShowAllWorkspaceSuggestions(false);
      setCreateWorkspaceSuffix("");
      setWorkspacePath("");
    }
  }

  function submitPrompt() {
    const text = promptText.trim();
    if ((!text && pendingImages.length === 0) || !activeSession) {
      return;
    }
    const images = pendingImages.flatMap((img) => {
      const commaIndex = img.dataUrl.indexOf(",");
      if (commaIndex === -1) return [];
      return [{ data: img.dataUrl.slice(commaIndex + 1), mimeType: img.mimeType }];
    });
    if (isSessionRunning(activeSession)) {
      setPendingQueue((q) => [...q, { id: makeId(), text, images: images.length > 0 ? images : undefined }]);
      setPromptText("");
      setPendingImages([]);
      return;
    }
    if (images.length > 0) {
      pendingPromptImagesRef.current.set(activeSession.clientSessionId, images);
    }
    if (
      !sendCommand({
        type: "prompt",
        payload: {
          clientSessionId: activeSession.clientSessionId,
          text,
          images: images.length > 0 ? images : undefined,
        },
      })
    ) {
      pendingPromptImagesRef.current.delete(activeSession.clientSessionId);
      return;
    }
    setPromptText("");
    setPendingImages([]);
  }

  function applyCommandSuggestion(commandName: string) {
    setPromptText((current) => applyPromptCommandCompletion(current, commandName));
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

  function changeSessionMode(clientSessionId: string, modeId: string) {
    sendCommand({
      type: "set_mode",
      payload: { clientSessionId, modeId },
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

  function answerQuestion(question: QuestionPayload, answer: string) {
    sendCommand({
      type: "answer_question",
      payload: {
        clientSessionId: question.clientSessionId,
        questionId: question.questionId,
        answer,
      },
    });
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

    const demoSession = demoFixtures?.bySessionId[activeSession.clientSessionId];
    if (demoSession) {
      setSessionDiff(demoSession.sessionDiff);
      setSessionFileDiffCache({});
      setSessionDiffLoading(false);
      return;
    }

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

    const demoSession = demoFixtures?.bySessionId[activeSession.clientSessionId];
    if (demoSession) {
      const demoDiff = demoSession.fileDiffs[cacheKey];
      if (demoDiff) {
        setSessionFileDiffCache((current) => ({ ...current, [cacheKey]: demoDiff }));
        return demoDiff;
      }
      throw new Error("Demo 文件 Diff 不存在");
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
                  timeline: normalizeMergedTimeline([...history.items.map(normalizeTimelineItem), ...session.timeline]),
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


  function openWorkspaceInVscode(workspacePath: string) {
    const mappedWorkspacePath = mapWorkspacePathForVscode(workspacePath, vscodeLaunchConfig);
    const uri = createVscodeOpenUri(vscodeLaunchConfig, mappedWorkspacePath);
    if (!uri) {
      setVscodeLaunchError("请先配置 VSCode 打开参数（模式、主机或目录映射）。");
      return;
    }
    setVscodeLaunchError("");
    window.open(uri, "_self");
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
    <>
      <div className="shell multi-session">
      <aside className="panel masthead">
        <div className="masthead-intro">
          <div className="brand-stack">
            <div className="brand-lockup">
              <img className="brand-icon" src="/assets/brand-icon.png" alt="" aria-hidden="true" />
              <div className="brand-copy">
                <p className="eyebrow">leduo-patrol</p>
                <div className="brand-title-row">
                  <h1>{config?.appName ?? "LEDUO-PATROL 乐多汪汪队"}</h1>
                </div>
              </div>
            </div>
            <p className="lede masthead-lede">欢迎来到 leduo-patrol：在一个控制台里并行查看多会话进展、差异和执行结果。</p>
          </div>
          {globalErrorItems.length > 0 ? (
            <button
              className="error-indicator"
              type="button"
              onClick={() => setShowGlobalErrors(true)}
              aria-label={`查看 ${globalErrorItems.length} 条应用错误`}
              title={`查看 ${globalErrorItems.length} 条应用错误`}
            >
              <span className="error-indicator-dot" aria-hidden="true" />
              <span className="error-indicator-count">{globalErrorItems.length}</span>
            </button>
          ) : null}
        </div>

        <div className="status-grid">
          <StatusCard label="连接" value={connectionState} tone={toneForConnectionState(connectionState)} />
          <StatusCard label="会话数" value={String(sessions.length)} />
        </div>

        <div className="actions compact">
          <button
            className="secondary session-settings-trigger"
            type="button"
            onClick={() => setVscodeSettingsOpen(true)}
            aria-label="打开 VSCode 配置"
            title="VSCode 配置"
          >
            ⚙️
          </button>
          <button
            className="primary"
            type="button"
            onClick={() => {
              const defaultWorkspacePath = config?.workspacePath ?? workspacePath;
              const split = splitWorkspacePathByAllowedRoots(defaultWorkspacePath, config?.allowedRoots ?? []);
              setWorkspacePath(defaultWorkspacePath);
              setCreateWorkspaceRoot(split.root);
              setCreateWorkspaceSuffix(split.suffix);
              setDirectoryBrowserPath(resolveWorkspaceLookupPath(split.root, split.suffix, []));
              setNewSessionTitle("");
              setNewSessionModeId("default");
              setShowAllWorkspaceSuggestions(false);
              setCreateSessionModalOpen(true);
            }}
            title="新建一个 Claude Code 会话"
          >
            + 新建会话
          </button>
        </div>

        <div className="sidebar-body">
          <div id="panel-sessions" className="tab-panel fill" role="tabpanel" aria-label="当前会话">
            <div className="session-list">
              {sessions.length === 0 ? (
                <div className="empty">还没有会话。点击「+ 新建会话」创建一个。</div>
              ) : (
                sessions.map((session) => {
                  const sidebarStatus = getSessionSidebarStatus(session);
                  const updatedAtLabel = formatRelativeUpdatedAt(session.updatedAt);
                  const sessionModeLabel = labelForMode(session.defaultModeId);
                  const sidebarWorkspacePath = formatWorkspacePathForSidebar(session.workspacePath, config?.allowedRoots ?? []);
                  const isActive = session.clientSessionId === activeSessionId;
                  return (
                    <button
                      key={session.clientSessionId}
                      className={`session-chip ${isActive ? "active" : ""}`}
                      onClick={() => setActiveSessionId(session.clientSessionId)}
                      aria-current={isActive ? "true" : undefined}
                      title={session.title || session.workspacePath}
                    >
                      <span className="session-chip-title" title={session.title}>
                        {formatSessionTitleForDisplay(session.title)}
                      </span>
                      <span className="session-chip-meta">
                        <span className="session-chip-status">
                          {sidebarStatus ? (
                            <span className={`session-chip-tag session-chip-tag-${sidebarStatus.tone}`}>{sidebarStatus.label}</span>
                          ) : null}
                          <span className="session-chip-mode" title={`会话模式：${sessionModeLabel}`}>
                            {sessionModeLabel}
                          </span>
                        </span>
                        <span className="session-chip-time" title={session.updatedAt}>
                          {updatedAtLabel}
                        </span>
                      </span>
                      <span className="session-chip-path" title={session.workspacePath}>
                        {sidebarWorkspacePath}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>

      </aside>

      <main className="panel transcript">
        <div className="transcript-header">
          <h2>{activeSession ? formatSessionTitleForDisplay(activeSession.title) : "任务流"}</h2>
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
                  item={row.displayTitle ? { ...row.item, title: row.displayTitle } : row.item}
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
                  displayRunningHint={Boolean(activeSessionIsRunning && row.item.kind === "tool" && childCount > 0 && Boolean(collapsedSubagentRoots[row.item.id]))}
                  onOpen={() => setSelectedItem({ sessionTitle: activeSession ? formatSessionTitleForDisplay(activeSession.title) : "当前会话", item: row.item })}
                />
              );
            })
          )}
          {activeSessionIsRunning ? (
            <div className="timeline-running-indicator" aria-live="polite">
              <span className="timeline-running-dot" aria-hidden="true" />
              {activeSessionHasPendingPermission || activeSessionHasPendingQuestion ? "等待待处理中..." : "正在运行中..."}
            </div>
          ) : null}
        </div>
        {activeSessionHasPendingPermission || activeSessionHasPendingQuestion ? (
          <div className="composer composer-pending-placeholder">
            {activeSessionHasPendingPermission ? (
              <>
                <p className="composer-pending-title">待处理确认</p>
                <div className="composer-pending-list">
                  {activeSession?.permissions.map((permission) => {
                    return (
                      <section className="composer-pending-item" key={permission.requestId}>
                        <p className="composer-pending-tool">
                          {summarizeToolTitle(
                            permission.toolCall.title,
                            permission.toolCall.rawInput,
                            permission.toolCall.toolCallId,
                          )}
                        </p>
                        <div className="composer-pending-actions">
                          <button
                            className="secondary"
                            onClick={() => setPermissionDetail(permission)}
                          >
                            查看详情
                          </button>
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
                    );
                  })}
                </div>
              </>
            ) : null}
            {activeSessionHasPendingQuestion ? (
              <>
                <p className="composer-pending-title">待回答问题</p>
                <div className="composer-pending-list">
                  {activeSession?.questions.map((question) => (
                    <QuestionPanel
                      key={question.questionId}
                      question={question}
                      onAnswer={(answer) => answerQuestion(question, answer)}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <div className="composer" ref={composerContainerRef}>
            <div className="composer-mode-row">
              <span>会话模式</span>
              <select
                value={activeSession?.defaultModeId ?? "default"}
                disabled={!activeSession?.sessionId || activeSessionIsRunning}
                onChange={(event) => {
                  if (activeSession) {
                    changeSessionMode(activeSession.clientSessionId, event.target.value);
                  }
                }}
              >
                {activeSessionModeOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="composer-capability-summary">
              ACP 能力：{activeAvailableCommands.length}
            </p>
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
                        <span>
                          {renderCompletionLabel(command.name, completionQuery)}
                        </span>
                        <small>{command.description || "命令"}</small>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
            {pendingQueue.length > 0 ? (
              <div className="composer-pending-queue">
                <p className="composer-pending-queue-title">待发送队列 ({pendingQueue.length})</p>
                <div className="composer-pending-queue-list">
                  {pendingQueue.map((item) => (
                    <div key={item.id} className="composer-pending-queue-item">
                      {item.images && item.images.length > 0 ? (
                        <div className="composer-pending-queue-images">
                          {item.images.map((img, idx) => (
                            <img
                              key={idx}
                              src={`data:${img.mimeType};base64,${img.data}`}
                              alt={`图片 ${idx + 1}`}
                              className="composer-pending-queue-img"
                            />
                          ))}
                        </div>
                      ) : null}
                      <p className="composer-pending-queue-text">{item.text}</p>
                      <div className="composer-pending-queue-actions">
                        <button
                          type="button"
                          className="composer-pending-queue-btn"
                          title="复制"
                          onClick={() => { navigator.clipboard.writeText(item.text).catch(() => {}); }}
                        >
                          复制
                        </button>
                        <button
                          type="button"
                          className="composer-pending-queue-btn composer-pending-queue-btn-delete"
                          title="删除"
                          onClick={() => setPendingQueue((q) => q.filter((m) => m.id !== item.id))}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="composer-input-shell">
            {pendingImages.length > 0 ? (
              <div className="composer-image-previews">
                {pendingImages.map((img, index) => (
                  <div key={img.id} className="composer-image-preview">
                    <div className="composer-image-preview-thumb">
                      <img src={img.dataUrl} alt={`待发送图片 ${index + 1}`} />
                    </div>
                    <button
                      type="button"
                      className="composer-image-preview-remove"
                      title="移除图片"
                      onClick={() => setPendingImages((prev) => prev.filter((i) => i.id !== img.id))}
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <textarea
              placeholder={activeSessionIsRunning ? "输入消息，将加入待发送队列…" : "例如：分析这个目录的仓库结构，然后给我一个重构计划。"}
              value={promptText}
              onFocus={() => {
                if (commandCompletions.length > 0) {
                  setIsCompletionOpen(true);
                }
              }}
              onChange={(event) => {
                const nextValue = event.target.value;
                setPromptText(nextValue);
                setIsCompletionOpen(Boolean(extractPromptCommandQuery(nextValue)));
              }}
              onPaste={(event) => {
                const items = event.clipboardData?.items;
                if (!items) return;
                const imageItems = Array.from(items).filter((item) => item.type.startsWith("image/"));
                if (imageItems.length === 0) return;
                event.preventDefault();
                for (const item of imageItems) {
                  const blob = item.getAsFile();
                  if (!blob) continue;
                  const mimeType = item.type;
                  const reader = new FileReader();
                  reader.onload = (e) => {
                    const dataUrl = e.target?.result;
                    if (typeof dataUrl !== "string") return;
                    setPendingImages((prev) => [...prev, { id: makeId(), dataUrl, mimeType }]);
                  };
                  reader.readAsDataURL(blob);
                }
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  isCompletionOpen &&
                  commandCompletions.length > 0 &&
                  Boolean(extractPromptCommandQuery(promptText))
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
                  submitPrompt();
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
              <button className="primary composer-send" onClick={submitPrompt} disabled={(!promptText.trim() && pendingImages.length === 0) || !activeSession}>
                {activeSessionIsRunning ? "加入队列" : "发送"}
                <kbd className="composer-send-shortcut">⌘↩</kbd>
              </button>
              <button className="secondary composer-cancel" onClick={cancelActiveSession} disabled={!activeSessionIsRunning}>
                <span aria-hidden="true">⏹</span>
                停止
              </button>
            </div>
          </div>
        )}
      </main>

      <aside className="panel approvals">
        <div className="transcript-header">
          <h2>会话详情</h2>
          <p>当前会话会持久化到服务器用户目录，浏览器刷新后会自动恢复。</p>
        </div>
        {activeSession ? (
          <>
            <section className="details session-meta session-meta-card">
              <div className="session-meta-header">
                <div>
                  <p className="approval-label">会话详情</p>
                  <h3>{formatSessionTitleForDisplay(activeSession.title)}</h3>
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
                <div className="session-meta-item session-meta-item-wide">
                  <span>会话模式</span>
                  <code>{labelForMode(activeSession.defaultModeId)}</code>
                </div>
              </div>
              <div className="session-meta-actions">
                <button className="secondary session-open-vscode" onClick={() => openWorkspaceInVscode(activeSession.workspacePath)}>
                  VSCode
                </button>
                <button className="secondary session-diff-trigger" onClick={openSessionDiff}>
                  查看diff
                </button>
                <button className="secondary session-close" onClick={() => closeSession(activeSession.clientSessionId)}>
                  关闭会话
                </button>
              </div>
            </section>
            {latestExecutionPlan ? (
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
            ) : null}
          </>
        ) : (
          <div className="empty">选择一个会话后再处理确认或关闭会话。</div>
        )}
      </aside>

      {vscodeSettingsOpen ? (
        <div className="modal-backdrop" onClick={() => setVscodeSettingsOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3>VSCode 打开配置</h3>
                <p className="modal-meta">远程模式需要填写 SSH 用户与主机（如 <code>dev@10.0.0.8</code>）以及目录映射；本地模式只需目录路径。</p>
              </div>
              <button className="secondary" onClick={() => setVscodeSettingsOpen(false)}>
                关闭
              </button>
            </div>
            <div className="modal-scroll-body">
              <div className="details">
                <div className="vscode-settings-help">
                  <p><strong>需要配置的内容：</strong></p>
                  <ul>
                    <li><code>打开模式</code>：远程 SSH 或本地目录。</li>
                    <li><code>SSH 主机</code>：远程模式必填，格式如 <code>user@host</code>。</li>
                    <li><code>本地根目录</code>：当前 patrol 里的目录前缀。</li>
                    <li><code>远程根目录</code>：远端服务器上对应的目录前缀。</li>
                  </ul>
                </div>
                <label htmlFor="vscode-open-mode">打开模式</label>
                <select
                  id="vscode-open-mode"
                  value={vscodeLaunchConfig.mode}
                  onChange={(event) => {
                    const nextMode = event.target.value === "remote" ? "remote" : "local";
                    setVscodeLaunchConfig((current) => ({ ...current, mode: nextMode }));
                  }}
                >
                  <option value="remote">远程 SSH</option>
                  <option value="local">本地目录</option>
                </select>

                <label htmlFor="vscode-open-ssh-host">SSH 主机</label>
                <input
                  id="vscode-open-ssh-host"
                  placeholder="如 user@server"
                  value={vscodeLaunchConfig.sshHost}
                  onChange={(event) => {
                    const value = event.target.value;
                    setVscodeLaunchConfig((current) => ({ ...current, sshHost: value }));
                  }}
                />

                <label htmlFor="vscode-open-local-base">本地根目录（用于映射）</label>
                <input
                  id="vscode-open-local-base"
                  placeholder="如 /workspace/leduo-patrol"
                  value={vscodeLaunchConfig.localBasePath}
                  onChange={(event) => {
                    const value = event.target.value;
                    setVscodeLaunchConfig((current) => ({ ...current, localBasePath: value }));
                  }}
                />

                <label htmlFor="vscode-open-remote-base">远程根目录（用于映射）</label>
                <input
                  id="vscode-open-remote-base"
                  placeholder="如 /home/dev/leduo-patrol"
                  value={vscodeLaunchConfig.sshBasePath}
                  onChange={(event) => {
                    const value = event.target.value;
                    setVscodeLaunchConfig((current) => ({ ...current, sshBasePath: value }));
                  }}
                />

                <div className="session-meta-item session-meta-item-wide">
                  <span>当前一键打开目标</span>
                  <code>{workspaceForLaunch || "(未选择目录)"}</code>
                </div>
                {vscodeLaunchError ? <p className="modal-meta">{vscodeLaunchError}</p> : null}
                <div className="session-meta-actions vscode-settings-actions">
                  <button className="secondary" onClick={() => openWorkspaceInVscode(activeSession?.workspacePath ?? config?.workspacePath ?? "")} disabled={!canOpenWorkspaceInVscode}>
                    立即打开当前目录
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {createSessionModalOpen ? (
        <div
          className="modal-backdrop"
          onClick={() => {
            setCreateSessionModalOpen(false);
            setShowAllWorkspaceSuggestions(false);
          }}
        >
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3>新建会话</h3>
              </div>
              <button className="secondary" onClick={() => {
                setCreateSessionModalOpen(false);
                setShowAllWorkspaceSuggestions(false);
              }}>
                关闭
              </button>
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
                        onClick={() => setShowAllWorkspaceSuggestions((current) => !current)}
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
                <label>默认模式</label>
                <div className="mode-tile-grid" role="radiogroup" aria-label="默认模式">
                  {MODE_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`mode-tile ${newSessionModeId === option.id ? "active" : ""}`}
                      role="radio"
                      aria-checked={newSessionModeId === option.id}
                      onClick={() => setNewSessionModeId(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {directoryError ? <p>{directoryError}</p> : null}
              </div>
            </div>
            <div className="modal-footer">
              <button className="primary" onClick={createSession} disabled={!workspacePath.trim()}>
                新建目录会话
              </button>
              <button className="secondary" type="button" onClick={() => {
                setCreateSessionModalOpen(false);
                setShowAllWorkspaceSuggestions(false);
              }}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedItem ? (
        <MessageModal
          sessionTitle={selectedItem.sessionTitle}
          item={selectedItem.item}
          onClose={() => setSelectedItem(null)}
        />
      ) : null}

      {permissionDetail && activeSession ? (
        <PermissionModal
          sessionTitle={formatSessionTitleForDisplay(activeSession.title)}
          permission={permissionDetail}
          onResolve={(permission, optionId) => {
            resolvePermission(permission, optionId);
            setPermissionDetail(null);
          }}
          onClose={() => setPermissionDetail(null)}
        />
      ) : null}

      {showGlobalErrors ? (
        <SystemFeedModal
          items={globalErrorItems}
          title="应用错误"
          subtitle="仅展示未归属到单个会话的全局异常。"
          onClose={() => setShowGlobalErrors(false)}
          onOpenItem={(item) => {
            setShowGlobalErrors(false);
            setSelectedItem({ sessionTitle: "应用错误", item });
          }}
        />
      ) : null}

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

      {config?.enableShell ? (
        <div className={`terminal-drawer ${terminalOpen ? "terminal-drawer-open" : ""}`}>
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
              限制模式 · 工作目录：{activeSession?.workspacePath ?? config.workspacePath}
            </span>
          </div>
          {terminalOpen ? (
            <div className="terminal-viewport" ref={terminalContainerRef} />
          ) : null}
        </div>
      ) : null}
    </div>
    <ToastContainer toasts={toasts} onDismiss={dismissToast} onNavigate={(sessionId) => setActiveSessionId(sessionId)} />
    </>
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

function TimelineRow(props: {
  item: TimelineItem;
  depth?: number;
  childCount?: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onOpen: () => void;
  displayRunningHint?: boolean;
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
            {props.collapsed ? "▸" : "▾"} 子项 {props.childCount}{props.displayRunningHint ? " · 运行中" : ""}
          </span>
        ) : null}
      </span>
      <span className={`timeline-body ${expandedPreview ? "multiline" : ""}`}>
        {summary}
        {props.item.images && props.item.images.length > 0 ? (
          <span className="timeline-image-badge"> 🖼 {props.item.images.length}</span>
        ) : null}
      </span>
      <span className="timeline-meta">{props.item.meta ?? "查看"}</span>
    </button>
  );
}

function buildToolTimelineItem(update: SessionUpdate): TimelineItem {
  const normalizedTitle = normalizeAcpToolTitle(update.title) || undefined;
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

function canMergeToolTimelineItem(existingItem: TimelineItem, incomingItem: TimelineItem, toolCallId: string) {
  if (existingItem.kind !== "tool" || incomingItem.kind !== "tool") {
    return false;
  }
  const existingMeta = readToolMeta(existingItem);
  const incomingMeta = readToolMeta(incomingItem);
  if (existingMeta?.toolCallId !== toolCallId || incomingMeta?.toolCallId !== toolCallId) {
    return false;
  }
  const existingTitle = normalizeToolTitleForMerge(existingMeta.title ?? existingItem.title);
  const incomingTitle = normalizeToolTitleForMerge(incomingMeta.title ?? incomingItem.title);
  const existingIsSubagent = isSubagentToolTitle(existingMeta.title);
  const incomingIsSubagent = isSubagentToolTitle(incomingMeta.title);

  if (existingIsSubagent || incomingIsSubagent) {
    return existingIsSubagent && incomingIsSubagent && existingTitle === incomingTitle;
  }
  return true;
}

function normalizeToolTitleForMerge(title: string | null) {
  return (title ?? "").trim().toLowerCase();
}

function mergeToolTimelineItems(existingItem: TimelineItem, incomingItem: TimelineItem) {
  const existingEntries = parseToolTimelineEntries(existingItem.body);
  const incomingEntries = parseToolTimelineEntries(incomingItem.body);
  const mergedEntries = [...existingEntries, ...incomingEntries];
  return {
    ...incomingItem,
    id: existingItem.id,
    title: resolveToolDisplayTitle(mergedEntries, incomingItem.title),
    body: stringifyMaybe(mergedEntries),
  } satisfies TimelineItem;
}

function buildTimelineTreeRows(items: TimelineItem[]): TimelineTreeRow[] {
  const rows: TimelineTreeRow[] = [];
  const activeRoots: Array<{ rootId: string; toolCallId: string | null; rowIndex: number }> = [];

  for (const item of items) {
    const toolMeta = readToolMeta(item);
    const shouldHandleAsSubagent = Boolean(toolMeta && isSubagentToolTitle(toolMeta.title));

    if (toolMeta?.toolCallId) {
      const candidateSummary = buildSubagentSummaryFromChild(toolMeta.title);
      if (candidateSummary) {
        const matchedRoot = [...activeRoots].reverse().find((root) => root.toolCallId === toolMeta.toolCallId);
        if (matchedRoot) {
          const row = rows[matchedRoot.rowIndex];
          if (row && !row.displayTitle) {
            row.displayTitle = `${row.item.title || "Task"} · ${candidateSummary}`;
          }
        }
      }
    }

    const isTerminalByToolCall = Boolean(toolMeta?.toolCallId && isTerminalToolStatus(toolMeta.status));
    if (isTerminalByToolCall && closeSubagentRoot(activeRoots, toolMeta?.toolCallId ?? null, false)) {
      continue;
    }

    if (!shouldHandleAsSubagent) {
      const activeRootId = activeRoots.at(-1)?.rootId ?? null;
      rows.push({
        item,
        depth: activeRootId ? activeRoots.length : 0,
        rootId: activeRootId,
      });
      continue;
    }

    const subagentToolMeta = toolMeta;
    if (!subagentToolMeta) {
      continue;
    }

    const isTerminal = isTerminalToolStatus(subagentToolMeta.status);

    if (isTerminal) {
      const closed = closeSubagentRoot(activeRoots, subagentToolMeta.toolCallId ?? null);
      if (closed) {
        continue;
      }
    }

    const activeRootId = activeRoots.at(-1)?.rootId ?? null;
    rows.push({
      item,
      depth: activeRootId ? activeRoots.length : 0,
      rootId: activeRootId,
    });

    if (!isTerminal) {
      activeRoots.push({ rootId: item.id, toolCallId: subagentToolMeta.toolCallId, rowIndex: rows.length - 1 });
    }
  }

  return rows;
}

function closeSubagentRoot(
  activeRoots: Array<{ rootId: string; toolCallId: string | null; rowIndex: number }>,
  toolCallId: string | null,
  allowFallback = true,
) {
  if (toolCallId) {
    for (let i = activeRoots.length - 1; i >= 0; i -= 1) {
      if (activeRoots[i]?.toolCallId === toolCallId) {
        activeRoots.splice(i, 1);
        return true;
      }
    }
  }

  if (allowFallback && activeRoots.length > 0) {
    activeRoots.pop();
    return true;
  }

  return false;
}


function buildSubagentSummaryFromChild(title: string | null) {
  const normalized = (title ?? "").trim();
  if (!normalized) {
    return null;
  }
  if (isSubagentToolTitle(normalized)) {
    return null;
  }
  if (/^工具\s+tool_/.test(normalized) || /^tool_/.test(normalized)) {
    return null;
  }
  return normalized;
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
  const entries = parseToolTimelineEntries(item.body);
  const latestRecord = [...entries].reverse().map((entry) => asRecord(entry)).find((entry) => entry !== null) ?? null;
  const title = resolveToolDisplayTitle(entries, item.title) || item.title;
  const status = typeof latestRecord?.status === "string" ? latestRecord.status : item.meta ?? null;
  const toolCallId = typeof latestRecord?.toolCallId === "string" ? latestRecord.toolCallId : null;
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

/**
 * Strip the `mcp__acp__` prefix that the ACP agent adds when it re-publishes
 * Claude Code built-in tools as MCP tools.
 */
function normalizeAcpToolTitle(rawTitle: unknown): string {
  if (typeof rawTitle !== "string") return "";
  return rawTitle.replace(/^mcp__acp__/i, "");
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

  // If description is available, use it as the primary label (replaces command in title)
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
  if (!preferred) {
    return title || "Task";
  }
  return `${title || "Task"} · ${preferred}`;
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

function resolveToolDisplayTitle(entries: unknown[], fallbackTitle: string) {
  // Prefer description from rawInput — it is the most human-readable label
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

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const record = asRecord(entries[index]);
    const toolCallId = typeof record?.toolCallId === "string" ? record.toolCallId.trim() : "";
    if (toolCallId) {
      return toolCallId;
    }
  }

  return fallbackTitle;
}

function normalizeAvailableCommands(rawValue: unknown): AvailableCommand[] {
  if (!Array.isArray(rawValue)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: AvailableCommand[] = [];

  for (const item of rawValue) {
    const record = asRecord(item);
    const rawName =
      typeof item === "string"
        ? item.trim()
        : typeof record?.name === "string"
          ? record.name.trim()
          : typeof record?.command === "string"
            ? record.command.trim()
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

function getPromptCommandCompletions(prompt: string, commands: AvailableCommand[]) {
  const query = extractPromptCommandQuery(prompt);
  if (!query) {
    return [];
  }

  if (query === "/") {
    return commands;
  }

  const normalizedQuery = query.toLowerCase();
  return commands
    .filter((command) => command.name.toLowerCase().startsWith(normalizedQuery))
    .slice(0, 50);
}

function extractPromptCommandQuery(prompt: string) {
  const match = prompt.match(/(^|\s)(\/[^\s]*)$/);
  if (!match) {
    return null;
  }
  return match[2] ?? null;
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

function splitCompletionLabel(commandName: string, query: string | null) {
  const normalizedQuery = (query ?? "").trim();
  if (!normalizedQuery) {
    return { matched: "", rest: commandName };
  }
  if (!commandName.toLowerCase().startsWith(normalizedQuery.toLowerCase())) {
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

function buildCompletionSections(commands: AvailableCommand[], query: string | null) {
  const indexed = commands.map((command, index) => ({ command, index }));
  if (!query || indexed.length === 0) {
    return [];
  }
  return [{ key: "all", title: null, items: indexed }];
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

function parseStructuredLogMessage(message: string): { level: string | null; detail: string } | null {
  const parsed = tryParseJson(message);
  const record = asRecord(parsed);
  if (!record) {
    return null;
  }
  const level = typeof record.level === "string" ? record.level.toLowerCase() : null;
  const detail = typeof record.message === "string" ? record.message : message;
  return { level, detail };
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

function isSessionRunning(session: SessionRecord) {
  return session.busy || session.permissions.length > 0 || session.questions.length > 0;
}

function shouldKeepSessionRunningAfterPromptFinished(stopReason: string) {
  const normalized = stopReason.trim().toLowerCase();
  return normalized === "pause_turn" || normalized === "pause-turn" || normalized.includes("permission");
}

function getSessionSidebarStatus(session: SessionRecord): SessionSidebarStatus | null {
  if (session.permissions.length > 0 || session.questions.length > 0) {
    return { label: "待处理", tone: "pending" };
  }
  if (isSessionRunning(session)) {
    return { label: "运行中", tone: "running" };
  }
  if (!hasCompletedPrompt(session) && hasSessionErrorLog(session)) {
    return { label: "运行中", tone: "running" };
  }
  if (shouldShowSessionException(session)) {
    return { label: "异常", tone: "error" };
  }
  if (hasCompletedPrompt(session)) {
    return { label: "已完成", tone: "completed" };
  }
  if (session.connectionState === "connecting") {
    return { label: "连接中", tone: "connecting" };
  }
  return null;
}

function hasCompletedPrompt(session: SessionRecord) {
  return session.timeline.some((item) => item.kind === "system" && item.title === "本轮完成");
}

function hasSessionErrorLog(session: SessionRecord) {
  return session.timeline.some((item) => item.kind === "error");
}

function shouldShowSessionException(session: SessionRecord) {
  if (isSessionRunning(session) || session.connectionState !== "error") {
    return false;
  }
  if (!hasCompletedPrompt(session)) {
    return false;
  }
  const lastItem = [...session.timeline].reverse().find((item) => item.kind !== "system" || item.title !== "本轮完成");
  return Boolean(lastItem && lastItem.kind === "error");
}

function truncateUnknownText(value: unknown, maxLength = 500) {
  const raw = typeof value === "string" ? value : stringifyMaybe(value);
  const normalized = raw.trim();
  if (!normalized) {
    return "(空)";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...（已截断，原始 ${normalized.length} 字符）`;
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
  if (!planBody) {
    return null;
  }
  return truncateUnknownText(planBody, 1800);
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
  if (normalized === "completed") {
    return "completed";
  }
  if (normalized === "in_progress") {
    return "in_progress";
  }
  if (normalized === "pending") {
    return "pending";
  }
  return "unknown";
}

function formatRelativeUpdatedAt(updatedAt: string, now = Date.now()) {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) {
    return "刚刚";
  }

  const elapsedMs = Math.max(0, now - timestamp);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) {
    return "刚刚";
  }
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} 分钟前`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours} 小时前`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} 天前`;
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

function sanitizeWorkspaceSuffix(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function composeWorkspacePath(rootPath: string, suffixPath: string) {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedSuffix = sanitizeWorkspaceSuffix(suffixPath);
  if (!normalizedSuffix) {
    return normalizedRoot;
  }
  return normalizePath(`${normalizedRoot}/${normalizedSuffix}`);
}

function resolveWorkspaceLookupPath(
  rootPath: string,
  suffixPath: string,
  availableDirectories: Array<{ name: string; path: string }>,
) {
  const normalizedSuffix = sanitizeWorkspaceSuffix(suffixPath);
  const composedPath = composeWorkspacePath(rootPath, normalizedSuffix);
  if (!normalizedSuffix) {
    return composedPath;
  }
  const normalizedComposedPath = normalizePath(composedPath);
  const hasExactMatch = availableDirectories.some((entry) => normalizePath(entry.path) === normalizedComposedPath);
  if (hasExactMatch) {
    return composedPath;
  }
  return parentDirectory(composedPath);
}

function relativePathFromRoot(rootPath: string, targetPath: string) {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedTarget = normalizePath(targetPath);
  if (!isWithinRoot(normalizedRoot, normalizedTarget)) {
    return "";
  }
  if (normalizedTarget === normalizedRoot) {
    return "";
  }
  return normalizedTarget.slice(normalizedRoot.length).replace(/^\/+/, "");
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

function buildPathBreadcrumbs(currentPath: string, allowedRoots: string[]) {
  const normalizedCurrent = normalizePath(currentPath.trim());
  if (!normalizedCurrent) {
    return [];
  }

  const sortedRoots = allowedRoots
    .map((rootPath) => normalizePath(rootPath.trim()))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const matchedRoot = sortedRoots.find((rootPath) => isWithinRoot(rootPath, normalizedCurrent));
  const activeBase = matchedRoot ?? "/";

  const remainder = normalizedCurrent === activeBase ? "" : normalizedCurrent.slice(activeBase.length).replace(/^\/+/, "");
  const segments = remainder ? remainder.split("/").filter(Boolean) : [];

  const crumbs: Array<{ label: string; path: string; active: boolean }> = [];
  const baseLabel = matchedRoot ? "根目录" : "/";
  crumbs.push({ label: baseLabel, path: activeBase, active: normalizedCurrent === activeBase });

  let cursor = activeBase;
  for (const segment of segments) {
    const nextPath = cursor === "/" ? `/${segment}` : `${cursor}/${segment}`;
    cursor = normalizePath(nextPath);
    crumbs.push({ label: segment, path: cursor, active: cursor === normalizedCurrent });
  }

  if (crumbs.length === 0) {
    return [{ label: "/", path: "/", active: normalizedCurrent === "/" }];
  }
  return crumbs;
}

function toSingleLine(value: string) {
  return value.replace(/\s+/g, " ").trim() || "(空)";
}

function toPreviewText(value: string) {
  return value.trim() || "(空)";
}

function normalizeSessionTitle(title: string) {
  return title.trim() || "未命名会话";
}

function formatSessionTitleForDisplay(title: string) {
  return title.replace(/_/g, "_\u200b");
}

function formatWorkspacePathForSidebar(workspacePath: string, allowedRoots: string[]) {
  const normalizedPath = workspacePath.trim();
  if (!normalizedPath) {
    return workspacePath;
  }

  const matchingRoot = allowedRoots
    .map((root) => root.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find((root) => isWithinRoot(root, normalizedPath));

  if (!matchingRoot) {
    return normalizedPath;
  }
  if (normalizedPath === matchingRoot) {
    return "…/";
  }

  const suffix = normalizedPath.slice(matchingRoot.length).replace(/^\/+/, "");
  return suffix ? `…/${suffix}` : "…/";
}

function normalizeSessionRecord(session: SessionRecord): SessionRecord {
  const total = session.historyTotal ?? session.timeline.length;
  const start = session.historyStart ?? Math.max(0, total - session.timeline.length);
  const normalizedTitle = normalizeSessionTitle(session.title);

  return {
    ...session,
    title: normalizedTitle,
    timeline: normalizeMergedTimeline(session.timeline.map(normalizeTimelineItem)),
    historyTotal: total,
    historyStart: start,
    questions: Array.isArray(session.questions) ? session.questions : [],
    availableCommands: normalizeAvailableCommands(session.availableCommands),
  };
}

function normalizeMergedTimeline(items: TimelineItem[]) {
  const merged: TimelineItem[] = [];
  for (const item of items) {
    const normalized = normalizeTimelineItem(item);
    if (normalized.kind !== "tool") {
      merged.push(normalized);
      continue;
    }
    if (isSubagentToolTitle(normalized.title)) {
      merged.push(normalized);
      continue;
    }
    const toolMeta = readToolMeta(normalized);
    const toolCallId = toolMeta?.toolCallId;
    if (!toolCallId) {
      merged.push(normalized);
      continue;
    }
    let existingIndex = -1;
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      const existing = merged[index];
      if (existing?.kind === "system" && existing.title === "本轮完成") {
        break;
      }
      if (canMergeToolTimelineItem(existing, normalized, toolCallId)) {
        existingIndex = index;
        break;
      }
    }
    if (existingIndex < 0) {
      merged.push(normalized);
      continue;
    }
    merged[existingIndex] = mergeToolTimelineItems(merged[existingIndex] ?? normalized, normalized);
  }
  return merged;
}

function buildDemoFixtures(workspacePath: string, demoPreset: DemoPreset): DemoFixtures | null {
  if (demoPreset !== "subagent-tree") {
    return null;
  }

  const demoLongSessionTitle =
    "demo_release_readiness_multi_service_validation_timeline_and_diff_walkthrough";
  const demoLongWorkspacePath =
    "/workspace/leduo-patrol/demo_assets/very_long_gallery_workspace/ink_landscape_collection_archive/seasonal_series_spring_morning_mist_over_mountains_with_boat_and_pines";

  const demoSession: SessionRecord = normalizeSessionRecord({
    clientSessionId: "demo-subagent-tree",
    title: demoLongSessionTitle,
    workspacePath: demoLongWorkspacePath,
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
        body: "请完成“发布前检查”演练：拆分子任务、汇总风险，并给出最终建议。",
      },
      {
        id: "demo-plan-1",
        kind: "system",
        title: "执行计划",
        body: JSON.stringify(
          [
            { content: "检查环境变量与配置模板", priority: "medium", status: "completed" },
            { content: "扫描 API / WebSocket 错误处理路径", priority: "medium", status: "completed" },
            { content: "复核构建产物与静态资源缓存", priority: "medium", status: "in_progress" },
            { content: "输出发布风险清单与回滚建议", priority: "medium", status: "pending" },
          ],
          null,
          2,
        ),
      },
      {
        id: "demo-tool-task-start",
        kind: "tool",
        title: "Task",
        body: JSON.stringify(
          { toolCallId: "demo-task-1", title: "Task", status: "running", input: "并行执行发布前检查清单" },
          null,
          2,
        ),
        meta: "running",
      },
      {
        id: "demo-agent-sub-1",
        kind: "agent",
        title: "Claude",
        body: "子代理 A：正在扫描项目目录，确认关键配置、脚本入口和部署依赖。",
      },
      {
        id: "demo-tool-sub-search",
        kind: "tool",
        title: "ripgrep",
        body: JSON.stringify(
          {
            toolCallId: "demo-rg-1",
            title: "ripgrep",
            status: "completed",
            result: ["server/index.ts", "server/session-manager.ts", "src/App.tsx"],
          },
          null,
          2,
        ),
        meta: "completed",
      },
      {
        id: "demo-tool-sub-lint",
        kind: "tool",
        title: "npm run check",
        body: JSON.stringify(
          {
            toolCallId: "demo-check-1",
            title: "npm run check",
            status: "completed",
            summary: "类型检查与静态检查通过",
          },
          null,
          2,
        ),
        meta: "completed",
      },
      {
        id: "demo-agent-sub-1-summary",
        kind: "agent",
        title: "Claude",
        body: "子代理 A 总结：核心入口清晰，可继续进行构建与差异复核。",
      },
      {
        id: "demo-tool-task-start-2",
        kind: "tool",
        title: "Task",
        body: JSON.stringify(
          { toolCallId: "demo-task-2", title: "Task", status: "running", input: "验证构建产物与回滚包" },
          null,
          2,
        ),
        meta: "running",
      },
      {
        id: "demo-agent-sub-2-progress",
        kind: "agent",
        title: "Claude",
        body: "子代理 B：正在对比 dist 产物哈希并检查版本元数据。",
      },
      {
        id: "demo-tool-sub-test",
        kind: "tool",
        title: "npm test",
        body: JSON.stringify(
          {
            toolCallId: "demo-test-1",
            title: "npm test",
            status: "completed",
            summary: "46 passed / 0 failed",
          },
          null,
          2,
        ),
        meta: "completed",
      },
      {
        id: "demo-agent-sub-2",
        kind: "agent",
        title: "Claude",
        body: "子代理 B 完成构建校验，发现 1 项中风险：静态资源缓存策略需要确认。",
      },
      {
        id: "demo-tool-task-end-2",
        kind: "tool",
        title: "Task",
        body: JSON.stringify({ toolCallId: "demo-task-2", title: "Task", status: "completed" }, null, 2),
        meta: "completed",
      },
      {
        id: "demo-tool-task-end",
        kind: "tool",
        title: "Task",
        body: JSON.stringify({ toolCallId: "demo-task-1", title: "Task", status: "completed" }, null, 2),
        meta: "completed",
      },
      {
        id: "demo-agent-main-summary",
        kind: "agent",
        title: "Claude",
        body: "主代理汇总：2 个子任务已完成。建议先确认缓存 TTL，再执行正式发布。",
      },
      {
        id: "demo-tool-read",
        kind: "tool",
        title: "Read /src/config.ts",
        body: JSON.stringify(
          {
            toolCallId: "demo-read-1",
            title: "Read /src/config.ts",
            status: "completed",
            rawInput: { file_path: "/src/config.ts" },
            rawOutput: "export const version = '1.1.0';",
          },
          null,
          2,
        ),
        meta: "completed",
      },
      {
        id: "demo-tool-write",
        kind: "tool",
        title: "Write /src/config.ts",
        body: JSON.stringify(
          {
            toolCallId: "demo-write-1",
            title: "Write /src/config.ts",
            status: "completed",
            rawInput: { file_path: "/src/config.ts", content: "export const version = '1.2.0';" },
          },
          null,
          2,
        ),
        meta: "completed",
      },
      {
        id: "demo-agent-main",
        kind: "agent",
        title: "Claude",
        body: "演示提示：点击 `Task` 行右侧子项按钮，可折叠/展开子任务明细；同时可切换查看会话差异与文件 diff。",
      },
    ],
    historyTotal: 19,
    historyStart: 0,
    permissions: [
      {
        clientSessionId: "demo-subagent-tree",
        requestId: "demo-permission-1",
        toolCall: {
          toolCallId: "demo-task-1",
          title: "Task",
          status: "pending",
          rawInput: { description: "是否允许执行“清理旧构建缓存”步骤" },
        },
        options: [
          { optionId: "demo-allow", name: "允许", kind: "allow" },
          { optionId: "demo-deny", name: "拒绝", kind: "deny" },
        ],
      },
    ],
    questions: [
      {
        clientSessionId: "demo-subagent-tree",
        questionId: "demo-question-1",
        question: "发布前需要确认：是否已完成回滚测试？",
        options: [
          { id: "yes", label: "是，已完成" },
          { id: "no", label: "否，尚未完成" },
        ],
        allowCustomAnswer: true,
      },
    ],
    updatedAt: new Date().toISOString(),
  });

  const demoSessionDiff: SessionDiffResponse = {
    workspacePath: demoLongWorkspacePath,
    workspaceReadonly: false,
    repositoryRoot: demoLongWorkspacePath,
    workingTree: [
      { filePath: "src/App.tsx", changeType: "修改" },
      { filePath: "src/components/TimelinePanel.tsx", changeType: "修改" },
      { filePath: "src/styles.css", changeType: "修改" },
    ],
    staged: [{ filePath: "docs/release-checklist.md", changeType: "修改" }],
    untracked: [{ filePath: "scripts/verify-build-cache.ts", changeType: "新增" }],
  };

  const demoFileDiffs: Record<string, SessionFileDiffResponse> = {
    "workingTree:src/App.tsx": {
      category: "workingTree",
      filePath: "src/App.tsx",
      omitted: false,
      diff: "@@ -1200,6 +1200,12 @@\n+const demo = true;\n+// demo timeline row\n",
    },
    "workingTree:src/styles.css": {
      category: "workingTree",
      filePath: "src/styles.css",
      omitted: false,
      diff: "@@ -610,6 +610,10 @@\n+.timeline-row {\n+  width: calc(100% - 18px);\n+}\n",
    },
    "staged:docs/release-checklist.md": {
      category: "staged",
      filePath: "docs/release-checklist.md",
      omitted: false,
      diff: "@@ -12,5 +12,9 @@\n+- [ ] 发布前确认缓存策略\n+- [ ] 回滚包完整性校验\n",
    },
    "untracked:scripts/verify-build-cache.ts": {
      category: "untracked",
      filePath: "scripts/verify-build-cache.ts",
      omitted: false,
      diff: "export async function verifyBuildCache() {\n+  return { ok: true, checked: [\"assets-manifest\", \"etag\"] };\n+}\n",
    },
  };

  const overflowSessions = Array.from({ length: 7 }, (_, index) => {
    const sequence = index + 2;
    return normalizeSessionRecord({
      clientSessionId: `demo-session-${sequence}`,
      title: `demo_session_${sequence}_release_validation_iteration`,
      workspacePath: `${workspacePath}/demo/session-${sequence}`,
      connectionState: "connected",
      sessionId: `demo-session-${sequence}`,
      modes: ["default", "plan"],
      defaultModeId: "default",
      currentModeId: "default",
      busy: sequence % 3 === 0,
      timeline: [
        {
          id: `demo-${sequence}-user-1`,
          kind: "user",
          title: "你",
          body: `请继续处理会话 ${sequence}：补充检查记录并同步风险状态。`,
        },
      ],
      historyTotal: 1,
      historyStart: 0,
      permissions: [],
      questions: [],
      updatedAt: new Date(Date.now() - sequence * 60_000).toISOString(),
    });
  });

  return {
    createSession: {
      workspacePath: `${workspacePath}/demo/new-session-showcase/client-dashboard`,
      title: "demo_new_session_path_picker_showcase",
      modeId: "plan",
    },
    bySessionId: {
      [demoSession.clientSessionId]: {
        session: demoSession,
        sessionDiff: demoSessionDiff,
        fileDiffs: demoFileDiffs,
      },
      ...Object.fromEntries(
        overflowSessions.map((session) => [
          session.clientSessionId,
          {
            session,
            sessionDiff: demoSessionDiff,
            fileDiffs: demoFileDiffs,
          },
        ]),
      ),
    },
  };
}

function applyDemoPreset(sessions: SessionRecord[], fixtures: DemoFixtures | null): SessionRecord[] {
  if (!fixtures) {
    return sessions;
  }

  const demoSessions = Object.values(fixtures.bySessionId).map((entry) => entry.session);
  const demoSessionIdSet = new Set(demoSessions.map((session) => session.clientSessionId));
  const rest = sessions.filter((session) => !demoSessionIdSet.has(session.clientSessionId));
  return [...demoSessions, ...rest];
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

function isReadToolTitle(title: string | null): boolean {
  const t = normalizeAcpToolTitle(title).trim().toLowerCase();
  const prefixes = ["read", "readfile", "read_file", "read file", "file_read", "fileread"];
  return prefixes.some((p) => t === p || t.startsWith(p + " "));
}

function isWriteToolTitle(title: string | null): boolean {
  const t = normalizeAcpToolTitle(title).trim().toLowerCase();
  const prefixes = ["write", "writefile", "write_file", "write file"];
  // "create" variants use exact match only – "Create <path>" is not a
  // recognised title pattern from Claude Code, whereas "Write <path>" is.
  const exact = ["create", "createfile", "create_file", "create file"];
  return prefixes.some((p) => t === p || t.startsWith(p + " ")) || exact.some((p) => t === p);
}

function FileContentView(props: { content: string; filePath: string | null; mode: "read" | "write" }) {
  // Trim all trailing newlines so files ending in \n don't show blank last lines
  const normalized = props.content.replace(/\n+$/, "");
  const lines = normalized.split("\n");
  const lineCount = lines.length;
  const trimmed = lines.length > FILE_VIEWER_MAX_LINES;
  const visibleLines = trimmed ? lines.slice(0, FILE_VIEWER_MAX_LINES) : lines;
  const modeLabel = FILE_VIEWER_MODE_LABEL[props.mode];

  return (
    <div className={`tool-read-output tool-read-output-${props.mode}`}>
      <div className="tool-read-header">
        {props.filePath ? <code className="tool-read-path">{props.filePath}</code> : null}
        <span className="tool-read-linecount">{modeLabel} · {lineCount} 行</span>
      </div>
      <div className="tool-read-body">
        <table className="tool-read-table" cellSpacing={0} cellPadding={0}>
          <tbody>
            {visibleLines.map((line, i) => (
              <tr key={i} className="tool-read-line">
                <td className="tool-read-lineno">{i + 1}</td>
                <td className="tool-read-linetext">{line}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {trimmed ? (
          <p className="tool-read-truncated">（已截断，仅显示前 {FILE_VIEWER_MAX_LINES} 行，共 {lineCount} 行）</p>
        ) : null}
      </div>
    </div>
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
  let writeContent: string | null = null;

  for (const entry of [...entries].reverse()) {
    const record = asRecord(entry);
    if (!record) continue;

    if (!rawTitle && typeof record.title === "string" && record.title.trim()) {
      rawTitle = record.title.trim();
    }
    if (!status && typeof record.status === "string" && record.status.trim()) {
      status = record.status.trim();
    }
    if (rawOutput === undefined && record.rawOutput !== undefined && record.rawOutput !== null) {
      rawOutput = record.rawOutput;
    }
    const inputRecord = asRecord(record.rawInput) ?? asRecord(tryParseJson(record.rawInput));
    if (inputRecord) {
      if (!description && typeof inputRecord.description === "string" && inputRecord.description.trim()) {
        description = inputRecord.description.trim();
      }
      if (!command) {
        // `command` is a string in bash-style tools; `cmd` is an array in exec-style tools
        if (typeof inputRecord.command === "string" && inputRecord.command.trim()) {
          command = inputRecord.command.trim();
        } else if (Array.isArray(inputRecord.cmd)) {
          const parts = inputRecord.cmd.filter((p): p is string => typeof p === "string");
          if (parts.length) command = parts.join(" ");
        }
      }
      if (!pathValue) {
        for (const key of ["path", "filePath", "file_path", "cwd"]) {
          const val = inputRecord[key];
          if (typeof val === "string" && val.trim()) {
            pathValue = val.trim();
            break;
          }
        }
      }
      // Extract write content from rawInput (Write/Create tool)
      if (writeContent === null) {
        for (const key of ["content", "new_content", "new_string", "new_str"]) {
          const val = inputRecord[key];
          if (typeof val === "string") {
            writeContent = val;
            break;
          }
        }
      }
    }
  }

  const isReadTool = isReadToolTitle(rawTitle);
  const isWriteTool = isWriteToolTitle(rawTitle);
  const suppressPath = isReadTool || isWriteTool;
  const hasStructuredInfo = description || command || (pathValue && !suppressPath) || status;
  const outputText =
    rawOutput !== undefined && rawOutput !== null
      ? typeof rawOutput === "string"
        ? rawOutput
        : stringifyMaybe(rawOutput)
      : null;

  return (
    <div className="tool-detail-view">
      {hasStructuredInfo ? (
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
          {pathValue && !suppressPath ? (
            <div className="tool-detail-row">
              <span className="tool-detail-key">路径</span>
              <code className="tool-detail-val tool-detail-code">{pathValue}</code>
            </div>
          ) : null}
        </div>
      ) : null}

      {isReadTool && outputText !== null ? (
        <FileContentView content={outputText} filePath={pathValue} mode="read" />
      ) : isWriteTool && writeContent !== null ? (
        <FileContentView content={writeContent} filePath={pathValue} mode="write" />
      ) : outputText !== null ? (
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
          <button className="secondary" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="modal-scroll-body">
          <p className="modal-meta">{props.item.meta ?? "详细内容"}</p>
          {props.item.images && props.item.images.length > 0 ? (
            <div className="modal-attached-images">
              {props.item.images.map((img, idx) => (
                <img
                  key={idx}
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={`附件图片 ${idx + 1}`}
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

function QuestionPanel(props: {
  question: QuestionPayload;
  onAnswer: (answer: string) => void;
}) {
  const [customAnswer, setCustomAnswer] = useState("");

  function handleSubmitCustomAnswer() {
    const trimmed = customAnswer.trim();
    if (!trimmed) {
      return;
    }
    props.onAnswer(trimmed);
  }

  return (
    <section className="composer-pending-item question-panel">
      <p className="composer-pending-tool question-text">{props.question.question}</p>
      {props.question.options.length > 0 ? (
        <div className="question-options">
          {props.question.options.map((option) => (
            <button
              key={option.id}
              className="question-option-btn"
              onClick={() => props.onAnswer(option.label)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {props.question.allowCustomAnswer || props.question.options.length === 0 ? (
        <div className="question-custom-answer">
          <input
            type="text"
            className="question-custom-input"
            placeholder="输入自定义回答..."
            value={customAnswer}
            onChange={(event) => setCustomAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                handleSubmitCustomAnswer();
              }
            }}
          />
          <button
            className="secondary"
            onClick={handleSubmitCustomAnswer}
            disabled={!customAnswer.trim()}
          >
            提交
          </button>
        </div>
      ) : null}
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
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">{props.sessionTitle}</p>
            <h3>{toolTitle}</h3>
          </div>
          <button className="secondary" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="modal-scroll-body">
          <p className="modal-meta">待处理确认</p>
          {planText ? (
            <div className="modal-body markdown-body">{renderMarkdownBlocks(planText)}</div>
          ) : (
            <ToolCallDetailView body={body} />
          )}
        </div>
        <div className="modal-footer">
          {props.permission.options.map((option) => (
            <button
              key={option.optionId}
              className="secondary"
              onClick={() => props.onResolve(props.permission, option.optionId)}
            >
              {option.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SystemFeedModal(props: {
  items: TimelineItem[];
  title: string;
  subtitle: string;
  onClose: () => void;
  onOpenItem: (item: TimelineItem) => void;
}) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal-card system-modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">{props.title}</p>
            <h3>{props.subtitle}</h3>
          </div>
          <button className="secondary" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="modal-scroll-body">
          <div className="system-modal-list">
            {props.items.map((item) => (
              <TimelineRow key={item.id} item={item} onOpen={() => props.onOpenItem(item)} />
            ))}
          </div>
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
  getSessionSidebarStatus,
  shouldShowSessionException,
  hasCompletedPrompt,
  hasSessionErrorLog,
  formatRelativeUpdatedAt,
  canNavigateUp,
  parentDirectory,
  isWithinRoot,
  normalizePath,
  buildPathBreadcrumbs,
  toSingleLine,
  toPreviewText,
  normalizeTimelineItem,
  normalizeMergedTimeline,
  normalizeSessionTitle,
  formatSessionTitleForDisplay,
  formatWorkspacePathForSidebar,
  resolveToolDisplayTitle,
  extractPlanPreview,
  extractChunkText,
  tryParseJson,
  normalizeAvailableCommands,
  getPromptCommandCompletions,
  applyPromptCommandCompletion,
  extractPromptCommandQuery,
  splitCompletionLabel,
  buildCompletionSections,
  normalizeAcpToolTitle,
  isReadToolTitle,
  isWriteToolTitle,
  canMergeToolTimelineItem,
  resolveWorkspaceLookupPath,
  buildTimelineTreeRows,
  countChildrenByRoot,
  isSubagentToolTitle,
  buildDemoFixtures,
  applyDemoPreset,
  shouldUseExpandedPreview,
  shouldRenderMarkdown,
  parseMarkdownTableRow,
  isMarkdownTableSeparator,
  isMarkdownTableRow,
  findLatestExecutionPlan,
  findLatestExecutionPlanBody,
  parseExecutionPlanSteps,
  truncateUnknownText,
  shouldKeepSessionRunningAfterPromptFinished,
};
