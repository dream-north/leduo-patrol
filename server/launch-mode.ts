import os from "node:os";
import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import readline from "node:readline/promises";

export type BindMode = "server" | "local";

type ResolveBindModeOptions = {
  argv?: string[];
  envMode?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
};

type LaunchPreferences = {
  bindMode?: BindMode;
};

const DEFAULT_MODE: BindMode = "server";
const PREFS_FILE_PATH = path.join(os.homedir(), ".leduo-patrol", "launch-preferences.json");

export async function resolveBindMode(options: ResolveBindModeOptions = {}): Promise<BindMode> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  const argvMode = parseBindMode(readOptionValue(argv, "--mode"));
  if (argvMode) {
    return argvMode;
  }

  const envMode = parseBindMode(options.envMode ?? process.env.LEDUO_PATROL_BIND_MODE);
  if (envMode) {
    return envMode;
  }

  const rememberedMode = await loadRememberedMode();
  if (rememberedMode) {
    return rememberedMode;
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    return DEFAULT_MODE;
  }

  const selectedMode = await promptForMode(stdin, stdout);
  const shouldRemember = await promptShouldRemember(stdin, stdout);
  if (shouldRemember) {
    await saveRememberedMode(selectedMode);
    stdout.write(`已记住启动模式：${selectedMode}\n`);
  }
  return selectedMode;
}

function parseBindMode(raw: string | undefined | null): BindMode | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "local" || normalized === "server") {
    return normalized;
  }
  return null;
}

function readOptionValue(argv: string[], optionName: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === optionName) {
      return argv[i + 1];
    }
    if (arg.startsWith(`${optionName}=`)) {
      return arg.slice(`${optionName}=`.length);
    }
  }
  return undefined;
}

async function promptForMode(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): Promise<BindMode> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    stdout.write("\n请选择启动模式：\n");
    stdout.write("  1) 服务器模式（server，监听 0.0.0.0，可远程连接）\n");
    stdout.write("  2) 本地模式（local，监听 127.0.0.1，仅本机访问）\n");
    const answer = (await rl.question("输入 1/2，默认 1: ")).trim();
    return answer === "2" || answer.toLowerCase() === "local" ? "local" : "server";
  } finally {
    rl.close();
  }
}

async function promptShouldRemember(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): Promise<boolean> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question("是否记住此模式用于后续启动？(y/N): ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function loadRememberedMode(): Promise<BindMode | null> {
  if (!(await isReadable(PREFS_FILE_PATH))) {
    return null;
  }

  try {
    const raw = await readFile(PREFS_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as LaunchPreferences;
    return parseBindMode(parsed.bindMode ?? "");
  } catch {
    return null;
  }
}

async function saveRememberedMode(mode: BindMode) {
  await mkdir(path.dirname(PREFS_FILE_PATH), { recursive: true });
  const payload: LaunchPreferences = { bindMode: mode };
  await writeFile(PREFS_FILE_PATH, JSON.stringify(payload, null, 2), "utf8");
}

async function isReadable(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export const launchModeTestables = {
  parseBindMode,
  readOptionValue,
};
