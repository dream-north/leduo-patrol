import { test, expect, type Page } from "@playwright/test";

const KEY = "showcase-key";
const BASE = `http://localhost:3099/?key=${KEY}`;
const DEMO = `${BASE}&demo=subagent-tree`;

async function goDemo(page: Page) {
  await page.goto(DEMO);
  await page.waitForSelector(".shell", { timeout: 8000 });
}

async function captureFull(page: Page, path: string) {
  await page.screenshot({
    path,
    fullPage: true,
  });
}

// ─── Native Read tool (without mcp__acp__ prefix) renders with completed status ─
test("native Read tool renders with completed status in timeline", async ({ page }) => {
  await goDemo(page);

  // The demo data includes a Read tool timeline item (native, no prefix).
  // It should display "Read /src/config.ts" with "completed" status.
  const readRow = page.locator(".timeline-row", { hasText: "Read /src/config.ts" });
  await expect(readRow.first()).toBeVisible({ timeout: 5000 });

  // The status should show as completed (not failed or denied)
  const completedMeta = readRow.first().locator(".timeline-meta", { hasText: /completed/ });
  await expect(completedMeta).toBeVisible();

  await captureFull(page, "docs/screenshots/e2e-native-read-tool.png");
});

// ─── Native Write tool renders with completed status ─────────────────────────────
test("native Write tool renders with completed status in timeline", async ({ page }) => {
  await goDemo(page);

  const writeRow = page.locator(".timeline-row", { hasText: "Write /src/config.ts" });
  await expect(writeRow.first()).toBeVisible({ timeout: 5000 });

  const completedMeta = writeRow.first().locator(".timeline-meta", { hasText: /completed/ });
  await expect(completedMeta).toBeVisible();

  await captureFull(page, "docs/screenshots/e2e-native-write-tool.png");
});

// ─── AskUserQuestion renders as Question panel (seamless handling) ───────────────
test("AskUserQuestion renders question panel with options", async ({ page }) => {
  await goDemo(page);

  // The demo data includes 3 questions from the real-world AskUserQuestion format
  const questionPanel = page.locator(".question-panel");
  await expect(questionPanel.first()).toBeVisible({ timeout: 5000 });

  // Check headers are shown
  const headerEl = page.locator(".question-header", { hasText: "作业排序" });
  await expect(headerEl.first()).toBeVisible();

  // Check the question text
  const questionText = page.locator(".question-text", { hasText: "接口返回的作业列表" });
  await expect(questionText.first()).toBeVisible();

  // Check that option buttons with descriptions are shown
  const optionBtns = page.locator(".question-option-btn");
  await expect(optionBtns.first()).toBeVisible();
  const optionLabel = page.locator(".question-option-label", { hasText: "已排序" });
  await expect(optionLabel.first()).toBeVisible();
  const optionDesc = page.locator(".question-option-desc");
  await expect(optionDesc.first()).toBeVisible();

  // With allowCustomAnswer=false, custom input should NOT be visible
  const customInput = page.locator(".question-custom-input");
  await expect(customInput).toHaveCount(0);

  await captureFull(page, "docs/screenshots/e2e-native-ask-user-question.png");
});

// ─── All three tools visible together in the UI ─────────────────────────────────
test("Read + Write + AskUserQuestion all visible seamlessly", async ({ page }) => {
  await goDemo(page);

  // Read tool visible
  await expect(
    page.locator(".timeline-row", { hasText: "Read /src/config.ts" }).first(),
  ).toBeVisible({ timeout: 5000 });

  // Write tool visible
  await expect(
    page.locator(".timeline-row", { hasText: "Write /src/config.ts" }).first(),
  ).toBeVisible({ timeout: 5000 });

  // Question panel visible
  await expect(page.locator(".question-panel").first()).toBeVisible({ timeout: 5000 });

  await captureFull(page, "docs/screenshots/e2e-all-native-tools-combined.png");
});

// ─── Multi-question AskUserQuestion renders all 3 sub-questions with options ────
test("AskUserQuestion multi-question renders all sub-questions with headers and options", async ({ page }) => {
  await goDemo(page);

  // Should have 3 question panels (one per sub-question)
  const questionPanels = page.locator(".question-panel");
  await expect(questionPanels).toHaveCount(3, { timeout: 5000 });

  // Verify headers
  await expect(page.locator(".question-header", { hasText: "作业排序" })).toBeVisible();
  await expect(page.locator(".question-header", { hasText: "作业状态" })).toBeVisible();
  await expect(page.locator(".question-header", { hasText: "错误类型" })).toBeVisible();

  // Verify first question's option buttons include descriptions
  const firstPanel = questionPanels.nth(0);
  const firstOptions = firstPanel.locator(".question-option-btn");
  await expect(firstOptions).toHaveCount(3); // 已排序, 未排序, 不确定
  await expect(firstPanel.locator(".question-option-label", { hasText: "已排序" })).toBeVisible();
  await expect(firstPanel.locator(".question-option-desc").first()).toBeVisible();

  // Verify second question
  const secondPanel = questionPanels.nth(1);
  await expect(secondPanel.locator(".question-option-btn")).toHaveCount(3);
  await expect(secondPanel.locator(".question-option-label", { hasText: /Recommended/ })).toBeVisible();

  // Verify third question
  const thirdPanel = questionPanels.nth(2);
  await expect(thirdPanel.locator(".question-option-btn")).toHaveCount(2);

  await captureFull(page, "docs/screenshots/e2e-multi-question-ask-user.png");
});
