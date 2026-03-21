import { statSync } from "node:fs";
import path from "node:path";

export function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function resolveAllowedPath(requestedPath: string, allowedRoots: string[]) {
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

export function ensureDirectoryExistsSync(requestedPath: string, label: string) {
  try {
    const stats = statSync(requestedPath);
    if (!stats.isDirectory()) {
      throw new Error(`${label} is not a directory: ${requestedPath}`);
    }
    return requestedPath;
  } catch (error) {
    if (error instanceof Error && error.message.includes("is not a directory")) {
      throw error;
    }
    throw new Error(`${label} does not exist or is not accessible: ${requestedPath}`);
  }
}

export function buildSpawnFailureMessage(commandLabel: string, command: string, cwd: string, error: unknown, hint?: string) {
  const quotedCommand = JSON.stringify(command);
  const quotedCwd = JSON.stringify(cwd);
  const message = `Failed to start ${commandLabel} ${quotedCommand} in ${quotedCwd}: ${formatError(error)}`;
  return hint ? `${message}. ${hint}` : message;
}
