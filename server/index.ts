import express from "express";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { SessionManager, type SocketEvent } from "./session-manager.js";
import { buildWorkspaceDiffSnapshot } from "./git-diff.js";
import { createAccessKey, isAccessKeyAuthorized } from "./access-key.js";

type ClientCommand =
  | { type: "hello" }
  | { type: "create_session"; payload: { workspacePath: string; title?: string; modeId?: string } }
  | { type: "prompt"; payload: { clientSessionId: string; text: string; modeId?: string } }
  | { type: "cancel"; payload: { clientSessionId: string } }
  | { type: "permission"; payload: { clientSessionId: string; requestId: string; optionId: string } }
  | { type: "close_session"; payload: { clientSessionId: string } };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkspacePath = process.env.LEDUO_PATROL_WORKSPACE_PATH ?? process.cwd();
const allowedRoots = (
  process.env.LEDUO_PATROL_ALLOWED_ROOTS
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [defaultWorkspacePath]
).map((entry) => path.resolve(entry));
const appName = process.env.LEDUO_PATROL_APP_NAME ?? "乐汪队";
const sshHost = process.env.LEDUO_PATROL_SSH_HOST ?? "";
const sshPath = process.env.LEDUO_PATROL_SSH_PATH ?? defaultWorkspacePath;
const vscodeRemoteUri =
  process.env.LEDUO_PATROL_VSCODE_URI ??
  (sshHost ? `vscode://vscode-remote/ssh-remote+${encodeURIComponent(sshHost)}${sshPath}` : "");
const port = Number(process.env.PORT ?? 3001);
const agentBinPath = path.resolve(process.cwd(), "node_modules/.bin/claude-code-acp");
const accessKey = process.env.LEDUO_PATROL_ACCESS_KEY?.trim() || createAccessKey();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const sessionManager = new SessionManager({
  allowedRoots,
  agentBinPath,
});

await sessionManager.initialize();

app.use((req, res, next) => {
  if (isAccessKeyAuthorized(req.originalUrl, accessKey)) {
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

app.get("/api/session-diff", async (req, res) => {
  try {
    const clientSessionId = typeof req.query.clientSessionId === "string" ? req.query.clientSessionId : "";
    if (!clientSessionId) {
      throw new Error("clientSessionId is required");
    }

    const workspacePath = sessionManager.getSessionWorkspacePath(clientSessionId);
    const diffSnapshot = await buildWorkspaceDiffSnapshot(workspacePath);
    res.json(diffSnapshot);
  } catch (error) {
    res.status(400).json({
      message: formatError(error),
    });
  }
});

app.get("/api/directories", async (req, res) => {
  try {
    const requestedRoot = typeof req.query.root === "string" ? req.query.root : defaultWorkspacePath;
    const resolvedRoot = resolveAllowedPath(requestedRoot);
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
app.use(express.static(webDistPath));

app.get("/{*rest}", (_req, res) => {
  res.sendFile(path.resolve(webDistPath, "index.html"));
});

wss.on("connection", (socket, request) => {
  if (!isAccessKeyAuthorized(request.url, accessKey)) {
    socket.close(1008, "Unauthorized");
    return;
  }

  const unsubscribe = sessionManager.subscribe((event) => sendEvent(socket, event));

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
          );
          break;
        case "cancel":
          await sessionManager.cancel(message.payload.clientSessionId);
          break;
        case "permission":
          await sessionManager.resolvePermission(
            message.payload.clientSessionId,
            message.payload.requestId,
            message.payload.optionId,
          );
          break;
        case "close_session":
          await sessionManager.closeSession(message.payload.clientSessionId);
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
  });
});

server.listen(port, () => {
  console.log(`${appName} listening on http://localhost:${port}`);
  console.log(`Access URL: http://localhost:${port}/?key=${accessKey}`);
});

function sendEvent(socket: WebSocket, event: SocketEvent) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(event));
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

function resolveAllowedPath(requestedPath: string) {
  const resolvedPath = path.resolve(requestedPath);
  const isAllowed = allowedRoots.some((rootPath) => {
    const relativePath = path.relative(rootPath, resolvedPath);
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  });

  if (!isAllowed) {
    throw new Error(`Path is outside allowed roots: ${resolvedPath}`);
  }

  return resolvedPath;
}
