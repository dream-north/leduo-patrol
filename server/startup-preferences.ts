import os from "node:os";
import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

export type StartupPreferences = {
  bindMode?: "server" | "local";
  accessKey?: string;
};

const PREFS_FILE_PATH = path.join(os.homedir(), ".leduo-patrol", "launch-preferences.json");

export async function loadStartupPreferences(): Promise<StartupPreferences> {
  if (!(await isReadable(PREFS_FILE_PATH))) {
    return {};
  }

  try {
    const raw = await readFile(PREFS_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as StartupPreferences;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveStartupPreferences(
  updates: Partial<StartupPreferences>,
): Promise<StartupPreferences> {
  const current = await loadStartupPreferences();
  const next: StartupPreferences = {
    ...current,
    ...updates,
  };

  for (const key of Object.keys(next) as Array<keyof StartupPreferences>) {
    const value = next[key];
    if (value == null || value === "") {
      delete next[key];
    }
  }

  await mkdir(path.dirname(PREFS_FILE_PATH), { recursive: true });
  await writeFile(PREFS_FILE_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function isReadable(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export const startupPreferencesTestables = {
  PREFS_FILE_PATH,
};
