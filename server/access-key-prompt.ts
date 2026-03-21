import readline from "node:readline/promises";
import { createAccessKey } from "./access-key.js";
import { loadStartupPreferences, saveStartupPreferences } from "./startup-preferences.js";
import { readOptionValue } from "./launch-mode.js";

type ResolveAccessKeyOptions = {
  argv?: string[];
  envKey?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  createRandomKey?: () => string;
  loadRememberedKey?: () => Promise<string>;
  saveRememberedKey?: (key: string) => Promise<void>;
  promptForAccessKey?: (
    stdin: NodeJS.ReadStream,
    stdout: NodeJS.WriteStream,
    generatedKey: string,
  ) => Promise<string>;
  promptShouldRememberKey?: (
    stdin: NodeJS.ReadStream,
    stdout: NodeJS.WriteStream,
  ) => Promise<boolean>;
};

export async function resolveAccessKey(options: ResolveAccessKeyOptions = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const createRandomKey = options.createRandomKey ?? createAccessKey;
  const loadRememberedKey = options.loadRememberedKey ?? loadRememberedAccessKey;
  const saveRememberedKey = options.saveRememberedKey ?? saveRememberedAccessKey;
  const promptForKey = options.promptForAccessKey ?? promptForAccessKey;
  const promptShouldRemember = options.promptShouldRememberKey ?? promptShouldRememberKey;

  const argvKey = normalizeAccessKey(readOptionValue(argv, "--access-key"));
  if (argvKey) {
    return argvKey;
  }

  const envKey = normalizeAccessKey(options.envKey ?? process.env.LEDUO_PATROL_ACCESS_KEY);
  if (envKey) {
    return envKey;
  }

  const rememberedKey = normalizeAccessKey(await loadRememberedKey());
  if (rememberedKey) {
    return rememberedKey;
  }

  const generatedKey = createRandomKey();
  if (!stdin.isTTY || !stdout.isTTY) {
    return generatedKey;
  }

  const selectedKey = await promptForKey(stdin, stdout, generatedKey);
  const shouldRemember = await promptShouldRemember(stdin, stdout);
  if (shouldRemember) {
    await saveRememberedKey(selectedKey);
    stdout.write("已记住访问 key，后续启动会自动复用。\n");
  }

  return selectedKey;
}

async function promptForAccessKey(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  generatedKey: string,
) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    stdout.write("\n请选择访问 key 生成方式：\n");
    stdout.write("  1) 手动输入自定义 key\n");
    stdout.write("  2) 使用随机生成 key\n");
    const answer = (await rl.question("输入 1/2，默认 2: ")).trim().toLowerCase();
    if (answer === "1" || answer === "custom" || answer === "manual") {
      const customAnswer = (await rl.question("请输入自定义访问 key: ")).trim();
      const customKey = normalizeAccessKey(customAnswer);
      if (customKey) {
        return customKey;
      }
      stdout.write("未输入有效 key，已改用随机生成 key。\n");
    }

    stdout.write(`本次启动使用随机 key: ${generatedKey}\n`);
    return generatedKey;
  } finally {
    rl.close();
  }
}

async function promptShouldRememberKey(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question("是否记住此访问 key 用于后续启动？(y/N): ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function normalizeAccessKey(raw: string | undefined | null) {
  const normalized = raw?.trim() ?? "";
  return normalized || "";
}

async function loadRememberedAccessKey() {
  return normalizeAccessKey((await loadStartupPreferences()).accessKey);
}

async function saveRememberedAccessKey(key: string) {
  await saveStartupPreferences({ accessKey: key });
}

export const accessKeyPromptTestables = {
  normalizeAccessKey,
  loadRememberedAccessKey,
  saveRememberedAccessKey,
};
