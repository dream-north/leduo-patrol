import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSpawnFailureMessage, ensureDirectoryExistsSync } from "./server-helpers.js";
import { ensureNodePtySpawnHelperExecutable } from "./pty-runtime.js";

export interface ClaudeCliSessionOptions {
  workspacePath: string;
  sessionId: string;
  resume?: boolean;
  cols?: number;
  rows?: number;
  claudeBin?: string;
  allowSkipPermissions?: boolean;
}

type ClaudeLaunchConfig = {
  command: string;
  args: string[];
};

/**
 * A PTY-backed session that runs the native Claude Code CLI.
 *
 * Unlike ShellSession (restricted bash), this inherits the full process
 * environment so that the CLI has access to PATH, ANTHROPIC_API_KEY,
 * user-configured tool-chains (nvm, pyenv, etc.) and everything else
 * available to the OS user that started leduo-patrol.
 */
export class ClaudeCliSession extends EventEmitter {
  private pty: IPty;
  private _alive = true;
  readonly sessionId: string;

  constructor(opts: ClaudeCliSessionOptions) {
    super();

    this.sessionId = opts.sessionId;
    ensureDirectoryExistsSync(opts.workspacePath, "Session workspace");
    ensureNodePtySpawnHelperExecutable();

    const bin = resolveClaudeBin(opts.claudeBin);
    const args: string[] = opts.resume
      ? ["--resume", opts.sessionId]
      : ["--session-id", opts.sessionId];

    if (opts.allowSkipPermissions) {
      args.push("--allow-dangerously-skip-permissions");
    }

    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    } as Record<string, string>;

    try {
      this.pty = spawnClaudePty(
        buildDirectClaudeLaunch(bin, args),
        opts.workspacePath,
        opts.cols ?? 80,
        opts.rows ?? 24,
        env,
      );
    } catch (error) {
      if (!shouldRetryClaudeSpawnWithShell(error)) {
        throw new Error(
          buildSpawnFailureMessage(
            "Claude CLI",
            bin,
            opts.workspacePath,
            error,
            "Check that the command is installed correctly, or override it with LEDUO_PATROL_CLAUDE_BIN.",
          ),
        );
      }

      try {
        this.pty = spawnClaudePty(
          buildShellWrappedClaudeLaunch(bin, args),
          opts.workspacePath,
          opts.cols ?? 80,
          opts.rows ?? 24,
          env,
        );
      } catch (fallbackError) {
        throw new Error(
          buildSpawnFailureMessage(
            "Claude CLI",
            bin,
            opts.workspacePath,
            fallbackError,
            "Direct PTY spawn also failed, even after retrying through a shell wrapper. Check that Claude Code is installed correctly, or override it with LEDUO_PATROL_CLAUDE_BIN.",
          ),
        );
      }
    }

    this.pty.onData((data) => {
      this.emit("output", data);
    });

    this.pty.onExit(({ exitCode }) => {
      this._alive = false;
      this.emit("exit", exitCode);
    });
  }

  get alive(): boolean {
    return this._alive;
  }

  write(data: string): void {
    if (this._alive) {
      this.pty.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (this._alive) {
      this.pty.resize(Math.max(cols, 2), Math.max(rows, 2));
    }
  }

  kill(): void {
    if (this._alive) {
      this._alive = false;
      this.pty.kill();
    }
  }
}

function spawnClaudePty(
  launch: ClaudeLaunchConfig,
  workspacePath: string,
  cols: number,
  rows: number,
  env: Record<string, string>,
) {
  return spawn(launch.command, launch.args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: workspacePath,
    env,
  });
}

function buildDirectClaudeLaunch(bin: string, args: string[]): ClaudeLaunchConfig {
  return {
    command: bin,
    args,
  };
}

function buildShellWrappedClaudeLaunch(
  bin: string,
  args: string[],
  shellExists: (candidate: string) => boolean = existsSync,
): ClaudeLaunchConfig {
  return {
    command: resolveClaudeWrapperShell(shellExists),
    args: ["-c", 'exec "$0" "$@"', bin, ...args],
  };
}

function resolveClaudeWrapperShell(shellExists: (candidate: string) => boolean = existsSync) {
  const candidates = ["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/sh"];
  for (const candidate of candidates) {
    if (shellExists(candidate)) {
      return candidate;
    }
  }
  throw new Error("No compatible shell was found for Claude CLI fallback launch.");
}

function shouldRetryClaudeSpawnWithShell(error: unknown) {
  if (process.platform === "win32") {
    return false;
  }

  return error instanceof Error && /posix_spawnp failed/i.test(error.message);
}

function findExecutableOnPath(command: string, envPath = process.env.PATH) {
  if (!envPath) return null;

  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT?.split(";").filter(Boolean) ?? [".exe", ".cmd", ".bat"])
    : [""];

  for (const entry of envPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${command}${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolveClaudeBin(configuredBin?: string, env: NodeJS.ProcessEnv = process.env) {
  const candidate = configuredBin?.trim() || "claude";
  const hasExplicitPath = candidate.includes("/") || candidate.includes("\\");

  if (hasExplicitPath) {
    if (existsSync(candidate)) {
      return candidate;
    }
    throw new Error(
      `Claude CLI not found at "${candidate}". Set LEDUO_PATROL_CLAUDE_BIN to a valid Claude executable path.`,
    );
  }

  const resolved = findExecutableOnPath(candidate, env.PATH);
  if (resolved) {
    return resolved;
  }

  throw new Error(
    `Claude CLI "${candidate}" was not found in PATH. Install Claude Code first, or set LEDUO_PATROL_CLAUDE_BIN=/absolute/path/to/claude.`,
  );
}

export const claudeCliSessionTestables = {
  buildDirectClaudeLaunch,
  buildShellWrappedClaudeLaunch,
  findExecutableOnPath,
  resolveClaudeBin,
  resolveClaudeWrapperShell,
  shouldRetryClaudeSpawnWithShell,
};
