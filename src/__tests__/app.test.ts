import test from "node:test";
import assert from "node:assert/strict";
import { appTestables } from "../App";

test("app path helpers normalize and guard navigation", () => {
  assert.equal(appTestables.normalizePath("/a/b///"), "/a/b");
  assert.equal(appTestables.isWithinRoot("/a", "/a/b/c"), true);
  assert.equal(appTestables.isWithinRoot("/a", "/x/y"), false);
});

test("app relative updatedAt formatter uses minute hour and day buckets", () => {
  const now = Date.parse("2026-03-11T12:00:00.000Z");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-11T11:59:40.000Z", now), "刚刚");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-11T11:45:00.000Z", now), "15 分钟前");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-11T09:00:00.000Z", now), "3 小时前");
  assert.equal(appTestables.formatRelativeUpdatedAt("2026-03-08T12:00:00.000Z", now), "3 天前");
});

test("app mode/connection helpers return expected labels", () => {
  assert.equal(appTestables.toneForConnectionState("connected"), "positive");
  assert.equal(appTestables.toneForConnectionState("error"), "negative");
});

test("app access key helpers read and preserve search params", () => {
  assert.equal(appTestables.getAccessKeyFromSearch("?demo=subagent-tree&key=abc123"), "abc123");
  assert.equal(
    appTestables.buildLocationWithAccessKey("http://localhost/?demo=subagent-tree", " next-key "),
    "/?demo=subagent-tree&key=next-key",
  );
  assert.equal(
    appTestables.buildLocationWithAccessKey("http://localhost/?demo=subagent-tree&key=old#gate", ""),
    "/?demo=subagent-tree#gate",
  );
});

test("app path helpers parent/isWithinRoot", () => {
  assert.equal(appTestables.parentDirectory("/a/b/c"), "/a/b");
  assert.equal(appTestables.isWithinRoot("/a", "/a/b/c"), true);
  assert.equal(appTestables.isWithinRoot("/a", "/x/y"), false);
});

test("app resolveWorkspaceLookupPath falls back to parent for partial directory names", () => {
  assert.equal(
    appTestables.resolveWorkspaceLookupPath(
      "/repo",
      "src/compo",
      [{ name: "components", path: "/repo/src/components" }],
    ),
    "/repo/src",
  );
  assert.equal(
    appTestables.resolveWorkspaceLookupPath(
      "/repo",
      "src/components",
      [{ name: "components", path: "/repo/src/components" }],
    ),
    "/repo/src/components",
  );
});

test("app formatSessionTitleForDisplay inserts zero-width space after underscores", () => {
  assert.equal(appTestables.formatSessionTitleForDisplay("my_session"), "my_\u200bsession");
  assert.equal(appTestables.formatSessionTitleForDisplay("no_underscore_test"), "no_\u200bunderscore_\u200btest");
});

test("app formatWorkspacePathForSidebar truncates allowed root prefix", () => {
  assert.equal(appTestables.formatWorkspacePathForSidebar("/repo/project", ["/repo"]), "…/project");
  assert.equal(appTestables.formatWorkspacePathForSidebar("/repo", ["/repo"]), "…/");
  assert.equal(appTestables.formatWorkspacePathForSidebar("/other/path", ["/repo"]), "/other/path");
});

test("app splitWorkspacePathByAllowedRoots splits path correctly", () => {
  const result = appTestables.splitWorkspacePathByAllowedRoots("/repo/src/app", ["/repo", "/tmp"]);
  assert.equal(result.root, "/repo");
  assert.equal(result.suffix, "src/app");

  const exact = appTestables.splitWorkspacePathByAllowedRoots("/repo", ["/repo"]);
  assert.equal(exact.root, "/repo");
  assert.equal(exact.suffix, "");
});

test("app mobile terminal detection prefers narrow touch devices", () => {
  assert.equal(
    appTestables.shouldEnableMobileTerminalInput({
      viewportWidth: 430,
      coarsePointer: true,
      touchPoints: 5,
    }),
    true,
  );
  assert.equal(
    appTestables.shouldEnableMobileTerminalInput({
      viewportWidth: 430,
      coarsePointer: false,
      touchPoints: 0,
    }),
    false,
  );
  assert.equal(
    appTestables.shouldEnableMobileTerminalInput({
      viewportWidth: 1280,
      coarsePointer: true,
      touchPoints: 5,
    }),
    false,
  );
});

test("app mobile terminal key mapping returns expected control sequences", () => {
  assert.equal(appTestables.mapMobileTerminalActionToSequence("enter"), "\r");
  assert.equal(appTestables.mapMobileTerminalActionToSequence("backspace"), "\u007f");
  assert.equal(appTestables.mapMobileTerminalActionToSequence("pageUp"), "");
  assert.equal(appTestables.mapMobileTerminalActionToSequence("pageDown"), "");
  assert.equal(appTestables.mapMobileTerminalActionToSequence("arrowUp"), "\u001b[A");
  assert.equal(appTestables.mapMobileTerminalActionToSequence("arrowRight"), "\u001b[C");
  assert.equal(appTestables.mapMobileTerminalActionToSequence("ctrlC"), "\u0003");
});

test("app mobile terminal input disables when session or connection is unavailable", () => {
  assert.equal(appTestables.shouldDisableMobileTerminalInput(null, "connected"), true);
  assert.equal(appTestables.shouldDisableMobileTerminalInput("session-1", "closed"), true);
  assert.equal(appTestables.shouldDisableMobileTerminalInput("session-1", "connected", "error"), true);
  assert.equal(appTestables.shouldDisableMobileTerminalInput("session-1", "connected"), false);
});
