#!/usr/bin/env node
import express from "express";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { userInfo } from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import { SessionManager, type SocketEvent } from "./session-manager.js";
import { formatError, resolveAllowedPath } from "./server-helpers.js";
import { ShellSession } from "./shell-session.js";
import { buildSingleFileDiff, buildWorkspaceDiffFilesSnapshot, type DiffCategory } from "./git-diff.js";
import { buildAccessCookie, hasAuthorizedAccessCookie, isAccessKeyAuthorized } from "./access-key.js";
import { findAvailablePort, pickPreferredLanIp } from "./network.js";
import { resolveBindMode } from "./launch-mode.js";
import { resolveAccessKey } from "./access-key-prompt.js";

type ClientCommand =
  | { type: "hello" }
  | { type: "create_session"; payload: { workspacePath: string; title?: string; allowSkipPermissions?: boolean } }
  | { type: "close_session"; payload: { clientSessionId: string } }
  | { type: "cli_start"; payload: { clientSessionId: string; cols: number; rows: number } }
  | { type: "cli_input"; payload: { clientSessionId: string; data: string } }
  | { type: "cli_resize"; payload: { clientSessionId: string; cols: number; rows: number } }
  | { type: "shell_start"; payload: { clientSessionId: string; cols: number; rows: number } }
  | { type: "shell_input"; payload: { clientSessionId: string; data: string } }
  | { type: "shell_resize"; payload: { clientSessionId: string; cols: number; rows: number } }
  | { type: "shell_stop"; payload: { clientSessionId: string } };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const launchCwd = process.cwd();
const defaultWorkspacePath = process.env.LEDUO_PATROL_WORKSPACE_PATH ?? launchCwd;
const allowedRoots = (
  process.env.LEDUO_PATROL_ALLOWED_ROOTS
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [launchCwd]
).map((entry) => path.resolve(entry));
const appName = process.env.LEDUO_PATROL_APP_NAME ?? "乐多汪汪队";
const sshHost = process.env.LEDUO_PATROL_SSH_HOST ?? "";
const sshPath = process.env.LEDUO_PATROL_SSH_PATH ?? defaultWorkspacePath;
const vscodeRemoteUri =
  process.env.LEDUO_PATROL_VSCODE_URI ??
  (sshHost ? `vscode://vscode-remote/ssh-remote+${encodeURIComponent(sshHost)}${sshPath}` : "");
const requestedPort = Number(process.env.PORT ?? 3001);
const devWebPort = Number(process.env.LEDUO_PATROL_WEB_PORT ?? 5173);
const npmLifecycleEvent = process.env.npm_lifecycle_event ?? "";
const isDevServer = npmLifecycleEvent === "dev:server" || npmLifecycleEvent === "dev:server:local";
const bindMode = await resolveBindMode();
const listenHost = bindMode === "local" ? "127.0.0.1" : "0.0.0.0";
const launchHost = bindMode === "local" ? "127.0.0.1" : pickPreferredLanIp();
const launchUser = userInfo().username;
const claudeBin = process.env.LEDUO_PATROL_CLAUDE_BIN?.trim() || undefined;
const accessKey = await resolveAccessKey();
const enableShell = parseBooleanFlag(process.env.LEDUO_ENABLE_SHELL, true);
const allowSkipPermissions = process.env.LEDUO_PATROL_ALLOW_SKIP_PERMISSIONS === "true";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const sessionManager = new SessionManager({
  allowedRoots,
  claudeBin,
  allowSkipPermissions,
});

await sessionManager.initialize();

if (!process.env.LEDUO_PATROL_WORKSPACE_PATH) {
  console.log(`LEDUO_PATROL_WORKSPACE_PATH not set, defaulting to current directory: ${defaultWorkspacePath}`);
  console.log("Tip: set LEDUO_PATROL_WORKSPACE_PATH to customize the default workspace.");
}
if (!process.env.LEDUO_PATROL_ALLOWED_ROOTS) {
  console.log(`LEDUO_PATROL_ALLOWED_ROOTS not set, defaulting to current directory: ${allowedRoots.join(",")}`);
  console.log("Tip: set LEDUO_PATROL_ALLOWED_ROOTS (comma-separated) to customize allowed roots.");
}

