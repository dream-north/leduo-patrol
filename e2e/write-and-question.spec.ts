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

// ─── AskUserQuestion rendered as multi-question form ────────────────────────────
test("AskUserQuestion demo renders multi-question form with options", async ({ page }) => {
  await goDemo(page);

  // The demo data includes 3 real-world multi-question panels in a grouped form
  const form = page.locator(".multi-question-form");
  await expect(form).toBeVisible({ timeout: 5000 });

  // Check the first question has header and text
  const headerEl = form.locator(".question-header", { hasText: "作业排序" });
  await expect(headerEl.first()).toBeVisible();
  const questionText = form.locator(".question-text", { hasText: "接口返回的作业列表" });
  await expect(questionText.first()).toBeVisible();

  // Check that option buttons with labels and descriptions are shown
  const optionBtns = form.locator(".question-option-btn");
  await expect(optionBtns.first()).toBeVisible();
  const optionDesc = form.locator(".question-option-desc");
  await expect(optionDesc.first()).toBeVisible();

  // Each question should have a custom input toggle
  await expect(form.locator(".question-custom-toggle")).toHaveCount(3);

  await captureFull(page, "docs/screenshots/e2e-ask-user-question.png");
});

// ─── Combined Write + Question screenshot ───────────────────────────────────────
test("showcase: Write tool and Question panel together", async ({ page }) => {
  await goDemo(page);

  // Ensure both Write timeline item and multi-question form are visible
  await expect(page.locator(".timeline-row", { hasText: "Write" }).first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".multi-question-form").first()).toBeVisible({ timeout: 5000 });

  await captureFull(page, "docs/screenshots/e2e-write-and-question-combined.png");
});
