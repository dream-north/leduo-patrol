import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSpawnFailureMessage, ensureDirectoryExistsSync } from "./server-helpers.js";
import { ensureNodePtySpawnHelperExecutable } from "./pty-runtime.js";

type ShellLaunchConfig = {
  command: string;
  args: string[];
};

function buildShellLoginArgs(command: string): string[] {
  const shellName = path.basename(command).toLowerCase();
  if (["bash", "zsh", "ksh", "fish"].includes(shellName)) {
    return ["-l"];
  }

  return [];
}

function resolveShellLaunch(
  env: NodeJS.ProcessEnv = process.env,
  shellExists: (path: string) => boolean = existsSync,
): ShellLaunchConfig {
  const configuredShell = env.LEDUO_PATROL_SHELL?.trim() ?? "";
  const loginShell = env.SHELL?.trim() ?? "";
  const absoluteCandidates = [
    configuredShell,
    loginShell,
    "/bin/bash",
    "/bin/zsh",
    "/bin/sh",
    "/usr/bin/bash",
    "/usr/bin/zsh",
    "/usr/local/bin/bash",
    "/usr/local/bin/zsh",
    "/opt/homebrew/bin/bash",
    "/opt/homebrew/bin/zsh",
  ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);

  for (const candidate of absoluteCandidates) {
    if (shellExists(candidate)) {
      return {
        command: candidate,
        args: buildShellLoginArgs(candidate),
      };
    }
  }

  if (configuredShell) {
    return {
      command: configuredShell,
      args: buildShellLoginArgs(configuredShell),
    };
  }

  throw new Error(
    `No supported shell was found. Set LEDUO_PATROL_SHELL to an absolute shell path if your system does not provide /bin/bash, /bin/zsh, or /bin/sh.`,
  );
}

/**
 * An interactive shell session backed by a PTY.
 *
 * Spawns the best-available interactive shell for the host environment.
 * We prefer a login shell when possible so that user toolchains such as
 * pyenv, nvm, brew, cargo, aliases, etc. are available in published installs too.
 */
export class ShellSession extends EventEmitter {
  private pty: IPty;
  private _alive = true;

  constructor(workspacePath: string, cols = 80, rows = 24) {
    super();
    ensureDirectoryExistsSync(workspacePath, "Shell workspace");
    ensureNodePtySpawnHelperExecutable();
    const shellLaunch = resolveShellLaunch();

    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] != null,
        ),
      ),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PWD: workspacePath,
      SHELL: shellLaunch.command,
    };

    try {
      this.pty = spawn(shellLaunch.command, shellLaunch.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: workspacePath,
        env,
      });
    } catch (error) {
      throw new Error(
        buildSpawnFailureMessage(
          "shell",
          shellLaunch.command,
          workspacePath,
          error,
          "Set LEDUO_PATROL_SHELL to a valid shell path if this environment uses a non-standard shell location.",
        ),
      );
    }

    this.pty.onData((data) => {
      this.emit("output", data);
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this._alive = false;
      this.emit("exit", exitCode, signal);
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

export const shellSessionTestables = {
  buildShellLoginArgs,
  resolveShellLaunch,
};
