import test from "node:test";
import assert from "node:assert/strict";
import { appTestables } from "../App";

test("app path helpers normalize and guard navigation", () => {
  assert.equal(appTestables.normalizePath("/a/b///"), "/a/b");
  assert.equal(appTestables.canNavigateUp("/a/b", ["/a"]), true);
  assert.equal(appTestables.canNavigateUp("/a", ["/a"]), false);
});

test("app extractPlanPreview handles nested plan payload", () => {
  const preview = appTestables.extractPlanPreview({
    rawInput: {
      file_path: "/repo/.claude/plans/p1.md",
      content: "# Plan\n- item",
    },
  });

  assert.deepEqual(preview, { title: "计划", body: "# Plan\n- item" });
});

test("app summarizeToolTitle builds fallback summary", () => {
  const summary = appTestables.summarizeToolTitle("tool_exec", { cmd: ["npm", "run", "check"], cwd: "/repo" }, "tool-2");
  assert.equal(summary, "npm run check · /repo");
});