app.use((req, res, next) => {
  const authorizedByQuery = isAccessKeyAuthorized(req.originalUrl, accessKey);
  const authorizedByCookie = hasAuthorizedAccessCookie(req.headers.cookie, accessKey);
  const isApiRequest = req.path.startsWith("/api/");

  if (authorizedByQuery) {
    res.setHeader("Set-Cookie", buildAccessCookie(accessKey));
  }

  if (!isApiRequest) {
    next();
    return;
  }

  if (authorizedByQuery || authorizedByCookie) {
    next();
    return;
  }

  res.status(401).json({
    message: "Unauthorized: invalid access key",
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    appName,
    workspacePath: defaultWorkspacePath,
    allowedRoots,
    sshHost,
    sshPath,
    vscodeRemoteUri,
    enableShell,
    launchMode: bindMode,
    launchHost,
    launchUser,
    allowSkipPermissions,
  });
});

app.get("/api/state", (_req, res) => {
  res.json(sessionManager.getStateSnapshot());
});

app.get("/api/session-diff/files", async (req, res) => {
  try {
    const clientSessionId = typeof req.query.clientSessionId === "string" ? req.query.clientSessionId : "";
    if (!clientSessionId) {
      throw new Error("clientSessionId is required");
    }

    const workspacePath = sessionManager.getSessionWorkspacePath(clientSessionId);
    const diffSnapshot = await buildWorkspaceDiffFilesSnapshot(workspacePath);
    res.json(diffSnapshot);
  } catch (error) {
    res.status(400).json({
      message: formatError(error),
    });
  }
});

app.get("/api/session-diff/file", async (req, res) => {
  try {
    const clientSessionId = typeof req.query.clientSessionId === "string" ? req.query.clientSessionId : "";
    const category = typeof req.query.category === "string" ? req.query.category : "";
    const filePath = typeof req.query.filePath === "string" ? req.query.filePath : "";
    if (!clientSessionId) {
      throw new Error("clientSessionId is required");
    }
    if (!["workingTree", "staged", "untracked"].includes(category)) {
      throw new Error("category is invalid");
    }
    if (!filePath.trim()) {
      throw new Error("filePath is required");
    }

    const workspacePath = sessionManager.getSessionWorkspacePath(clientSessionId);
    const fileDiff = await buildSingleFileDiff(workspacePath, category as DiffCategory, filePath);
    res.json(fileDiff);
  } catch (error) {
    res.status(400).json({
      message: formatError(error),
    });
  }
});

app.get("/api/directories", async (req, res) => {
  try {
    const requestedRoot = typeof req.query.root === "string" ? req.query.root : defaultWorkspacePath;
    const resolvedRoot = resolveAllowedPath(requestedRoot, allowedRoots);
    const entries = await readdir(resolvedRoot, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(resolvedRoot, entry.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));

    res.json({
      rootPath: resolvedRoot,
      directories,
    });
  } catch (error) {
    res.status(400).json({
      message: formatError(error),
    });
  }
});

const webDistPath = path.resolve(__dirname, "../web");
const hasBundledWeb = await hasReadableFile(path.resolve(webDistPath, "index.html"));

if (hasBundledWeb) {
  app.use(express.static(webDistPath));

  app.get("/{*rest}", (_req, res) => {
    res.sendFile(path.resolve(webDistPath, "index.html"));
  });
} else {
  app.get("/{*rest}", (_req, res) => {
    res.status(503).send(`<!doctype html><html><body><h2>Web assets not found</h2><p>Missing bundled web at <code>${webDistPath}</code>.</p><p>Run <code>npm run build</code> before <code>npm start</code>, or use <code>npm run dev</code> for development.</p></body></html>`);
  });

  console.log(`Bundled web assets not found at ${webDistPath}.`);
  console.log(`Tip: run \"npm run build\" before \"npm start\".`);
}

