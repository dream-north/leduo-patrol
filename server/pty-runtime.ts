import { chmodSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function ensureNodePtySpawnHelperExecutable() {
  if (process.platform !== "darwin") {
    return;
  }

  const helperPath = resolveNodePtySpawnHelperPath();
  if (!helperPath) {
    return;
  }

  ensureExecutableBit(helperPath);
}

export function resolveNodePtySpawnHelperPath() {
  const packageJsonPath = require.resolve("node-pty/package.json");
  const packageRoot = path.dirname(packageJsonPath);
  const helperPath = path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  return existsSync(helperPath) ? helperPath : null;
}

export function ensureExecutableBit(filePath: string) {
  const stats = statSync(filePath);
  if ((stats.mode & 0o111) === 0o111) {
    return false;
  }

  chmodSync(filePath, stats.mode | 0o755);
  return true;
}
