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

  // The demo data includes a question: "发布前需要确认：是否已完成回滚测试？"
  const questionPanel = page.locator(".question-panel");
  await expect(questionPanel.first()).toBeVisible({ timeout: 5000 });

  // Check the question text
  const questionText = page.locator(".question-text", { hasText: "发布前需要确认" });
  await expect(questionText.first()).toBeVisible();

  // Check that option buttons are shown
  const optionBtns = page.locator(".question-option-btn");
  await expect(optionBtns.first()).toBeVisible();

  // Check custom answer input is also visible (allowCustomAnswer=true)
  const customInput = page.locator(".question-custom-input");
  await expect(customInput.first()).toBeVisible();

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
