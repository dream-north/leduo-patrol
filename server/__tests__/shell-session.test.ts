import test from "node:test";
import assert from "node:assert/strict";
import { shellSessionTestables } from "../shell-session.js";

test("shellSessionTestables.resolveShellLaunch prefers configured shell over defaults", () => {
  const resolved = shellSessionTestables.resolveShellLaunch(
    {
      LEDUO_PATROL_SHELL: "/custom/bin/zsh",
      SHELL: "/bin/bash",
    },
    (candidate) => candidate === "/custom/bin/zsh" || candidate === "/bin/bash",
  );

  assert.deepEqual(resolved, {
    command: "/custom/bin/zsh",
    args: ["-l"],
  });
});

test("shellSessionTestables.resolveShellLaunch falls back to /bin/sh when bash and zsh are unavailable", () => {
  const resolved = shellSessionTestables.resolveShellLaunch(
    {
      SHELL: "/missing/shell",
    },
    (candidate) => candidate === "/bin/sh",
  );

  assert.deepEqual(resolved, {
    command: "/bin/sh",
    args: [],
  });
});

test("shellSessionTestables.resolveShellLaunch accepts plain configured shell names as a last resort", () => {
  const resolved = shellSessionTestables.resolveShellLaunch(
    {
      LEDUO_PATROL_SHELL: "fish",
      SHELL: "",
    },
    () => false,
  );

  assert.deepEqual(resolved, {
    command: "fish",
    args: ["-l"],
  });
});

test("shellSessionTestables.resolveShellLaunch throws actionable error when no shell is available", () => {
  assert.throws(
    () => shellSessionTestables.resolveShellLaunch({ SHELL: "" }, () => false),
    /LEDUO_PATROL_SHELL/,
  );
});
