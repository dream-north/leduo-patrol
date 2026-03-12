import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";

// Resolve bash path; prefer the user's login shell if it is bash, then common locations
function resolveBashPath(): string {
  const loginShell = process.env.SHELL ?? "";
  if (loginShell && /bash$/i.test(loginShell) && existsSync(loginShell)) {
    return loginShell;
  }
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  // Fall back to plain "bash" and let the OS resolve it via PATH
  return "bash";
}

/**
 * A restricted interactive shell session backed by a PTY.
 *
 * Security model:
 *  - Spawns `bash --restricted` (rbash): prevents `cd`, modifying PATH,
 *    output redirections, and running commands with slashes in the name.
 *  - Starts in `workspacePath` – with rbash's cd restriction users remain there.
 *  - Strips sensitive environment variables (API keys, tokens, etc.).
 *  - Inherits PATH so common tools (git, npm, etc.) stay available.
 */
export class ShellSession extends EventEmitter {
  private pty: IPty;
  private _alive = true;

  constructor(workspacePath: string, cols = 80, rows = 24) {
    super();

    const safeEnv: Record<string, string> = {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      HOME: workspacePath,
      PWD: workspacePath,
      // Inherit PATH so tools like git, npm, etc. are available
      PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      // Pass through locale/user info if available
      ...(process.env.USER ? { USER: process.env.USER } : {}),
      ...(process.env.LOGNAME ? { LOGNAME: process.env.LOGNAME } : {}),
      // Git user info so commits work inside the terminal
      ...(process.env.GIT_AUTHOR_NAME ? { GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME } : {}),
      ...(process.env.GIT_AUTHOR_EMAIL ? { GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL } : {}),
      ...(process.env.GIT_COMMITTER_NAME ? { GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME } : {}),
      ...(process.env.GIT_COMMITTER_EMAIL ? { GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL } : {}),
    };

    this.pty = spawn(resolveBashPath(), ["--restricted", "--norc", "--noprofile"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: workspacePath,
      env: safeEnv,
    });

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
