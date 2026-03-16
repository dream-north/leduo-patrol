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

// ─── Write tool with mcp__acp__ prefix normalised ─────────────────────────────
test("Write tool timeline item appears with normalised title", async ({ page }) => {
  await goDemo(page);

  // The demo data includes a Write tool timeline item.
  // The title should display "Write /src/config.ts" (with mcp__acp__ prefix stripped).
  const writeRow = page.locator(".timeline-row", { hasText: "Write /src/config.ts" });
  await expect(writeRow.first()).toBeVisible({ timeout: 5000 });

  // The status should show as completed
  const completedMeta = writeRow.first().locator(".timeline-meta", { hasText: /completed/ });
  await expect(completedMeta).toBeVisible();

  await captureFull(page, "docs/screenshots/e2e-write-tool.png");
});

// ─── AskUserQuestion rendered as Question panel ─────────────────────────────────
test("AskUserQuestion demo renders question panel with options", async ({ page }) => {
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

  await captureFull(page, "docs/screenshots/e2e-ask-user-question.png");
});

// ─── Combined Write + Question screenshot ───────────────────────────────────────
test("showcase: Write tool and Question panel together", async ({ page }) => {
  await goDemo(page);

  // Ensure both Write timeline item and Question panel are visible
  await expect(page.locator(".timeline-row", { hasText: "Write" }).first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".question-panel").first()).toBeVisible({ timeout: 5000 });

  await captureFull(page, "docs/screenshots/e2e-write-and-question-combined.png");
});
