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
 * An interactive shell session backed by a PTY.
 *
 * Spawns a login shell (`bash --login`) that inherits the full user
 * environment and loads ~/.bash_profile / ~/.bashrc so that tools like
 * pyenv, nvm, brew, cargo, aliases, etc. are all available.
 */
export class ShellSession extends EventEmitter {
  private pty: IPty;
  private _alive = true;

  constructor(workspacePath: string, cols = 80, rows = 24) {
    super();

    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] != null,
        ),
      ),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PWD: workspacePath,
    };

    this.pty = spawn(resolveBashPath(), ["--login"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: workspacePath,
      env,
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
