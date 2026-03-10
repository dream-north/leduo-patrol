import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type WorkspaceDiffSnapshot = {
  workspacePath: string;
  workspaceReadonly: boolean;
  repositoryRoot: string;
  workingTreeDiff: string;
  stagedDiff: string;
  untrackedFiles: Array<{ path: string; diff: string }>;
};

export async function buildWorkspaceDiffSnapshot(workspacePath: string): Promise<WorkspaceDiffSnapshot> {
  const repositoryRoot = await resolveRepositoryRoot(workspacePath);
  const [workingTreeDiff, stagedDiff, statusOutput] = await Promise.all([
    runGit(repositoryRoot, ["diff", "--no-color", "--", "."]),
    runGit(repositoryRoot, ["diff", "--cached", "--no-color", "--", "."]),
    runGit(repositoryRoot, ["status", "--porcelain", "--", "."]),
  ]);
  const untrackedPaths = parseUntrackedPaths(statusOutput);
  const untrackedFiles = await Promise.all(
    untrackedPaths.map(async (relativePath) => {
      const absolutePath = path.join(repositoryRoot, relativePath);
      const diff = await runDiffForNewFile(repositoryRoot, absolutePath);
      return {
        path: relativePath,
        diff,
      };
    }),
  );

  return {
    workspacePath,
    workspaceReadonly: await detectReadonly(workspacePath),
    repositoryRoot,
    workingTreeDiff,
    stagedDiff,
    untrackedFiles,
  };
}

async function detectReadonly(workspacePath: string) {
  try {
    await access(workspacePath, constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

async function resolveRepositoryRoot(workspacePath: string) {
  const output = await runGit(workspacePath, ["rev-parse", "--show-toplevel"]);
  const root = output.trim();
  if (!root) {
    throw new Error("当前目录不是 Git 仓库。");
  }
  return root;
}

async function runGit(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

async function runDiffForNewFile(cwd: string, absolutePath: string) {
  try {
    return await runGit(cwd, ["diff", "--no-index", "--no-color", "/dev/null", absolutePath]);
  } catch (error) {
    if (isExpectedNoIndexExit(error)) {
      return error.stdout;
    }
    throw error;
  }
}

function isExpectedNoIndexExit(error: unknown): error is { code?: number; stdout: string } {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: number }).code === 1 && "stdout" in error;
}

function parseUntrackedPaths(statusOutput: string) {
  return statusOutput
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}
