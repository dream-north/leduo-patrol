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

