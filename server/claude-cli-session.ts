import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import { EventEmitter } from "node:events";

export interface ClaudeCliSessionOptions {
  workspacePath: string;
  sessionId: string;
  resume?: boolean;
  cols?: number;
  rows?: number;
  claudeBin?: string;
  allowSkipPermissions?: boolean;
}

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

    const bin = opts.claudeBin ?? "claude";
    const args: string[] = opts.resume
      ? ["--resume", opts.sessionId]
      : ["--session-id", opts.sessionId];

    if (opts.allowSkipPermissions) {
      args.push("--allow-dangerously-skip-permissions");
    }

    this.pty = spawn(bin, args, {
      name: "xterm-256color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.workspacePath,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      } as Record<string, string>,
    });

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