wss.on("connection", (socket, request) => {
  if (!isAccessKeyAuthorized(request.url, accessKey)) {
    socket.close(1008, "Unauthorized");
    return;
  }

  const shellSessions = new Map<string, ShellSession>();
  const unsubscribe = sessionManager.subscribe((event) => {
    if (event.type === "session_closed") {
      const shellSession = shellSessions.get(event.payload.clientSessionId);
      if (shellSession) {
        shellSession.kill();
        shellSessions.delete(event.payload.clientSessionId);
      }
    }
    sendEvent(socket, event);
  });

  socket.on("message", async (raw) => {
    try {
      const message = JSON.parse(String(raw)) as ClientCommand;
      switch (message.type) {
        case "hello":
          sendEvent(socket, {
            type: "ready",
            payload: { sessions: sessionManager.getStateSnapshot().sessions },
          });
          break;
        case "create_session":
          await sessionManager.createSession(
            message.payload.workspacePath,
            message.payload.title,
            message.payload.allowSkipPermissions,
          );
          break;
        case "close_session":
          await sessionManager.closeSession(message.payload.clientSessionId);
          break;
        case "cli_start": {
          const cliSessionId = message.payload.clientSessionId;
          sessionManager.resizeCliSession(
            cliSessionId,
            Math.max(2, message.payload.cols),
            Math.max(2, message.payload.rows),
          );
          // Replay buffered output so the client sees history after reconnect
          const buffered = sessionManager.getSessionOutputBuffer(cliSessionId);
          if (buffered) {
            sendEvent(socket, {
              type: "cli_output",
              payload: { clientSessionId: cliSessionId, data: buffered },
            });
          }
          break;
        }
        case "cli_input":
          sessionManager.writeToSession(
            message.payload.clientSessionId,
            message.payload.data,
          );
          break;
        case "cli_resize":
          sessionManager.resizeCliSession(
            message.payload.clientSessionId,
            Math.max(2, message.payload.cols),
            Math.max(2, message.payload.rows),
          );
          break;
        case "shell_start": {
          if (!enableShell) {
            throw new Error("Shell feature is disabled. Set LEDUO_ENABLE_SHELL=true to enable it.");
          }
          const clientSessionId = message.payload.clientSessionId;
          const existingShell = shellSessions.get(clientSessionId);
          const cols = Math.max(2, message.payload.cols);
          const rows = Math.max(2, message.payload.rows);
          if (existingShell?.alive) {
            existingShell.resize(cols, rows);
            break;
          }

          const shellWorkspacePath = sessionManager.getSessionWorkspacePath(clientSessionId);
          const newShell = new ShellSession(shellWorkspacePath, cols, rows);
          shellSessions.set(clientSessionId, newShell);
          newShell.on("output", (data: string) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "shell_output", payload: { clientSessionId, data } }));
            }
          });
          newShell.on("exit", (exitCode: number) => {
            if (shellSessions.get(clientSessionId) === newShell) {
              shellSessions.delete(clientSessionId);
            }
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "shell_exited", payload: { clientSessionId, exitCode } }));
            }
          });
          break;
        }
        case "shell_input":
          if (!shellSessions.get(message.payload.clientSessionId)?.alive) {
            throw new Error("Shell is not running");
          }
          shellSessions.get(message.payload.clientSessionId)?.write(message.payload.data);
          break;
        case "shell_resize":
          shellSessions.get(message.payload.clientSessionId)?.resize(message.payload.cols, message.payload.rows);
          break;
        case "shell_stop":
          shellSessions.get(message.payload.clientSessionId)?.kill();
          shellSessions.delete(message.payload.clientSessionId);
          break;
      }
    } catch (error) {
      sendEvent(socket, {
        type: "error",
        payload: { message: formatError(error), fatal: true },
      });
    }
  });

  socket.on("close", () => {
    unsubscribe();
    for (const shellSession of shellSessions.values()) {
      shellSession.kill();
    }
    shellSessions.clear();
  });
});

const listenPort = await findAvailablePort(requestedPort, listenHost);

await new Promise<void>((resolve) => {
  server.listen(listenPort, listenHost, () => resolve());
});

const displayHost = launchHost;
const accessPort = isDevServer ? devWebPort : listenPort;

console.log(`Launch mode: ${bindMode === "local" ? "local (127.0.0.1 only)" : "server (remote accessible)"}`);
console.log(`${appName} server listening on http://${displayHost}:${listenPort}`);
if (listenPort !== requestedPort) {
  console.log(`Port ${requestedPort} is busy, switched to ${listenPort}`);
}
if (isDevServer) {
  console.log(`Dev Web URL (Vite default): http://${displayHost}:${devWebPort}`);
} else if (hasBundledWeb) {
  console.log(`Web UI is served by the same server port: http://${displayHost}:${listenPort}`);
} else {
  console.log("Web UI is unavailable on this start because bundled assets are missing.");
}
console.log(`Access URL: http://${displayHost}:${accessPort}/?key=${accessKey}`);
console.log(`Shell feature: ${enableShell ? "enabled" : "disabled"}`);

function sendEvent(socket: WebSocket, event: SocketEvent) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(event));
}

async function hasReadableFile(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseBooleanFlag(rawValue: string | undefined, defaultValue: boolean) {
  if (rawValue == null || rawValue.trim() === "") {
    return defaultValue;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}
