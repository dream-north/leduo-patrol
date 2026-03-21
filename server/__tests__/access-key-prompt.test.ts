import assert from "node:assert/strict";
import test from "node:test";
import { resolveAccessKey, accessKeyPromptTestables } from "../access-key-prompt.js";

const NON_TTY_STREAM = {
  isTTY: false,
} as NodeJS.ReadStream;
const SILENT_STDOUT = {
  isTTY: true,
  write: () => true,
} as unknown as NodeJS.WriteStream;

test("access key prompt normalizes values", () => {
  assert.equal(accessKeyPromptTestables.normalizeAccessKey("  abc  "), "abc");
  assert.equal(accessKeyPromptTestables.normalizeAccessKey(""), "");
  assert.equal(accessKeyPromptTestables.normalizeAccessKey(undefined), "");
});

test("resolveAccessKey prefers argv over env and remembered key", async () => {
  const result = await resolveAccessKey({
    argv: ["--access-key", "cli-key"],
    envKey: "env-key",
    stdin: NON_TTY_STREAM,
    stdout: SILENT_STDOUT,
    loadRememberedKey: async () => "remembered-key",
    createRandomKey: () => "random-key",
  });

  assert.equal(result, "cli-key");
});

test("resolveAccessKey falls back to env key", async () => {
  const result = await resolveAccessKey({
    argv: [],
    envKey: "env-key",
    stdin: NON_TTY_STREAM,
    stdout: SILENT_STDOUT,
    loadRememberedKey: async () => "remembered-key",
    createRandomKey: () => "random-key",
  });

  assert.equal(result, "env-key");
});

test("resolveAccessKey falls back to remembered key", async () => {
  const result = await resolveAccessKey({
    argv: [],
    envKey: "",
    stdin: NON_TTY_STREAM,
    stdout: SILENT_STDOUT,
    loadRememberedKey: async () => "remembered-key",
    createRandomKey: () => "random-key",
  });

  assert.equal(result, "remembered-key");
});

test("resolveAccessKey generates a random key when no tty prompt is available", async () => {
  const result = await resolveAccessKey({
    argv: [],
    envKey: "",
    stdin: NON_TTY_STREAM,
    stdout: SILENT_STDOUT,
    loadRememberedKey: async () => "",
    createRandomKey: () => "random-key",
  });

  assert.equal(result, "random-key");
});

test("resolveAccessKey can save an interactively chosen key", async () => {
  let savedKey = "";
  const ttyStream = {
    isTTY: true,
  } as NodeJS.ReadStream;

  const result = await resolveAccessKey({
    argv: [],
    envKey: "",
    stdin: ttyStream,
    stdout: SILENT_STDOUT,
    loadRememberedKey: async () => "",
    saveRememberedKey: async (key) => {
      savedKey = key;
    },
    createRandomKey: () => "random-key",
    promptForAccessKey: async () => "custom-key",
    promptShouldRememberKey: async () => true,
  });

  assert.equal(result, "custom-key");
  assert.equal(savedKey, "custom-key");
});
