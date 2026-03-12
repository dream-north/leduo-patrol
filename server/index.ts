#!/usr/bin/env node
import express from "express";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { SessionManager, type SocketEvent } from "./session-manager.js";
import { formatError, resolveAllowedPath } from "./server-helpers.js";
import { ShellSession } from "./shell-session.js";
import { buildSingleFileDiff, buildWorkspaceDiffFilesSnapshot, type DiffCategory } from "./git-diff.js";
import { buildAccessCookie, createAccessKey, hasAuthorizedAccessCookie, isAccessKeyAuthorized } from "./access-key.js";
import { findAvailablePort, pickPreferredLanIp } from "./network.js";

type ClientCommand =
  | { type: "hello" }
  | { type: "create_session"; payload: { workspacePath: string; title?: string; modeId?: string } }
  | { type: "prompt"; payload: { clientSessionId: string; text: string; modeId?: string; images?: Array<{ data: string; mimeType: string }> } }
  | { type: "set_mode"; payload: { clientSessionId: string; modeId: string } }
  | { type: "cancel"; payload: { clientSessionId: string } }
  | { type: "permission"; payload: { clientSessionId: string; requestId: string; optionId: string; note?: string } }
  | { type: "close_session"; payload: { clientSessionId: string } }
  | { type: "shell_start"; payload: { clientSessionId: string; cols: number; rows: number } }
  | { type: "shell_input"; payload: { data: string } }
  | { type: "shell_resize"; payload: { cols: number; rows: number } }
  | { type: "shell_stop" };

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
const isDevServer = process.env.npm_lifecycle_event === "dev:server";
const agentBinPath = resolveAgentBinPath();
const accessKey = process.env.LEDUO_PATROL_ACCESS_KEY?.trim() || createAccessKey();
const enableShell = process.env.LEDUO_ENABLE_SHELL === "true";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const sessionManager = new SessionManager({
  allowedRoots,
  agentBinPath,
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
  });
});

app.get("/api/state", (_req, res) => {
  res.json(sessionManager.getStateSnapshot());
});

app.get("/api/session-history", (req, res) => {
  try {
    const clientSessionId = typeof req.query.clientSessionId === "string" ? req.query.clientSessionId : "";
    const before = Number(req.query.before ?? 0);
    const limit = Number(req.query.limit ?? 120);
    if (!clientSessionId) {
      throw new Error("clientSessionId is required");
    }

    res.json(sessionManager.getSessionHistory(clientSessionId, before, limit));
  } catch (error) {
    res.status(400).json({
      message: formatError(error),
    });
  }
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

  const unsubscribe = sessionManager.subscribe((event) => sendEvent(socket, event));
  let shellSession: ShellSession | null = null;

  socket.on("message", async (raw) => {
    try {
      const message = JSON.parse(String(raw)) as ClientCommand;
      switch (message.type) {
        case "hello":
          sendEvent(socket, {
            type: "ready",
            payload: { workspacePath: defaultWorkspacePath, agentConnected: sessionManager.getStateSnapshot().sessions.length > 0 },
          });
          break;
        case "create_session":
          await sessionManager.createSession(
            message.payload.workspacePath,
            message.payload.title,
            message.payload.modeId,
          );
          break;
        case "prompt":
          await sessionManager.prompt(
            message.payload.clientSessionId,
            message.payload.text,
            message.payload.modeId,
            message.payload.images,
          );
          break;
        case "set_mode":
          await sessionManager.setSessionMode(message.payload.clientSessionId, message.payload.modeId);
          break;
        case "cancel":
          await sessionManager.cancel(message.payload.clientSessionId);
          break;
        case "permission":
          await sessionManager.resolvePermission(
            message.payload.clientSessionId,
            message.payload.requestId,
            message.payload.optionId,
            message.payload.note,
          );
          break;
        case "close_session":
          await sessionManager.closeSession(message.payload.clientSessionId);
          break;
        case "shell_start": {
          if (!enableShell) {
            throw new Error("Shell feature is disabled. Set LEDUO_ENABLE_SHELL=true to enable it.");
          }
          shellSession?.kill();
          shellSession = null;
          const cols = Math.max(2, message.payload.cols);
          const rows = Math.max(2, message.payload.rows);
          const shellWorkspacePath = sessionManager.getSessionWorkspacePath(message.payload.clientSessionId);
          const newShell = new ShellSession(shellWorkspacePath, cols, rows);
          shellSession = newShell;
          newShell.on("output", (data: string) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "shell_output", payload: { data } }));
            }
          });
          newShell.on("exit", (exitCode: number) => {
            if (shellSession === newShell) {
              shellSession = null;
            }
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "shell_exited", payload: { exitCode } }));
            }
          });
          break;
        }
        case "shell_input":
          if (!shellSession?.alive) {
            throw new Error("Shell is not running");
          }
          shellSession.write(message.payload.data);
          break;
        case "shell_resize":
          shellSession?.resize(message.payload.cols, message.payload.rows);
          break;
        case "shell_stop":
          shellSession?.kill();
          shellSession = null;
          break;
      }
    } catch (error) {
      sendEvent(socket, {
        type: "error",
        payload: { message: formatError(error) },
      });
    }
  });

  socket.on("close", () => {
    unsubscribe();
    shellSession?.kill();
    shellSession = null;
  });
});

const listenPort = await findAvailablePort(requestedPort);

await new Promise<void>((resolve) => {
  server.listen(listenPort, "0.0.0.0", () => resolve());
});

const lanIp = pickPreferredLanIp();
const accessPort = isDevServer ? devWebPort : listenPort;

console.log(`${appName} server listening on http://${lanIp}:${listenPort}`);
if (listenPort !== requestedPort) {
  console.log(`Port ${requestedPort} is busy, switched to ${listenPort}`);
}
if (isDevServer) {
  console.log(`Dev Web URL (Vite default): http://${lanIp}:${devWebPort}`);
} else if (hasBundledWeb) {
  console.log(`Web UI is served by the same server port: http://${lanIp}:${listenPort}`);
} else {
  console.log("Web UI is unavailable on this start because bundled assets are missing.");
}
console.log(`Access URL: http://${lanIp}:${accessPort}/?key=${accessKey}`);

function sendEvent(socket: WebSocket, event: SocketEvent) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(event));
}

function resolveAgentBinPath() {
  if (process.env.LEDUO_PATROL_AGENT_BIN?.trim()) {
    return process.env.LEDUO_PATROL_AGENT_BIN.trim();
  }

  const require = createRequire(import.meta.url);
  try {
    const pkgPath = require.resolve("@zed-industries/claude-code-acp/package.json");
    const pkgDir = path.dirname(pkgPath);
    return path.join(pkgDir, "dist", "index.js");
  } catch {
    return "claude-code-acp";
  }
}

async function hasReadableFile(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
