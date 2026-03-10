import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const DIFF_TOO_LARGE_THRESHOLD_BYTES = Number(process.env.LEDUO_PATROL_MAX_DIFF_FILE_BYTES ?? 200 * 1024);

export type DiffCategory = "workingTree" | "staged" | "untracked";

export type DiffFileInfo = {
  filePath: string;
  changeType: "新增" | "修改";
};

export type WorkspaceDiffFilesSnapshot = {
  workspacePath: string;
  workspaceReadonly: boolean;
  repositoryRoot: string;
  workingTree: DiffFileInfo[];
  staged: DiffFileInfo[];
  untracked: DiffFileInfo[];
};

export type DiffFileResponse = {
  category: DiffCategory;
  filePath: string;
  omitted: boolean;
  diff: string;
  reason?: string;
};

export async function buildWorkspaceDiffFilesSnapshot(workspacePath: string): Promise<WorkspaceDiffFilesSnapshot> {
  const repositoryRoot = await resolveRepositoryRoot(workspacePath);
  const statusOutput = await runGit(repositoryRoot, ["status", "--porcelain", "--", "."]);
  const parsed = parsePorcelainStatus(statusOutput);

  return {
    workspacePath,
    workspaceReadonly: await detectReadonly(workspacePath),
    repositoryRoot,
    workingTree: parsed.workingTree,
    staged: parsed.staged,
    untracked: parsed.untracked,
  };
}

export async function buildSingleFileDiff(
  workspacePath: string,
  category: DiffCategory,
  filePath: string,
): Promise<DiffFileResponse> {
  const repositoryRoot = await resolveRepositoryRoot(workspacePath);
  const normalizedPath = filePath.trim();
  if (!normalizedPath) {
    throw new Error("filePath is required");
  }

  const diff =
    category === "workingTree"
      ? await runGit(repositoryRoot, ["diff", "--no-color", "--", normalizedPath])
      : category === "staged"
        ? await runGit(repositoryRoot, ["diff", "--cached", "--no-color", "--", normalizedPath])
        : await runDiffForUntrackedFile(repositoryRoot, normalizedPath);

  if (Buffer.byteLength(diff, "utf8") > DIFF_TOO_LARGE_THRESHOLD_BYTES) {
    return {
      category,
      filePath: normalizedPath,
      omitted: true,
      diff: "",
      reason: `该文件 Diff 过大（>${Math.round(DIFF_TOO_LARGE_THRESHOLD_BYTES / 1024)}KB），已省略显示。`,
    };
  }

  return {
    category,
    filePath: normalizedPath,
    omitted: false,
    diff,
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

async function runDiffForUntrackedFile(cwd: string, relativePath: string) {
  const absolutePath = path.join(cwd, relativePath);
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

function parsePorcelainStatus(statusOutput: string) {
  const workingTree = new Set<string>();
  const staged = new Set<string>();
  const untracked = new Set<string>();

  for (const rawLine of statusOutput.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }
    const statusCode = line.slice(0, 2);
    const pathText = normalizeStatusPath(line.slice(3).trim());
    if (!pathText) {
      continue;
    }

    if (statusCode === "??") {
      untracked.add(pathText);
      continue;
    }

    const stagedCode = statusCode[0] ?? " ";
    const workingCode = statusCode[1] ?? " ";

    if (stagedCode !== " ") {
      staged.add(pathText);
    }
    if (workingCode !== " ") {
      workingTree.add(pathText);
    }
  }

  return {
    workingTree: [...workingTree].sort((a, b) => a.localeCompare(b)).map((filePath) => ({ filePath, changeType: "修改" as const })),
    staged: [...staged].sort((a, b) => a.localeCompare(b)).map((filePath) => ({ filePath, changeType: "修改" as const })),
    untracked: [...untracked].sort((a, b) => a.localeCompare(b)).map((filePath) => ({ filePath, changeType: "新增" as const })),
  };
}

function normalizeStatusPath(pathText: string) {
  const renameMarker = " -> ";
  const renamedTo = pathText.includes(renameMarker) ? pathText.split(renameMarker).at(-1) : pathText;
  return (renamedTo ?? "").trim();
}
